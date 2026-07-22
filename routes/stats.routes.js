// routes/stats.routes.js
const express = require("express");
const router  = express.Router();
const { auth }       = require("../middleware/auth.middleware");
const { adminScope } = require("../middleware/adminScope");
const { getDashboardStats } = require("../controllers/stats.controller");

router.use(auth);
router.use(adminScope);

router.get("/dashboard", getDashboardStats);

module.exports = router;