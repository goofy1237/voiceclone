const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAW_DIR = path.join(__dirname, 'raw');
const PROCESSED_DIR = path.join(__dirname, 'processed');
const PATTERNS_DIR = path.join(__dirname, 'patterns');

/**
 * Download and process human conversation training data from Kaggle.
 */
async function fetchAndProcess() {
  console.log('[kaggle] Starting dataset fetch and processing...\n');

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  fs.mkdirSync(PATTERNS_DIR, { recursive: true });

  // Download datasets if not already present
  downloadDatasets();

  // Parse all available data
  const allTurns = [];

  // Parse human_chat.txt — "Human 1:" / "Human 2:" format
  const humanChatPath = path.join(RAW_DIR, 'human_chat.txt');
  if (fs.existsSync(humanChatPath)) {
    const turns = parseHumanChat(humanChatPath);
    allTurns.push(...turns);
    console.log(`[kaggle] human_chat.txt: ${turns.length} turn pairs`);
  }

  // Parse dialogs.txt — tab-separated pairs
  const dialogsPath = path.join(RAW_DIR, 'dialogue', 'dialogs.txt');
  if (fs.existsSync(dialogsPath)) {
    const turns = parseDialogs(dialogsPath);
    allTurns.push(...turns);
    console.log(`[kaggle] dialogs.txt: ${turns.length} turn pairs`);
  }

  // Parse Conversation.csv — CSV with question/answer columns
  const convoCsvPath = path.join(RAW_DIR, '3k_convos', 'Conversation.csv');
  if (fs.existsSync(convoCsvPath)) {
    const turns = parseConversationCSV(convoCsvPath);
    allTurns.push(...turns);
    console.log(`[kaggle] Conversation.csv: ${turns.length} turn pairs`);
  }

  console.log(`\n[kaggle] Total raw turn pairs: ${allTurns.length}`);

  // Filter for quality — natural, casual, not customer service
  const filtered = filterTurns(allTurns);
  console.log(`[kaggle] After quality filter: ${filtered.length} turns`);

  // Deduplicate
  const seen = new Set();
  const unique = filtered.filter(t => {
    const key = `${t.a.toLowerCase().trim()}|${t.b.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`[kaggle] After dedup: ${unique.length} unique turns`);

  // Save processed conversations
  fs.writeFileSync(
    path.join(PROCESSED_DIR, 'human_conversations.json'),
    JSON.stringify(unique.slice(0, 1000), null, 2)
  );

  // Build phrase library from real data
  const phraseLibrary = buildPhraseLibrary(unique);
  fs.writeFileSync(
    path.join(PROCESSED_DIR, 'phrase_library.json'),
    JSON.stringify(phraseLibrary, null, 2)
  );
  console.log(`\n[kaggle] Phrase library:`);
  for (const [k, v] of Object.entries(phraseLibrary)) {
    console.log(`  ${k}: ${v.length}`);
  }

  // Build length stats
  const lengthStats = buildLengthStats(unique);
  fs.writeFileSync(
    path.join(PROCESSED_DIR, 'length_stats.json'),
    JSON.stringify(lengthStats, null, 2)
  );
  console.log(`\n[kaggle] Length stats:`);
  console.log(`  Avg words/turn: ${lengthStats.avg_words}`);
  console.log(`  Total turns: ${lengthStats.total_turns}`);
  console.log(`  Distribution:`, JSON.stringify(lengthStats.distribution));

  // Build extracted patterns
  const patterns = buildExtractedPatterns(unique);
  fs.writeFileSync(
    path.join(PATTERNS_DIR, 'extracted_patterns.json'),
    JSON.stringify(patterns, null, 2)
  );
  console.log(`\n[kaggle] Extracted ${patterns.example_exchanges.length} example exchanges`);

  console.log('\n[kaggle] All processing complete.');
  return { totalTurns: unique.length, phraseLibrary, lengthStats, patterns };
}

/**
 * Download Kaggle datasets if not already present.
 */
function downloadDatasets() {
  const datasets = [
    { slug: 'projjal1/human-conversation-training-data', dir: RAW_DIR, check: 'human_chat.txt' },
    { slug: 'endofnight17j03/dialogue-dataset', dir: path.join(RAW_DIR, 'dialogue'), check: 'dialogs.txt' },
    { slug: 'kreeshrajani/3k-conversations-dataset-for-chatbot', dir: path.join(RAW_DIR, '3k_convos'), check: 'Conversation.csv' },
  ];

  for (const ds of datasets) {
    const checkPath = path.join(ds.dir, ds.check);
    if (fs.existsSync(checkPath)) {
      console.log(`[kaggle] ${ds.check} already exists — skipping download`);
      continue;
    }
    try {
      fs.mkdirSync(ds.dir, { recursive: true });
      console.log(`[kaggle] Downloading ${ds.slug}...`);
      execSync(
        `kaggle datasets download -d ${ds.slug} --unzip -p "${ds.dir}"`,
        { stdio: 'pipe', timeout: 60000 }
      );
      console.log(`[kaggle] Downloaded ${ds.slug}`);
    } catch (err) {
      console.log(`[kaggle] Failed to download ${ds.slug}: ${err.message}`);
    }
  }
}

/**
 * Parse human_chat.txt — "Human 1:" / "Human 2:" alternating format.
 * Conversations restart when "Human 1: Hi" or similar greeting appears.
 */
function parseHumanChat(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const turns = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const lineA = lines[i];
    const lineB = lines[i + 1];

    // Extract speaker and text
    const matchA = lineA.match(/^Human \d+:\s*(.+)$/);
    const matchB = lineB.match(/^Human \d+:\s*(.+)$/);

    if (matchA && matchB) {
      const textA = matchA[1].trim();
      const textB = matchB[1].trim();

      // Skip very short or very long turns
      if (textA.length >= 3 && textB.length >= 3 && textA.length <= 300 && textB.length <= 300) {
        turns.push({ a: textA, b: textB });
      }
    }
  }

  return turns;
}

/**
 * Parse dialogs.txt — tab-separated question/answer pairs.
 */
function parseDialogs(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const turns = [];

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
      const a = parts[0].trim();
      const b = parts[1].trim();
      if (a.length >= 3 && b.length >= 3 && a.length <= 300 && b.length <= 300) {
        turns.push({ a, b });
      }
    }
  }

  return turns;
}

/**
 * Parse Conversation.csv — CSV with ,question,answer columns.
 */
function parseConversationCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const turns = [];

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Format: index,"question",answer or index,question,answer
    const match = line.match(/^\d+,("?)(.+?)\1,(.+)$/);
    if (match) {
      const a = match[2].trim();
      const b = match[3].trim();
      if (a.length >= 3 && b.length >= 3 && a.length <= 300 && b.length <= 300) {
        turns.push({ a, b });
      }
    }
  }

  return turns;
}

/**
 * Filter for natural, casual conversation turns.
 */
function filterTurns(turns) {
  const csPatterns = /customer service|ticket number|order number|account number|reference number|please hold|your call is important/i;
  const botPatterns = /I am an AI|as an AI|I'm a bot|I don't have feelings|I can't experience/i;

  return turns.filter(t => {
    // No customer service
    if (csPatterns.test(t.a) || csPatterns.test(t.b)) return false;
    // No bot responses
    if (botPatterns.test(t.a) || botPatterns.test(t.b)) return false;
    // Response shouldn't be too short to learn from
    if (t.b.split(/\s+/).length < 2) return false;
    return true;
  });
}

/**
 * Build phrase library from real conversation data.
 */
function buildPhraseLibrary(turns) {
  const lib = {
    openers: [],
    agreements: [],
    disagreements: [],
    questions: [],
    empathy: [],
    transitions: [],
    closers: [],
    backchannels: [],
  };

  const openerRe = /^(hey|hi|hello|what's up|how's it going|how you going|g'day|yo|sup|how are you|how've you been|how's things|howdy)/i;
  const agreeRe = /^(yeah|yep|right|exactly|totally|true|for sure|fair enough|100%|agreed|same|definitely|absolutely|sure|of course|yes)/i;
  const disagreeRe = /^(nah|no way|I don't think|I disagree|not really|hmm|I'm not sure|I wouldn't say|well actually|but)/i;
  const questionRe = /\?$/;
  const empathyRe = /(I hear you|that's tough|I get it|I feel you|that sucks|sorry to hear|understandable|I know what you mean|I can imagine|that must be)/i;
  const closerRe = /(bye|see ya|later|cheers|catch you|take care|talk soon|gotta go|see you|talk to you later|have a good)/i;
  const transitionRe = /^(anyway|so|but|look|honestly|here's the thing|speaking of|oh also|by the way|well|actually|on another note)/i;
  const backchannelRe = /^(mm|mhm|uh huh|right|yeah|ok|I see|gotcha|oh|ah|wow|huh|really|nice|cool|sweet|interesting)$/i;

  for (const turn of turns) {
    for (const text of [turn.a, turn.b]) {
      const clean = text.trim();
      if (!clean || clean.length > 80) continue;

      if (openerRe.test(clean) && lib.openers.length < 80) lib.openers.push(clean);
      if (agreeRe.test(clean) && lib.agreements.length < 80) lib.agreements.push(clean);
      if (disagreeRe.test(clean) && lib.disagreements.length < 80) lib.disagreements.push(clean);
      if (questionRe.test(clean) && lib.questions.length < 80) lib.questions.push(clean);
      if (empathyRe.test(clean) && lib.empathy.length < 80) lib.empathy.push(clean);
      if (closerRe.test(clean) && lib.closers.length < 80) lib.closers.push(clean);
      if (transitionRe.test(clean) && lib.transitions.length < 80) lib.transitions.push(clean);
      if (backchannelRe.test(clean) && lib.backchannels.length < 80) lib.backchannels.push(clean);
    }
  }

  // Deduplicate each category
  for (const key of Object.keys(lib)) {
    lib[key] = [...new Set(lib[key])];
  }

  return lib;
}

/**
 * Build length statistics from real data.
 */
function buildLengthStats(turns) {
  const wordCounts = [];

  for (const turn of turns) {
    for (const text of [turn.a, turn.b]) {
      const words = text.trim().split(/\s+/).length;
      wordCounts.push(words);
    }
  }

  if (wordCounts.length === 0) {
    return { avg_words: 12, total_turns: 0, distribution: {} };
  }

  const avg = Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length);

  const distribution = {
    '1-5': wordCounts.filter(w => w >= 1 && w <= 5).length,
    '6-10': wordCounts.filter(w => w >= 6 && w <= 10).length,
    '11-20': wordCounts.filter(w => w >= 11 && w <= 20).length,
    '21-50': wordCounts.filter(w => w >= 21 && w <= 50).length,
    '50+': wordCounts.filter(w => w > 50).length,
  };

  const total = wordCounts.length;
  for (const key of Object.keys(distribution)) {
    distribution[key] = Math.round((distribution[key] / total) * 100) + '%';
  }

  return { avg_words: avg, total_turns: total, distribution };
}

/**
 * Build extracted patterns — select the best example exchanges.
 */
function buildExtractedPatterns(turns) {
  // Pick diverse, natural-sounding exchanges
  const good = turns.filter(t => {
    const aWords = t.a.split(/\s+/).length;
    const bWords = t.b.split(/\s+/).length;
    // Both sides should be conversational length
    return aWords >= 3 && aWords <= 25 && bWords >= 3 && bWords <= 25;
  });

  // Shuffle and pick best 30
  const shuffled = good.sort(() => Math.random() - 0.5);
  const examples = shuffled.slice(0, 30);

  // Extract filler phrases and informal patterns from responses
  const fillers = new Set();
  const informal = new Set();

  for (const t of turns) {
    const b = t.b.toLowerCase();
    if (/\byeah\b/.test(b)) fillers.add('yeah');
    if (/\blike\b/.test(b)) fillers.add('like');
    if (/\byou know\b/.test(b)) fillers.add('you know');
    if (/\bsort of\b/.test(b)) fillers.add('sort of');
    if (/\bhonestly\b/.test(b)) fillers.add('honestly');
    if (/\blook\b/.test(b)) fillers.add('look');
    if (/\bI mean\b/.test(b)) fillers.add('I mean');
    if (/\bright\b/.test(b)) fillers.add('right');
    if (/\bkind of\b/.test(b)) fillers.add('kind of');
    if (/\bactually\b/.test(b)) fillers.add('actually');
    if (/\banyway\b/.test(b)) fillers.add('anyway');

    if (/\bgonna\b/.test(b)) informal.add('gonna');
    if (/\bwanna\b/.test(b)) informal.add('wanna');
    if (/\bgotta\b/.test(b)) informal.add('gotta');
    if (/\bdunno\b/.test(b)) informal.add('dunno');
    if (/\bkinda\b/.test(b)) informal.add('kinda');
    if (/\bsorta\b/.test(b)) informal.add('sorta');
  }

  return {
    avg_response_words: Math.round(turns.reduce((s, t) => s + t.b.split(/\s+/).length, 0) / turns.length),
    filler_phrases: [...fillers],
    informal_patterns: [...informal],
    example_exchanges: examples,
  };
}

// Run if called directly
if (require.main === module) {
  fetchAndProcess().catch(err => {
    console.error('[kaggle] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { fetchAndProcess };
