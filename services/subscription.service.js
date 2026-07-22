// services/subscription.service.js
// Núcleo de toda la lógica de suscripción.
// Importado por: superadmin.controller, subscription.controller, cron jobs.

const db = require("../config/db");
const { invalidateCache } = require("../middleware/subscription.middleware");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
};

const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
};

const addYears = (date, years) => {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().split("T")[0];
};

const genInvoiceNumber = () => {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `INV-${ts}-${rand}`;
};

// ─── getSubscriptionByAdmin ───────────────────────────────────────────────────
const getSubscriptionByAdmin = async (adminId) => {
  const { rows } = await db.query(
    `SELECT
       s.*,
       sp.name          AS plan_name,
       sp.slug          AS plan_slug,
       sp.color         AS color,
       sp.badge_label,
       sp.price_monthly,
       sp.price_yearly,
       sp.trial_days,
       sp.max_products, sp.max_users, sp.max_api_keys,
       sp.max_categories, sp.max_banners, sp.max_providers,
       sp.max_monthly_sales,
       sp.has_analytics, sp.has_ai_agent, sp.has_api_access,
       sp.has_multi_admin, sp.has_custom_branding, sp.has_wompi_payments,
       sp.has_export, sp.has_priority_support, sp.has_push_notifications,
       sp.has_financial_reports, sp.has_purchase_orders, sp.has_discount_system,
       sp.has_inventory
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE s.admin_id = $1`,
    [adminId]
  );
  return rows[0] ?? null;
};

// ─── checkLimits ──────────────────────────────────────────────────────────────
const checkLimits = async (adminId) => {
  const sub = await getSubscriptionByAdmin(adminId);
  if (!sub) return { allowed: false, features: {}, limits: {} };

  const ACTIVE = new Set(["trial", "active", "past_due"]);
  const allowed = ACTIVE.has(sub.status);

  const features = {
    analytics:          sub.has_analytics,
    ai_agent:           sub.has_ai_agent,
    api_access:         sub.has_api_access,
    multi_admin:        sub.has_multi_admin,
    custom_branding:    sub.has_custom_branding,
    wompi_payments:     sub.has_wompi_payments,
    export:             sub.has_export,
    priority_support:   sub.has_priority_support,
    push_notifications: sub.has_push_notifications,
    financial_reports:  sub.has_financial_reports,
    purchase_orders:    sub.has_purchase_orders,
    discount_system:    sub.has_discount_system,
    inventory:          sub.has_inventory,
  };

  const { rows: usageRows } = await db.query(
    "SELECT * FROM subscription_usage WHERE admin_id = $1",
    [adminId]
  );
  const usage = usageRows[0] ?? {};

  const mkLimit = (max, used) => ({ max, used: used ?? 0 });

  const limits = {
    products:      mkLimit(sub.max_products,      usage.products_count),
    users:         mkLimit(sub.max_users,          usage.users_count),
    api_keys:      mkLimit(sub.max_api_keys,       usage.api_keys_count),
    categories:    mkLimit(sub.max_categories,     usage.categories_count),
    banners:       mkLimit(sub.max_banners,        usage.banners_count),
    providers:     mkLimit(sub.max_providers,      usage.providers_count),
    monthly_sales: mkLimit(sub.max_monthly_sales,  usage.monthly_sales_count),
  };

  return { allowed, features, limits };
};

// ─── syncUsage ────────────────────────────────────────────────────────────────
// Sincroniza los contadores reales de uso para un admin.
// Llamado desde el cron cada hora y opcionalmente tras crear/eliminar recursos.
const syncUsage = async (adminId) => {
  await db.query(
    `INSERT INTO subscription_usage
       (admin_id,
        products_count, users_count, categories_count,
        providers_count, banners_count, api_keys_count,
        monthly_sales_count, updated_at)
     VALUES (
       $1,
       (SELECT COUNT(*) FROM products   WHERE owner_admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM users      WHERE owner_admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM categories WHERE owner_admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM providers  WHERE owner_admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM banners    WHERE created_by     = $1),
       (SELECT COUNT(*) FROM api_keys   WHERE admin_id       = $1 AND is_active = true),
       (SELECT COUNT(*) FROM sales
        WHERE owner_admin_id = $1
          AND DATE_TRUNC('month', sale_date) = DATE_TRUNC('month', now())),
       now()
     )
     ON CONFLICT (admin_id) DO UPDATE SET
       products_count      = EXCLUDED.products_count,
       users_count         = EXCLUDED.users_count,
       categories_count    = EXCLUDED.categories_count,
       providers_count     = EXCLUDED.providers_count,
       banners_count       = EXCLUDED.banners_count,
       api_keys_count      = EXCLUDED.api_keys_count,
       monthly_sales_count = EXCLUDED.monthly_sales_count,
       updated_at          = now()`,
    [adminId]
  );
};

