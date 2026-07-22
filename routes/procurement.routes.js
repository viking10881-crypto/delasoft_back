// routes/procurement.routes.js
'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/procurement.controller');
const { auth, requireManager }  = require('../middleware/auth.middleware');
const { adminScope }            = require('../middleware/adminScope');
const { requireFeature }        = require('../middleware/subscription.middleware');

router.use(auth);
router.use(adminScope);
router.use(requireFeature("has_purchase_orders"));

// ── Static routes first ───────────────────────────────────────────────────────
router.get ('/pending',              requireManager, ctrl.getPending);
router.get ('/purchase-orders',      requireManager, ctrl.getPurchaseOrders);
router.get ('/sales-awaiting',       requireManager, ctrl.getSalesAwaiting);
router.post('/group-purchase-order', requireManager, ctrl.groupPurchaseOrder);

// ── Routes with :id ───────────────────────────────────────────────────────────
router.post('/purchase-orders/:id/receive', requireManager, ctrl.receivePurchaseOrder);
router.post('/:id/cancel',                 requireManager, ctrl.cancel);

module.exports = router;
