// app.js
const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const morgan      = require("morgan");
const compression = require("compression");
const crypto      = require("crypto");

const app    = express();
const isProd = process.env.NODE_ENV === "production";

// ============================================
// MIDDLEWARES GLOBALES
// ============================================

// X-Request-Id — trazabilidad en logs y respuestas
app.use((req, _res, next) => {
  req.id = crypto.randomUUID();
  next();
});

// Compresión gzip/brotli — reduce payload hasta un 70%
app.use(compression());

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// CORS — solo origenes explícitamente permitidos
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:5174,http://localhost:3000")
  .split(",").map((o) => o.trim()).filter(Boolean);

const CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

// API pública: acepta cualquier origen (acceso controlado por API Key en BD)
// Panel admin: solo origenes en ALLOWED_ORIGINS
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/public-api/")) {
    return cors({
      origin:         true,
      methods:        CORS_METHODS,
      allowedHeaders: ["Content-Type", "X-API-Key", "Authorization"],
      maxAge:         86400,
    })(req, res, next);
  }
  return cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(Object.assign(new Error("Origin no permitido"), { status: 403 }));
    },
    credentials:    true,
    methods:        CORS_METHODS,
    allowedHeaders: ["Content-Type", "Authorization"],
  })(req, res, next);
});

// Wompi webhook — raw body MUST be captured before express.json() parses other routes
// express.raw() only runs for this exact path; all other routes use express.json() below
app.post("/api/wompi/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => require("./controllers/wompi.controller").handleWebhook(req, res)
);

app.use(express.json({
  limit: process.env.REQUEST_LIMIT || "10mb",
  verify: (req, _res, buf) => {
    // Preserve raw body for webhook HMAC verification
    if (req.originalUrl.startsWith('/api/notifications/webhook')) {
      req.rawBody = buf;
    }
  },
}));
app.use(express.urlencoded({ extended: false, limit: process.env.REQUEST_LIMIT || "10mb" }));
app.use(morgan(isProd ? "combined" : "dev"));

// Timeout por petición — evita que conexiones colgadas agoten el pool
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT) || 30_000;
app.use((req, res, next) => {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({ success: false, message: "Tiempo de espera agotado", code: "REQUEST_TIMEOUT" });
    }
  });
  next();
});

// ============================================
// 🔧 HELPER: Carga segura de módulos
// ============================================
function safeRequire(path, label) {
  try {
    const mod = require(path);
    console.log(`  ✅ ${label}`);
    return mod;
  } catch (e) {
    console.error(`  ❌ ${label} → ${e.message}`);
    console.error(e.stack);
    return null;
  }
}

console.log("\n[APP] Cargando rutas...");

// ============================================
// 🗺️ RUTAS — Panel de administración
// ============================================
const authRoutes          = safeRequire("./routes/auth.routes",             "auth.routes");
const superadminRoutes    = safeRequire("./routes/superadmin.routes",       "superadmin.routes");
const usersRoutes         = safeRequire("./routes/users.routes",            "users.routes");
const rolesRoutes         = safeRequire("./routes/roles.routes",            "roles.routes");
const apiKeysRoutes       = safeRequire("./routes/apikeys.routes",          "apikeys.routes");
const adminProfileRoutes  = safeRequire("./routes/adminProfile.routes",     "adminProfile.routes");
const subscriptionRoutes  = safeRequire("./routes/subscription.routes",     "subscription.routes"); // ← nuevo

const statsRoutes         = safeRequire("./routes/stats.routes",            "stats.routes");
const providersRoutes     = safeRequire("./routes/providers.routes",        "providers.routes");
const financeRoutes       = safeRequire("./routes/finance.routes",          "finance.routes");
const productsRoutes      = safeRequire("./routes/products.routes",         "products.routes");
const categoriesRoutes    = safeRequire("./routes/categories.routes",       "categories.routes");
const discountsRoutes     = safeRequire("./routes/discounts.routes",        "discounts.routes");
const salesRoutes         = safeRequire("./routes/sales.routes",            "sales.routes");
const bannersRoutes       = safeRequire("./routes/banners.routes",          "banners.routes");
const notificationsRoutes = safeRequire("./routes/notifications.routes",    "notifications.routes");
const agentRoutes         = safeRequire("./routes/agent.routes",            "agent.routes");
const variantsRoutes      = safeRequire("./routes/variants_bundles.routes", "variants_bundles.routes");
const reviewsRoutes       = safeRequire("./routes/reviews.routes",          "reviews.routes");
const chatRoutes          = safeRequire("./routes/chat.routes",             "chat.routes");
const wompiRoutes              = safeRequire("./routes/wompi.routes",            "wompi.routes");
const paymentAccountsRoutes    = safeRequire("./routes/paymentAccounts.routes",  "paymentAccounts.routes");
const analyticsRoutes          = safeRequire("./routes/analytics.routes",        "analytics.routes");
const contactRoutes       = safeRequire("./routes/contact.routes",          "contact.routes");
const inventoryRoutes     = safeRequire("./routes/inventory.routes",        "inventory.routes");
const procurementRoutes   = safeRequire("./routes/procurement.routes",      "procurement.routes");
const financePinRoutes = safeRequire("./routes/financePin.routes", "financePin.routes");

// ============================================
// 🌐 RUTAS — API Pública
// ============================================
const publicApiRoutes = safeRequire("./routes/public-api.routes", "public-api.routes");