// ─── createTrialSubscription ──────────────────────────────────────────────────
const createTrialSubscription = async (adminId, planSlug, createdBy) => {
  const { rows: plans } = await db.query(
    "SELECT * FROM subscription_plans WHERE slug = $1 AND is_active = true",
    [planSlug]
  );
  if (!plans.length) throw new Error(`Plan '${planSlug}' no encontrado`);
  const plan = plans[0];

  const today    = new Date().toISOString().split("T")[0];
  const trialEnd = addDays(today, plan.trial_days || 14);

  const { rows } = await db.query(
    `INSERT INTO subscriptions
       (admin_id, plan_id, status, billing_cycle,
        trial_start, trial_end,
        current_period_start, current_period_end,
        next_billing_date, amount_due, created_by)
     VALUES ($1,$2,'trial','monthly',$3,$4,$3,$4,$4,$5,$6)
     ON CONFLICT (admin_id) DO UPDATE SET
       plan_id              = EXCLUDED.plan_id,
       status               = 'trial',
       trial_start          = EXCLUDED.trial_start,
       trial_end            = EXCLUDED.trial_end,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end   = EXCLUDED.current_period_end,
       next_billing_date    = EXCLUDED.next_billing_date,
       amount_due           = EXCLUDED.amount_due,
       cancel_at_period_end = false,
       cancelled_at         = NULL,
       updated_at           = now()
     RETURNING *`,
    [adminId, plan.id, today, trialEnd, plan.price_monthly, createdBy]
  );

  await db.query(
    `INSERT INTO subscription_usage (admin_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [adminId]
  );

  await _logChange(adminId, null, plan.id, null, "trial", createdBy, "Trial creado por superadmin");
  invalidateCache(adminId);
  return rows[0];
};

// ─── activateSubscription ─────────────────────────────────────────────────────
const activateSubscription = async (adminId, {
  planSlug, billingCycle = "monthly",
  paymentMethod = "manual", paymentReference,
  changedBy,
}) => {
  const { rows: plans } = await db.query(
    "SELECT * FROM subscription_plans WHERE slug = $1 AND is_active = true",
    [planSlug]
  );
  if (!plans.length) throw new Error(`Plan '${planSlug}' no encontrado`);
  const plan = plans[0];

  const today     = new Date().toISOString().split("T")[0];
  const periodEnd = billingCycle === "yearly" ? addYears(today, 1) : addMonths(today, 1);
  const amount    = billingCycle === "yearly"
    ? (plan.price_yearly ?? plan.price_monthly * 12)
    : plan.price_monthly;

  const { rows } = await db.query(
    `INSERT INTO subscriptions
       (admin_id, plan_id, status, billing_cycle,
        current_period_start, current_period_end,
        next_billing_date, amount_due, created_by)
     VALUES ($1,$2,'active',$3,$4,$5,$5,$6,$7)
     ON CONFLICT (admin_id) DO UPDATE SET
       plan_id              = EXCLUDED.plan_id,
       status               = 'active',
       billing_cycle        = EXCLUDED.billing_cycle,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end   = EXCLUDED.current_period_end,
       next_billing_date    = EXCLUDED.next_billing_date,
       amount_due           = EXCLUDED.amount_due,
       trial_start          = NULL,
       trial_end            = NULL,
       cancel_at_period_end = false,
       cancelled_at         = NULL,
       grace_expires_at     = NULL,
       updated_at           = now()
     RETURNING *`,
    [adminId, plan.id, billingCycle, today, periodEnd, amount, changedBy]
  );

  await db.query(
    `INSERT INTO subscription_usage (admin_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [adminId]
  );

  await db.query(
    `INSERT INTO subscription_invoices
       (subscription_id, admin_id, plan_id, invoice_number, billing_cycle,
        subtotal, discount_amount, total, status,
        payment_method, payment_reference, paid_at,
        period_start, period_end, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,0,$6,'paid',$7,$8,now(),$9,$10,$9)`,
    [
      rows[0].id, adminId, plan.id, genInvoiceNumber(),
      billingCycle, amount, paymentMethod, paymentReference ?? "manual",
      today, periodEnd,
    ]
  );

  await _logChange(adminId, null, plan.id, null, "active", changedBy, `Activado manual (${paymentMethod})`);
  invalidateCache(adminId);
  return rows[0];
};

// ─── changePlan ───────────────────────────────────────────────────────────────
const changePlan = async (adminId, planSlug, changedBy) => {
  const current = await getSubscriptionByAdmin(adminId);
  if (!current) throw new Error("Suscripción no encontrada");

  const { rows: plans } = await db.query(
    "SELECT * FROM subscription_plans WHERE slug = $1 AND is_active = true",
    [planSlug]
  );
  if (!plans.length) throw new Error(`Plan '${planSlug}' no encontrado`);
  const plan = plans[0];

  const amount = current.billing_cycle === "yearly"
    ? (plan.price_yearly ?? plan.price_monthly * 12)
    : plan.price_monthly;

  const { rows } = await db.query(
    `UPDATE subscriptions
     SET plan_id = $1, amount_due = $2, updated_at = now()
     WHERE admin_id = $3
     RETURNING *`,
    [plan.id, amount, adminId]
  );

  await _logChange(adminId, current.plan_id, plan.id, current.status, current.status, changedBy, "Cambio de plan");
  invalidateCache(adminId);
  return rows[0];
};

// ─── cancelSubscription ───────────────────────────────────────────────────────
const cancelSubscription = async (adminId, reason, cancelNow = false, changedBy) => {
  let query, params;

  if (cancelNow) {
    query = `
      UPDATE subscriptions SET
        status = 'cancelled', cancelled_at = now(),
        cancellation_reason = $1, updated_at = now()
      WHERE admin_id = $2 RETURNING *`;
    params = [reason, adminId];
  } else {
    query = `
      UPDATE subscriptions SET
        cancel_at_period_end = true, cancellation_reason = $1, updated_at = now()
      WHERE admin_id = $2 RETURNING *`;
    params = [reason, adminId];
  }

  const { rows } = await db.query(query, params);
  await _logChange(
    adminId, null, null, null,
    cancelNow ? "cancelled" : rows[0]?.status,
    changedBy,
    `Cancelación: ${reason}`
  );
  invalidateCache(adminId);
  return rows[0];
};

// ─── processExpiredTrials ─────────────────────────────────────────────────────
const processExpiredTrials = async () => {
  const today = new Date().toISOString().split("T")[0];
  const { rows: expired } = await db.query(
    `UPDATE subscriptions
     SET status = 'suspended', updated_at = now()
     WHERE status = 'trial' AND trial_end < $1
     RETURNING admin_id`,
    [today]
  );
  expired.forEach(r => invalidateCache(r.admin_id));
  return expired.length;
};

// ─── processExpiredActive ─────────────────────────────────────────────────────
const processExpiredActive = async () => {
  const today      = new Date().toISOString().split("T")[0];
  const GRACE_DAYS = 7;

  const { rows: pastDue } = await db.query(
    `UPDATE subscriptions
     SET status = 'past_due',
         grace_expires_at = now() + ($1 || ' days')::INTERVAL,
         updated_at = now()
     WHERE status = 'active'
       AND current_period_end < $2
       AND cancel_at_period_end = false
     RETURNING admin_id`,
    [GRACE_DAYS, today]
  );

  const { rows: suspended } = await db.query(
    `UPDATE subscriptions
     SET status = 'suspended', updated_at = now()
     WHERE status = 'past_due'
       AND grace_expires_at < now()
     RETURNING admin_id`
  );

  const { rows: cancelled } = await db.query(
    `UPDATE subscriptions
     SET status = 'cancelled', cancelled_at = now(), updated_at = now()
     WHERE status = 'active'
       AND current_period_end < $1
       AND cancel_at_period_end = true
     RETURNING admin_id`,
    [today]
  );

  [...pastDue, ...suspended, ...cancelled].forEach(r => invalidateCache(r.admin_id));
  return { pastDue: pastDue.length, suspended: suspended.length, cancelled: cancelled.length };
};

// ─── processExpiredSubscriptions ─────────────────────────────────────────────
// Función unificada que llama el cron job diario.
const processExpiredSubscriptions = async () => {
  const trialCount  = await processExpiredTrials();
  const activeStats = await processExpiredActive();
  console.log(`[CRON] Trials expirados: ${trialCount}`);
  console.log(`[CRON] past_due: ${activeStats.pastDue}, suspended: ${activeStats.suspended}, cancelled: ${activeStats.cancelled}`);
  return { trialExpired: trialCount, ...activeStats };
};

// ─── Private helper ───────────────────────────────────────────────────────────
const _logChange = async (adminId, fromPlanId, toPlanId, fromStatus, toStatus, changedBy, reason) => {
  try {
    const { rows: subs } = await db.query(
      "SELECT id FROM subscriptions WHERE admin_id = $1",
      [adminId]
    );
    if (!subs.length) return;

    await db.query(
      `INSERT INTO subscription_plan_changes
         (subscription_id, admin_id, from_plan_id, to_plan_id, from_status, to_status, reason, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [subs[0].id, adminId, fromPlanId, toPlanId, fromStatus, toStatus, reason, changedBy]
    );
  } catch (e) {
    console.error("[SUBSCRIPTION LOG ERROR]", e.message);
  }
};

module.exports = {
  getSubscriptionByAdmin,
  checkLimits,
  syncUsage,
  createTrialSubscription,
  activateSubscription,
  changePlan,
  cancelSubscription,
  processExpiredTrials,
  processExpiredActive,
  processExpiredSubscriptions,  // ← unificada para el cron
};