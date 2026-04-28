/**
 * Upstash Redis HTTP REST client.
 * Replaces ioredis with fetch()-based calls against Upstash REST API.
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function isAvailable() {
  return !!(UPSTASH_URL && UPSTASH_TOKEN);
}

async function command(...args) {
  if (!isAvailable()) return null;
  const res = await fetch(`${UPSTASH_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// Convenience wrappers matching Redis commands
async function set(key, value, ...opts) { return command('SET', key, value, ...opts); }
async function get(key) { return command('GET', key); }
async function del(...keys) { return command('DEL', ...keys); }
async function rpush(key, ...values) { return command('RPUSH', key, ...values); }
async function lrange(key, start, stop) { return command('LRANGE', key, start, stop); }
async function ltrim(key, start, stop) { return command('LTRIM', key, start, stop); }
async function expire(key, seconds) { return command('EXPIRE', key, seconds); }
async function ping() { return command('PING'); }

module.exports = {
  isAvailable,
  command,
  set, get, del,
  rpush, lrange, ltrim, expire,
  ping,
};
