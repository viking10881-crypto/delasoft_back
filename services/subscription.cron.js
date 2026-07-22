// services/subscription.cron.js
const cron = require("node-cron");
const subscriptionService = require("./subscription.service");
const db = require("../config/db");

// ─────────────────────────────────────────────────────────────────
// OPCIONAL: importa tu módulo de email cuando esté listo
// const { sendEmail } = require('./email.service');
// ─────────────────────────────────────────────────────────────────

function startSubscriptionCron() {

  // ── 1. Vencimientos: cada día a las 00:05 ──────────────────────
  cron.schedule("5 0 * * *", async () => {
    console.log("[SubscriptionCron] ▶ Procesando vencimientos...");
    try {
      const result = await subscriptionService.processExpiredSubscriptions();
      console.log("[SubscriptionCron] Resultado:", result);
    } catch (err) {
      console.error("[SubscriptionCron] processExpiredSubscriptions error:", err.message);
    }
  });

  // ── 2. Notificaciones: cada día a las 09:00 ─────────────────────
  cron.schedule("0 9 * * *", async () => {
    console.log("[SubscriptionCron] ▶ Enviando notificaciones...");
    await runSafely("notifyTrialExpiring",   notifyTrialExpiring);
    await runSafely("notifyGraceExpiring",   notifyGraceExpiring);
    await runSafely("notifyPastDue",         notifyPastDue);
    await runSafely("notifyRenewalReminder", notifyRenewalReminder);
  });

  // ── 3. Sync contadores de uso: cada hora en el minuto 30 ────────
  cron.schedule("30 * * * *", async () => {
    try {
      const { rows } = await db.query(
        `SELECT DISTINCT admin_id
         FROM subscriptions
         WHERE status IN ('trial', 'active', 'past_due')`
      );

      const BATCH_SIZE = 10;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map(r => subscriptionService.syncUsage(r.admin_id))
        );
      }

      console.log(`[SubscriptionCron] ✔ Usage synced for ${rows.length} admins`);
    } catch (err) {
      console.error("[SubscriptionCron] syncUsage error:", err.message);
    }
  });

  console.log("[SubscriptionCron] ✔ Cron jobs iniciados");
}

// ─── Helper ───────────────────────────────────────────────────────
async function runSafely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[SubscriptionCron] ${label} error:`, err.message);
  }
}

// ─── Notificación: trial por vencer (≤ 3 días) ───────────────────
async function notifyTrialExpiring() {
  const { rows } = await db.query(`
    SELECT
      s.admin_id, u.email, u.name, s.trial_end,
      EXTRACT(DAY FROM s.trial_end::timestamp - now())::int AS days_left,
      sp.name AS plan_name
    FROM subscriptions s
    JOIN users u            ON u.id   = s.admin_id
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.status = 'trial'
      AND s.trial_end::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
  `);

  for (const row of rows) {
    console.log(
      `[SubscriptionCron] ⚠ Trial por vencer: ${row.email} | Plan: ${row.plan_name} | ${row.days_left}d`
    );
    // await sendEmail({ to: row.email, subject: `Tu prueba vence en ${row.days_left} día(s)`, ... });
  }
}

// ─── Notificación: período de gracia (≤ 2 días) ──────────────────
async function notifyGraceExpiring() {
  const { rows } = await db.query(`
    SELECT
      s.admin_id, u.email, u.name, s.grace_expires_at,
      EXTRACT(DAY FROM s.grace_expires_at - now())::int AS days_left
    FROM subscriptions s
    JOIN users u ON u.id = s.admin_id
    WHERE s.status = 'past_due'
      AND s.grace_expires_at IS NOT NULL
      AND s.grace_expires_at > now()
      AND s.grace_expires_at <= now() + INTERVAL '2 days'
  `);

  for (const row of rows) {
    console.log(`[SubscriptionCron] 🔴 Gracia por expirar: ${row.email} | ${row.days_left}d`);
    // await sendEmail({ ... });
  }
}

// ─── Notificación: primer día en past_due ────────────────────────
async function notifyPastDue() {
  const { rows } = await db.query(`
    SELECT
      s.admin_id, u.email, u.name, s.grace_expires_at,
      sp.name AS plan_name, sp.price_monthly
    FROM subscriptions s
    JOIN users u            ON u.id   = s.admin_id
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.status = 'past_due'
      AND s.updated_at::date = CURRENT_DATE
  `);

  for (const row of rows) {
    console.log(`[SubscriptionCron] 💸 Pago pendiente (primer día): ${row.email}`);
    // await sendEmail({ ... });
  }
}

// ─── Notificación: recordatorio de renovación (7 días antes) ─────
async function notifyRenewalReminder() {
  const { rows } = await db.query(`
    SELECT
      s.admin_id, u.email, u.name,
      s.current_period_end, s.billing_cycle, s.amount_due,
      sp.name AS plan_name
    FROM subscriptions s
    JOIN users u            ON u.id   = s.admin_id
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.status = 'active'
      AND s.cancel_at_period_end = false
      AND s.current_period_end::date = CURRENT_DATE + INTERVAL '7 days'
  `);

  for (const row of rows) {
    console.log(
      `[SubscriptionCron] 🔔 Recordatorio renovación: ${row.email} | ${row.plan_name} | vence ${row.current_period_end}`
    );
    // await sendEmail({ ... });
  }
}

module.exports = { startSubscriptionCron };