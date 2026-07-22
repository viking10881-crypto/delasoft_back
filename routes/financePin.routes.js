// routes/financePin.routes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/financePin.controller");
const { auth, checkRateLimit } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");

router.use(auth);
router.use(adminScope);

router.get ("/status",  ctrl.getStatus);
router.post("/setup",   ctrl.setPin);
router.post("/verify",
  checkRateLimit((req) => `fp:${req.adminId}`, 5, 15 * 60 * 1000),
  ctrl.verifyPin
);
router.post("/lock",    ctrl.lockPin);

module.exports = router;
