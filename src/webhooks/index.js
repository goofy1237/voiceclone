const express = require('express');
const router = express.Router();

const retellWebhook = require('./retell');
const recallWebhook = require('./recall');
const calendlyWebhook = require('./calendly');
const tavusWebhook = require('./tavus');

router.use('/retell', retellWebhook);
router.use('/recall', recallWebhook);
router.use('/calendly', calendlyWebhook);
router.use('/tavus', tavusWebhook);

module.exports = router;
