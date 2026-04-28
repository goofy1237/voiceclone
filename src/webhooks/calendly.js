const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../database/client');
const { deployRecallBot } = require('../agents/recall');
const { updateAgentForProspect } = require('../agents/retell');
const { createTavusConversation } = require('../agents/tavus');
const orchestrator = require('../video/orchestrator');
const env = require('../../config/env');

/**
 * Verify Calendly webhook signature.
 */
function verifyCalendlySignature(req) {
  const signature = req.headers['calendly-webhook-signature'];
  if (!signature || !env.CALENDLY_WEBHOOK_SECRET) return false;
  const body = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', env.CALENDLY_WEBHOOK_SECRET).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Calendly webhook — invitee.created
 * Flow:
 * 1. Extract email, name, meet URL from event
 * 2. Find or create prospect
 * 3. Match client by calendly_event_type_uri
 * 4. Update agent with fresh prospect memory
 * 5. Deploy Recall bot to Google Meet
 */
router.post('/', async (req, res) => {
  // Verify webhook signature (skip if secret not configured)
  const sig = req.headers['calendly-webhook-signature'];
  if (sig && env.CALENDLY_WEBHOOK_SECRET && !verifyCalendlySignature(req)) {
    console.warn('[webhook:calendly] Invalid signature — rejecting.');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // Respond immediately
  res.status(200).json({ received: true });

  try {
    const event = req.body;
    console.log(`[webhook:calendly] Event: ${event.event}`);

    if (event.event !== 'invitee.created') return;

    const payload = event.payload || {};

    // Extract invitee info
    const inviteeEmail = payload.email
      || payload.invitee?.email
      || payload.invitee_email
      || null;
    const inviteeName = payload.name
      || payload.invitee?.name
      || payload.first_name
      || null;

    // Extract event type URI for client matching
    const eventTypeUri = payload.event_type
      || payload.event_type_uri
      || payload.scheduled_event?.event_type
      || null;

    // Extract Google Meet URL from location
    const scheduledEvent = payload.scheduled_event || payload.event || {};
    const location = scheduledEvent.location || payload.location || {};
    let meetUrl = null;

    if (typeof location === 'object') {
      meetUrl = location.join_url || location.data?.url || location.url || null;
    } else if (typeof location === 'string' && location.includes('meet.google.com')) {
      meetUrl = location;
    }

    // Also check conferencing object
    if (!meetUrl) {
      const conferencing = scheduledEvent.conferencing || payload.conferencing || {};
      meetUrl = conferencing.join_url || conferencing.details?.url || null;
    }

    console.log(`[webhook:calendly] Invitee: ${inviteeName} <${inviteeEmail}> | Meet: ${meetUrl || 'none'} | EventType: ${eventTypeUri || 'none'}`);

    if (!inviteeEmail) {
      console.warn('[webhook:calendly] No email — cannot process.');
      return;
    }

    // Match client by calendly_event_type_uri
    let client = null;
    if (eventTypeUri) {
      const { data } = await supabase
        .from('clients')
        .select('id, video_mode, tavus_replica_id, tavus_persona_id, base_url')
        .eq('calendly_event_type_uri', eventTypeUri)
        .single();
      client = data;
    }

    // Fallback: if only one client exists, use that
    if (!client) {
      const { data: clients } = await supabase
        .from('clients')
        .select('id, video_mode, tavus_replica_id, tavus_persona_id, base_url')
        .limit(2);
      if (clients && clients.length === 1) {
        client = clients[0];
      }
    }

    if (!client) {
      console.warn('[webhook:calendly] Could not match invitee to a client.');
      return;
    }

    // Find or create prospect
    let { data: prospect } = await supabase
      .from('prospects')
      .select('id, client_id')
      .eq('email', inviteeEmail)
      .single();

    if (!prospect) {
      console.log(`[webhook:calendly] Creating new prospect for ${inviteeEmail}`);
      const { data: newProspect, error } = await supabase
        .from('prospects')
        .insert({
          client_id: client.id,
          name: inviteeName || inviteeEmail.split('@')[0],
          email: inviteeEmail,
          funnel_stage: 'qualified',
        })
        .select()
        .single();

      if (error) {
        console.error('[webhook:calendly] Failed to create prospect:', error.message);
        return;
      }
      prospect = newProspect;
    }

    console.log(`[webhook:calendly] Prospect: ${prospect.id} | Client: ${client.id}`);

    // Update agent with fresh prospect memory
    try {
      await updateAgentForProspect(client.id, prospect.id);
      console.log('[webhook:calendly] Agent updated with prospect memory.');
    } catch (err) {
      console.warn('[webhook:calendly] Agent update failed (non-fatal):', err.message);
    }

    // Route by video_mode
    const videoMode = client.video_mode || 'voice_only';
    console.log(`[webhook:calendly] Video mode: ${videoMode}`);

    if (videoMode === 'video_recall_v2') {
      // Hyper-real: LiveKit + Raven + Phoenix-4 or Anam
      try {
        const renderMode = client.render_mode || 'phoenix_4';
        const result = await orchestrator.startVideoSession(client.id, prospect.id, meetUrl, renderMode);
        console.log(`[webhook:calendly] Hyper-real session started: ${result.sessionId}`);
        console.log(`[webhook:calendly] Render mode: ${renderMode}`);
      } catch (err) {
        console.error('[webhook:calendly] Hyper-real session failed:', err.message);
      }
    } else if (videoMode === 'video_avatar') {
      // Create Tavus conversation → prospect gets video call link
      try {
        const result = await createTavusConversation(client.id, prospect.id);
        console.log(`[webhook:calendly] Tavus conversation created: ${result.conversation_id}`);
        console.log(`[webhook:calendly] Video URL: ${result.conversation_url}`);
        // TODO Sprint 7: Send conversation_url via SMS/email to prospect
      } catch (err) {
        console.error('[webhook:calendly] Tavus conversation failed:', err.message);
      }
    } else if (videoMode === 'video_recall') {
      // Create Tavus conversation + deploy Recall bot with camera feed
      try {
        const tavusResult = await createTavusConversation(client.id, prospect.id);
        console.log(`[webhook:calendly] Tavus conversation created: ${tavusResult.conversation_id}`);

        if (meetUrl && meetUrl.includes('meet.google.com')) {
          // Deploy Recall bot with camera set to conversation_url
          const recallResult = await deployRecallBot(meetUrl, prospect.id, client.id);
          console.log(`[webhook:calendly] Recall bot deployed with video: ${recallResult.bot?.id || 'ok'}`);

          // Update call record with both IDs
          if (tavusResult.call) {
            await supabase.from('calls').update({
              recall_bot_id: recallResult.bot?.id || null,
              video_mode: 'video_recall',
            }).eq('id', tavusResult.call.id);
          }
        }
      } catch (err) {
        console.error('[webhook:calendly] Video+Recall deployment failed:', err.message);
      }
    } else {
      // voice_only — existing Recall audio-only flow
      if (meetUrl && meetUrl.includes('meet.google.com')) {
        try {
          const result = await deployRecallBot(meetUrl, prospect.id, client.id);
          console.log(`[webhook:calendly] Recall bot deployed: ${result.bot?.id || 'ok'}`);
        } catch (err) {
          console.error('[webhook:calendly] Recall bot deployment failed:', err.message);
        }
      } else {
        console.log('[webhook:calendly] No Google Meet URL — skipping bot deployment.');
      }
    }
  } catch (err) {
    console.error('[webhook:calendly] Error:', err.message);
  }
});

module.exports = router;
