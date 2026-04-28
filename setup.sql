-- AI Closer Platform — Database Setup
-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/sfnwkvpnpwntmyigycrd/sql/new

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
  elevenlabs_voice_id text,
  retell_agent_id text,
  retell_llm_id text,
  retell_phone_number text,
  phone_number_provisioned_at timestamptz,
  vapi_agent_id text,
  soul_document text,
  system_prompt text,
  closing_enabled boolean DEFAULT false,
  booking_enabled boolean DEFAULT true,
  crm_enabled boolean DEFAULT true,
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
  created_at timestamptz DEFAULT now()
);

-- Enable RPC for future auto-migrations
CREATE OR REPLACE FUNCTION exec_sql(sql text) RETURNS void AS $$
BEGIN
  EXECUTE sql;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
