const supabase = require('../database/client');

/**
 * API Key authentication middleware.
 * Extracts X-API-Key header, looks up client by api_key in Supabase,
 * attaches the client record to req.client.
 * Returns 401 if no key provided or key is invalid.
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
 * Client isolation middleware.
 * Must be used after apiKeyAuth. Verifies that the :clientId param
 * matches the authenticated client.
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

module.exports = { apiKeyAuth, enforceClientIsolation };
