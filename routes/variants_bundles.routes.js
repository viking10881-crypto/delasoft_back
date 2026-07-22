const express = require("express");
const router  = express.Router();
const { auth, requireManager } = require("../middleware/auth.middleware");
const { uploadBundle, uploadProduct } = require("../middleware/upload.middleware");
const varCtrl    = require("../controllers/variants.controller");
const bundleCtrl = require("../controllers/bundles.controller");

// ── Atributos ─────────────────────────────────────────────────────────────────
router.get ("/attributes",                        auth, varCtrl.getAttributeTypes);
router.post("/attributes/:typeId/values",         auth, requireManager, varCtrl.createAttributeValue);

// ── Variantes ─────────────────────────────────────────────────────────────────
router.get   ("/products/:productId/variants",              auth, varCtrl.list);
router.post  ("/products/:productId/variants",              auth, requireManager, varCtrl.create);
router.put   ("/products/:productId/variants/:variantId",   auth, requireManager, varCtrl.update);
router.delete("/products/:productId/variants/:variantId",   auth, requireManager, varCtrl.remove);

// ── Imágenes de variante ──────────────────────────────────────────────────────
router.post  ("/products/:productId/variants/:variantId/images",           auth, requireManager, uploadProduct.array("images", 10), varCtrl.uploadVariantImages);
router.delete("/products/:productId/variants/:variantId/images/:imageId",  auth, requireManager, varCtrl.deleteVariantImage);

// ── Bundle items ──────────────────────────────────────────────────────────────
router.get("/products/:bundleId/bundle-items", auth, bundleCtrl.getBundleItems);
router.put("/products/:bundleId/bundle-items", auth, requireManager, bundleCtrl.updateBundleItems);

// ── Crear bundle ──────────────────────────────────────────────────────────────
router.post("/bundles", auth, requireManager, uploadBundle.array("images", 4), bundleCtrl.createBundle);

module.exports = router;