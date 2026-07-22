// controllers/subscription.controller.js
const db = require("../config/db");
const subscriptionService = require("../services/subscription.service");

// ──────────────────────────────────────────
// PLANES PÚBLICOS
// ──────────────────────────────────────────

/** GET /api/subscriptions/plans */
exports.getPublicPlans = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, slug, description, tagline,
              price_monthly, price_yearly, trial_days, currency,
              max_products, max_users, max_admins, max_monthly_sales,
              max_api_keys, max_categories, max_banners, max_providers, storage_mb,
              has_analytics, has_ai_agent, has_api_access, has_multi_admin,
              has_custom_branding, has_wompi_payments, has_export,
              has_priority_support, has_push_notifications,
              has_financial_reports, has_purchase_orders, has_discount_system,
              color, badge_label, sort_order
       FROM subscription_plans
       WHERE is_active = true AND is_public = true
       ORDER BY sort_order ASC`
    );
    res.json({ success: true, plans: rows });
  } catch (err) {
    console.error("[getPublicPlans]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ──────────────────────────────────────────
// MI SUSCRIPCIÓN
// ──────────────────────────────────────────

/** GET /api/subscriptions/me */
exports.getMySubscription = async (req, res) => {
  try {
    const adminId = req.user.owner_admin_id || req.user.id;
    const sub = await subscriptionService.getSubscriptionByAdmin(adminId);
    if (!sub) {
      return res.status(404).json({ success: false, message: "Sin suscripción activa" });
    }
    const limits = await subscriptionService.checkLimits(adminId);
    res.json({ success: true, subscription: sub, limits });
  } catch (err) {
    console.error("[getMySubscription]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /api/subscriptions/me/invoices */
exports.getMyInvoices = async (req, res) => {
  try {
    const adminId = req.user.owner_admin_id || req.user.id;
    const { rows } = await db.query(
      `SELECT si.*, sp.name AS plan_name
       FROM subscription_invoices si
       JOIN subscription_plans sp ON sp.id = si.plan_id
       WHERE si.admin_id = $1
       ORDER BY si.created_at DESC
       LIMIT 24`,
      [adminId]
    );
    res.json({ success: true, invoices: rows });
  } catch (err) {
    console.error("[getMyInvoices]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ──────────────────────────────────────────
// VALIDAR CUPÓN
// ──────────────────────────────────────────

/** POST /api/subscriptions/coupons/validate */
exports.validateCoupon = async (req, res) => {
  try {
    const { code, plan_slug, billing_cycle = "monthly" } = req.body;
    if (!code) return res.status(400).json({ success: false, message: "Código requerido" });

    const couponRes = await db.query(
      `SELECT sc.*, ARRAY_AGG(sp.slug) AS applicable_plan_slugs
       FROM subscription_coupons sc
       LEFT JOIN subscription_plans sp ON sp.id = ANY(sc.applicable_plans)
       WHERE sc.code = $1
         AND sc.is_active = true
         AND (sc.valid_until IS NULL OR sc.valid_until > now())
         AND (sc.max_uses IS NULL OR sc.times_used < sc.max_uses)
       GROUP BY sc.id`,
      [code.toUpperCase().trim()]
    );

    if (!couponRes.rows.length) {
      return res.status(404).json({ success: false, valid: false, message: "Cupón inválido o expirado" });
    }

    const coupon = couponRes.rows[0];

    if (coupon.applicable_plan_slugs?.filter(Boolean).length > 0 && plan_slug) {
      if (!coupon.applicable_plan_slugs.includes(plan_slug)) {
        return res.status(400).json({
          success: false, valid: false,
          message: "Este cupón no aplica al plan seleccionado",
        });
      }
    }

    let planPrice = 0;
    if (plan_slug) {
      const pRes = await db.query(
        "SELECT price_monthly, price_yearly FROM subscription_plans WHERE slug = $1",
        [plan_slug]
      );
      if (pRes.rows.length) {
        planPrice = billing_cycle === "yearly"
          ? (pRes.rows[0].price_yearly || pRes.rows[0].price_monthly * 12)
          : pRes.rows[0].price_monthly;
      }
    }

    let discountPreview = 0;
    if (coupon.coupon_type === "percentage") discountPreview = (planPrice * coupon.discount_value) / 100;
    else if (coupon.coupon_type === "fixed")      discountPreview = Math.min(coupon.discount_value, planPrice);
    else if (coupon.coupon_type === "free_months") discountPreview = coupon.free_months;
    else if (coupon.coupon_type === "full_free")   discountPreview = planPrice;

    res.json({
      success: true,
      valid: true,
      coupon: {
        code:           coupon.code,
        description:    coupon.description,
        coupon_type:    coupon.coupon_type,
        discount_value: coupon.discount_value,
        free_months:    coupon.free_months,
      },
      discount_preview: discountPreview,
    });
  } catch (err) {
    console.error("[validateCoupon]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ──────────────────────────────────────────
// CANCELAR / REACTIVAR
// ──────────────────────────────────────────

/** POST /api/subscriptions/cancel */
exports.cancelSubscription = async (req, res) => {
  try {
    const adminId = req.user.owner_admin_id || req.user.id;
    const { reason, cancel_now = false } = req.body;
    const result = await subscriptionService.cancelSubscription(adminId, reason, cancel_now, req.user.id);
    res.json({
      success: true,
      message: cancel_now ? "Suscripción cancelada" : "Se cancelará al finalizar el período",
      subscription: result,
    });
  } catch (err) {
    console.error("[cancelSubscription]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /api/subscriptions/reactivate */
exports.reactivateSubscription = async (req, res) => {
  try {
    const adminId = req.user.owner_admin_id || req.user.id;
    const { rows } = await db.query(
      `UPDATE subscriptions SET
         cancel_at_period_end = false,
         cancelled_at = NULL,
         cancellation_reason = NULL,
         status = CASE WHEN status = 'cancelled' THEN 'active' ELSE status END,
         updated_at = now()
       WHERE admin_id = $1
       RETURNING *`,
      [adminId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Suscripción no encontrada" });
    }
    res.json({ success: true, message: "Suscripción reactivada", subscription: rows[0] });
  } catch (err) {
    console.error("[reactivateSubscription]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ──────────────────────────────────────────
// CAMBIAR PLAN
// ──────────────────────────────────────────

/** POST /api/subscriptions/change-plan */
exports.changePlan = async (req, res) => {
  try {
    const adminId = req.user.owner_admin_id || req.user.id;
    const { plan_slug } = req.body;
    if (!plan_slug) return res.status(400).json({ success: false, message: "plan_slug requerido" });
    const result = await subscriptionService.changePlan(adminId, plan_slug, req.user.id);
    res.json({ success: true, message: "Plan actualizado", subscription: result });
  } catch (err) {
    console.error("[changePlan]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ──────────────────────────────────────────
// SUPERADMIN: gestión global
// ──────────────────────────────────────────

/** GET /api/subscriptions/admin/all */
exports.getAllSubscriptions = async (req, res) => {
  try {
    const { status, plan, page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (status) { params.push(status); conditions.push(`s.status = $${params.length}`); }
    if (plan)   { params.push(plan);   conditions.push(`sp.slug = $${params.length}`); }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT s.*,
              sp.name AS plan_name, sp.slug AS plan_slug, sp.price_monthly,
              u.name AS admin_name, u.email AS admin_email,
              su.products_count, su.users_count, su.monthly_sales_count
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       JOIN users u ON u.id = s.admin_id
       LEFT JOIN subscription_usage su ON su.admin_id = s.admin_id
       ${where}
       ORDER BY s.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countRes = await db.query(
      `SELECT COUNT(*) FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id ${where}`,
      params.slice(0, -2)
    );

    res.json({
      success: true,
      subscriptions: rows,
      total: parseInt(countRes.rows[0].count),
      page: +page,
      limit: +limit,
    });
  } catch (err) {
    console.error("[getAllSubscriptions]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /api/subscriptions/admin/assign */
exports.assignSubscription = async (req, res) => {
  try {
    const { admin_id, plan_slug, trial_days, billing_cycle = "monthly" } = req.body;
    if (!admin_id || !plan_slug) {
      return res.status(400).json({ success: false, message: "admin_id y plan_slug requeridos" });
    }

    let result;
    if (trial_days && parseInt(trial_days) > 0) {
      result = await subscriptionService.createTrialSubscription(admin_id, plan_slug, req.user.id);
      // Override trial_end si se pasó un valor custom
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + parseInt(trial_days));
      await db.query(
        `UPDATE subscriptions
         SET trial_end = $1, current_period_end = $1, next_billing_date = $1, updated_at = now()
         WHERE admin_id = $2`,
        [trialEnd.toISOString().split("T")[0], admin_id]
      );
    } else {
      result = await subscriptionService.activateSubscription(admin_id, {
        planSlug:         plan_slug,
        billingCycle:     billing_cycle,
        paymentMethod:    "manual",
        paymentReference: `ADMIN-${req.user.id}`,
        changedBy:        req.user.id,
      });
    }

    res.json({ success: true, message: "Suscripción asignada", data: result });
  } catch (err) {
    console.error("[assignSubscription]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /api/subscriptions/admin/stats */
exports.getSubscriptionStats = async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')    AS active_count,
        COUNT(*) FILTER (WHERE status = 'trial')     AS trial_count,
        COUNT(*) FILTER (WHERE status = 'past_due')  AS past_due_count,
        COUNT(*) FILTER (WHERE status = 'suspended') AS suspended_count,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
        SUM(amount_due) FILTER (WHERE status = 'active') AS mrr,
        COUNT(DISTINCT plan_id) AS plans_used
      FROM subscriptions
    `);

    const byPlan = await db.query(`
      SELECT sp.name, sp.slug, sp.color, COUNT(s.id) AS count, SUM(s.amount_due) AS revenue
      FROM subscriptions s
      JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE s.status IN ('active', 'trial')
      GROUP BY sp.id
      ORDER BY count DESC
    `);

    const recentInvoices = await db.query(`
      SELECT si.*, u.name AS admin_name, sp.name AS plan_name
      FROM subscription_invoices si
      JOIN users u            ON u.id   = si.admin_id
      JOIN subscription_plans sp ON sp.id = si.plan_id
      ORDER BY si.created_at DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      stats:           stats.rows[0],
      by_plan:         byPlan.rows,
      recent_invoices: recentInvoices.rows,
    });
  } catch (err) {
    console.error("[getSubscriptionStats]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /api/subscriptions/admin/coupons */
exports.createCoupon = async (req, res) => {
  try {
    const {
      code, description, coupon_type, discount_value,
      free_months, max_uses, valid_from, valid_until,
      applicable_plans, applies_to_cycle,
    } = req.body;

    if (!code || !coupon_type) {
      return res.status(400).json({ success: false, message: "code y coupon_type requeridos" });
    }

    const { rows } = await db.query(
      `INSERT INTO subscription_coupons
         (code, description, coupon_type, discount_value, free_months,
          max_uses, valid_from, valid_until, applicable_plans,
          applies_to_cycle, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        code.toUpperCase().trim(), description, coupon_type,
        discount_value || 0, free_months || 0,
        max_uses || null, valid_from || new Date(), valid_until || null,
        applicable_plans || null, applies_to_cycle || null, req.user.id,
      ]
    );

    res.status(201).json({ success: true, coupon: rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ success: false, message: "Ese código ya existe" });
    }
    console.error("[createCoupon]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /api/subscriptions/admin/coupons */
exports.getCoupons = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT sc.*, u.name AS created_by_name
       FROM subscription_coupons sc
       LEFT JOIN users u ON u.id = sc.created_by
       ORDER BY sc.created_at DESC`
    );
    res.json({ success: true, coupons: rows });
  } catch (err) {
    console.error("[getCoupons]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PATCH /api/subscriptions/admin/plans/:id */
exports.updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    const allowed = [
      "name", "description", "tagline", "price_monthly", "price_yearly", "trial_days",
      "max_products", "max_users", "max_admins", "max_monthly_sales", "max_api_keys",
      "max_categories", "max_banners", "max_providers", "storage_mb",
      "has_analytics", "has_ai_agent", "has_api_access", "has_multi_admin",
      "has_custom_branding", "has_wompi_payments", "has_export", "has_priority_support",
      "has_push_notifications", "has_financial_reports", "has_purchase_orders",
      "has_discount_system", "color", "badge_label", "sort_order", "is_active", "is_public",
    ];

    const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
    if (!entries.length) {
      return res.status(400).json({ success: false, message: "Sin campos para actualizar" });
    }

    const updates = entries.map(([k], i) => `"${k}" = $${i + 2}`).join(", ");
    const values  = entries.map(([, v]) => v);

    const { rows } = await db.query(
      `UPDATE subscription_plans SET ${updates}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...values]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Plan no encontrado" });
    }

    res.json({ success: true, plan: rows[0] });
  } catch (err) {
    console.error("[updatePlan]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};