console.log("[APP] Rutas cargadas.\n");

// ============================================
// ⏱️ TAREAS PROGRAMADAS
// ============================================
require("./services/agent.cron");            // Agente autónomo
require("./services/notificationScheduler"); // Push notifications

// Cron de suscripciones: vencimientos, sync de uso y notificaciones
const { startSubscriptionCron } = require("./services/subscription.cron");
startSubscriptionCron();

// Motor de inventario: reservas expiradas + alertas de stock bajo
const { startInventoryJobs } = require("./services/inventory.jobs");
startInventoryJobs();

// Worker de notificaciones salientes (WhatsApp, email) — cada 30 segundos
const { startNotificationWorker } = require("./services/notification.worker");
startNotificationWorker();

// ============================================
// 🔌 REGISTRO DE RUTAS
// ============================================

// — Auth —
if (authRoutes)          app.use("/api/auth",          authRoutes);

// — Panel de administración —
if (superadminRoutes)    app.use("/api/superadmin",     superadminRoutes);
if (usersRoutes)         app.use("/api/users",          usersRoutes);
if (rolesRoutes)         app.use("/api/roles",          rolesRoutes);
if (apiKeysRoutes)       app.use("/api/api-keys",       apiKeysRoutes);
if (adminProfileRoutes)  app.use("/api/admin-profile",  adminProfileRoutes);
if (subscriptionRoutes)  app.use("/api/subscriptions",  subscriptionRoutes); // ← nuevo

// — Resto del panel —
if (statsRoutes)         app.use("/api/stats",         statsRoutes);
if (providersRoutes)     app.use("/api/providers",     providersRoutes);
if (financeRoutes)       app.use("/api/finance",       financeRoutes);
if (productsRoutes)      app.use("/api/products",      productsRoutes);
if (categoriesRoutes)    app.use("/api/categories",    categoriesRoutes);
if (salesRoutes)         app.use("/api/sales",         salesRoutes);
if (discountsRoutes)     app.use("/api/discounts",     discountsRoutes);
if (bannersRoutes)       app.use("/api/banners",       bannersRoutes);
if (notificationsRoutes) app.use("/api/notifications", notificationsRoutes);
if (variantsRoutes)      app.use("/api",               variantsRoutes);
if (reviewsRoutes)       app.use("/api",               reviewsRoutes);
if (chatRoutes)          app.use("/api/chat",          chatRoutes);
if (agentRoutes)         app.use("/api/agent",         agentRoutes);
if (wompiRoutes)              app.use("/api/wompi",            wompiRoutes);
if (paymentAccountsRoutes)    app.use("/api/payment-accounts", paymentAccountsRoutes);
if (analyticsRoutes)          app.use("/api/analytics",        analyticsRoutes);
if (contactRoutes)       app.use("/api/contact",       contactRoutes);
if (inventoryRoutes)     app.use("/api/inventory",     inventoryRoutes);
if (procurementRoutes)   app.use("/api/procurement",   procurementRoutes);
if (financePinRoutes) app.use("/api/finance-pin", financePinRoutes);

// — API pública —
if (publicApiRoutes)     app.use("/public-api/v1",     publicApiRoutes);

// ============================================
// HEALTH CHECK
// ============================================
app.get("/api/health", (req, res) => {
  const base = { status: "ok", timestamp: new Date().toISOString() };
  if (isProd) return res.json(base);
  res.json({
    ...base,
    routes: {
      auth:          !!authRoutes,
      superadmin:    !!superadminRoutes,
      users:         !!usersRoutes,
      roles:         !!rolesRoutes,
      apiKeys:       !!apiKeysRoutes,
      adminProfile:  !!adminProfileRoutes,
      subscriptions: !!subscriptionRoutes,
      stats:         !!statsRoutes,
      providers:     !!providersRoutes,
      finance:       !!financeRoutes,
      products:      !!productsRoutes,
      categories:    !!categoriesRoutes,
      sales:         !!salesRoutes,
      discounts:     !!discountsRoutes,
      banners:       !!bannersRoutes,
      notifications: !!notificationsRoutes,
      variants:      !!variantsRoutes,
      reviews:       !!reviewsRoutes,
      chat:          !!chatRoutes,
      agent:         !!agentRoutes,
      financePin:    !!financePinRoutes,
      wompi:          !!wompiRoutes,
      paymentAccounts: !!paymentAccountsRoutes,
      analytics:      !!analyticsRoutes,
      contact:       !!contactRoutes,
      publicApi:     !!publicApiRoutes,
    },
    services: {
      agent_cron:             true,
      notification_scheduler: true,
      subscription_cron:      true,
      notification_worker:    true,
    },
  });
});

app.get("/", (req, res) =>
  res.json({ message: "API Delasoft OK", timestamp: new Date() })
);

// ============================================
// 404 — Ruta no encontrada
// ============================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Ruta no encontrada: ${req.method} ${req.path}`,
    code: "NOT_FOUND",
  });
});

// ============================================
// MANEJO GLOBAL DE ERRORES
// ============================================
app.use((err, req, res, _next) => {
  const reqId  = req.id || "-";
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[EXPRESS ERROR] [${reqId}]`, err.stack);
  const message = isProd && status === 500 ? "Error interno del servidor" : err.message;
  res.status(status).json({ success: false, message, ...(isProd ? {} : { requestId: reqId }) });
});

module.exports = app;