const express = require('express');
const { checkRateLimit } = require('../middleware/auth.middleware');
const controller = require('../controllers/subscriptionCheckout.controller');

const router = express.Router();

router.post(
  '/',
  checkRateLimit((req) => `subscription-checkout:${req.ip}`, 8, 60 * 60 * 1000),
  controller.create
);

module.exports = router;
