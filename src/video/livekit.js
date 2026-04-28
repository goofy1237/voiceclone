const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');
const env = require('../../config/env');
const supabase = require('../database/client');

const livekitHost = env.LIVEKIT_URL
  ? env.LIVEKIT_URL.replace('wss://', 'https://')
  : null;

function getRoomService() {
  if (!livekitHost || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error('LiveKit not configured — set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
  }
  return new RoomServiceClient(livekitHost, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}

/**
 * Create a LiveKit room for a video session.
 */
async function createRoom(clientId, prospectId) {
  const svc = getRoomService();

  const { data: client } = await supabase
    .from('clients')
    .select('agent_name')
    .eq('id', clientId)
    .single();

  const agentName = client?.agent_name || 'Agent';
  const roomName = `${agentName.toLowerCase().replace(/\s+/g, '-')}-${prospectId.slice(0, 8)}-${Date.now()}`;

  console.log(`[livekit] Creating room: ${roomName}`);

  const room = await svc.createRoom({
    name: roomName,
    maxParticipants: 3,
    emptyTimeout: 300,
  });

  const agentToken = await getAgentToken(roomName, agentName);
  const prospectToken = await getParticipantToken(roomName, 'prospect');

  console.log(`[livekit] Room created: ${roomName}`);
  return { room_name: roomName, agent_token: agentToken, prospect_token: prospectToken, room };
}

/**
 * Generate an agent access token for a LiveKit room.
 */
async function getAgentToken(roomName, agentName) {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: `${agentName}_ai`,
    ttl: 3600,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
  });
  return await at.toJwt();
}

/**
 * Generate a participant token.
 */
async function getParticipantToken(roomName, identity) {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity,
    ttl: 3600,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });
  return await at.toJwt();
}

/**
 * Get the composite URL for a room (used by Recall bot as camera).
 */
function getRoomCompositeUrl(roomName) {
  const base = env.LIVEKIT_URL
    ? env.LIVEKIT_URL.replace('wss://', 'https://')
    : 'https://livekit.cloud';
  return `${base}/rooms/${roomName}`;
}

/**
 * List all active rooms.
 */
async function listRooms() {
  const svc = getRoomService();
  const rooms = await svc.listRooms();
  return rooms;
}

/**
 * Delete a room.
 */
async function deleteRoom(roomName) {
  const svc = getRoomService();
  await svc.deleteRoom(roomName);
  console.log(`[livekit] Room deleted: ${roomName}`);
}

module.exports = { createRoom, getAgentToken, getParticipantToken, getRoomCompositeUrl, listRooms, deleteRoom };
