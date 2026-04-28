const supabase = require('../database/client');
const { buildSoulLayer, buildVoiceLayer, buildSpeechRealismLayer, buildHardRules } = require('./soul');

/**
 * Build the complete system prompt with five parts:
 * 1. Identity — who she is
 * 2. How She Talks — her voice, rhythm, patterns
 * 3. Speech Realism — thinking sounds, breathing, stutters, corrections, dynamics
 * 4. Hard Rules — non-negotiable constraints
 * 5. Context — what's happening right now
 */
async function buildSystemPrompt(clientId, prospectId) {
  // Fetch client
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (clientErr || !client) {
    throw new Error(`Client not found: ${clientId}`);
  }

  let soul = {};
  try {
    soul = typeof client.soul_document === 'string'
      ? JSON.parse(client.soul_document)
      : client.soul_document || {};
  } catch (e) {
    soul = {};
  }

  // PART 1 — IDENTITY
  const identityLayer = buildSoulLayer(soul, client);

  // PART 2 — HOW SHE TALKS
  const voiceLayer = buildVoiceLayer(soul);

  // PART 3 — SPEECH REALISM
  const speechRealism = buildSpeechRealismLayer();

  // PART 4 — HARD RULES
  const hardRules = buildHardRules();

  // PART 5 — CONTEXT
  const contextLayer = buildContextLayer(client, prospectId);

  // Minimal capabilities — only if enabled, and kept short
  const capabilitiesLayer = buildMinimalCapabilities(client);

  // Prospect memory — if we know who we're talking to
  let memoryLayer = '';
  if (prospectId) {
    const { data: prospect } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', prospectId)
      .single();

    if (prospect) {
      memoryLayer = buildMemoryLayer(prospect);
    }
  }

  let fullPrompt = [
    identityLayer,
    voiceLayer,
    speechRealism,
    hardRules,
    contextLayer,
    capabilitiesLayer,
    memoryLayer,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  // Enhance with training data if available
  try {
    const { buildTrainingEnhancedPrompt } = require('../training/inject');
    fullPrompt = await buildTrainingEnhancedPrompt(fullPrompt);
  } catch (err) {
    // Training data not available — use base prompt
  }

  return fullPrompt;
}

/**
 * Fix prompt text for TTS (ElevenLabs) naturalness.
 * ElevenLabs reads punctuation literally — this cleans it up so
 * the voice doesn't say "dash dash" or pause weirdly on markup.
 */
function fixPromptForTTS(prompt) {
  let fixed = prompt;

  // Replace em-dashes with commas for natural pauses
  fixed = fixed.replace(/—/g, ', ');

  // Replace double hyphens with commas
  fixed = fixed.replace(/--/g, ', ');

  // Replace ellipsis with a single period (natural pause, not trailing)
  // Only in speech examples and conversational text, not in section headers
  fixed = fixed.replace(/\.{3,}/g, '.');

  // Remove markdown-style bold/italic markers
  fixed = fixed.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');

  // Clean up multiple spaces
  fixed = fixed.replace(/  +/g, ' ');

  // Clean up multiple newlines (keep max 2)
  fixed = fixed.replace(/\n{4,}/g, '\n\n\n');

  return fixed;
}

/**
 * Memory layer — what we know about the person we're talking to.
 * Kept conversational, not clinical.
 */
function buildMemoryLayer(prospect) {
  const objections = prospect.objections || { raised: [], resolved: [], unresolved: [] };
  const painPoints = prospect.pain_points || {};
  const personalNotes = prospect.personal_notes || [];

  const sections = [];

  sections.push('ABOUT THE PERSON YOU\'RE TALKING TO:');
  sections.push(`Their name is ${prospect.name || 'unknown'}.`);

  if (prospect.business_name) {
    sections.push(`They run ${prospect.business_name}.`);
  }

  if (prospect.call_count > 0) {
    sections.push(`You've spoken ${prospect.call_count} time${prospect.call_count > 1 ? 's' : ''} before.`);
  } else {
    sections.push('This is your first conversation.');
  }

  const painEntries = Object.entries(painPoints);
  if (painEntries.length > 0) {
    sections.push(`\nWhat you know about their situation:\n${painEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
  }

  if (personalNotes.length > 0) {
    sections.push(`\nThings they've mentioned:\n${personalNotes.map(n => `- ${n}`).join('\n')}`);
  }

  if (prospect.communication_style) {
    sections.push(`\nTheir vibe: ${prospect.communication_style}`);
  }

  if (prospect.last_contact) {
    sections.push(`Last time you spoke: ${new Date(prospect.last_contact).toLocaleDateString()}`);
  }

  if (prospect.next_action) {
    sections.push(`What you said you'd follow up on: ${prospect.next_action}`);
  }

  if (objections.raised && objections.raised.length > 0) {
    sections.push(`Things they've pushed back on: ${objections.raised.join(', ')}`);
  }

  return sections.join('\n');
}

/**
 * Minimal capabilities — only what's enabled, kept short.
 * Sarah is a person first. These are incidental.
 */
function buildMinimalCapabilities(client) {
  const tools = [];

  if (client.closing_enabled) {
    tools.push('- send_payment_link: Send a payment link if they want to move forward');
    tools.push('- book_follow_up: Schedule a follow-up call');
  }

  if (client.booking_enabled && !client.closing_enabled) {
    tools.push('- book_follow_up: Schedule a follow-up call');
  }

  if (client.crm_enabled) {
    tools.push('- update_crm: Update records after the conversation');
  }

  tools.push('- pull_prospect_data: Pull up what you know about someone');

  if (tools.length <= 1) return ''; // Only the default tool, skip the section

  return `TOOLS AVAILABLE (use naturally, don't force them):\n${tools.join('\n')}`;
}

/**
 * Context layer — minimal, just the facts.
 */
function buildContextLayer(client, prospectId) {
  const now = new Date();
  const sections = [];

  sections.push('RIGHT NOW:');
  sections.push(`It's ${now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}.`);
  sections.push(`You work at ${client.business_name}.`);

  if (client.offer_name) {
    sections.push(`The offer: ${client.offer_name}`);
  }
  if (client.offer_price) {
    sections.push(`Price: $${client.offer_price}`);
  }
  if (client.transformation) {
    sections.push(`What it does for people: ${client.transformation}`);
  }
  if (client.target_prospect) {
    sections.push(`Who it's for: ${client.target_prospect}`);
  }

  return sections.join('\n');
}

module.exports = { buildSystemPrompt, fixPromptForTTS };
