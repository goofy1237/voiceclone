const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../database/client');
const { processCallWithClaude } = require('../memory/processor');
const { updateAgentForProspect } = require('../agents/retell');
const { getTavusConversationStatus } = require('../agents/tavus');
const env = require('../../config/env');

/**
 * Verify Tavus webhook signature.
 */
function verifyTavusSignature(req) {
  const signature = req.headers['x-tavus-signature'];
  if (!signature) return false;
  const body = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', env.TAVUS_API_KEY).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Tavus webhook — handles conversation lifecycle events.
 * conversation.started → update status
 * conversation.ended → fetch transcript → Claude analysis → update agent
 */
router.post('/', async (req, res) => {
  // Verify webhook signature (skip in dev if no signature present)
  const sig = req.headers['x-tavus-signature'];
  if (sig && !verifyTavusSignature(req)) {
    console.warn('[webhook:tavus] Invalid signature — rejecting.');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // Respond immediately
  res.status(200).json({ received: true });

  try {
    const event = req.body;
    const eventType = event.event || event.event_type || event.type || '';
    const conversationId = event.conversation_id || event.data?.conversation_id || '';

    console.log(`[webhook:tavus] Event: ${eventType} | Conversation: ${conversationId}`);

    if (!conversationId) return;

    // Find call record
    const { data: call } = await supabase
      .from('calls')
      .select('id, prospect_id, client_id')
      .eq('conversation_id', conversationId)
      .single();

    if (!call) {
      console.warn(`[webhook:tavus] No call record for conversation ${conversationId}`);
      return;
    }

    switch (eventType) {
      case 'conversation.started':
      case 'conversation_started': {
        console.log(`[webhook:tavus] Conversation ${conversationId} started.`);
        await supabase.from('calls').update({
          status: 'in_progress',
        }).eq('id', call.id);
        break;
      }

      case 'conversation.ended':
      case 'conversation_ended': {
        console.log(`[webhook:tavus] Conversation ${conversationId} ended. Running memory loop...`);

        // Get conversation details including transcript
        let transcript = '';
        let duration = null;

        try {
          const convo = await getTavusConversationStatus(conversationId);
          duration = convo.conversation_length || convo.duration || null;

          // Extract transcript
          if (convo.transcript) {
            if (Array.isArray(convo.transcript)) {
              transcript = convo.transcript.map(t =>
                `${t.speaker || t.role || 'Unknown'}: ${t.text || t.content || ''}`
              ).join('\n');
            } else if (typeof convo.transcript === 'string') {
              transcript = convo.transcript;
            }
          }
        } catch (err) {
          console.warn(`[webhook:tavus] Failed to fetch conversation details: ${err.message}`);
        }

        // Also check event payload for transcript
        if (!transcript && event.transcript) {
          transcript = typeof event.transcript === 'string'
            ? event.transcript
            : JSON.stringify(event.transcript);
        }

        // Save transcript and status
        await supabase.from('calls').update({
          transcript: transcript || 'No transcript captured',
          status: 'done',
          duration_seconds: duration ? Math.round(duration) : null,
        }).eq('id', call.id);

        // Run Claude memory loop
        try {
          const analysis = await processCallWithClaude(call.id);
          console.log(`[webhook:tavus] Memory processed. Risk: ${analysis.detection_risk_score}/10`);

          // Update agent prompt with fresh memory
          if (call.prospect_id && call.client_id) {
            try {
              await updateAgentForProspect(call.client_id, call.prospect_id);
              console.log(`[webhook:tavus] Agent prompt updated.`);
            } catch (agentErr) {
              console.error(`[webhook:tavus] Agent update failed (non-fatal): ${agentErr.message}`);
            }
          }
        } catch (memErr) {
          console.error(`[webhook:tavus] Memory processing failed: ${memErr.message}`);
        }

        // Mark as processed
        await supabase.from('calls').update({
          status: 'processed',
          outcome: 'completed',
        }).eq('id', call.id);

        break;
      }

      default:
        console.log(`[webhook:tavus] Unhandled event: ${eventType}`);
    }
  } catch (err) {
    console.error('[webhook:tavus] Handler error:', err.message);
  }
});

module.exports = router;
