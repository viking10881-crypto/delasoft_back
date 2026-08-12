'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/fiscalIntegrations.controller');
const { auth, requireAdmin } = require('../middleware/auth.middleware');
const { adminScope } = require('../middleware/adminScope');
const guard = [auth, adminScope, requireAdmin];

router.get('/', ...guard, ctrl.get);
router.put('/', ...guard, ctrl.save);
router.post('/verify', ...guard, ctrl.verify);
router.get('/sales/:saleId', ...guard, ctrl.getForSale);
router.post('/sales/:saleId/request', ...guard, ctrl.requestForSale);

module.exports = router;
