const express = require('express');
const { checkRateLimit } = require('../middleware/auth.middleware');
const leadsController = require('../controllers/leads.controller');

const router = express.Router();

// Máximo 5 solicitudes por IP cada hora. La ruta es pública y no crea usuarios.
router.post(
  '/',
  checkRateLimit((req) => `landing-lead:${req.ip}`, 5, 60 * 60 * 1000),
  leadsController.submit
);

module.exports = router;

