/**
 * Tavus Phoenix-4 Renderer — full photorealistic upper body + face.
 * No compositing needed — Phoenix-4 outputs a complete video stream.
 */
const axios = require('axios');
const env = require('../../config/env');
const { TAVUS_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');

const tavusHeaders = {
  'x-api-key': env.TAVUS_API_KEY,
  'Content-Type': 'application/json',
};

/**
 * Create a Phoenix-4 session (Tavus conversation in full pipeline mode).
 * Returns conversation_url which is the full video stream.
 */
async function createPhoenixSession(clientId, prospectId) {
  console.log(`[phoenix] Creating session: client=${clientId} prospect=${prospectId}`);

  const { data: client } = await supabase
    .from('clients')
    .select('agent_name, tavus_replica_id, tavus_persona_id, soul_document, base_url')
    .eq('id', clientId)
    .single();

  if (!client) throw new Error('Client not found');
  if (!client.tavus_replica_id) throw new Error('No Tavus replica — upload a training video first');
  if (!client.tavus_persona_id) throw new Error('No Tavus persona — create one first');

  let prospectName = 'New Prospect';
  if (prospectId) {
    const { data: p } = await supabase.from('prospects').select('name').eq('id', prospectId).single();
    if (p) prospectName = p.name;
  }

  const systemPrompt = await buildSystemPrompt(clientId, prospectId);

  // Natural greeting
  let greeting = `Hey ${prospectName.split(' ')[0]}, good to see you!`;

  const baseUrl = client.base_url || env.BASE_URL;

  const payload = {
    replica_id: client.tavus_replica_id,
    persona_id: client.tavus_persona_id,
    conversation_name: `${client.agent_name} x ${prospectName}`,
    conversational_context: systemPrompt,
    custom_greeting: greeting,
    callback_url: `${baseUrl}/webhooks/tavus`,
    properties: {
      max_call_duration: 3600,
      participant_left_timeout: 30,
      enable_recording: true,
      apply_greenscreen: false,
      language: 'english',
    },
  };

  const response = await axios.post(`${TAVUS_API_BASE}/conversations`, payload, {
    headers: tavusHeaders,
  });

  const conversationId = response.data.conversation_id;
  const conversationUrl = response.data.conversation_url;

  console.log(`[phoenix] Session created: ${conversationId}`);
  console.log(`[phoenix] Stream URL: ${conversationUrl}`);

  return { conversation_id: conversationId, conversation_url: conversationUrl, data: response.data };
}

/**
 * Get the stream URL for a Phoenix session.
 */
async function getPhoenixStreamUrl(conversationId) {
  const response = await axios.get(`${TAVUS_API_BASE}/conversations/${conversationId}`, {
    headers: tavusHeaders,
  });
  return response.data.conversation_url;
}

/**
 * Inject perception context mid-conversation.
 * Tavus supports additional_context updates.
 */
async function injectPerceptionContext(conversationId, perceptionSignal) {
  console.log(`[phoenix] Injecting perception signal to ${conversationId}`);
  try {
    await axios.patch(`${TAVUS_API_BASE}/conversations/${conversationId}`, {
      additional_context: perceptionSignal,
    }, {
      headers: tavusHeaders,
    });
  } catch (err) {
    console.warn(`[phoenix] Context injection failed (non-fatal): ${err.response?.data?.message || err.message}`);
  }
}

/**
 * End a Phoenix session.
 */
async function endPhoenixSession(conversationId) {
  console.log(`[phoenix] Ending session: ${conversationId}`);
  try {
    await axios.post(`${TAVUS_API_BASE}/conversations/${conversationId}/end`, {}, {
      headers: tavusHeaders,
    });
  } catch (err) {
    console.warn(`[phoenix] End session error (non-fatal): ${err.message}`);
  }
}

module.exports = { createPhoenixSession, getPhoenixStreamUrl, injectPerceptionContext, endPhoenixSession };
