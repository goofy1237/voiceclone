const express = require('express');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { runMigrations } = require('./src/database/migrations');
const supabase = require('./src/database/client');
const { verifyConnection } = require('./src/database/client');
const webhooks = require('./src/webhooks/index');
const { generateAndSaveSoul } = require('./src/soul/generator');
const { createRetellAgent, updateAgentForProspect, initiateOutboundCall, getRetellCallStatus } = require('./src/agents/retell');
const { createVapiAgent } = require('./src/agents/vapi');
const { deployRecallBot } = require('./src/agents/recall');
const { createTavusReplica, createTavusPersona, createTavusConversation, endTavusConversation, getTavusConversationStatus } = require('./src/agents/tavus');
const { buildSystemPrompt } = require('./src/prompts/builder');
const { RETELL_API_BASE } = require('./config/constants');
const { apiKeyAuth, enforceClientIsolation } = require('./src/middleware/auth');
const multer = require('multer');
const upload = multer({ dest: '/tmp/tavus-uploads/' });
const { WebSocketServer } = require('ws');
const { createAnamPersona } = require('./src/video/anam');
const orchestrator = require('./src/video/orchestrator');
const { listRooms } = require('./src/video/livekit');

// ============================================================
//  ENV VAR CHECK — fail fast on hard-required, warn on optional
// ============================================================
function checkHardRequiredEnvVars(keys) {
  const missing = keys.filter(k => !env[k] && !process.env[k]);
  if (missing.length > 0) {
    console.error('\n===================================');
    console.error('  MISSING ENVIRONMENT VARIABLES');
    console.error('===================================');
    missing.forEach(k => console.error(`  - ${k}`));
    console.error('\nSet these before starting the server.');
    console.error('===================================\n');
    process.exit(1);
  }
}

function checkSoftRequiredEnvVars(groups) {
  const missingLines = [];
  for (const { keys, feature } of groups) {
    const missing = keys.filter(k => !env[k] && !process.env[k]);
    if (missing.length > 0) {
      missingLines.push({ keys: missing, feature });
    }
  }
  if (missingLines.length > 0) {
    console.warn('\n===================================');
    console.warn('  OPTIONAL ENV VARS MISSING');
    console.warn('===================================');
    missingLines.forEach(({ keys, feature }) => {
      console.warn(`  - ${keys.join(', ')} → ${feature}`);
    });
    console.warn('\nServer will start, but the listed features are disabled.');
    console.warn('===================================\n');
  }
}

checkHardRequiredEnvVars([
  'ANTHROPIC_API_KEY',
  'RETELL_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]);

checkSoftRequiredEnvVars([
  { keys: ['VAPI_API_KEY'], feature: 'Vapi agent creation will be skipped' },
  { keys: ['ELEVENLABS_API_KEY'], feature: 'ElevenLabs voices unavailable, using Retell built-in voices only' },
  { keys: ['RECALL_API_KEY'], feature: 'Google Meet bot disabled' },
  { keys: ['TAVUS_API_KEY'], feature: 'Video avatars disabled' },
  { keys: ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL'], feature: 'Hyper-real video sessions disabled' },
]);

// ============================================================
//  GLOBAL ERROR HANDLERS
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  // In production, log but don't exit — let the process manager restart if needed
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// ============================================================
//  EXPRESS APP SETUP
// ============================================================
const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
  origin: [
    env.BASE_URL,
    'http://localhost:3000',
    'http://localhost:3001',
  ].filter(Boolean),
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-API-Key'],
}));

// Request logging
if (env.NODE_ENV === 'production') {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}

// Rate limiting — general
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Rate limiting — webhooks (higher limit)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Webhook rate limit exceeded.' },
});

// Apply rate limiting
app.use('/webhooks', webhookLimiter);
app.use(generalLimiter);

// Body parsing
app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Mount webhooks
app.use('/webhooks', webhooks);

// ============================================================
//  HEALTH CHECK — deep service verification
// ============================================================
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: require('./package.json').version,
    uptime: process.uptime(),
    services: {
      supabase: 'error',
      retell: 'error',
      livekit: 'error',
      redis: 'unavailable',
    },
  };

  // Check Supabase
  try {
    const { error } = await supabase.from('clients').select('id').limit(1);
    health.services.supabase = error ? 'error' : 'connected';
  } catch (e) {
    health.services.supabase = 'error';
  }

  // Check Retell
  try {
    const r = await axios.get(`${RETELL_API_BASE}/list-agents`, {
      headers: { 'Authorization': `Bearer ${env.RETELL_API_KEY}` },
      timeout: 5000,
    });
    health.services.retell = r.status === 200 ? 'connected' : 'error';
  } catch (e) {
    health.services.retell = 'error';
  }

  // Check LiveKit
  try {
    const rooms = await listRooms();
    health.services.livekit = Array.isArray(rooms) ? 'connected' : 'error';
  } catch (e) {
    health.services.livekit = 'error';
  }

  // Check Redis (Upstash HTTP REST — optional)
  try {
    const upstash = require('./src/lib/upstash-redis');
    if (upstash.isAvailable()) {
      const pong = await upstash.ping();
      health.services.redis = pong === 'PONG' ? 'connected' : 'unavailable';
    } else {
      health.services.redis = 'not configured';
    }
  } catch (e) {
    health.services.redis = 'unavailable';
  }

  // If Supabase is down, the whole platform is down
  if (health.services.supabase !== 'connected') {
    health.status = 'degraded';
    return res.status(503).json(health);
  }

  res.json(health);
});

