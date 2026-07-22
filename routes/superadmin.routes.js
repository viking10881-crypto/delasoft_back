// routes/superadmin.routes.js
const express        = require("express");
const router         = express.Router();
const superadminCtrl = require("../controllers/superadmin.controller");
const { auth, requireSuperAdmin } = require("../middleware/auth.middleware");

// Toda ruta requiere JWT válido + rol superadmin
router.use(auth, requireSuperAdmin);

// ── Dashboard ────────────────────────────────────────────────────
router.get("/stats", superadminCtrl.getSystemStats);

// ── CRUD admins ──────────────────────────────────────────────────
router.get   ("/admins",              superadminCtrl.getAdmins);
router.post  ("/admins",              superadminCtrl.createAdmin);
router.put   ("/admins/:id",          superadminCtrl.updateAdmin);
router.patch ("/admins/:id/toggle",   superadminCtrl.toggleAdminStatus);
router.delete("/admins/:id",          superadminCtrl.deleteAdmin);

// ── Suscripción por admin ────────────────────────────────────────
router.get ("/admins/:id/subscription", superadminCtrl.getAdminSubscription);
router.post("/admins/:id/subscription", superadminCtrl.setAdminSubscription);

module.exports = router;