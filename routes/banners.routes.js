// routes/banners.routes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/banners.controller");
const { uploadBanner }         = require("../middleware/upload.middleware");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");

// ── Pública — sin auth (storefront, con caché) ────────────────
router.get("/", ctrl.getAll);

// ── Privadas — auth + adminScope para todo lo de abajo ────────
router.use(auth);
router.use(adminScope);

router.get   ("/admin", requireManager, ctrl.getAllAdmin);
router.post  ("/",      requireManager, uploadBanner.single("image"), ctrl.create);
router.put   ("/:id",   requireManager, uploadBanner.single("image"), ctrl.update);
router.delete("/:id",   requireManager, ctrl.delete);

module.exports = router;