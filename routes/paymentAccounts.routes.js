// routes/paymentAccounts.routes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/paymentAccounts.controller");
const { auth, requireAdmin }  = require("../middleware/auth.middleware");
const { requireFeature }      = require("../middleware/subscription.middleware");
const { adminScope }          = require("../middleware/adminScope");

// All payment-account routes require: valid JWT + admin role + has_wompi_payments feature
const guard = [auth, adminScope, requireAdmin, requireFeature("has_wompi_payments")];

router.get   ("/",              ...guard, ctrl.getAccount);    // GET  account status (no secrets)
router.post  ("/",              ...guard, ctrl.createOrUpdate); // POST connect new account
router.post  ("/verify",        ...guard, ctrl.verify);        // POST legacy verify (no id)
router.delete("/",              ...guard, ctrl.deactivate);    // DELETE deactivate account

// /:id routes — used by the frontend which sends account.id in the path
router.put   ("/:id",          ...guard, ctrl.updateById);    // PUT  update credentials
router.post  ("/:id/verify",   ...guard, ctrl.verifyById);    // POST verify against Wompi
router.patch ("/:id/toggle",   ...guard, ctrl.toggle);        // PATCH toggle is_active

module.exports = router;