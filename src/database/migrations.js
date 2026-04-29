const supabase = require('./client');
const env = require('../../config/env');

async function runMigrations() {
  console.log('[migrations] Checking database tables...');

  const tables = ['clients', 'prospects', 'calls'];
  const status = {};

  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1);
    status[table] = !error;
  }

  const missing = Object.entries(status).filter(([, ok]) => !ok).map(([t]) => t);
  const found = Object.entries(status).filter(([, ok]) => ok).map(([t]) => t);

  if (found.length > 0) {
    console.log(`[migrations] Tables ready: ${found.join(', ')}`);
  }

  if (missing.length === 0) {
    console.log('[migrations] All tables ready.');
    // Run ALTER TABLE for new columns (idempotent)
    if (env.SUPABASE_ACCESS_TOKEN) {
      await runDDLviaManagementAPI(getAlterSQL()).catch(() => {});
    }
    return true;
  }

  console.log(`[migrations] Tables missing: ${missing.join(', ')}`);

  // Try Management API if access token is available
  if (env.SUPABASE_ACCESS_TOKEN) {
    console.log('[migrations] Using Supabase Management API...');
    const ok = await runDDLviaManagementAPI(getFullMigrationSQL());
    if (ok) return true;
  }

  // Try exec_sql RPC as fallback
  const { error: rpcErr } = await supabase.rpc('exec_sql', {
    sql: getFullMigrationSQL(),
  });

  if (!rpcErr) {
    console.log('[migrations] Tables created via exec_sql RPC.');
    return true;
  }

  console.log('[migrations] Auto-migration not available. Run setup.sql manually.');
  return false;
}

async function runDDLviaManagementAPI(sql) {
  try {
    const r = await fetch(
      `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ query: sql }),
      }
    );
    if (r.ok || r.status === 201) {
      console.log('[migrations] Tables created via Management API.');
      return true;
    }
    console.log(`[migrations] Management API returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return false;
  } catch (err) {
    console.log(`[migrations] Management API error: ${err.message}`);
    return false;
  }
}

function getFullMigrationSQL() {
  return `
CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name text NOT NULL,
  offer_name text,
  offer_price numeric,
  transformation text,
  target_prospect text,
  top_objections jsonb DEFAULT '[]'::jsonb,
  agent_name text NOT NULL,
  agent_gender text DEFAULT 'female',
  agent_personality text DEFAULT 'warm, direct, curious',
  personality_traits text,
  elevenlabs_voice_id text,
  retell_agent_id text,
  retell_llm_id text,
  retell_phone_number text,
  phone_number_provisioned_at timestamptz,
  vapi_agent_id text,
  soul_document text,
  soul_updated_at timestamptz,
  system_prompt text,
  closing_enabled boolean DEFAULT false,
  booking_enabled boolean DEFAULT true,
  crm_enabled boolean DEFAULT true,
  calendly_event_type_uri text,
  calendly_webhook_id text,
  base_url text,
  api_key text,
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id),
  name text,
  email text,
  phone text,
  business_name text,
  communication_style text,
  funnel_stage text DEFAULT 'lead',
  pain_points jsonb DEFAULT '{}'::jsonb,
  objections jsonb DEFAULT '{"raised":[],"resolved":[],"unresolved":[]}'::jsonb,
  buying_signals jsonb DEFAULT '[]'::jsonb,
  personal_notes jsonb DEFAULT '[]'::jsonb,
  conversation_history jsonb DEFAULT '[]'::jsonb,
  call_count integer DEFAULT 0,
  last_contact timestamptz,
  next_action text,
  next_contact_date timestamptz,
  payment_link_sent boolean DEFAULT false,
  closed_value numeric,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid REFERENCES prospects(id),
  client_id uuid REFERENCES clients(id),
  retell_call_id text,
  recall_bot_id text,
  call_type text DEFAULT 'phone',
  duration_seconds integer,
  transcript text,
  recording_url text,
  outcome text,
  claude_analysis jsonb,
  call_summary text,
  key_moments jsonb DEFAULT '[]'::jsonb,
  human_moments jsonb DEFAULT '[]'::jsonb,
  detection_risk_score integer DEFAULT 0,
  agent_performance_notes text,
  status text DEFAULT 'initiated',
  created_at timestamptz DEFAULT now()
);
  `;
}

function getAlterSQL() {
  return `
ALTER TABLE clients ADD COLUMN IF NOT EXISTS retell_llm_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS elevenlabs_voice_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS retell_phone_number text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone_number_provisioned_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS personality_traits text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS soul_updated_at timestamptz;
  `;
}

module.exports = { runMigrations, runDDLviaManagementAPI, getFullMigrationSQL, getAlterSQL };
