// routes/wompi.routes.js
// ⚠️  The webhook route is registered in app.js BEFORE express.json() so that
//     express.raw() can capture the body as a Buffer for signature validation.
//     Only the session and verify endpoints live here.
const express  = require("express");
const { auth } = require("../middleware/auth.middleware");
const {
  getSession,
  verifyByReference,
} = require("../controllers/wompi.controller");

const router = express.Router();

// Authenticated — storefront calls these after JWT login
router.get("/session/:sale_id",  auth, getSession);
router.get("/verify/:reference", auth, verifyByReference);

module.exports = router;