// routes/index.js
const router = require("express").Router();
const { auth }       = require("../middleware/auth.middleware");
const { adminScope } = require("../middleware/adminScope");

// ── Rutas públicas (sin auth) ─────────────────────────
router.use("/auth",       require("./auth.routes"));
router.use("/public-api", require("./public-api.routes")); // API key auth propia

// ── Middleware global para TODO lo de abajo ───────────
router.use(auth);        // ← verifica JWT
router.use(adminScope);  // ← inyecta req.isSuperAdmin y req.adminId

// ── Rutas del panel (todas protegidas) ────────────────
router.use("/products",       require("./products.routes"));
router.use("/categories",     require("./categories.routes"));
router.use("/providers",      require("./providers.routes"));
router.use("/sales",          require("./sales.routes"));
router.use("/users",          require("./users.routes"));
router.use("/banners",        require("./banners.routes"));
router.use("/discounts",      require("./discounts.routes"));
router.use("/finance",        require("./finance.routes"));
router.use("/analytics",      require("./analytics.routes"));
router.use("/stats",          require("./stats.routes"));
router.use("/agent",          require("./agent.routes"));
router.use("/chat",           require("./chat.routes"));
router.use("/contact",        require("./contact.routes"));
router.use("/notifications",  require("./notifications.routes"));
router.use("/roles",          require("./roles.routes"));
router.use("/api-keys",       require("./apikeys.routes"));
router.use("/superadmin",     require("./superadmin.routes"));
router.use("/variants",       require("./variants_bundles.routes"));
router.use("/wompi",          require("./wompi.routes"));
router.use("/payments",       require("./payments.controller")); // parece mal nombrado
// Agrega esta línea junto a las demás rutas del panel
router.use("/subscriptions", require("./subscription.routes"));

module.exports = router;