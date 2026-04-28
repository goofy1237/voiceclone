const { sendPaymentLink } = require('./payment');
const { bookFollowUp } = require('./booking');
const { pullProspectData, updateCRM } = require('./crm');

module.exports = {
  sendPaymentLink,
  bookFollowUp,
  pullProspectData,
  updateCRM,
};
