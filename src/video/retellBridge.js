/**
 * Retell Audio Bridge — handles STT + LLM + TTS for video sessions.
 * Creates a Retell web call, pipes TTS audio to renderer for lip sync.
 */
const axios = require('axios');
const env = require('../../config/env');
const { RETELL_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');
const { getPerceptionContext } = require('./raven');

/**
 * Init a Retell audio bridge for a video session.
 * Creates a web call and returns the call ID.
 */
async function initRetellBridge(sessionId, clientId, prospectId) {
  console.log(`[retell-bridge] Initialising for session: ${sessionId}`);

  const { data: client } = await supabase
    .from('clients')
    .select('retell_agent_id')
    .eq('id', clientId)
    .single();

  if (!client?.retell_agent_id) {
    throw new Error('No Retell agent configured for this client');
  }

  // Build prompt with perception context
  let fullPrompt = await buildSystemPrompt(clientId, prospectId);
  const perceptionContext = await getPerceptionContext(sessionId);
  if (perceptionContext) {
    fullPrompt += '\n\nLIVE SESSION SIGNALS:\n' + perceptionContext;
  }

  // Create web call via Retell
  const response = await axios.post(`${RETELL_API_BASE}/v2/create-web-call`, {
    agent_id: client.retell_agent_id,
    metadata: { sessionId, prospectId },
  }, {
    headers: {
      'Authorization': `Bearer ${env.RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const retellCallId = response.data.call_id;
  const webCallUrl = response.data.web_call_url || response.data.call_url;

  console.log(`[retell-bridge] Web call created: ${retellCallId}`);

  return { retellCallId, webCallUrl, data: response.data };
}

module.exports = { initRetellBridge };
