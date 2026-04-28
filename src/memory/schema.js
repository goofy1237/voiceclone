/**
 * Memory schema — defines the structure of prospect memory
 * used by the Claude memory processor.
 */

const MEMORY_ANALYSIS_SCHEMA = {
  updated_prospect: {
    name: 'string',
    communication_style: 'string',
    funnel_stage: 'string — one of: lead, qualified, proposal, negotiation, closed_won, closed_lost',
    pain_points: 'object — key:value pairs of identified pain points',
    objections: {
      raised: ['array of objection strings'],
      resolved: ['array of resolved objection strings'],
      unresolved: ['array of unresolved objection strings'],
    },
    buying_signals: ['array of buying signal strings'],
    personal_notes: ['array of personal detail strings — things they shared about their life'],
    next_action: 'string — what to follow up on',
    next_contact_date: 'ISO date string',
  },
  call_summary: 'string — 3 sentences, written as personal notes not a report',
  key_moments: ['array of pivotal moments in the conversation'],
  human_moments: ['array of moments of genuine human connection'],
  detection_risk_moments: ['array of moments where the AI may have sounded unnatural'],
  detection_risk_score: 'number 0-10 — 0 is completely human, 10 is obvious AI',
  objections_raised: ['array'],
  buying_signals: ['array'],
  recommended_next_action: 'string',
  next_contact_date: 'ISO string',
  agent_performance_notes: 'string',
  humanness_improvements: 'string — specific ways to improve humanness next time',
  suggested_prompt_tweaks: 'string',
};

module.exports = { MEMORY_ANALYSIS_SCHEMA };
