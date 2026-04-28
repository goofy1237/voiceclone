const Anthropic = require('@anthropic-ai/sdk');
const env = require('../../config/env');
const supabase = require('../database/client');
const { DETECTION_RISK_THRESHOLD } = require('../../config/constants');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const MEMORY_SYSTEM_PROMPT = `You are the memory and intelligence layer for a human AI platform. Your job is to analyse conversations and extract everything that makes the next interaction more human, more personal, and more natural.

Focus obsessively on the human details — what did they laugh about, what lit them up, what made them hesitate, what personal things did they share. These details are what make the next conversation feel like talking to someone who actually knows you.

Return ONLY valid JSON. No markdown, no explanation, no code fences.`;

async function processCallWithClaude(callId) {
  console.log(`[memory] Processing call ${callId}...`);

  // Fetch call data
  const { data: call, error: callErr } = await supabase
    .from('calls')
    .select('*')
    .eq('id', callId)
    .single();

  if (callErr || !call) {
    throw new Error(`Call not found: ${callId}`);
  }

  // Fetch prospect
  const { data: prospect } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', call.prospect_id)
    .single();

  // Fetch client soul
  const { data: client } = await supabase
    .from('clients')
    .select('soul_document')
    .eq('id', call.client_id)
    .single();

  const userPrompt = `
TRANSCRIPT:
${call.transcript || 'No transcript available'}

EXISTING PROSPECT MEMORY:
${JSON.stringify(prospect || {}, null, 2)}

CLIENT SOUL:
${client?.soul_document || 'Not available'}

Analyse this conversation and return ONLY valid JSON with this structure:
{
  "updated_prospect": {
    "name": "string",
    "communication_style": "string describing how they communicate",
    "funnel_stage": "one of: lead, qualified, proposal, negotiation, closed_won, closed_lost",
    "pain_points": {"key": "value pairs"},
    "objections": {"raised": [], "resolved": [], "unresolved": []},
    "buying_signals": [],
    "personal_notes": ["personal details they shared"],
    "next_action": "what to follow up on",
    "next_contact_date": "ISO date string or null"
  },
  "call_summary": "3 sentences, written as personal notes not a report",
  "key_moments": ["pivotal moments"],
  "human_moments": ["moments of genuine human connection — laughs, personal shares, emotional beats"],
  "detection_risk_moments": ["any moments where the AI may have sounded unnatural — be honest"],
  "detection_risk_score": 0,
  "objections_raised": [],
  "buying_signals": [],
  "recommended_next_action": "string",
  "next_contact_date": "ISO string or null",
  "agent_performance_notes": "string",
  "humanness_improvements": "specific ways to make it more human next time",
  "suggested_prompt_tweaks": "string"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: MEMORY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const responseText = message.content[0].text;

  let analysis;
  try {
    const cleaned = responseText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    analysis = JSON.parse(cleaned);
  } catch (e) {
    console.error('[memory] Failed to parse analysis JSON:', e.message);
    throw new Error('Failed to parse Claude memory analysis');
  }

  // Update prospect
  if (prospect && analysis.updated_prospect) {
    const updates = {
      communication_style: analysis.updated_prospect.communication_style || prospect.communication_style,
      funnel_stage: analysis.updated_prospect.funnel_stage || prospect.funnel_stage,
      pain_points: analysis.updated_prospect.pain_points || prospect.pain_points,
      objections: analysis.updated_prospect.objections || prospect.objections,
      buying_signals: analysis.updated_prospect.buying_signals || prospect.buying_signals,
      personal_notes: analysis.updated_prospect.personal_notes || prospect.personal_notes,
      next_action: analysis.updated_prospect.next_action || prospect.next_action,
      next_contact_date: analysis.updated_prospect.next_contact_date || prospect.next_contact_date,
      last_contact: new Date().toISOString(),
      call_count: (prospect.call_count || 0) + 1,
    };

    await supabase
      .from('prospects')
      .update(updates)
      .eq('id', prospect.id);

    console.log(`[memory] Prospect ${prospect.id} updated.`);
  }

  // Update call record
  await supabase
    .from('calls')
    .update({
      claude_analysis: analysis,
      call_summary: analysis.call_summary,
      key_moments: analysis.key_moments || [],
      human_moments: analysis.human_moments || [],
      detection_risk_score: analysis.detection_risk_score || 0,
      agent_performance_notes: analysis.agent_performance_notes,
    })
    .eq('id', callId);

  // Flag high detection risk
  if ((analysis.detection_risk_score || 0) > DETECTION_RISK_THRESHOLD) {
    console.warn(`[memory] HIGH DETECTION RISK (${analysis.detection_risk_score}/10) on call ${callId}. Flagged for review.`);
  }

  console.log(`[memory] Call ${callId} processed. Detection risk: ${analysis.detection_risk_score || 0}/10`);
  return analysis;
}

module.exports = { processCallWithClaude };
