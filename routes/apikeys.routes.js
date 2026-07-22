// routes/apikeys.routes.js
const express     = require("express");
const router      = express.Router();
const ctrl        = require("../controllers/apikeys.controller");
const { auth, requireAdmin } = require("../middleware/auth.middleware");
const { adminScope }         = require("../middleware/adminScope");

// ── Middleware global ─────────────────────────────────────────
router.use(auth);
router.use(adminScope);
router.use(requireAdmin);

// ── Rutas ─────────────────────────────────────────────────────
router.get   ("/permissions",   ctrl.getAvailablePermissions);
router.get   ("/",              ctrl.getApiKeys);
router.post  ("/",              ctrl.createApiKey);
router.put   ("/:id",           ctrl.updateApiKey);
router.patch ("/:id/toggle",    ctrl.toggleApiKey);
router.post  ("/:id/rotate",    ctrl.rotateApiKey);
router.delete("/:id",           ctrl.deleteApiKey);
router.get   ("/:id/logs",      ctrl.getApiKeyLogs);

module.exports = router;