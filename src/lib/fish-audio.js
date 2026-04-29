const axios = require('axios');
const FormData = require('form-data');
const env = require('../../config/env');

const FISH_BASE = 'https://api.fish.audio';

function apiKey() {
  const key = env.FISH_AUDIO_API_KEY || process.env.FISH_AUDIO_API_KEY;
  if (!key) throw new Error('FISH_AUDIO_API_KEY is not configured');
  return key;
}

function extractError(err, fallback) {
  const data = err.response?.data;
  if (data) {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data.detail) return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    if (data.message) return data.message;
    try { return JSON.stringify(data); } catch (_) {}
  }
  return err.message || fallback;
}

function guessExt(mimeType) {
  if (!mimeType) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'mp3';
}

async function cloneVoice({ name, audioBuffer, description, mimeType }) {
  if (!name) throw new Error('name is required');
  if (!audioBuffer || !audioBuffer.length) throw new Error('audioBuffer is required');

  const form = new FormData();
  form.append('title', name);
  form.append('description', description || `Cloned voice for ${name}`);
  form.append('visibility', 'private');
  form.append('type', 'tts');
  form.append('train_mode', 'fast');
  form.append('voices', audioBuffer, {
    filename: `sample.${guessExt(mimeType)}`,
    contentType: mimeType || 'audio/mpeg',
  });

  try {
    const res = await axios.post(`${FISH_BASE}/model`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${apiKey()}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120_000,
    });
    const voiceId = res.data?._id || res.data?.id;
    if (!voiceId) {
      throw new Error(`Fish Audio did not return a voice ID. Response: ${JSON.stringify(res.data)}`);
    }
    return { voice_id: voiceId };
  } catch (err) {
    throw new Error(`Fish Audio clone failed: ${extractError(err, 'unknown error')}`);
  }
}

async function previewVoice({ voiceId, text }) {
  if (!voiceId) throw new Error('voiceId is required');
  const body = {
    text: text || "Hi, I'm calling from Apex Sales Academy — got a sec to chat?",
    reference_id: voiceId,
    format: 'mp3',
  };
  try {
    const res = await axios.post(`${FISH_BASE}/v1/tts`, body, {
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 30_000,
    });
    return Buffer.from(res.data);
  } catch (err) {
    throw new Error(`Fish Audio preview failed: ${extractError(err, 'unknown error')}`);
  }
}

module.exports = { cloneVoice, previewVoice };
