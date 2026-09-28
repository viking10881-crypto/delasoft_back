// routes/subscription.routes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/subscription.controller");
const checkoutCtrl = require("../controllers/subscriptionCheckout.controller");
const {
  auth,
  requireAdmin,
  requireSuperAdmin,
} = require("../middleware/auth.middleware");

// ── Pública ────────────────────────────────────────────────────
// No requiere auth; la tabla debe tener filas con is_active=true, is_public=true
router.get("/plans", ctrl.getPublicPlans);

// ── Cualquier usuario autenticado ──────────────────────────────
// Incluye sub-usuarios: el controller resuelve owner_admin_id || id
router.get("/me",               auth, ctrl.getMySubscription);
router.get("/me/invoices",      auth, ctrl.getMyInvoices);
router.get("/me/invoices/:id/pdf", auth, ctrl.downloadMyInvoicePdf);
router.post("/coupons/validate", auth, ctrl.validateCoupon);

// ── Solo el admin raíz puede gestionar su propia suscripción ──
router.post("/cancel",       auth, requireAdmin, ctrl.cancelSubscription);
router.post("/reactivate",   auth, requireAdmin, ctrl.reactivateSubscription);
router.post("/change-plan",  auth, requireAdmin, ctrl.changePlan);
// Planes de pago: genera la orden de Wompi; el webhook activa el plan al aprobarse.
router.post("/checkout",     auth, requireAdmin, checkoutCtrl.createForAdmin);

// ── Solo superadmin ────────────────────────────────────────────
router.get  ("/admin/all",        auth, requireSuperAdmin, ctrl.getAllSubscriptions);
router.post ("/admin/assign",     auth, requireSuperAdmin, ctrl.assignSubscription);
router.get  ("/admin/stats",      auth, requireSuperAdmin, ctrl.getSubscriptionStats);
router.post ("/admin/coupons",    auth, requireSuperAdmin, ctrl.createCoupon);
router.get  ("/admin/coupons",    auth, requireSuperAdmin, ctrl.getCoupons);
router.patch("/admin/plans/:id",  auth, requireSuperAdmin, ctrl.updatePlan);
router.get  ("/admin/checkouts", auth, requireSuperAdmin, checkoutCtrl.listAdmin);
router.post ("/admin/checkouts/:id/activate", auth, requireSuperAdmin, checkoutCtrl.activate);

module.exports = router;
