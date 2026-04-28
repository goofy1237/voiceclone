module.exports = {
  RETELL_API_BASE: 'https://api.retellai.com',
  VAPI_API_BASE: 'https://api.vapi.ai',
  RECALL_API_BASE: 'https://us-east-1.recall.ai/api/v1',
  CALENDLY_API_BASE: 'https://api.calendly.com',
  TAVUS_API_BASE: 'https://tavusapi.com/v2',
  ANAM_API_BASE: 'https://api.anam.ai/v1',

  FUNNEL_STAGES: ['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'],

  DEFAULT_AGENT_PERSONALITY: 'warm, direct, curious',
  DEFAULT_AGENT_GENDER: 'female',

  // Humanness thresholds
  DETECTION_RISK_THRESHOLD: 6,

  // Timing
  MIN_RESPONSE_DELAY_MS: 800,
  MAX_RESPONSE_DELAY_MS: 1200,
};
