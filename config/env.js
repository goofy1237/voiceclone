require('dotenv').config();

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  RETELL_API_KEY: process.env.RETELL_API_KEY,
  FISH_AUDIO_API_KEY: process.env.FISH_AUDIO_API_KEY,
  RETELL_PHONE_NUMBER: process.env.RETELL_PHONE_NUMBER,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN,
  SUPABASE_PROJECT_REF: 'sfnwkvpnpwntmyigycrd',
  PORT: process.env.PORT || 3000,
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
};

// Validate required keys
const required = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

for (const key of required) {
  if (!env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

module.exports = env;
