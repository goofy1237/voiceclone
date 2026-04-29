const { createClient } = require('@supabase/supabase-js');
const env = require('../../config/env');
const supabase = require('../database/client');

const supabaseAuth = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * API Key authentication middleware (kept for programmatic access).
 * Extracts X-API-Key header, looks up client by api_key in Supabase,
 * attaches the client record to req.client.
 */
async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  try {
    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('api_key', apiKey)
      .single();

    if (error || !client) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.client = client;
    next();
  } catch (err) {
    console.error('[auth] Middleware error:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Client isolation for X-API-Key flow.
 * Must run after apiKeyAuth.
 */
function enforceClientIsolation(req, res, next) {
  const { clientId } = req.params;

  if (!req.client) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (clientId && req.client.id !== clientId) {
    return res.status(403).json({ error: 'Access denied: client mismatch' });
  }

  next();
}

/**
 * Supabase user authentication.
 * Accepts a Bearer token in the Authorization header OR an
 * sb-access-token cookie. Sets req.user.
 */
async function requireUser(req, res, next) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = req.cookies?.['sb-access-token'];
  const token = bearerToken || cookieToken;

  if (!token) {
    const isApiRoute = req.path.startsWith('/api/');
    if (isApiRoute) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }

  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) {
      const isApiRoute = req.path.startsWith('/api/');
      if (isApiRoute) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      return res.redirect('/login');
    }
    req.user = data.user;
    next();
  } catch (err) {
    console.error('[auth] getUser failed:', err.message);
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

/**
 * Verifies the authenticated user owns the client referenced in the URL.
 * Must run AFTER requireUser. Reads :clientId (or :id) from params.
 */
async function requireClientOwnership(req, res, next) {
  const clientId = req.params.clientId || req.params.id;
  if (!clientId) return res.status(400).json({ error: 'Client ID required' });

  const { data: client, error } = await supabase
    .from('clients')
    .select('id, owner_id')
    .eq('id', clientId)
    .single();

  if (error || !client) {
    return res.status(404).json({ error: 'Client not found' });
  }
  if (client.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.client = client;
  next();
}

module.exports = {
  apiKeyAuth,
  enforceClientIsolation,
  requireUser,
  requireClientOwnership,
  supabaseAuth,
};
