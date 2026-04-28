const fs = require('fs');
const path = require('path');

const PROCESSED_DIR = path.join(__dirname, 'processed');
const PATTERNS_DIR = path.join(__dirname, 'patterns');

/**
 * Load all training data into memory once on server startup.
 * Sets global.trainingCache so buildSystemPrompt can use it without disk reads.
 */
function initTrainingCache() {
  console.log('[training-cache] Loading training data into memory...');

  const cache = {};

  try {
    cache.phraseLibrary = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'phrase_library.json'), 'utf8'));
    console.log(`[training-cache] Phrase library: ${Object.keys(cache.phraseLibrary).length} categories`);
  } catch { cache.phraseLibrary = null; }

  try {
    cache.patterns = JSON.parse(fs.readFileSync(path.join(PATTERNS_DIR, 'extracted_patterns.json'), 'utf8'));
    console.log(`[training-cache] Patterns: loaded`);
  } catch { cache.patterns = null; }

  try {
    cache.lengthStats = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'length_stats.json'), 'utf8'));
    console.log(`[training-cache] Length stats: avg ${cache.lengthStats.avg_words} words/turn`);
  } catch { cache.lengthStats = null; }

  try {
    cache.ausSlang = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'australian_patterns.json'), 'utf8'));
    console.log(`[training-cache] Australian patterns: loaded`);
  } catch { cache.ausSlang = null; }

  global.trainingCache = cache;
  console.log('[training-cache] Cache ready — zero latency for prompt injection.\n');

  return cache;
}

module.exports = { initTrainingCache };
