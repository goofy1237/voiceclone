const axios = require('axios');
const env = require('../../config/env');
const { RETELL_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');

const retellHeaders = {
  'Authorization': `Bearer ${env.RETELL_API_KEY}`,
  'Content-Type': 'application/json',
};

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
  const agentPayload = {
    agent_name: client.agent_name,
    response_engine: {
      type: 'retell-llm',
      llm_id: llmId,
    },
    voice_id: '11labs-Willa',
    voice_model: 'eleven_v3',
    language: 'en-US',
    voice_speed: 1.0,
    voice_temperature: 1.0,
    responsiveness: 1.0,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    backchannel_frequency: 0.8,
    backchannel_words: ['yeah', 'right', 'totally', 'mm', 'uh huh', 'for sure', 'exactly'],
  };

  try {
    const agentRes = await axios.post(`${RETELL_API_BASE}/create-agent`, agentPayload, {
      headers: retellHeaders,
    });

    const agentId = agentRes.data.agent_id;
    console.log(`[retell] Agent created: ${agentId}`);

    // Save both IDs
    await supabase
      .from('clients')
      .update({ retell_agent_id: agentId })
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
 */
async function updateAgentForProspect(clientId, prospectId) {
  console.log(`[retell] Updating agent for prospect ${prospectId}...`);

  const { data: client } = await supabase
    .from('clients')
    .select('retell_agent_id')
    .eq('id', clientId)
    .single();

  if (!client?.retell_agent_id) {
    throw new Error('No Retell agent ID found for client');
  }

  // Get the LLM ID from the agent
  let llmId;
  try {
    const agentRes = await axios.get(`${RETELL_API_BASE}/get-agent/${client.retell_agent_id}`, {
      headers: retellHeaders,
    });
    llmId = agentRes.data.response_engine?.llm_id;
  } catch (err) {
    console.error('[retell] Failed to fetch agent:', err.response?.data || err.message);
    throw new Error('Failed to fetch Retell agent');
  }

  if (!llmId) {
    throw new Error('No LLM ID found on Retell agent');
  }

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
  if (!client.retell_agent_id) throw new Error('No Retell agent configured for this client');

  const retellPhone = env.RETELL_PHONE_NUMBER || process.env.RETELL_PHONE_NUMBER;
  if (!retellPhone) {
    throw new Error('RETELL_PHONE_NUMBER not configured. Go to app.retellai.com → Phone Numbers → Buy a number → then set RETELL_PHONE_NUMBER in your environment variables.');
  }

  // Update agent with fresh prospect memory
  await updateAgentForProspect(clientId, prospectId);

  // Place the call via Retell v2
  let retellCall;
  try {
    const callRes = await axios.post(`${RETELL_API_BASE}/v2/create-phone-call`, {
      from_number: retellPhone,
      to_number: phoneNumber,
      agent_id: client.retell_agent_id,
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

module.exports = { createRetellAgent, updateAgentForProspect, initiateOutboundCall, getRetellCallStatus };
