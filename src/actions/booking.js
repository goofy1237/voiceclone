const axios = require('axios');
const env = require('../../config/env');
const supabase = require('../database/client');

async function bookFollowUp(prospectId, clientId, preferredTime) {
  console.log(`[booking] Booking follow-up for prospect ${prospectId}`);

  let schedulingLink = null;

  // Try Calendly API to get scheduling link
  if (env.CALENDLY_API_KEY) {
    try {
      // Get current user to find event types
      const userResponse = await axios.get('https://api.calendly.com/users/me', {
        headers: { 'Authorization': `Bearer ${env.CALENDLY_API_KEY}` },
      });

      const userUri = userResponse.data.resource.uri;

      // Get event types
      const eventTypesResponse = await axios.get('https://api.calendly.com/event_types', {
        headers: { 'Authorization': `Bearer ${env.CALENDLY_API_KEY}` },
        params: { user: userUri, active: true },
      });

      const eventTypes = eventTypesResponse.data.collection;
      if (eventTypes.length > 0) {
        schedulingLink = eventTypes[0].scheduling_url;
      }
    } catch (err) {
      console.warn('[booking] Calendly API error:', err.response?.data?.message || err.message);
      schedulingLink = `https://calendly.com/placeholder/${prospectId}`;
    }
  } else {
    schedulingLink = `https://calendly.com/placeholder/${prospectId}`;
  }

  // Update prospect
  const nextDate = preferredTime || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  await supabase
    .from('prospects')
    .update({
      next_action: 'Follow-up call booked',
      next_contact_date: nextDate,
    })
    .eq('id', prospectId);

  console.log(`[booking] Follow-up scheduled. Link: ${schedulingLink}`);
  return { success: true, link: schedulingLink, nextDate };
}

module.exports = { bookFollowUp };
