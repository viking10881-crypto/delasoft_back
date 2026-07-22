// middleware/subscription.middleware.js
// Protege rutas de API según el plan del admin autenticado.
//
// Uso en rutas:
//   router.use(auth, requireFeature("has_analytics"), analyticsCtrl.get);
//   router.use(auth, requireLimit("products"), productsCtrl.create);
//
// El superadmin bypasea TODO.

const db = require("../config/db");

// ─── Cache en memoria (TTL 5 min por admin) ──────────────────────────────────
const _cache = new Map(); // adminId → { data, expiresAt }
const CACHE_TTL = 5 * 60 * 1000;

const getSubscriptionData = async (adminId) => {
  const cached = _cache.get(adminId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const { rows } = await db.query(
    `SELECT
       s.status,
       sp.has_analytics, sp.has_ai_agent, sp.has_api_access,
       sp.has_multi_admin, sp.has_custom_branding, sp.has_wompi_payments,
       sp.has_export, sp.has_priority_support, sp.has_push_notifications,
       sp.has_financial_reports, sp.has_purchase_orders, sp.has_discount_system,
       sp.has_inventory,
       sp.max_products, sp.max_users, sp.max_api_keys, sp.max_categories,
       sp.max_banners, sp.max_providers, sp.max_monthly_sales,
       su.products_count, su.users_count, su.api_keys_count,
       su.categories_count, su.banners_count, su.providers_count,
       su.monthly_sales_count,
       s.trial_end, s.current_period_end, s.grace_expires_at
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     LEFT JOIN subscription_usage su ON su.admin_id = s.admin_id
     WHERE s.admin_id = $1`,
    [adminId]
  );

  if (!rows.length) return null;

  const data = rows[0];
  _cache.set(adminId, { data, expiresAt: Date.now() + CACHE_TTL });
  return data;
};

// Invalida cache cuando cambia el plan (llamar desde subscriptionService)
const invalidateCache = (adminId) => _cache.delete(adminId);

// ─── Status que permiten operar ──────────────────────────────────────────────
const ACTIVE_STATUSES = new Set(["trial", "active", "past_due"]);

// ─── requireFeature ──────────────────────────────────────────────────────────
// Bloquea la ruta si el plan del admin no incluye la feature.
// feature: "has_analytics" | "has_ai_agent" | "has_api_access" | etc.
const requireFeature = (feature) => async (req, res, next) => {
  try {
    // Superadmin bypasea todo
    if (req.user?.roles?.includes("superadmin")) return next();

    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ success: false, message: "No autenticado", code: "NOT_AUTHENTICATED" });
    }

    const sub = await getSubscriptionData(adminId);

    if (!sub) {
      return res.status(403).json({
        success: false,
        message: "Sin suscripción activa. Contacta al administrador.",
        code: "NO_SUBSCRIPTION",
      });
    }

    if (!ACTIVE_STATUSES.has(sub.status)) {
      return res.status(403).json({
        success: false,
        message: sub.status === "suspended"
          ? "Tu cuenta está suspendida. Renueva tu suscripción."
          : "Tu suscripción ha expirado.",
        code: "SUBSCRIPTION_INACTIVE",
        status: sub.status,
      });
    }

    if (!sub[feature]) {
      return res.status(403).json({
        success: false,
        message: "Tu plan actual no incluye esta funcionalidad.",
        code: "FEATURE_LOCKED",
        feature,
        upgrade_url: "/subscription",
      });
    }

    next();
  } catch (err) {
    console.error("[REQUIRE FEATURE ERROR]", err);
    return res.status(500).json({ success: false, message: "Error al verificar suscripción" });
  }
};

// ─── requireLimit ────────────────────────────────────────────────────────────
// Bloquea POST/PUT si el admin superó el límite del plan para un recurso.
// resource: "products" | "users" | "api_keys" | "categories" | "banners" | "providers"
//
// Mapea: resource → { maxCol, usedCol }
const LIMIT_MAP = {
  products:      { maxCol: "max_products",       usedCol: "products_count" },
  users:         { maxCol: "max_users",           usedCol: "users_count" },
  api_keys:      { maxCol: "max_api_keys",        usedCol: "api_keys_count" },
  categories:    { maxCol: "max_categories",      usedCol: "categories_count" },
  banners:       { maxCol: "max_banners",         usedCol: "banners_count" },
  providers:     { maxCol: "max_providers",       usedCol: "providers_count" },
  monthly_sales: { maxCol: "max_monthly_sales",   usedCol: "monthly_sales_count" },
};

const requireLimit = (resource) => async (req, res, next) => {
  try {
    if (req.user?.roles?.includes("superadmin")) return next();

    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ success: false, message: "No autenticado", code: "NOT_AUTHENTICATED" });
    }

    const mapping = LIMIT_MAP[resource];
    if (!mapping) return next(); // recurso no limitado → dejar pasar

    const sub = await getSubscriptionData(adminId);
    if (!sub) {
      return res.status(403).json({
        success: false,
        message: "Sin suscripción activa.",
        code: "NO_SUBSCRIPTION",
      });
    }

    if (!ACTIVE_STATUSES.has(sub.status)) {
      return res.status(403).json({
        success: false,
        message: "Suscripción inactiva.",
        code: "SUBSCRIPTION_INACTIVE",
        status: sub.status,
      });
    }

    const max  = sub[mapping.maxCol];
    const used = sub[mapping.usedCol] ?? 0;

    // -1 = ilimitado
    if (max !== -1 && used >= max) {
      return res.status(403).json({
        success: false,
        message: `Límite de ${resource} alcanzado (${used}/${max}). Actualiza tu plan para continuar.`,
        code: "LIMIT_REACHED",
        resource,
        used,
        max,
        upgrade_url: "/subscription",
      });
    }

    next();
  } catch (err) {
    console.error("[REQUIRE LIMIT ERROR]", err);
    return res.status(500).json({ success: false, message: "Error al verificar límites" });
  }
};

// ─── requireActiveSubscription ───────────────────────────────────────────────
// Bloquea TODA operación si la suscripción no está activa.
// Úsalo como middleware global en rutas críticas.
const requireActiveSubscription = async (req, res, next) => {
  try {
    if (req.user?.roles?.includes("superadmin")) return next();

    const adminId = req.user?.id;
    if (!adminId) return next(); // auth middleware ya lo maneja

    const sub = await getSubscriptionData(adminId);
    if (!sub) return next(); // sin sub → dejar que otros middlewares decidan

    if (!ACTIVE_STATUSES.has(sub.status)) {
      return res.status(403).json({
        success: false,
        message: "Suscripción inactiva. No puedes realizar esta acción.",
        code: "SUBSCRIPTION_INACTIVE",
        status: sub.status,
      });
    }

    next();
  } catch (err) {
    console.error("[REQUIRE ACTIVE SUB ERROR]", err);
    next(); // fail open para no bloquear login, etc.
  }
};

module.exports = {
  requireFeature,
  requireLimit,
  requireActiveSubscription,
  invalidateCache,
};