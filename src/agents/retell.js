const axios = require('axios');
const env = require('../../config/env');
const { RETELL_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');

const retellHeaders = {
  'Authorization': `Bearer ${env.RETELL_API_KEY}`,
  'Content-Type': 'application/json',
};

async function registerVoiceWithRetell({
  providerVoiceId,
  voiceName,
  publicUserId,
  voiceProvider = 'fish_audio',
}) {
  if (!providerVoiceId) throw new Error('providerVoiceId is required');
  if (!voiceName) throw new Error('voiceName is required');

  const body = {
    provider_voice_id: providerVoiceId,
    voice_name: voiceName,
    voice_provider: voiceProvider,
  };
  if (publicUserId) {
    body.public_user_id = publicUserId;
  }

  try {
    const { data } = await axios.post(
      'https://api.retellai.com/add-community-voice',
      body,
      {
        headers: {
          Authorization: `Bearer ${env.RETELL_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!data?.voice_id) {
      throw new Error(`Retell add-community-voice returned no voice_id. Full response: ${JSON.stringify(data)}`);
    }

    console.log(`[retell] Voice registered: ${providerVoiceId} → ${data.voice_id} (${voiceProvider})`);
    return {
      voice_id: data.voice_id,
      voice_name: data.voice_name,
      preview_audio_url: data.preview_audio_url,
    };
  } catch (err) {
    const status = err.response?.status;
    const errBody = err.response?.data;
    console.error('[retell] add-community-voice failed.', {
      status,
      requestBody: body,
      responseBody: errBody,
      message: err.message,
    });
    const errMsg = typeof errBody === 'string'
      ? errBody
      : (Buffer.isBuffer(errBody) ? errBody.toString('utf8') : JSON.stringify(errBody || err.message));
    const e = new Error(`Retell voice registration failed (status ${status || 'n/a'}): ${errMsg}`);
    e.retellResponse = errBody;
    e.retellStatus = status;
    throw e;
  }
}

/**
 * Create a Retell LLM + Agent for a client.
 * Retell requires: 1) create LLM with prompt/tools, 2) create agent referencing LLM.
 */
async function createRetellAgent(clientId) {
  console.log(`[retell] Creating Retell agent for client ${clientId}...`);

  const { data: client, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error || !client) throw new Error(`Client not found: ${clientId}`);

  // Duplicate guard: if client already has a Retell agent, verify it exists before creating a new one
  if (client.retell_agent_id) {
    try {
      const existing = await axios.get(`${RETELL_API_BASE}/get-agent/${client.retell_agent_id}`, {
        headers: retellHeaders,
      });
      console.log(`[retell] Agent already exists: ${client.retell_agent_id} — skipping creation`);
      return { agent_id: client.retell_agent_id, ...existing.data };
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`[retell] Existing agent ${client.retell_agent_id} not found on Retell — creating new one`);
      } else {
        console.warn(`[retell] Could not verify existing agent: ${err.message} — creating new one`);
      }
    }
  }

  const systemPrompt = await buildSystemPrompt(clientId, null);

  // Build tools
  const generalTools = [
    {
      type: 'end_call',
      name: 'end_call',
      description: 'End the call when the conversation reaches a natural conclusion.',
    },
  ];

  // Step 1: Create Retell LLM
  const llmPayload = {
    model: 'claude-4.6-sonnet',
    general_prompt: systemPrompt,
    general_tools: generalTools,
    start_speaker: 'agent',
  };

  let llmId;
  try {
    const llmRes = await axios.post(`${RETELL_API_BASE}/create-retell-llm`, llmPayload, {
      headers: retellHeaders,
    });
    llmId = llmRes.data.llm_id;
    console.log(`[retell] LLM created: ${llmId}`);
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[retell] LLM creation failed:', JSON.stringify(errMsg));
    throw new Error(`Retell LLM creation failed: ${JSON.stringify(errMsg)}`);
  }

  // Step 2: Create Agent referencing the LLM
  // elevenlabs_voice_id column stores the Retell-registered voice ID
  // (NOT the raw ElevenLabs ID — registration happens at clone time)
  const voiceId = client.elevenlabs_voice_id || '11labs-Willa';
  const language = 'en-AU';
  const agentPayload = {
    agent_name: client.agent_name,
    response_engine: {
      type: 'retell-llm',
      llm_id: llmId,
    },
    voice_id: voiceId,
    language,
    voice_speed: 1.0,
    voice_temperature: 1.0,
    responsiveness: 1.0,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    backchannel_frequency: 0.8,
    backchannel_words: ['yeah', 'right', 'totally', 'mm', 'uh huh', 'for sure', 'exactly'],
  };

  // voice_model only applies to ElevenLabs voices
  if (voiceId.startsWith('11labs-')) {
    agentPayload.voice_model = 'eleven_v3';
  }

  try {
    const agentRes = await axios.post(`${RETELL_API_BASE}/create-agent`, agentPayload, {
      headers: retellHeaders,
    });

    const agentId = agentRes.data.agent_id;
    console.log(`[retell] Agent created: ${agentId}`);

    // Save both IDs
    await supabase
      .from('clients')
      .update({
        retell_agent_id: agentId,
        retell_llm_id: llmId,
      })
      .eq('id', clientId);

    return { agent_id: agentId, llm_id: llmId, ...agentRes.data };
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[retell] Agent creation failed:', JSON.stringify(errMsg));
    throw new Error(`Retell agent creation failed: ${JSON.stringify(errMsg)}`);
  }
}

/**
 * Update the Retell LLM prompt with fresh prospect memory.
 * Called before every call so memory is always current.
 *
 * Uses the retell_llm_id stored on the client at creation time — does not
 * call /get-agent (which is unreliable due to a known Retell-side versioning bug).
 */
async function updateAgentForProspect(clientId, prospectId) {
  console.log(`[retell] Updating agent for prospect ${prospectId}...`);

  const { data: client } = await supabase
    .from('clients')
    .select('retell_agent_id, retell_llm_id')
    .eq('id', clientId)
    .single();

  if (!client?.retell_agent_id) {
    throw new Error('No Retell agent ID found for client');
  }

  if (!client.retell_llm_id) {
    console.warn(`[retell] No retell_llm_id stored for client ${clientId} — skipping memory update for this call. The next agent (re)creation will populate it.`);
    return { llm_id: null, prompt_length: 0, skipped: true };
  }

  const llmId = client.retell_llm_id;
  const systemPrompt = await buildSystemPrompt(clientId, prospectId);

  try {
    await axios.patch(`${RETELL_API_BASE}/update-retell-llm/${llmId}`, {
      general_prompt: systemPrompt,
    }, {
      headers: retellHeaders,
    });

    console.log(`[retell] LLM ${llmId} updated with prospect memory.`);
    return { llm_id: llmId, prompt_length: systemPrompt.length };
  } catch (err) {
    console.error('[retell] Failed to update LLM:', err.response?.data || err.message);
    throw new Error('Failed to update Retell LLM prompt');
  }
}

/**
 * Verify the Retell agent for a client still exists; recreate if Retell has purged it.
 * Returns the (possibly new) agent_id.
 */
async function ensureRetellAgentExists(clientId) {
  const { data: client, error } = await supabase
    .from('clients')
    .select('retell_agent_id')
    .eq('id', clientId)
    .single();

  if (error) throw new Error(`Client not found: ${clientId}`);

  if (!client?.retell_agent_id) {
    console.log(`[retell] No agent on file for client ${clientId} — creating one`);
    const created = await createRetellAgent(clientId);
    return created.agent_id;
  }

  try {
    await axios.get(`${RETELL_API_BASE}/get-agent/${client.retell_agent_id}`, {
      headers: retellHeaders,
    });
    return client.retell_agent_id;
  } catch (err) {
    const status = err.response?.status;
    const body = JSON.stringify(err.response?.data || '');
    const notFound = status === 404 || /not.?found/i.test(body);
    if (!notFound) {
      console.warn(`[retell] Could not verify agent ${client.retell_agent_id} (status ${status}): ${body || err.message} — proceeding with stored ID`);
      return client.retell_agent_id;
    }

    console.warn(`[retell] Agent ${client.retell_agent_id} no longer exists on Retell — recreating`);
    // Clear the stale ID so createRetellAgent's duplicate guard doesn't try to verify it again
    await supabase
      .from('clients')
      .update({ retell_agent_id: null, retell_llm_id: null })
      .eq('id', clientId);
    const created = await createRetellAgent(clientId);
    return created.agent_id;
  }
}

/**
 * Initiate an outbound phone call via Retell.
 * Updates agent prompt with fresh memory, then places the call.
 */
async function initiateOutboundCall(prospectId, clientId, phoneNumber) {
  console.log(`[retell] Initiating outbound call to ${phoneNumber} for prospect ${prospectId}...`);

  const { data: prospect, error: pErr } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', prospectId)
    .single();

  if (pErr || !prospect) throw new Error(`Prospect not found: ${prospectId}`);

  const { data: client, error: cErr } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (cErr || !client) throw new Error(`Client not found: ${clientId}`);

  // Make sure the Retell agent still exists; recreate transparently if Retell purged it.
  const agentId = await ensureRetellAgentExists(clientId);

  const fromNumber = client.retell_phone_number
    || env.RETELL_PHONE_NUMBER
    || process.env.RETELL_PHONE_NUMBER;
  if (!fromNumber) {
    throw new Error('No phone number configured for this client. Set RETELL_PHONE_NUMBER env var or provision a per-client number.');
  }

  // Update agent with fresh prospect memory
  await updateAgentForProspect(clientId, prospectId);

  // Place the call via Retell v2
  let retellCall;
  try {
    const callRes = await axios.post(`${RETELL_API_BASE}/v2/create-phone-call`, {
      from_number: fromNumber,
      to_number: phoneNumber,
      agent_id: agentId,
      metadata: {
        prospect_id: prospectId,
        client_id: clientId,
      },
    }, {
      headers: retellHeaders,
    });
    retellCall = callRes.data;
    console.log(`[retell] Call initiated: ${retellCall.call_id}`);
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[retell] Outbound call failed:', JSON.stringify(errMsg));
    throw new Error(`Retell outbound call failed: ${JSON.stringify(errMsg)}`);
  }

  // Create call record in Supabase
  const { data: callRecord, error: callErr } = await supabase
    .from('calls')
    .insert({
      prospect_id: prospectId,
      client_id: clientId,
      retell_call_id: retellCall.call_id,
      call_type: 'phone',
      status: 'active',
    })
    .select()
    .single();

  if (callErr) {
    console.error('[retell] Failed to save call record:', callErr.message);
  }

  return {
    call_id: callRecord?.id || null,
    retell_call_id: retellCall.call_id,
    status: 'initiated',
    call: callRecord,
  };
}

/**
 * Get call status from Retell API.
 */
async function getRetellCallStatus(retellCallId) {
  try {
    const res = await axios.get(`${RETELL_API_BASE}/v2/get-call/${retellCallId}`, {
      headers: retellHeaders,
    });
    return res.data;
  } catch (err) {
    console.error('[retell] Failed to get call status:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Update the Retell LLM with a fresh BASE prompt — used when the soul changes.
 * Unlike updateAgentForProspect (which injects per-prospect memory before each
 * call), this writes the global prompt that future calls start from.
 */
async function updateAgentBasePrompt(clientId) {
  console.log(`[retell] Updating base prompt for client ${clientId}...`);

  const { data: client, error } = await supabase
    .from('clients')
    .select('retell_llm_id')
    .eq('id', clientId)
    .single();

  if (error || !client) throw new Error(`Client not found: ${clientId}`);

  if (!client.retell_llm_id) {
    console.warn(`[retell] No retell_llm_id for client ${clientId} — base prompt not pushed. Agent will be (re)created later with the new soul.`);
    return { llm_id: null, prompt_length: 0, skipped: true };
  }

  const llmId = client.retell_llm_id;
  const systemPrompt = await buildSystemPrompt(clientId, null);

  // Persist the new base prompt locally too
  await supabase
    .from('clients')
    .update({ system_prompt: systemPrompt })
    .eq('id', clientId);

  try {
    await axios.patch(`${RETELL_API_BASE}/update-retell-llm/${llmId}`, {
      general_prompt: systemPrompt,
    }, {
      headers: retellHeaders,
    });

    console.log(`[retell] Base prompt pushed to LLM ${llmId} (${systemPrompt.length} chars).`);
    return { llm_id: llmId, prompt_length: systemPrompt.length };
  } catch (err) {
    console.error('[retell] Failed to update base prompt:', err.response?.data || err.message);
    throw new Error('Failed to update Retell LLM base prompt');
  }
}

module.exports = { createRetellAgent, ensureRetellAgentExists, updateAgentForProspect, updateAgentBasePrompt, initiateOutboundCall, getRetellCallStatus, registerVoiceWithRetell };
