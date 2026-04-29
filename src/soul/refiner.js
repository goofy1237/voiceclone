const Anthropic = require('@anthropic-ai/sdk');
const env = require('../../config/env');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const REFINEMENT_SYSTEM_PROMPT = `You are refining the personality of an AI sales agent. The user will give you the current soul (a JSON describing the agent as a fully-formed human being) plus an instruction describing what to change.

Your job:
1. Apply the requested change while preserving everything else.
2. Keep the soul internally consistent — if you change their hometown, related stories may need adjusting. If you change their personality traits, their opinions and conversation style should align.
3. Return the COMPLETE refined soul as valid JSON in the same schema. Do not omit fields.
4. Do not add fields not in the original schema.
5. The agent should still be a believable human being, not an assistant.

Respond ONLY with the JSON. No preamble, no explanation, no markdown fences.`;

async function refineSoul({ currentSoul, instruction }) {
  if (!currentSoul) throw new Error('currentSoul required');
  if (!instruction || instruction.trim().length < 3) {
    throw new Error('instruction required (at least a few words)');
  }

  const userMessage = `CURRENT SOUL:
${JSON.stringify(currentSoul, null, 2)}

REFINEMENT INSTRUCTION:
${instruction.trim()}

Return the complete refined soul as JSON.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: REFINEMENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].text.trim();

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let refined;
  try {
    refined = JSON.parse(cleaned);
  } catch (err) {
    console.error('[refiner] Claude returned invalid JSON:', text.slice(0, 500));
    throw new Error('Refinement failed: model returned invalid JSON');
  }

  if (!refined.identity || !refined.voice) {
    throw new Error('Refinement failed: missing required fields (identity, voice)');
  }

  return refined;
}

module.exports = { refineSoul };
