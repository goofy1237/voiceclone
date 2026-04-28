const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const env = require('../../config/env');
const { TAVUS_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');

const tavusHeaders = {
  'x-api-key': env.TAVUS_API_KEY,
  'Content-Type': 'application/json',
};

/**
 * Create a Tavus replica from a training video file.
 * Uploads video → polls until ready → saves replica_id to client.
 */
async function createTavusReplica(clientId, videoFilePath) {
  console.log(`[tavus] Creating replica for client ${clientId}...`);

  const { data: client } = await supabase
    .from('clients')
    .select('agent_name')
    .eq('id', clientId)
    .single();

  const replicaName = client?.agent_name || 'AI Agent';

  // Multipart form upload
  const form = new FormData();
  form.append('train_video', fs.createReadStream(videoFilePath));
  form.append('replica_name', replicaName);

  const response = await axios.post(`${TAVUS_API_BASE}/replicas`, form, {
    headers: {
      'x-api-key': env.TAVUS_API_KEY,
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const replicaId = response.data.replica_id;
  console.log(`[tavus] Replica created: ${replicaId} — polling for readiness...`);

  // Poll until ready (max 30 attempts, 10s apart = 5 min)
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const status = await axios.get(`${TAVUS_API_BASE}/replicas/${replicaId}`, {
        headers: tavusHeaders,
      });
      console.log(`[tavus] Replica ${replicaId} status: ${status.data.status}`);
      if (status.data.status === 'ready') {
        ready = true;
        break;
      }
    } catch (err) {
      console.warn(`[tavus] Replica poll error: ${err.message}`);
    }
  }

  // Save to client regardless of poll result (replica may still be processing)
  await supabase.from('clients').update({
    tavus_replica_id: replicaId,
  }).eq('id', clientId);

  console.log(`[tavus] Replica ${replicaId} saved to client. Ready: ${ready}`);
  return { replica_id: replicaId, ready, data: response.data };
}

/**
 * Create a Tavus persona for a client.
 * Configures LLM (Claude), TTS (ElevenLabs), and vision.
 */
async function createTavusPersona(clientId) {
  console.log(`[tavus] Creating persona for client ${clientId}...`);

  const { data: client } = await supabase
    .from('clients')
    .select('agent_name, elevenlabs_voice_id')
    .eq('id', clientId)
    .single();

  if (!client) throw new Error('Client not found');

  const systemPrompt = await buildSystemPrompt(clientId, null);

  const payload = {
    persona_name: client.agent_name || 'AI Agent',
    system_prompt: systemPrompt,
    context: systemPrompt,
    default_replica_id: null, // Will use replica from conversation
    layers: {
      llm: {
        model: 'claude-sonnet-4-20250514',
      },
      tts: {
        tts_engine: 'cartesia',
        voice_id: client.elevenlabs_voice_id || undefined,
      },
    },
  };

  const response = await axios.post(`${TAVUS_API_BASE}/personas`, payload, {
    headers: tavusHeaders,
  });

  const personaId = response.data.persona_id;
  console.log(`[tavus] Persona created: ${personaId}`);

  await supabase.from('clients').update({
    tavus_persona_id: personaId,
    tavus_enabled: true,
  }).eq('id', clientId);

  return { persona_id: personaId, data: response.data };
}

/**
 * Create a Tavus conversation for a prospect.
 * Returns conversation_id and conversation_url.
 */
async function createTavusConversation(clientId, prospectId) {
  console.log(`[tavus] Creating conversation: client=${clientId} prospect=${prospectId}`);

  const { data: client } = await supabase
    .from('clients')
    .select('agent_name, tavus_replica_id, tavus_persona_id, soul_document, video_mode, base_url')
    .eq('id', clientId)
    .single();

  if (!client) throw new Error('Client not found');
  if (!client.tavus_replica_id) throw new Error('No Tavus replica configured — upload a training video first');
  if (!client.tavus_persona_id) throw new Error('No Tavus persona configured — create a persona first');

  let prospect = null;
  if (prospectId) {
    const { data } = await supabase
      .from('prospects')
      .select('name, email, funnel_stage, pain_points, personal_notes')
      .eq('id', prospectId)
      .single();
    prospect = data;
  }

  const systemPrompt = await buildSystemPrompt(clientId, prospectId);

  // Generate natural greeting from soul doc + prospect memory
  let greeting = `Hey${prospect?.name ? ' ' + prospect.name.split(' ')[0] : ''}, good to see you!`;
  if (prospect?.personal_notes?.length > 0) {
    // Reference something personal for continuity
    greeting = `Hey ${prospect.name?.split(' ')[0] || 'there'}! Good to connect again.`;
  }

  const baseUrl = client.base_url || env.BASE_URL;

  const payload = {
    replica_id: client.tavus_replica_id,
    persona_id: client.tavus_persona_id,
    conversation_name: `${client.agent_name} x ${prospect?.name || 'New Prospect'}`,
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
  console.log(`[tavus] Conversation created: ${conversationId}`);
  console.log(`[tavus] URL: ${conversationUrl}`);

  // Create call record
  const { data: callRecord, error } = await supabase
    .from('calls')
    .insert({
      prospect_id: prospectId,
      client_id: clientId,
      conversation_id: conversationId,
      conversation_url: conversationUrl,
      call_type: 'video_avatar',
      video_mode: client.video_mode || 'video_avatar',
      status: 'conversation_created',
    })
    .select()
    .single();

  if (error) {
    console.error('[tavus] Failed to create call record:', error.message);
  }

  return {
    conversation_id: conversationId,
    conversation_url: conversationUrl,
    call: callRecord,
    data: response.data,
  };
}

/**
 * End a Tavus conversation.
 */
async function endTavusConversation(conversationId) {
  console.log(`[tavus] Ending conversation: ${conversationId}`);

  await axios.post(`${TAVUS_API_BASE}/conversations/${conversationId}/end`, {}, {
    headers: tavusHeaders,
  });

  // Update call record
  await supabase.from('calls').update({
    status: 'ended',
  }).eq('conversation_id', conversationId);

  return { conversationId, status: 'ended' };
}

/**
 * Get conversation status from Tavus.
 */
async function getTavusConversationStatus(conversationId) {
  const response = await axios.get(`${TAVUS_API_BASE}/conversations/${conversationId}`, {
    headers: tavusHeaders,
  });

  return response.data;
}

module.exports = {
  createTavusReplica,
  createTavusPersona,
  createTavusConversation,
  endTavusConversation,
  getTavusConversationStatus,
};
