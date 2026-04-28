const Anthropic = require('@anthropic-ai/sdk');
const env = require('../../config/env');
const supabase = require('../database/client');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const SOUL_SYSTEM_PROMPT = `You are designing a human being, not an AI assistant. You are creating a fully realised person who works for a specific company. This person has a life, opinions, memories, communication quirks, a sense of humour, and genuine feelings. They are indistinguishable from a real human in conversation. Design them completely.

Return ONLY valid JSON. No markdown, no explanation, no code fences. Just the JSON object.`;

async function generateSoul(clientData) {
  console.log(`[soul] Generating soul for ${clientData.agent_name} at ${clientData.business_name}...`);

  const userPrompt = `Create a complete human soul for an AI agent with these parameters:
Business: ${clientData.business_name}
Agent name: ${clientData.agent_name}
Gender: ${clientData.agent_gender || 'female'}
Personality traits: ${clientData.agent_personality || 'warm, direct, curious'}
Industry: derived from the offer and target prospect below
Offer: ${clientData.offer_name || 'not specified'}
Target prospect: ${clientData.target_prospect || 'not specified'}
Transformation offered: ${clientData.transformation || 'not specified'}

Return a JSON object with this exact structure:
{
  "identity": {
    "full_name": "string — full realistic name matching gender",
    "age": "number between 28-42",
    "location": "string — a real city that makes sense for this industry",
    "background": "string — 2 paragraph backstory as a real person, specific and vivid",
    "education": "string — specific degree and school",
    "years_in_industry": "number",
    "personal_life_details": ["array of 5 specific human details — hobbies, family, quirks, things they love"],
    "origin_story": "string — why they got into this work, personal and specific"
  },
  "voice": {
    "tone": "string",
    "pace": "string",
    "favourite_phrases": ["array of 6 natural phrases this person uses regularly"],
    "things_they_never_say": ["array of 6 robotic/corporate phrases to avoid"],
    "how_they_laugh": "string — specific description",
    "how_they_disagree": "string — how they push back",
    "how_they_show_enthusiasm": "string",
    "how_they_handle_silence": "string"
  },
  "opinions": {
    "hot_takes": ["array of 3 genuine opinions about their industry"],
    "things_they_believe_strongly": ["array of 3 conviction statements"],
    "things_they_are_skeptical_of": ["array of 3 things they push back on"]
  },
  "stories": {
    "personal_transformation": "string — their own journey, specific and emotional",
    "best_client_win": "string — specific story of someone they helped",
    "hardest_moment": "string — something real that challenged them",
    "funny_memory": "string — a genuine funny story from their work"
  },
  "conversation_style": {
    "how_they_open": "string",
    "how_they_show_curiosity": "string",
    "how_they_build_rapport": "string",
    "how_they_handle_objections": "string",
    "how_they_close_a_topic": "string",
    "favourite_questions_to_ask": ["array of 5 genuine human questions they love asking"]
  }
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SOUL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const responseText = message.content[0].text;

  // Parse the JSON — strip any markdown fences if present
  let soul;
  try {
    const cleaned = responseText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    soul = JSON.parse(cleaned);
  } catch (e) {
    console.error('[soul] Failed to parse soul JSON:', e.message);
    console.error('[soul] Raw response:', responseText.slice(0, 500));
    throw new Error('Failed to generate valid soul JSON from Claude');
  }

  console.log(`[soul] Soul generated: ${soul.identity?.full_name || clientData.agent_name}, age ${soul.identity?.age || '??'}, based in ${soul.identity?.location || '??'}`);

  return soul;
}

async function generateAndSaveSoul(clientId) {
  // Fetch client data
  const { data: client, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error || !client) {
    throw new Error(`Client not found: ${clientId}`);
  }

  const soul = await generateSoul(client);

  // Save soul to client record
  const { error: updateErr } = await supabase
    .from('clients')
    .update({ soul_document: JSON.stringify(soul) })
    .eq('id', clientId);

  if (updateErr) {
    throw new Error(`Failed to save soul: ${updateErr.message}`);
  }

  console.log(`[soul] Soul saved to client ${clientId}`);
  return soul;
}

module.exports = { generateSoul, generateAndSaveSoul };
