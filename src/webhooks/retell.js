const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../database/client');
const { processCallWithClaude } = require('../memory/processor');
const { updateAgentForProspect } = require('../agents/retell');
const env = require('../../config/env');

/**
 * Verify Retell webhook signature.
 * Retell signs with HMAC-SHA256 using the API key.
 */
function verifyRetellSignature(req) {
  const signature = req.headers['x-retell-signature'];
  if (!signature) return false;
  const body = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', env.RETELL_API_KEY).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Full memory loop:
 * 1. Retell webhook fires (call_ended)
 * 2. Save transcript to calls table
 * 3. processCallWithClaude() analyses transcript, updates prospect memory
 * 4. updateAgentForProspect() rebuilds prompt with fresh memory
 * 5. Retell agent is patched with new prompt — ready for next call
 *
 * Zero manual steps.
 */
router.post('/', async (req, res) => {
   try {
    // Verify webhook signature (skip in dev if no signature present)
    // Signature verification disabled for MVP — re-enable before production
// const sig = req.headers['x-retell-signature'];
// if (sig && !verifyRetellSignature(req)) {
//   console.warn('[webhook:retell] Invalid signature — rejecting.');
//   return res.status(401).json({ error: 'Invalid webhook signature' });
// }
    

    const event = req.body;
    console.log(`[webhook:retell] Event received: ${event.event}`);

    if (event.event === 'call_ended' || event.event === 'call_analyzed') {
      const callData = event.call || event.data || {};
      const retellCallId = callData.call_id || callData.id;
      const transcript = callData.transcript || '';
      const duration = callData.duration_ms ? Math.round(callData.duration_ms / 1000) : null;
      const recordingUrl = callData.recording_url || null;

      // Find or create call record
      let { data: existingCall } = await supabase
        .from('calls')
        .select('id, prospect_id, client_id')
        .eq('retell_call_id', retellCallId)
        .single();

      if (!existingCall) {
        const { data: newCall } = await supabase
          .from('calls')
          .insert({
            retell_call_id: retellCallId,
            call_type: 'phone',
            transcript,
            duration_seconds: duration,
            recording_url: recordingUrl,
          })
          .select()
          .single();
        existingCall = newCall;
      } else {
        await supabase
          .from('calls')
          .update({ transcript, duration_seconds: duration, recording_url: recordingUrl })
          .eq('id', existingCall.id);
      }

      if (existingCall && transcript) {
        // Run full memory loop async — don't block the webhook response
        runMemoryLoop(existingCall.id, existingCall.prospect_id, existingCall.client_id).catch(err => {
          console.error(`[webhook:retell] Memory loop failed: ${err.message}`);
        });
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook:retell] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The full automatic memory loop.
 * Called after every call ends. Returns the analysis for testing.
 */
async function runMemoryLoop(callId, prospectId, clientId) {
  console.log(`[memory-loop] Starting for call ${callId}...`);

  // Step 1: Claude analyses transcript → updates prospect + call records
  const analysis = await processCallWithClaude(callId);
  console.log(`[memory-loop] Analysis complete. Detection risk: ${analysis.detection_risk_score}/10`);

  // Step 2: Rebuild prompt with fresh memory and push to Retell
  if (prospectId && clientId) {
    try {
      await updateAgentForProspect(clientId, prospectId);
      console.log(`[memory-loop] Retell agent updated with fresh memory.`);
    } catch (err) {
      // Don't throw — agent update failure shouldn't break the loop
      console.error(`[memory-loop] Agent update failed (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`[memory-loop] Skipping agent update — no prospect/client linked to call.`);
  }

  console.log(`[memory-loop] Complete for call ${callId}.`);
  return analysis;
}

module.exports = router;
module.exports.runMemoryLoop = runMemoryLoop;
