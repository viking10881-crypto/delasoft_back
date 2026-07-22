// routes/categories.routes.js
const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");
const ctrl = require("../controllers/categories.controller");

const router = express.Router();

// ── Middleware global para este router ────────────────────────
router.use(auth);
router.use(adminScope);

// ── Rutas ─────────────────────────────────────────────────────
router.get("/",       ctrl.getAll);
router.get("/flat",   ctrl.getFlat);
router.post("/",      requireManager, ctrl.create);
router.put("/:id",    requireManager, ctrl.update);
router.delete("/:id", requireManager, ctrl.remove);

module.exports = router;