const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../database/client');
const { processCallWithClaude } = require('../memory/processor');
const { updateAgentForProspect } = require('../agents/retell');
const { appendChunk, getTranscript, clearTranscript } = require('../lib/transcript-buffer');
const env = require('../../config/env');

/**
 * Verify Recall webhook signature.
 */
function verifyRecallSignature(req) {
  const signature = req.headers['x-recall-signature'];
  if (!signature || !env.RECALL_WEBHOOK_SECRET) return false;
  const body = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', env.RECALL_WEBHOOK_SECRET).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Main Recall webhook — handles bot lifecycle events.
 * Full flow: bot joins → records → done → processCallWithClaude → update agent
 */
router.post('/', async (req, res) => {
  // Verify webhook signature (skip if secret not configured)
  const sig = req.headers['x-recall-signature'];
  if (sig && env.RECALL_WEBHOOK_SECRET && !verifyRecallSignature(req)) {
    console.warn('[webhook:recall] Invalid signature — rejecting.');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // Respond immediately — all processing is async
  res.status(200).json({ received: true });

  try {
    const event = req.body;
    const statusCode = event.status?.code || event.data?.status?.code || event.event || '';
    const botId = event.data?.bot_id || event.bot_id || '';

    console.log(`[webhook:recall] Event: ${statusCode} | Bot: ${botId}`);

    if (!botId) return;

    // Find call record for this bot
    const { data: call } = await supabase
      .from('calls')
      .select('id, prospect_id, client_id')
      .eq('recall_bot_id', botId)
      .single();

    switch (statusCode) {
      // ---- Bot is joining the call ----
      case 'joining_call':
      case 'bot.joining_call': {
        console.log(`[webhook:recall] Bot ${botId} joining call...`);
        if (call) {
          await supabase.from('calls').update({ status: 'joining' }).eq('id', call.id);
        }
        break;
      }

      // ---- Bot is in the waiting room ----
      case 'in_waiting_room':
      case 'bot.in_waiting_room': {
        console.log(`[webhook:recall] Bot ${botId} in waiting room — waiting to be admitted.`);
        if (call) {
          await supabase.from('calls').update({ status: 'waiting_room' }).eq('id', call.id);
        }
        break;
      }

      // ---- Bot is in the call but not recording ----
      case 'in_call_not_recording':
      case 'bot.in_call_not_recording': {
        console.log(`[webhook:recall] Bot ${botId} in call, not recording yet.`);
        if (call) {
          await supabase.from('calls').update({ status: 'in_call' }).eq('id', call.id);
        }
        break;
      }

      // ---- Bot is recording ----
      case 'in_call_recording':
      case 'bot.in_call_recording': {
        console.log(`[webhook:recall] Bot ${botId} recording.`);
        if (call) {
          await supabase.from('calls').update({ status: 'recording' }).eq('id', call.id);
        }
        break;
      }

      // ---- Recording done — save recording URL ----
      case 'call_ended':
      case 'bot.call_ended':
      case 'recording_done':
      case 'bot.recording_done': {
        const recordingUrl = event.data?.recording_url || event.recording_url || null;
        console.log(`[webhook:recall] Recording done for bot ${botId}. URL: ${recordingUrl || 'pending'}`);
        if (call) {
          await supabase.from('calls').update({
            status: 'recording_done',
            recording_url: recordingUrl,
          }).eq('id', call.id);
        }
        break;
      }

      // ---- Bot done — trigger full memory loop ----
      case 'done':
      case 'bot.done': {
        console.log(`[webhook:recall] Bot ${botId} done. Running memory loop...`);

        if (!call) {
          console.warn(`[webhook:recall] No call record for bot ${botId}`);
          break;
        }

        // Build transcript from buffered chunks OR from event payload
        let transcript = '';

        // Try to get transcript from the event payload first
        if (event.data?.transcript) {
          const segments = event.data.transcript;
          if (Array.isArray(segments)) {
            transcript = segments.map(t => {
              const speaker = t.speaker || 'Unknown';
              const text = t.words?.map(w => w.text).join(' ') || t.text || '';
              return `${speaker}: ${text}`;
            }).join('\n');
          } else if (typeof segments === 'string') {
            transcript = segments;
          }
        }

        // Fall back to buffered real-time chunks
        if (!transcript) {
          const chunks = await getTranscript(botId);
          if (chunks.length > 0) {
            transcript = chunks.map(c => {
              const speaker = c.speaker || 'Unknown';
              const text = c.words?.map(w => w.text).join(' ') || c.text || c.transcript || '';
              return `${speaker}: ${text}`;
            }).join('\n');
          }
        }

        // Save transcript
        const duration = event.data?.duration_seconds || null;
        const recordingUrl = event.data?.recording_url || null;

        await supabase.from('calls').update({
          transcript: transcript || 'No transcript captured',
          status: 'done',
          duration_seconds: duration,
          recording_url: recordingUrl,
        }).eq('id', call.id);

        // Clear the transcript buffer
        await clearTranscript(botId);

        // Run full memory loop: Claude analysis → prospect update → agent update
        try {
          const analysis = await processCallWithClaude(call.id);
          console.log(`[webhook:recall] Memory processed. Risk: ${analysis.detection_risk_score}/10`);

          // Update Retell agent with fresh memory
          if (call.prospect_id && call.client_id) {
            try {
              await updateAgentForProspect(call.client_id, call.prospect_id);
              console.log(`[webhook:recall] Agent prompt updated with fresh memory.`);
            } catch (agentErr) {
              console.error(`[webhook:recall] Agent update failed (non-fatal): ${agentErr.message}`);
            }
          }
        } catch (memErr) {
          console.error(`[webhook:recall] Memory processing failed: ${memErr.message}`);
        }

        // Update call outcome
        await supabase.from('calls').update({
          status: 'processed',
          outcome: 'completed',
        }).eq('id', call.id);

        break;
      }

      // ---- Fatal error ----
      case 'fatal':
      case 'bot.fatal': {
        console.error(`[webhook:recall] Bot ${botId} fatal error:`, event.data?.error || 'unknown');
        if (call) {
          await supabase.from('calls').update({
            status: 'error',
            outcome: `error: ${event.data?.error || 'unknown'}`,
          }).eq('id', call.id);
        }
        break;
      }

      default:
        console.log(`[webhook:recall] Unhandled status: ${statusCode}`);
    }
  } catch (err) {
    console.error('[webhook:recall] Handler error:', err.message);
  }
});

/**
 * Real-time transcript chunks — buffered by bot_id
 */
router.post('/transcript', async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const chunk = req.body;
    const botId = chunk.bot_id || chunk.data?.bot_id || '';
    const speaker = chunk.speaker || chunk.data?.speaker || 'Unknown';
    const text = chunk.transcript || chunk.text || chunk.data?.transcript || '';

    if (botId && text) {
      await appendChunk(botId, { speaker, text, timestamp: Date.now() });
    }
  } catch (err) {
    console.error('[webhook:recall:transcript] Error:', err.message);
  }
});

module.exports = router;