// ============================================================
//  DASHBOARD ROUTES — serve HTML pages
// ============================================================
app.get('/dashboard', (req, res) => {
  res.sendFile('dashboard/team.html', { root: path.join(__dirname, 'public') });
});

app.get('/dashboard/signup', (req, res) => {
  res.sendFile('dashboard/signup.html', { root: path.join(__dirname, 'public') });
});

app.get('/dashboard/:clientId', (req, res) => {
  // Don't match 'signup' as a clientId
  if (req.params.clientId === 'signup') {
    return res.sendFile('dashboard/signup.html', { root: path.join(__dirname, 'public') });
  }
  res.sendFile('dashboard/client.html', { root: path.join(__dirname, 'public') });
});

app.get('/dashboard/:clientId/prospect/:prospectId', (req, res) => {
  res.sendFile('dashboard/prospect.html', { root: path.join(__dirname, 'public') });
});

app.get('/dashboard/:clientId/calls/:callId', (req, res) => {
  res.sendFile('dashboard/call.html', { root: path.join(__dirname, 'public') });
});

// ============================================================
// POST /clients — Full onboarding: soul + agents + save + api_key
// ============================================================
app.post('/clients', async (req, res) => {
  try {
    const clientData = req.body;
    if (!clientData.business_name || !clientData.agent_name) {
      return res.status(400).json({ error: 'business_name and agent_name are required' });
    }

    // Generate API key for multi-tenant auth
    clientData.api_key = crypto.randomUUID();
    clientData.base_url = env.BASE_URL;

    const { data: client, error } = await supabase
      .from('clients')
      .insert(clientData)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    console.log(`[server] Client created: ${client.id} — ${client.business_name}`);

    const soul = await generateAndSaveSoul(client.id);
    console.log(`[server] Soul generated: ${soul.identity?.full_name}`);

    const systemPrompt = await buildSystemPrompt(client.id, null);
    await supabase.from('clients').update({ system_prompt: systemPrompt }).eq('id', client.id);

    let retellResult = null;
    try { retellResult = await createRetellAgent(client.id); }
    catch (err) { console.error('[server] Retell:', err.message); }

    let vapiResult = null;
    try { vapiResult = await createVapiAgent(client.id); }
    catch (err) { console.error('[server] Vapi:', err.message); }

    const { data: finalClient } = await supabase
      .from('clients').select('*').eq('id', client.id).single();

    // Log structured welcome message (onboarding email placeholder)
    console.log('\n========================================');
    console.log('  WELCOME — New Client Onboarded');
    console.log('========================================');
    console.log(`  Agent Name:    ${finalClient.agent_name}`);
    console.log(`  Business:      ${finalClient.business_name}`);
    console.log(`  Client ID:     ${finalClient.id}`);
    console.log(`  API Key:       ${finalClient.api_key}`);
    console.log(`  Webhook URL:   ${env.BASE_URL}/webhooks/retell`);
    console.log(`  Dashboard:     ${env.BASE_URL}/dashboard/${finalClient.id}`);
    console.log(`  Retell Agent:  ${retellResult?.agent_id || 'not configured'}`);
    console.log(`  Vapi Agent:    ${vapiResult?.id || 'not configured'}`);
    console.log('========================================\n');

    res.json({
      client: finalClient,
      soul: soul.identity?.full_name,
      retell_agent_id: retellResult?.agent_id || null,
      vapi_agent_id: vapiResult?.id || null,
    });
  } catch (err) {
    console.error('[server] Client creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /clients/:clientId/calendly — setup Calendly webhook
// ============================================================
app.post('/clients/:clientId/calendly', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { event_type_uri } = req.body;

    if (!event_type_uri) {
      return res.status(400).json({ error: 'event_type_uri is required' });
    }

    // Save event type URI
    await supabase.from('clients').update({
      calendly_event_type_uri: event_type_uri,
    }).eq('id', clientId);

    // Register Calendly webhook subscription
    let webhookId = null;
    if (env.CALENDLY_API_KEY) {
      try {
        // Get organization URI
        const userRes = await axios.get('https://api.calendly.com/users/me', {
          headers: { 'Authorization': `Bearer ${env.CALENDLY_API_KEY}` },
        });
        const orgUri = userRes.data.resource.current_organization;

        const webhookRes = await axios.post('https://api.calendly.com/webhook_subscriptions', {
          url: `${env.BASE_URL}/webhooks/calendly`,
          events: ['invitee.created'],
          organization: orgUri,
          scope: 'organization',
        }, {
          headers: {
            'Authorization': `Bearer ${env.CALENDLY_API_KEY}`,
            'Content-Type': 'application/json',
          },
        });

        webhookId = webhookRes.data.resource?.uri || webhookRes.data.uri;
        console.log(`[server] Calendly webhook registered: ${webhookId}`);
      } catch (err) {
        console.warn('[server] Calendly webhook registration failed:', err.response?.data?.message || err.message);
      }
    }

    if (webhookId) {
      await supabase.from('clients').update({ calendly_webhook_id: webhookId }).eq('id', clientId);
    }

    res.json({
      clientId,
      event_type_uri,
      calendly_webhook_id: webhookId,
      webhook_url: `${env.BASE_URL}/webhooks/calendly`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /clients/:clientId/prompt/:prospectId — Live stitched prompt
// ============================================================
app.get('/clients/:clientId/prompt/:prospectId', async (req, res) => {
  try {
    const { clientId, prospectId } = req.params;
    const prompt = await buildSystemPrompt(clientId, prospectId === 'none' ? null : prospectId);
    res.json({ clientId, prospectId: prospectId === 'none' ? null : prospectId, promptLength: prompt.length, prompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /prospects/:prospectId/memory — Full memory record
// ============================================================
app.get('/prospects/:prospectId/memory', async (req, res) => {
  try {
    const { prospectId } = req.params;
    const { data: prospect, error } = await supabase
      .from('prospects').select('*').eq('id', prospectId).single();
    if (error || !prospect) return res.status(404).json({ error: 'Prospect not found' });

    const { data: calls } = await supabase
      .from('calls')
      .select('id, call_type, duration_seconds, call_summary, key_moments, human_moments, detection_risk_score, status, created_at')
      .eq('prospect_id', prospectId)
      .order('created_at', { ascending: true });

    res.json({ prospect, calls: calls || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /calls/phone/:prospectId — Retell outbound call
// ============================================================
app.post('/calls/phone/:prospectId', async (req, res) => {
  try {
    const { prospectId } = req.params;
    const { phone_number } = req.body || {};

    const { data: prospect } = await supabase
      .from('prospects')
      .select('client_id, phone, name')
      .eq('id', prospectId)
      .single();

    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    const phoneToUse = phone_number || prospect.phone;
    if (!phoneToUse) {
      return res.status(400).json({ error: 'No phone number provided and prospect has no phone on file. Pass phone_number in request body.' });
    }

    // Update prospect phone if override provided
    if (phone_number && phone_number !== prospect.phone) {
      await supabase.from('prospects').update({ phone: phone_number }).eq('id', prospectId);
    }

    try {
      const result = await initiateOutboundCall(prospectId, prospect.client_id, phoneToUse);
      res.json(result);
    } catch (err) {
      console.error('[server] Retell call failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  } catch (err) {
    console.error('[server] Phone call failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /calls/quick — Quick call from dashboard "Call Me Now"
// ============================================================
app.post('/calls/quick', async (req, res) => {
  try {
    const { client_id, phone_number, prospect_name } = req.body;

    if (!client_id || !phone_number) {
      return res.status(400).json({ error: 'client_id and phone_number are required' });
    }

    // Check if RETELL_PHONE_NUMBER is set
    const retellPhone = env.RETELL_PHONE_NUMBER || process.env.RETELL_PHONE_NUMBER;
    if (!retellPhone) {
      return res.status(400).json({
        error: 'RETELL_PHONE_NUMBER not configured',
        message: 'Go to app.retellai.com → Phone Numbers → Buy a number → then add RETELL_PHONE_NUMBER to your Railway env vars.',
        setup_required: true,
      });
    }

    // Verify client exists
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('id, retell_agent_id, agent_name')
      .eq('id', client_id)
      .single();

    if (clientErr || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (!client.retell_agent_id) {
      return res.status(400).json({ error: 'No Retell agent configured for this client' });
    }

    // Find or create prospect
    let prospect;
    const { data: existing } = await supabase
      .from('prospects')
      .select('*')
      .eq('client_id', client_id)
      .eq('phone', phone_number)
      .single();

    if (existing) {
      prospect = existing;
    } else {
      const { data: newProspect, error: pErr } = await supabase
        .from('prospects')
        .insert({
          client_id,
          name: prospect_name || 'Test Call',
          phone: phone_number,
          funnel_stage: 'lead',
        })
        .select()
        .single();

      if (pErr) {
        return res.status(500).json({ error: 'Failed to create prospect: ' + pErr.message });
      }
      prospect = newProspect;
    }

    // Initiate the call
    const result = await initiateOutboundCall(prospect.id, client_id, phone_number);

    res.json({
      ...result,
      prospect_id: prospect.id,
      prospect_name: prospect.name,
    });
  } catch (err) {
    console.error('[quick-call] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /calls/:callId/status — Live call status polling
// ============================================================
app.get('/calls/:callId/status', async (req, res) => {
  try {
    const { callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .single();

    if (error || !call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    let retellStatus = null;
    if (call.retell_call_id) {
      retellStatus = await getRetellCallStatus(call.retell_call_id);
    }

    // Map status
    let status = call.status || 'unknown';
    if (retellStatus) {
      const rStatus = retellStatus.call_status || retellStatus.status;
      if (rStatus === 'registered' || rStatus === 'ongoing') status = 'in_progress';
      else if (rStatus === 'ended') status = call.claude_analysis ? 'complete' : 'processing';
      else if (rStatus === 'error') status = 'error';
    }

    res.json({
      call_id: call.id,
      status,
      duration_seconds: retellStatus?.end_timestamp && retellStatus?.start_timestamp
        ? Math.round((retellStatus.end_timestamp - retellStatus.start_timestamp) / 1000)
        : call.duration_seconds || null,
      transcript_ready: !!(call.transcript || retellStatus?.transcript),
      claude_analysis: call.claude_analysis || null,
      detection_risk_score: call.detection_risk_score || null,
      retell_status: retellStatus?.call_status || retellStatus?.status || null,
    });
  } catch (err) {
    console.error('[call-status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  TEAM DASHBOARD API — aggregate endpoints for admin view
// ============================================================

// GET /api/team/clients — all clients
app.get('/api/team/clients', async (req, res) => {
  try {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, agent_name, business_name, retell_agent_id, vapi_agent_id, elevenlabs_voice_id, video_mode, created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Get call counts per client
    const clientIds = (clients || []).map(c => c.id);
    let callCounts = {};
    let lastCallDates = {};

    if (clientIds.length > 0) {
      const { data: calls } = await supabase
        .from('calls')
        .select('client_id, created_at')
        .in('client_id', clientIds)
        .order('created_at', { ascending: false });

      if (calls) {
        calls.forEach(c => {
          callCounts[c.client_id] = (callCounts[c.client_id] || 0) + 1;
          if (!lastCallDates[c.client_id]) lastCallDates[c.client_id] = c.created_at;
        });
      }
    }

    const enriched = (clients || []).map(c => ({
      ...c,
      call_count: callCounts[c.id] || 0,
      last_call_date: lastCallDates[c.id] || null,
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team/stats — aggregate stats across all clients
app.get('/api/team/stats', async (req, res) => {
  try {
    const { count: totalAgents } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true });

    const { count: totalCalls } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true });

    const { count: totalProspects } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true });

    const { data: riskData } = await supabase
      .from('calls')
      .select('detection_risk_score')
      .not('detection_risk_score', 'is', null);

    let avgDetectionRisk = null;
    if (riskData && riskData.length > 0) {
      const sum = riskData.reduce((acc, r) => acc + (r.detection_risk_score || 0), 0);
      avgDetectionRisk = (sum / riskData.length).toFixed(1);
    }

    res.json({
      total_agents: totalAgents || 0,
      total_calls: totalCalls || 0,
      total_prospects: totalProspects || 0,
      avg_detection_risk: avgDetectionRisk,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team/calls — recent calls across all clients
app.get('/api/team/calls', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const { data: calls, error } = await supabase
      .from('calls')
      .select('id, prospect_id, client_id, call_type, duration_seconds, outcome, detection_risk_score, call_summary, claude_analysis, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    // Enrich with prospect and client names
    const prospectIds = [...new Set((calls || []).filter(c => c.prospect_id).map(c => c.prospect_id))];
    const clientIds = [...new Set((calls || []).filter(c => c.client_id).map(c => c.client_id))];

    let prospectMap = {};
    let clientMap = {};

    if (prospectIds.length > 0) {
      const { data: prospects } = await supabase.from('prospects').select('id, name').in('id', prospectIds);
      if (prospects) prospects.forEach(p => { prospectMap[p.id] = p.name; });
    }

    if (clientIds.length > 0) {
      const { data: clients } = await supabase.from('clients').select('id, agent_name').in('id', clientIds);
      if (clients) clients.forEach(c => { clientMap[c.id] = c.agent_name; });
    }

    const enriched = (calls || []).map(c => ({
      ...c,
      prospect_name: prospectMap[c.prospect_id] || 'Unknown',
      agent_name: clientMap[c.client_id] || 'Unknown',
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team/prospects — all prospects across all clients
app.get('/api/team/prospects', async (req, res) => {
  try {
    const { data: prospects, error } = await supabase
      .from('prospects')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    res.json(prospects || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /calls/meet — Deploy Recall bot
// ============================================================
app.post('/calls/meet', async (req, res) => {
  try {
    const { meetUrl, prospectId, clientId } = req.body;
    if (!meetUrl || !prospectId || !clientId) {
      return res.status(400).json({ error: 'meetUrl, prospectId, and clientId are required' });
    }
    const result = await deployRecallBot(meetUrl, prospectId, clientId);
    res.json(result);
  } catch (err) {
    console.error('[server] Meet bot deployment failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SPRINT 6 — HYPER-REAL VIDEO ENDPOINTS
// ============================================================

// POST /clients/:clientId/anam/persona — create Anam CARA-3 persona
app.post('/clients/:clientId/anam/persona', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await createAnamPersona(clientId);
    res.json(result);
  } catch (err) {
    console.error('[server] Anam persona failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST /clients/:clientId/render-mode — set render engine
app.post('/clients/:clientId/render-mode', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { render_mode } = req.body;
    const validModes = ['phoenix_4', 'anam_cara3'];
    if (!validModes.includes(render_mode)) {
      return res.status(400).json({ error: `Invalid render_mode. Must be one of: ${validModes.join(', ')}` });
    }
    const { data: client, error } = await supabase
      .from('clients')
      .update({ render_mode })
      .eq('id', clientId)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    console.log(`[server] Client ${clientId} render mode set to: ${render_mode}`);
    res.json({ clientId, render_mode: client.render_mode, client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /calls/hyper-real/:prospectId — start hyper-real video session
app.post('/calls/hyper-real/:prospectId', async (req, res) => {
  try {
    const { prospectId } = req.params;
    const { meetUrl } = req.body || {};

    const { data: prospect } = await supabase
      .from('prospects')
      .select('client_id')
      .eq('id', prospectId)
      .single();
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    const { data: client } = await supabase
      .from('clients')
      .select('render_mode, tavus_replica_id, tavus_persona_id')
      .eq('id', prospect.client_id)
      .single();

    const renderMode = client?.render_mode || 'phoenix_4';
    const session = await orchestrator.startVideoSession(prospect.client_id, prospectId, meetUrl, renderMode);
    res.json({
      sessionId: session.sessionId,
      liveKitCompositeUrl: session.liveKitCompositeUrl,
      videoStreamUrl: session.videoStreamUrl,
      renderMode: session.renderMode,
      room_name: session.room_name,
    });
  } catch (err) {
    console.error('[server] Hyper-real session failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions/:sessionId/status — session status
app.get('/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = orchestrator.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId: session.sessionId,
    renderMode: session.renderMode,
    ravenActive: session.ravenActive,
    status: session.status,
    elapsed: Date.now() - session.startTime,
    room_name: session.room_name,
    videoStreamUrl: session.videoStreamUrl,
  });
});

// POST /webhooks/livekit — LiveKit room events
app.post('/webhooks/livekit', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const event = req.body;
    const eventType = event.event || '';
    console.log(`[webhook:livekit] Event: ${eventType}`);

    if (eventType === 'participant_joined' && event.sessionId) {
      await orchestrator.handleProspectJoined(event.sessionId, event.videoTrack);
    } else if (eventType === 'room_finished' && event.sessionId) {
      await orchestrator.endVideoSession(event.sessionId);
    }
  } catch (err) {
    console.error('[webhook:livekit] Error:', err.message);
  }
});

// ============================================================
//  SPRINT 5 — TAVUS VIDEO ENDPOINTS
// ============================================================

// POST /clients/:clientId/tavus/replica — upload training video
app.post('/clients/:clientId/tavus/replica', upload.single('video'), async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded. Use multipart form with field name "video".' });
    }
    const result = await createTavusReplica(clientId, req.file.path);
    res.json(result);
  } catch (err) {
    console.error('[server] Tavus replica failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST /clients/:clientId/tavus/persona — create Tavus persona
app.post('/clients/:clientId/tavus/persona', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await createTavusPersona(clientId);
    res.json(result);
  } catch (err) {
    console.error('[server] Tavus persona failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST /clients/:clientId/video-mode — set video mode
app.post('/clients/:clientId/video-mode', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { video_mode } = req.body;

    const validModes = ['voice_only', 'video_avatar', 'video_recall', 'video_recall_v2'];
    if (!validModes.includes(video_mode)) {
      return res.status(400).json({ error: `Invalid video_mode. Must be one of: ${validModes.join(', ')}` });
    }

    const { data: client, error } = await supabase
      .from('clients')
      .update({ video_mode })
      .eq('id', clientId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    console.log(`[server] Client ${clientId} video mode set to: ${video_mode}`);
    res.json({ clientId, video_mode: client.video_mode, client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /calls/video/:prospectId — create Tavus video conversation
app.post('/calls/video/:prospectId', async (req, res) => {
  try {
    const { prospectId } = req.params;

    const { data: prospect } = await supabase
      .from('prospects')
      .select('client_id, name')
      .eq('id', prospectId)
      .single();

    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    const { data: client } = await supabase
      .from('clients')
      .select('tavus_replica_id, tavus_persona_id, video_mode')
      .eq('id', prospect.client_id)
      .single();

    if (!client?.tavus_replica_id || !client?.tavus_persona_id) {
      return res.status(400).json({ error: 'Tavus not configured for this client. Create a replica and persona first.' });
    }

    const result = await createTavusConversation(prospect.client_id, prospectId);
    res.json({
      conversation_id: result.conversation_id,
      conversation_url: result.conversation_url,
      call: result.call,
    });
  } catch (err) {
    console.error('[server] Tavus video call failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// GET /calls/:callId/video-status — poll Tavus conversation status
app.get('/calls/:callId/video-status', async (req, res) => {
  try {
    const { callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls')
      .select('conversation_id, status')
      .eq('id', callId)
      .single();

    if (error || !call) return res.status(404).json({ error: 'Call not found' });
    if (!call.conversation_id) return res.status(400).json({ error: 'Not a video call' });

    const convo = await getTavusConversationStatus(call.conversation_id);

    res.json({
      status: convo.status || call.status,
      duration: convo.conversation_length || convo.duration || null,
      transcript_ready: !!(convo.transcript),
      conversation: convo,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ============================================================
//  NEW SPRINT 4 API ENDPOINTS — /api/ prefix
//  Dashboard pages call these; authenticated routes use apiKeyAuth
// ============================================================

// GET /api/clients/:clientId/info — client basic info (for dashboard)
app.get('/api/clients/:clientId/info', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/stats — aggregate stats
app.get('/api/clients/:clientId/stats', async (req, res) => {
  try {
    const { clientId } = req.params;

    // Total calls
    const { count: totalCalls, error: callsErr } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);

    if (callsErr) {
      console.error('[stats] calls count error:', callsErr.message);
    }

    // Closed deals (prospects with funnel_stage = 'closed_won')
    const { count: closedDeals, error: dealsErr } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('funnel_stage', 'closed_won');

    if (dealsErr) {
      console.error('[stats] closed deals error:', dealsErr.message);
    }

    // Average detection risk score
    const { data: riskData, error: riskErr } = await supabase
      .from('calls')
      .select('detection_risk_score')
      .eq('client_id', clientId)
      .not('detection_risk_score', 'is', null);

    let avgDetectionRisk = null;
    if (!riskErr && riskData && riskData.length > 0) {
      const sum = riskData.reduce((acc, r) => acc + (r.detection_risk_score || 0), 0);
      avgDetectionRisk = (sum / riskData.length).toFixed(1);
    }

    // Total pipeline value (sum of closed_value from prospects)
    const { data: pipelineData, error: pipelineErr } = await supabase
      .from('prospects')
      .select('closed_value')
      .eq('client_id', clientId)
      .not('closed_value', 'is', null);

    let totalPipelineValue = 0;
    if (!pipelineErr && pipelineData) {
      totalPipelineValue = pipelineData.reduce((acc, p) => acc + (parseFloat(p.closed_value) || 0), 0);
    }

    res.json({
      total_calls: totalCalls || 0,
      closed_deals: closedDeals || 0,
      avg_detection_risk: avgDetectionRisk,
      total_pipeline_value: totalPipelineValue,
    });
  } catch (err) {
    console.error('[stats] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/calls — paginated call history
app.get('/api/clients/:clientId/calls', async (req, res) => {
  try {
    const { clientId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    // Get total count
    const { count: total } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);

    // Get paginated calls with prospect name
    const { data: calls, error } = await supabase
      .from('calls')
      .select(`
        id,
        prospect_id,
        call_type,
        duration_seconds,
        outcome,
        detection_risk_score,
        call_summary,
        status,
        created_at,
        prospects!inner(name)
      `)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      // If inner join fails (calls without prospects), retry with left join
      const { data: callsFallback, error: fallbackErr } = await supabase
        .from('calls')
        .select(`
          id,
          prospect_id,
          call_type,
          duration_seconds,
          outcome,
          detection_risk_score,
          call_summary,
          status,
          created_at
        `)
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (fallbackErr) {
        return res.status(500).json({ error: fallbackErr.message });
      }

      // Manually fetch prospect names
      const prospectIds = [...new Set((callsFallback || []).filter(c => c.prospect_id).map(c => c.prospect_id))];
      let prospectMap = {};
      if (prospectIds.length > 0) {
        const { data: prospects } = await supabase
          .from('prospects')
          .select('id, name')
          .in('id', prospectIds);
        if (prospects) {
          prospects.forEach(p => { prospectMap[p.id] = p.name; });
        }
      }

      const formatted = (callsFallback || []).map(c => ({
        ...c,
        prospect_name: prospectMap[c.prospect_id] || null,
      }));

      return res.json({ calls: formatted, total: total || 0, page, limit });
    }

    // Format response — extract prospect name from join
    const formatted = (calls || []).map(c => {
      const { prospects: prospectData, ...callFields } = c;
      return {
        ...callFields,
        prospect_name: prospectData?.name || null,
      };
    });

    res.json({ calls: formatted, total: total || 0, page, limit });
  } catch (err) {
    console.error('[calls] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/prospects — all prospects
app.get('/api/clients/:clientId/prospects', async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: prospects, error } = await supabase
      .from('prospects')
      .select('*')
      .eq('client_id', clientId)
      .order('last_contact', { ascending: false, nullsFirst: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json(prospects || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:clientId/prospects — create prospect
app.post('/api/clients/:clientId/prospects', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, phone, email, pain_points, funnel_stage } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data: prospect, error } = await supabase
      .from('prospects')
      .insert({
        client_id: clientId,
        name,
        phone: phone || null,
        email: email || null,
        pain_points: pain_points || null,
        funnel_stage: funnel_stage || 'lead',
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(prospect);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/:callId/full — full call detail
app.get('/api/calls/:callId/full', async (req, res) => {
  try {
    const { callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .single();

    if (error || !call) return res.status(404).json({ error: 'Call not found' });

    // Verify the call belongs to the requesting client if X-API-Key is provided
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('api_key', apiKey)
        .single();

      if (client && call.client_id !== client.id) {
        return res.status(403).json({ error: 'Access denied: call does not belong to this client' });
      }
    }

    // Get prospect name
    let prospectName = null;
    if (call.prospect_id) {
      const { data: prospect } = await supabase
        .from('prospects')
        .select('name')
        .eq('id', call.prospect_id)
        .single();
      prospectName = prospect?.name || null;
    }

    res.json({
      call: {
        ...call,
        prospect_name: prospectName,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/prompt/preview — agent prompt preview (null prospect)
app.get('/api/clients/:clientId/prompt/preview', async (req, res) => {
  try {
    const { clientId } = req.params;
    const prompt = await buildSystemPrompt(clientId, null);
    res.json({
      clientId,
      prospectId: null,
      promptLength: prompt.length,
      prompt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/test — test call (creates records without calling Retell)
app.post('/api/calls/test', async (req, res) => {
  try {
    const { clientId, phoneNumber } = req.body;

    if (!clientId || !phoneNumber) {
      return res.status(400).json({ error: 'clientId and phoneNumber are required' });
    }

    // Verify client exists
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('id, agent_name, business_name')
      .eq('id', clientId)
      .single();

    if (clientErr || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Check if test prospect already exists for this phone + client
    let prospect = null;
    const { data: existing } = await supabase
      .from('prospects')
      .select('*')
      .eq('client_id', clientId)
      .eq('phone', phoneNumber)
      .single();

    if (existing) {
      prospect = existing;
    } else {
      // Create test prospect
      const { data: newProspect, error: prospectErr } = await supabase
        .from('prospects')
        .insert({
          client_id: clientId,
          name: 'Test Prospect',
          phone: phoneNumber,
          funnel_stage: 'lead',
        })
        .select()
        .single();

      if (prospectErr) {
        return res.status(500).json({ error: 'Failed to create test prospect: ' + prospectErr.message });
      }
      prospect = newProspect;
    }

    // Create test call record (no actual Retell call)
    const { data: callRecord, error: callErr } = await supabase
      .from('calls')
      .insert({
        prospect_id: prospect.id,
        client_id: clientId,
        call_type: 'phone',
        status: 'test',
        call_summary: 'Test call initiated from dashboard',
      })
      .select()
      .single();

    if (callErr) {
      return res.status(500).json({ error: 'Failed to create test call: ' + callErr.message });
    }

    console.log(`[test-call] Test call created for client ${clientId}, prospect ${prospect.id}`);

    res.json({
      prospect,
      call: callRecord,
      message: 'Test call created (no actual phone call placed)',
    });
  } catch (err) {
    console.error('[test-call] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/:prospectId/memory — proxy for dashboard (same as existing)
app.get('/api/prospects/:prospectId/memory', async (req, res) => {
  try {
    const { prospectId } = req.params;
    const { data: prospect, error } = await supabase
      .from('prospects').select('*').eq('id', prospectId).single();
    if (error || !prospect) return res.status(404).json({ error: 'Prospect not found' });

    const { data: calls } = await supabase
      .from('calls')
      .select('id, call_type, duration_seconds, call_summary, key_moments, human_moments, detection_risk_score, status, created_at')
      .eq('prospect_id', prospectId)
      .order('created_at', { ascending: true });

    res.json({ prospect, calls: calls || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  AUTHENTICATED API ENDPOINTS (require X-API-Key)
//  These mirror the above but enforce multi-tenant isolation
// ============================================================
app.get('/api/secure/clients/:clientId/stats', apiKeyAuth, enforceClientIsolation, async (req, res) => {
  try {
    const { clientId } = req.params;

    const { count: totalCalls } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);

    const { count: closedDeals } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('funnel_stage', 'closed_won');

    const { data: riskData } = await supabase
      .from('calls')
      .select('detection_risk_score')
      .eq('client_id', clientId)
      .not('detection_risk_score', 'is', null);

    let avgDetectionRisk = null;
    if (riskData && riskData.length > 0) {
      const sum = riskData.reduce((acc, r) => acc + (r.detection_risk_score || 0), 0);
      avgDetectionRisk = (sum / riskData.length).toFixed(1);
    }

    const { data: pipelineData } = await supabase
      .from('prospects')
      .select('closed_value')
      .eq('client_id', clientId)
      .not('closed_value', 'is', null);

    let totalPipelineValue = 0;
    if (pipelineData) {
      totalPipelineValue = pipelineData.reduce((acc, p) => acc + (parseFloat(p.closed_value) || 0), 0);
    }

    res.json({
      total_calls: totalCalls || 0,
      closed_deals: closedDeals || 0,
      avg_detection_risk: avgDetectionRisk,
      total_pipeline_value: totalPipelineValue,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/secure/clients/:clientId/calls', apiKeyAuth, enforceClientIsolation, async (req, res) => {
  try {
    const { clientId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const { count: total } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);

    const { data: calls, error } = await supabase
      .from('calls')
      .select('id, prospect_id, call_type, duration_seconds, outcome, detection_risk_score, call_summary, status, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });

    // Fetch prospect names
    const prospectIds = [...new Set((calls || []).filter(c => c.prospect_id).map(c => c.prospect_id))];
    let prospectMap = {};
    if (prospectIds.length > 0) {
      const { data: prospects } = await supabase
        .from('prospects')
        .select('id, name')
        .in('id', prospectIds);
      if (prospects) {
        prospects.forEach(p => { prospectMap[p.id] = p.name; });
      }
    }

    const formatted = (calls || []).map(c => ({
      ...c,
      prospect_name: prospectMap[c.prospect_id] || null,
    }));

    res.json({ calls: formatted, total: total || 0, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/secure/clients/:clientId/prospects', apiKeyAuth, enforceClientIsolation, async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: prospects, error } = await supabase
      .from('prospects')
      .select('*')
      .eq('client_id', clientId)
      .order('last_contact', { ascending: false, nullsFirst: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(prospects || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/secure/calls/:callId/full', apiKeyAuth, async (req, res) => {
  try {
    const { callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .single();

    if (error || !call) return res.status(404).json({ error: 'Call not found' });

    // Enforce tenant isolation
    if (call.client_id !== req.client.id) {
      return res.status(403).json({ error: 'Access denied: call does not belong to this client' });
    }

    let prospectName = null;
    if (call.prospect_id) {
      const { data: prospect } = await supabase
        .from('prospects')
        .select('name')
        .eq('id', call.prospect_id)
        .single();
      prospectName = prospect?.name || null;
    }

    res.json({
      call: {
        ...call,
        prospect_name: prospectName,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GLOBAL ERROR HANDLER — must be last middleware
// ============================================================
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
//  ADMIN — runtime config (secured by Supabase service role key)
// ============================================================
app.post('/admin/config', async (req, res) => {
  const authKey = req.headers['x-admin-key'];
  if (authKey !== env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const { key, value } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'key and value required' });
  const allowedKeys = ['RETELL_PHONE_NUMBER'];
  if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Key not allowed' });
  process.env[key] = value;
  env[key] = value;
  console.log(`[admin] Runtime config set: ${key}=${value}`);
  res.json({ ok: true, key, message: 'Set at runtime. Will reset on next deploy.' });
});

// ============================================================
//  START SERVER
// ============================================================
async function start() {
  console.log('\n========================================');
  console.log('  AI CLOSER PLATFORM — Starting...');
  console.log('========================================\n');

  // Verify database connection
  await verifyConnection();

  // Run migrations
  await runMigrations();

  // Load training data into memory for zero-latency prompt injection
  try {
    const { initTrainingCache } = require('./src/training/cache');
    initTrainingCache();
  } catch (err) {
    console.log('[server] Training cache not available:', err.message);
  }

  const server = app.listen(env.PORT, () => {
    console.log('\n===================================');
    console.log('  AI Closer Platform — LIVE');
    console.log('===================================');
    console.log(`  Server:    http://localhost:${env.PORT}`);
    console.log(`  Env:       ${env.NODE_ENV}`);
    console.log(`  Supabase:  connected`);
    console.log(`  Retell:    connected`);
    console.log(`  Vapi:      connected`);
    console.log(`  Tavus:     connected`);
    console.log(`  LiveKit:   connected`);
    console.log(`  Webhooks:  /webhooks/*`);
    console.log(`  Dashboard: /dashboard`);
    console.log('===================================\n');

    console.log(`[server] Endpoints:`);
    console.log(`  POST   /clients`);
    console.log(`  POST   /clients/:id/calendly`);
    console.log(`  GET    /clients/:id/prompt/:prospectId`);
    console.log(`  GET    /prospects/:id/memory`);
    console.log(`  POST   /calls/phone/:prospectId`);
    console.log(`  POST   /calls/meet`);
    console.log(`[server] Sprint 6 Hyper-Real:`);
    console.log(`  POST   /clients/:id/anam/persona`);
    console.log(`  POST   /clients/:id/render-mode`);
    console.log(`  POST   /calls/hyper-real/:prospectId`);
    console.log(`  GET    /sessions/:id/status`);
    console.log(`  POST   /webhooks/livekit`);
    console.log(`  WS     /ws/video/:sessionId`);
    console.log(`[server] Sprint 5 Tavus:`);
    console.log(`  POST   /clients/:id/tavus/replica`);
    console.log(`  POST   /clients/:id/tavus/persona`);
    console.log(`  POST   /clients/:id/video-mode`);
    console.log(`  POST   /calls/video/:prospectId`);
    console.log(`  GET    /calls/:id/video-status`);
    console.log(`[server] Sprint 4 API:`);
    console.log(`  GET    /api/clients/:id/stats`);
    console.log(`  GET    /api/clients/:id/calls`);
    console.log(`  GET    /api/clients/:id/prospects`);
    console.log(`  GET    /api/clients/:id/info`);
    console.log(`  GET    /api/clients/:id/prompt/preview`);
    console.log(`  GET    /api/calls/:id/full`);
    console.log(`  POST   /api/calls/test`);
    console.log(`[server] Dashboard:`);
    console.log(`  GET    /dashboard`);
    console.log(`  GET    /dashboard/signup`);
    console.log(`  GET    /dashboard/:clientId`);
    console.log(`  GET    /dashboard/:clientId/prospect/:prospectId`);
    console.log(`  GET    /dashboard/:clientId/calls/:callId\n`);
  });

  // WebSocket server for live video session monitoring
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (request.url && request.url.startsWith('/ws/video')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });
  wss.on('connection', (ws, req) => {
    const urlParts = (req.url || '').split('/');
    const sessionId = urlParts[urlParts.length - 1] || '';

    const session = orchestrator.getSession(sessionId);

    // Send initial status
    ws.send(JSON.stringify({
      type: 'session_status',
      data: session || { sessionId, status: 'not_found' },
    }));

    // Heartbeat every 5 seconds
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(heartbeat);
        return;
      }
      const s = orchestrator.getSession(sessionId);
      ws.send(JSON.stringify({
        type: 'heartbeat',
        data: {
          ravenActive: s?.ravenActive || false,
          renderMode: s?.renderMode || 'unknown',
          status: s?.status || 'inactive',
          elapsed: s ? Date.now() - s.startTime : 0,
        },
      }));
    }, 5000);

    ws.on('close', () => clearInterval(heartbeat));
  });

  console.log('[server] WebSocket server ready at /ws/video');
}

start().catch(err => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});

module.exports = app;
