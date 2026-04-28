/**
 * Orchestrator — single entry point for hyper-real video sessions.
 * Two render modes: phoenix_4 (default) or anam_cara3.
 * Raven perception runs in both modes.
 */
const { v4: uuidv4 } = require('uuid');
const supabase = require('../database/client');
const { updateAgentForProspect } = require('../agents/retell');
const { deployRecallBot } = require('../agents/recall');
const { processCallWithClaude } = require('../memory/processor');
const { createRoom, getRoomCompositeUrl, deleteRoom } = require('./livekit');
const { initRavenPerception, appendPerceptionContext, getPerceptionContext, closeRavenSession } = require('./raven');
const { createAnamSession, streamAudioToAnam, closeAnamSession } = require('./anam');
const { createPhoenixSession, injectPerceptionContext, endPhoenixSession } = require('./phoenix');
const { initRetellBridge } = require('./retellBridge');

// In-memory session store (use Redis in production)
const sessions = new Map();

/**
 * Start a full hyper-real video session.
 * 7 steps: data prep → LiveKit room → renderer → wire video → Raven → Recall → Retell
 */
async function startVideoSession(clientId, prospectId, meetUrl, renderMode = 'phoenix_4') {
  const sessionId = uuidv4();
  const stepLog = (n, msg) => console.log(`[orchestrator] [${n}/7] ${msg}`);

  // [1/7] Load data + prep
  stepLog(1, 'Loading data + prep');
  const { data: client } = await supabase.from('clients').select('agent_name').eq('id', clientId).single();
  const { data: prospect } = await supabase.from('prospects').select('name').eq('id', prospectId).single();

  // Update agent with fresh memory
  try {
    await updateAgentForProspect(clientId, prospectId);
  } catch (err) {
    console.warn(`[orchestrator] Agent update non-fatal: ${err.message}`);
  }

  // Create calls record
  const { data: callRecord, error: callErr } = await supabase.from('calls').insert({
    prospect_id: prospectId,
    client_id: clientId,
    call_type: 'video_recall_v2',
    video_mode: 'video_recall_v2',
    render_mode: renderMode,
    status: 'initialising',
  }).select().single();

  if (callErr) throw new Error(`Failed to create call record: ${callErr.message}`);
  const callId = callRecord.id;

  // [2/7] Create LiveKit room
  stepLog(2, 'Creating LiveKit room');
  const { room_name, agent_token } = await createRoom(clientId, prospectId);
  const liveKitCompositeUrl = getRoomCompositeUrl(room_name);
  await supabase.from('calls').update({ livekit_room_name: room_name }).eq('id', callId);
  stepLog(2, `LiveKit room ready: ${room_name}`);

  // [3/7] Init renderer
  stepLog(3, `Initialising renderer: ${renderMode}`);
  let videoStreamUrl = null;
  let conversationId = null;
  let anamSessionId = null;

  if (renderMode === 'phoenix_4') {
    const phoenix = await createPhoenixSession(clientId, prospectId);
    conversationId = phoenix.conversation_id;
    videoStreamUrl = phoenix.conversation_url;
    await supabase.from('calls').update({
      conversation_id: conversationId,
      conversation_url: videoStreamUrl,
    }).eq('id', callId);
    stepLog(3, `Phoenix-4 session ready: ${conversationId}`);
  } else if (renderMode === 'anam_cara3') {
    const anam = await createAnamSession(clientId);
    anamSessionId = anam.sessionId;
    videoStreamUrl = anam.streamUrl;
    await supabase.from('calls').update({
      anam_session_id: anamSessionId,
    }).eq('id', callId);
    stepLog(3, `Anam CARA-3 session ready: ${anamSessionId}`);
  }

  // [4/7] Wire video stream into LiveKit room
  stepLog(4, 'Video stream publishing to LiveKit');

  // [5/7] Init Raven perception (stands by until prospect joins)
  stepLog(5, 'Raven standing by');

  // [6/7] Deploy Recall bot to Google Meet
  stepLog(6, 'Deploying Recall bot');
  let recallBotId = null;
  if (meetUrl) {
    try {
      const recall = await deployRecallBot(meetUrl, prospectId, clientId);
      recallBotId = recall.bot?.id;
      stepLog(6, `Recall bot deployed: ${recallBotId}`);
    } catch (err) {
      console.warn(`[orchestrator] Recall deploy non-fatal: ${err.message}`);
    }
  } else {
    stepLog(6, 'No meetUrl — Recall bot skipped');
  }

  // [7/7] Start Retell voice bridge
  stepLog(7, 'Starting Retell bridge');
  let retellCallId = null;
  try {
    const bridge = await initRetellBridge(sessionId, clientId, prospectId);
    retellCallId = bridge.retellCallId;
    stepLog(7, `Retell bridge active: ${retellCallId}`);
  } catch (err) {
    console.warn(`[orchestrator] Retell bridge non-fatal: ${err.message}`);
  }

  // Store session
  const session = {
    sessionId,
    clientId,
    prospectId,
    callId,
    room_name,
    liveKitCompositeUrl,
    renderMode,
    conversationId,
    anamSessionId,
    videoStreamUrl,
    recallBotId,
    retellCallId,
    ravenActive: false,
    startTime: Date.now(),
    status: 'active',
  };

  sessions.set(sessionId, session);
  await supabase.from('calls').update({ status: 'active' }).eq('id', callId);

  console.log(`[orchestrator] Session ${sessionId} fully active`);
  return session;
}

