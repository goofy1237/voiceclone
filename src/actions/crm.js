const supabase = require('../database/client');

async function pullProspectData(prospectId) {
  const { data: prospect, error } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', prospectId)
    .single();

  if (error || !prospect) {
    return 'No data found for this prospect.';
  }

  const painPoints = prospect.pain_points || {};
  const personalNotes = prospect.personal_notes || [];
  const objections = prospect.objections || {};

  return `
Name: ${prospect.name || 'Unknown'}
Business: ${prospect.business_name || 'Unknown'}
Stage: ${prospect.funnel_stage || 'lead'}
Calls so far: ${prospect.call_count || 0}
Pain points: ${Object.values(painPoints).join(', ') || 'None identified yet'}
Personal notes: ${personalNotes.join(', ') || 'None yet'}
Objections raised: ${(objections.raised || []).join(', ') || 'None'}
Buying signals: ${(prospect.buying_signals || []).join(', ') || 'None yet'}
Next action: ${prospect.next_action || 'No specific follow-up set'}
  `.trim();
}

async function updateCRM(prospectId, stage, notes, outcome) {
  console.log(`[crm] Updating prospect ${prospectId}: stage=${stage}`);

  const updates = {};

  if (stage) updates.funnel_stage = stage;
  if (outcome) updates.next_action = outcome;

  if (notes) {
    // Append to personal_notes
    const { data: prospect } = await supabase
      .from('prospects')
      .select('personal_notes')
      .eq('id', prospectId)
      .single();

    const existing = prospect?.personal_notes || [];
    updates.personal_notes = [...existing, notes];
  }

  updates.last_contact = new Date().toISOString();

  const { error } = await supabase
    .from('prospects')
    .update(updates)
    .eq('id', prospectId);

  if (error) {
    console.error('[crm] Update failed:', error.message);
    return { success: false, error: error.message };
  }

  console.log(`[crm] Prospect ${prospectId} updated.`);
  return { success: true };
}

module.exports = { pullProspectData, updateCRM };
