// routes/providers.routes.js
const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");
const ctrl = require("../controllers/providers.controller");

const router = express.Router();

// ── Middleware global para este router ────────────────────────
router.use(auth);
router.use(adminScope);

// ── Colección (rutas estáticas SIEMPRE antes de /:id) ────────
router.get   ("/",                 requireManager, ctrl.getAll);
router.post  ("/",                 requireManager, ctrl.create);
router.post  ("/payments",         requireManager, ctrl.registerPayment);
router.get   ("/price-comparison", requireManager, ctrl.getPriceComparison);

// ── Recurso por ID ────────────────────────────────────────────
router.get   ("/:id",              requireManager, ctrl.getById);
router.put   ("/:id",              requireManager, ctrl.update);
router.delete("/:id",              requireManager, ctrl.remove);
router.patch ("/:id/toggle-active",requireManager, ctrl.toggleActive);

// ── Sub-recursos ──────────────────────────────────────────────
router.get   ("/:id/payments",                              requireManager, ctrl.getPaymentHistory);
router.get   ("/:id/purchases",                             requireManager, ctrl.getPurchaseHistory);
router.get   ("/:id/stats",                                 requireManager, ctrl.getStats);
router.patch ("/:id/purchase-orders/:orderId/receive",      requireManager, ctrl.receivePurchaseOrder);

module.exports = router;