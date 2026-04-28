const fs = require('fs');
const path = require('path');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');
const axios = require('axios');
const env = require('../../config/env');
const { RETELL_API_BASE } = require('../../config/constants');

const PROCESSED_DIR = path.join(__dirname, 'processed');
const PATTERNS_DIR = path.join(__dirname, 'patterns');

/**
 * Load training data — from cache if available, disk otherwise.
 */
function loadTrainingData() {
  if (global.trainingCache) return global.trainingCache;

  const data = {};
  try {
    data.phraseLibrary = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'phrase_library.json'), 'utf8'));
  } catch { data.phraseLibrary = null; }
  try {
    data.patterns = JSON.parse(fs.readFileSync(path.join(PATTERNS_DIR, 'extracted_patterns.json'), 'utf8'));
  } catch { data.patterns = null; }
  try {
    data.lengthStats = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'length_stats.json'), 'utf8'));
  } catch { data.lengthStats = null; }
  try {
    data.ausSlang = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'australian_patterns.json'), 'utf8'));
  } catch { data.ausSlang = null; }

  return data;
}

/**
 * Enhance a base system prompt with training data insights.
 *
 * Key insight: the Kaggle data gives us RHYTHM and LENGTH stats,
 * but Sarah's VOICE comes from her soul document and australian_patterns.
 * We use the Kaggle data for what it's good at (proving how short real
 * responses are) and the curated data for her actual speech patterns.
 */
async function buildTrainingEnhancedPrompt(basePrompt) {
  const data = loadTrainingData();

  const sections = [basePrompt];

  // Length stats are the most valuable training signal —
  // they prove to the LLM that real humans speak in 8-word bursts
  if (data.lengthStats) {
    sections.push('\nREAL CONVERSATION DATA (from 5,800+ human exchanges):');
    sections.push(`Average human response: ${data.lengthStats.avg_words} words.`);
    if (data.lengthStats.distribution) {
      sections.push(`Response length distribution: ${Object.entries(data.lengthStats.distribution).map(([k, v]) => `${k} words: ${v}`).join(', ')}`);
    }
    sections.push('This means: 79% of real human responses are 10 words or fewer. Match this.');
  }

  // Example exchanges — pick the most natural-sounding ones
  // These teach rhythm, not content
  if (data.patterns?.example_exchanges?.length) {
    // Filter for short, punchy exchanges that match Sarah's style
    const goodExchanges = data.patterns.example_exchanges.filter(ex => {
      if (!ex.a || !ex.b) return false;
      const bWords = ex.b.split(/\s+/).length;
      // Keep responses under 15 words — that's the rhythm we want
      return bWords >= 2 && bWords <= 15;
    });

    if (goodExchanges.length > 0) {
      sections.push('\nNATURAL CONVERSATION RHYTHMS (study these — notice how short the responses are):');
      const selected = goodExchanges.slice(0, 8);
      for (const ex of selected) {
        sections.push(`  Them: "${ex.a}"\n  You: "${ex.b}"`);
      }
    }
  }

  // Australian filler and slang — this is the voice layer
  if (data.ausSlang) {
    const aus = data.ausSlang;
    const slangParts = [];

    if (aus.greetings?.length) slangParts.push(`Greetings: ${aus.greetings.join(', ')}`);
    if (aus.acknowledgements?.length) slangParts.push(`Acknowledgements: ${aus.acknowledgements.join(', ')}`);
    if (aus.filler?.length) slangParts.push(`Fillers: ${aus.filler.join(', ')}`);
    if (aus.closers?.length) slangParts.push(`Closers: ${aus.closers.join(', ')}`);

    if (slangParts.length > 0) {
      sections.push(`\nYOUR AUSTRALIAN VOCABULARY (use naturally, don't force):\n${slangParts.join('\n')}`);
    }
  }

  // Backchannels from real data
  if (data.phraseLibrary?.backchannels?.length) {
    sections.push(`\nBackchannel words: ${data.phraseLibrary.backchannels.join(', ')}`);
  }

  return sections.join('\n');
}

/**
 * Build enhanced prompt for Sarah and push to her Retell LLM.
 */
async function updateSarahWithEnhancements() {
  const SARAH_CLIENT_ID = '9d3cd726-c57b-470d-9b18-24361a119496';
  const SARAH_AGENT_ID = 'agent_a65b3f0e09eddb372e7c7a9426';

  console.log('[inject] Building enhanced prompt for Sarah...');

  // Build base prompt (already includes training enhancement)
  const enhancedPrompt = await buildSystemPrompt(SARAH_CLIENT_ID, null);

  console.log(`[inject] Final prompt: ${enhancedPrompt.length} chars`);
  console.log(`[inject] Word count: ${enhancedPrompt.split(/\s+/).length}`);

  // Get LLM ID from agent
  const retellHeaders = {
    'Authorization': `Bearer ${env.RETELL_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const agentsRes = await axios.get(`${RETELL_API_BASE}/list-agents`, { headers: retellHeaders });
  const sarah = agentsRes.data.find(a => a.agent_id === SARAH_AGENT_ID);
  if (!sarah) throw new Error('Sarah agent not found on Retell');

  const llmId = sarah.response_engine?.llm_id;
  if (!llmId) throw new Error('No LLM ID on Sarah agent');

  console.log(`[inject] Patching Retell LLM ${llmId}...`);

  await axios.patch(`${RETELL_API_BASE}/update-retell-llm/${llmId}`, {
    general_prompt: enhancedPrompt,
  }, { headers: retellHeaders });

  console.log('[inject] Sarah updated successfully.');
  console.log(`[inject] First 500 chars:\n${enhancedPrompt.slice(0, 500)}...`);

  return { promptLength: enhancedPrompt.length, wordCount: enhancedPrompt.split(/\s+/).length };
}

module.exports = { buildTrainingEnhancedPrompt, updateSarahWithEnhancements, loadTrainingData };
