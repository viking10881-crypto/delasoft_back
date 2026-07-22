// routes/analytics.routes.js
const express    = require("express");
const router     = express.Router();
const ctrl       = require("../controllers/analytics.controller");
const { auth }   = require("../middleware/auth.middleware");
const { adminScope } = require("../middleware/adminScope");

// ── Pública — storefront sin auth ─────────────────────────────────
router.post("/pageview", ctrl.trackPageview);

// ── Privadas — auth + adminScope para todo lo de abajo ────────────
router.use(auth);
router.use(adminScope);

router.get("/summary", ctrl.getSummary);
router.get("/detail",  ctrl.getDetail);

module.exports = router;