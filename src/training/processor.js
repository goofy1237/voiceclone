const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const env = require('../../config/env');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Analyse human conversation text and extract speech patterns for AI training.
 */
async function extractConversationPatterns(conversationText) {
  console.log('[training] Extracting conversation patterns...');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: 'You are analysing natural human conversation to extract speech patterns for AI training. Be precise and extract only what is genuinely present.',
    messages: [{
      role: 'user',
      content: `Analyse this conversation and extract:
1. Average response length in words (count them)
2. Most common natural filler phrases used
3. How topic changes are signalled
4. How urgency is communicated
5. Informal language patterns and shortcuts
6. How questions are asked (direct? softened? rhetorical?)
7. Emotional expressions used
8. 10 example exchanges that show natural back-and-forth rhythm

Return as JSON with keys: avg_response_words, filler_phrases, topic_transitions, urgency_patterns, informal_patterns, question_styles, emotional_expressions, example_exchanges

Conversation:
${conversationText}`,
    }],
  });

  const text = response.content[0].text;
  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Claude response');

  const patterns = JSON.parse(jsonMatch[0]);

  const outPath = path.join(__dirname, 'patterns', 'extracted_patterns.json');
  fs.writeFileSync(outPath, JSON.stringify(patterns, null, 2));
  console.log(`[training] Patterns saved to ${outPath}`);

  return patterns;
}

module.exports = { extractConversationPatterns };
