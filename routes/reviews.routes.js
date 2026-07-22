// routes/reviews.routes.js
const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");
const ctrl    = require("../controllers/reviews.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");

// Token válido pero NO requerido — el controller puede funcionar sin req.user
const optionalAuth = (req, _res, next) => {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET, {
        issuer:   "delasoft-api",
        audience: "delasoft-client",
      });
      req.user = {
        id:    decoded.id,
        email: decoded.email,
        name:  decoded.name,
        roles: decoded.roles || [],
        owner_admin_id: decoded.owner_admin_id ?? null,
      };
    } catch (_) { /* token inválido/expirado — continúa como invitado */ }
  }
  next();
};

// ── Pública (auth opcional) ───────────────────────────────────────────────────
router.get("/products/:productId/reviews",     optionalAuth,                        ctrl.getProductReviews);

// ── Rutas con paths fijos (antes de :id para evitar conflictos) ───────────────
router.get("/reviews/my/:productId",           auth,                                ctrl.getUserReviewForProduct);
router.get("/reviews/admin/pending",           auth, adminScope, requireManager,    ctrl.getPendingReviews);

// ── CRUD con :id ──────────────────────────────────────────────────────────────
router.post  ("/reviews",                      auth, adminScope,                    ctrl.createReview);
router.post  ("/reviews/:id/vote",             auth,                                ctrl.voteReview);
router.post  ("/reviews/:id/report",           auth,                                ctrl.reportReview);
router.patch ("/reviews/:id/status",           auth, adminScope, requireManager,    ctrl.moderateReview);
router.delete("/reviews/:id",                  auth, adminScope,                    ctrl.deleteReview);

module.exports = router;
