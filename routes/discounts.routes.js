// routes/discounts.routes.js
const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");
const ctrl = require("../controllers/discounts.controller");

const router = express.Router();

// ── Middleware global ─────────────────────────────────────────
router.use(auth);
router.use(adminScope);
router.use(requireManager);

// ── Rutas ─────────────────────────────────────────────────────
router.get   ("/",    ctrl.getAll);
router.post  ("/",    ctrl.create);
router.put   ("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);
router.patch ("/:id", ctrl.toggleActive);

module.exports = router;