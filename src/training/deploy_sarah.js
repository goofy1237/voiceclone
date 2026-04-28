#!/usr/bin/env node
/**
 * Deploy the new Sarah persona:
 * 1. Save new soul document to Supabase
 * 2. Update Retell agent (begin_message, temperature)
 * 3. Build new prompt and push to Retell LLM
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const env = require('../../config/env');
const { RETELL_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');

const SARAH_CLIENT_ID = '9d3cd726-c57b-470d-9b18-24361a119496';
const SARAH_AGENT_ID = 'agent_a65b3f0e09eddb372e7c7a9426';
const SARAH_LLM_ID = 'llm_c1f4b041675d952aa98e8cc8ff93';

const retellHeaders = {
  'Authorization': `Bearer ${env.RETELL_API_KEY}`,
  'Content-Type': 'application/json',
};

async function deploy() {
  console.log('=== DEPLOYING NEW SARAH PERSONA ===\n');

  // Step 1: Load new soul document
  const soulPath = path.join(__dirname, 'new_soul.json');
  const soul = JSON.parse(fs.readFileSync(soulPath, 'utf8'));
  console.log(`[1/4] Loaded soul: ${soul.full_name}, ${soul.age}, ${soul.suburb}`);

  // Step 2: Save to Supabase
  const { error: updateErr } = await supabase
    .from('clients')
    .update({ soul_document: soul })
    .eq('id', SARAH_CLIENT_ID);

  if (updateErr) {
    console.error('[2/4] Failed to save soul to Supabase:', updateErr.message);
    throw updateErr;
  }
  console.log('[2/4] Soul document saved to Supabase');

  // Step 3: Update Retell agent — begin_message + responsiveness
  try {
    await axios.patch(`${RETELL_API_BASE}/update-agent/${SARAH_AGENT_ID}`, {
      begin_message: 'hey, how you going',
      responsiveness: 1.0,
      interruption_sensitivity: 0.8,
      enable_backchannel: true,
      backchannel_frequency: 0.8,
      backchannel_words: ['yeah', 'right', 'mm', 'totally', 'uh huh', 'for sure'],
    }, { headers: retellHeaders });
    console.log('[3/4] Retell agent updated (begin_message: "hey, how you going")');
  } catch (err) {
    console.error('[3/4] Failed to update agent:', err.response?.data || err.message);
    throw err;
  }

  // Step 4: Update Retell LLM — temperature + new prompt
  try {
    const newPrompt = await buildSystemPrompt(SARAH_CLIENT_ID, null);
    console.log(`[4/4] New prompt built: ${newPrompt.length} chars, ${newPrompt.split(/\s+/).length} words`);

    await axios.patch(`${RETELL_API_BASE}/update-retell-llm/${SARAH_LLM_ID}`, {
      general_prompt: newPrompt,
      model_temperature: 0.8,
    }, { headers: retellHeaders });

    console.log('[4/4] Retell LLM updated with new prompt + temperature 0.8');

    // Print the full prompt
    console.log('\n=== FULL NEW SOUL DOCUMENT ===');
    console.log(JSON.stringify(soul, null, 2));

    console.log('\n=== FULL NEW SYSTEM PROMPT ===');
    console.log(newPrompt);

    console.log(`\n=== STATS ===`);
    console.log(`Prompt length: ${newPrompt.length} chars`);
    console.log(`Word count: ${newPrompt.split(/\s+/).length}`);
    console.log(`Temperature: 0.8`);
    console.log(`Begin message: "hey, how you going"`);

    console.log('\n=== DEPLOY COMPLETE ===');
    return { prompt: newPrompt, soul, promptLength: newPrompt.length };
  } catch (err) {
    console.error('[4/4] Failed to update LLM:', err.response?.data || err.message);
    throw err;
  }
}

deploy().catch(err => {
  console.error('\nDEPLOY FAILED:', err.message);
  process.exit(1);
});
