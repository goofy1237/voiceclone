const express = require('express');
const router = express.Router();

const retellWebhook = require('./retell');

router.use('/retell', retellWebhook);

module.exports = router;
