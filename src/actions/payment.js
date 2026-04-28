const supabase = require('../database/client');

async function sendPaymentLink(prospectId, clientId) {
  console.log(`[payment] Sending payment link to prospect ${prospectId}`);

  // Mock payment link for Sprint 1 — Stripe integration in Sprint 3
  const mockLink = `https://pay.example.com/${prospectId}`;

  await supabase
    .from('prospects')
    .update({ payment_link_sent: true })
    .eq('id', prospectId);

  console.log(`[payment] Payment link sent: ${mockLink}`);
  return { success: true, link: mockLink };
}

module.exports = { sendPaymentLink };
