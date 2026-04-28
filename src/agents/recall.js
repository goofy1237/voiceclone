const axios = require('axios');
const env = require('../../config/env');
const { RECALL_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');

const recallHeaders = {
  'Authorization': `Token ${env.RECALL_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Deploy a Recall.ai bot to a Google Meet.
 * Creates a call record in Supabase, returns bot + call objects.
 */
async function deployRecallBot(meetUrl, prospectId, clientId) {
  console.log(`[recall] Deploying bot to meeting: ${meetUrl}`);

  const { data: client } = await supabase
    .from('clients')
    .select('agent_name, base_url')
    .eq('id', clientId)
    .single();

  const botName = client?.agent_name || 'Meeting Assistant';
  const baseUrl = client?.base_url || env.BASE_URL;

  const payload = {
    meeting_url: meetUrl,
    bot_name: botName,
    transcription_options: {
      provider: 'deepgram',
    },
    real_time_transcription: {
      destination_url: `${baseUrl}/webhooks/recall/transcript`,
      partial_results: true,
    },
    recording_mode: 'audio_only',
    webhook_url: `${baseUrl}/webhooks/recall`,
  };

  try {
    const response = await axios.post(`${RECALL_API_BASE}/bot`, payload, {
      headers: recallHeaders,
    });

    const botId = response.data.id;
    const joinUrl = response.data.meeting_url || response.data.video_url || meetUrl;
    console.log(`[recall] Bot deployed: ${botId}`);

    // Create call record
    const { data: callRecord, error } = await supabase
      .from('calls')
      .insert({
        prospect_id: prospectId,
        client_id: clientId,
        recall_bot_id: botId,
        call_type: 'google_meet',
        status: 'bot_deployed',
      })
      .select()
      .single();

    if (error) {
      console.error('[recall] Failed to create call record:', error.message);
    } else {
      console.log(`[recall] Call record created: ${callRecord.id}`);
    }

    return { bot: response.data, call: callRecord, joinUrl };
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[recall] Failed to deploy bot:', JSON.stringify(errMsg));
    throw new Error(`Recall bot deployment failed: ${JSON.stringify(errMsg)}`);
  }
}

module.exports = { deployRecallBot };