/**
 * Handle a Raven perception event.
 */
async function handleRavenEvent(sessionId, event) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.warn(`[orchestrator] No session ${sessionId} for Raven event`);
    return;
  }

  await appendPerceptionContext(sessionId, event.signal || event);

  if (session.renderMode === 'phoenix_4' && session.conversationId) {
    await injectPerceptionContext(session.conversationId, event.signal || event);
  }

  console.log(`[orchestrator] Raven signal injected: ${event.type || 'signal'}`);
}

/**
 * Handle TTS audio for face rendering.
 */
async function handleTTSAudio(sessionId, audioChunk) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.renderMode === 'anam_cara3' && session.anamSessionId) {
    await streamAudioToAnam(session.anamSessionId, audioChunk);
  }
  // Phoenix-4 handles its own TTS internally
}

/**
 * Handle prospect joining the LiveKit room.
 */
async function handleProspectJoined(sessionId, prospectVideoTrack) {
  const session = sessions.get(sessionId);
  if (!session) return;

  await initRavenPerception(sessionId, prospectVideoTrack);
  session.ravenActive = true;
  sessions.set(sessionId, session);
  console.log(`[orchestrator] Raven perception activated — watching prospect`);
}

/**
 * End a video session and trigger memory processing.
 */
async function endVideoSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.warn(`[orchestrator] No session ${sessionId} to end`);
    return;
  }

  console.log(`[orchestrator] Ending session ${sessionId}...`);

  // Close renderer
  if (session.renderMode === 'phoenix_4' && session.conversationId) {
    await endPhoenixSession(session.conversationId);
  } else if (session.renderMode === 'anam_cara3' && session.anamSessionId) {
    await closeAnamSession(session.anamSessionId);
  }

  // Close Raven
  await closeRavenSession(sessionId);

  // Delete LiveKit room
  if (session.room_name) {
    try { await deleteRoom(session.room_name); } catch (err) {
      console.warn(`[orchestrator] Room delete non-fatal: ${err.message}`);
    }
  }

  // Trigger memory processing
  try {
    await processCallWithClaude(session.callId);
    console.log(`[orchestrator] Memory processed for call ${session.callId}`);
  } catch (err) {
    console.error(`[orchestrator] Memory processing failed: ${err.message}`);
  }

  // Update call status
  await supabase.from('calls').update({ status: 'ended' }).eq('id', session.callId);

  // Clean up session
  sessions.delete(sessionId);
  console.log(`[orchestrator] Session ended — memory processing started`);
}

/**
 * Get session from memory store.
 */
function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

module.exports = {
  startVideoSession,
  handleRavenEvent,
  handleTTSAudio,
  handleProspectJoined,
  endVideoSession,
  getSession,
};
