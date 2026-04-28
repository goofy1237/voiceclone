/**
 * Transcript buffer — stores real-time transcript chunks keyed by bot_id.
 * Uses Upstash Redis HTTP REST if configured, otherwise falls back to in-memory Map.
 */

const redis = require('./upstash-redis');
const memoryStore = new Map();

async function appendChunk(botId, chunk) {
  const entry = JSON.stringify(chunk);

  if (redis.isAvailable()) {
    try {
      await redis.rpush(`transcript:${botId}`, entry);
      await redis.expire(`transcript:${botId}`, 7200); // 2 hour TTL
      return;
    } catch (err) {
      // Fall through to memory
    }
  }

  // In-memory fallback
  if (!memoryStore.has(botId)) {
    memoryStore.set(botId, []);
  }
  memoryStore.get(botId).push(chunk);
}

async function getTranscript(botId) {
  if (redis.isAvailable()) {
    try {
      const entries = await redis.lrange(`transcript:${botId}`, 0, -1);
      return (entries || []).map(e => JSON.parse(e));
    } catch (err) {
      // Fall through
    }
  }

  return memoryStore.get(botId) || [];
}

async function clearTranscript(botId) {
  if (redis.isAvailable()) {
    try {
      await redis.del(`transcript:${botId}`);
    } catch (err) {
      // Fall through
    }
  }

  memoryStore.delete(botId);
}

module.exports = { appendChunk, getTranscript, clearTranscript };
