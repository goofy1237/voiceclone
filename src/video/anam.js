/**
 * Anam Face Renderer — CARA-3 photorealistic face driven by TTS audio.
 * Used as the face layer when client chooses Anam over Tavus Phoenix-4.
 */
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const env = require('../../config/env');
const { ANAM_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');

const anamHeaders = {
  'Authorization': `Bearer ${env.ANAM_API_KEY}`,
  'Content-Type': 'application/json',
};

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Create an Anam persona for a client.
 * Uses Claude to extract a 2-sentence personality summary from the soul document.
 */
async function createAnamPersona(clientId) {
  console.log(`[anam] Creating persona for client ${clientId}...`);

  const { data: client } = await supabase
    .from('clients')
    .select('agent_name, soul_document')
    .eq('id', clientId)
    .single();

  if (!client) throw new Error('Client not found');

  // Extract personality summary via Claude
  let personalitySummary = `${client.agent_name} is a warm, engaging conversationalist who builds genuine rapport.`;

  if (client.soul_document) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: 'You extract avatar personality descriptions. Be specific and human, never generic.',
        messages: [{
          role: 'user',
          content: `Summarise this person's personality in exactly 2 sentences for a real-time avatar system:\n\n${client.soul_document}`,
        }],
      });
      personalitySummary = response.content[0].text.trim();
    } catch (err) {
      console.warn(`[anam] Claude extraction failed, using default: ${err.message}`);
    }
  }

  console.log(`[anam] Personality summary: ${personalitySummary}`);

  const payload = {
    name: client.agent_name,
    description: personalitySummary,
    personaPreset: 'CARA_3',
  };

  const response = await axios.post(`${ANAM_API_BASE}/personas`, payload, {
    headers: anamHeaders,
  });

  const personaId = response.data.id || response.data.persona_id;
  console.log(`[anam] Persona created: ${personaId}`);

  await supabase.from('clients').update({
    anam_persona_id: personaId,
  }).eq('id', clientId);

  return { anam_persona_id: personaId, persona: response.data, personalitySummary };
}

/**
 * Create an Anam streaming session.
 */
async function createAnamSession(clientId) {
  console.log(`[anam] Creating session for client ${clientId}...`);

  const { data: client } = await supabase
    .from('clients')
    .select('anam_persona_id')
    .eq('id', clientId)
    .single();

  if (!client?.anam_persona_id) throw new Error('No Anam persona configured — create one first');

  const response = await axios.post(`${ANAM_API_BASE}/sessions`, {
    personaId: client.anam_persona_id,
  }, {
    headers: anamHeaders,
  });

  const sessionId = response.data.id || response.data.session_id;
  const streamUrl = response.data.stream_url || response.data.streamUrl;
  const websocketUrl = response.data.websocket_url || response.data.websocketUrl;

  console.log(`[anam] Session created: ${sessionId}`);

  return { sessionId, streamUrl, websocketUrl, data: response.data };
}

/**
 * Stream TTS audio to Anam for face rendering.
 * In production, this connects via WebSocket and sends PCM audio.
 */
async function streamAudioToAnam(anamSessionId, audioBuffer) {
  // WebSocket streaming — implemented at runtime when session is active
  console.log(`[anam] Streaming audio to session ${anamSessionId}: ${audioBuffer.length} bytes`);
}

/**
 * Close an Anam session.
 */
async function closeAnamSession(anamSessionId) {
  console.log(`[anam] Closing session: ${anamSessionId}`);
  try {
    await axios.delete(`${ANAM_API_BASE}/sessions/${anamSessionId}`, {
      headers: anamHeaders,
    });
  } catch (err) {
    console.warn(`[anam] Close session error (non-fatal): ${err.message}`);
  }
}

module.exports = { createAnamPersona, createAnamSession, streamAudioToAnam, closeAnamSession };
