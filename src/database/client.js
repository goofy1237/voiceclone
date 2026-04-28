const { createClient } = require('@supabase/supabase-js');
const env = require('../../config/env');

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Verify Supabase connection with retries.
 * Returns true if connected, exits process if all retries fail.
 */
async function verifyConnection(maxRetries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[db] Connection attempt ${attempt}/${maxRetries}...`);
      const { error } = await supabase.from('clients').select('id').limit(1);
      if (error) throw error;
      console.log('[db] Supabase connected.');
      return true;
    } catch (err) {
      console.error(`[db] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  console.error('[db] All connection attempts failed. Exiting.');
  process.exit(1);
}

module.exports = supabase;
module.exports.verifyConnection = verifyConnection;
