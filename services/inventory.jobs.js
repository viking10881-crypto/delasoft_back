// services/inventory.jobs.js
// Two cron jobs for the inventory engine:
//   1. Release expired reservations (every minute)
//   2. Create stock alerts for low/out-of-stock products (every 15 min)
const cron = require('node-cron');
const db   = require('../config/db');
const inv  = require('./inventory.service');
const { sendLowStockDigestEmail } = require('../config/emailConfig');

// ─── Job 1: liberar reservas vencidas ────────────────────────────────────────
const CLEANUP_BATCH       = 100;
const CLEANUP_TIMEOUT_MS  = 30_000;

function startReservationCleanupJob() {
  cron.schedule('* * * * *', async () => {
    let released    = 0;
    let batchCount  = 0;
    const start     = Date.now();
    try {
      do {
        if (Date.now() - start > CLEANUP_TIMEOUT_MS) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(), event: 'reservation_cleanup_timeout',
            released, durationMs: Date.now() - start,
          }));
          break;
        }

        const { rows: expired } = await db.query(
          `SELECT id, owner_admin_id
           FROM stock_reservations
           WHERE status = 'active' AND expires_at < NOW()
           LIMIT $1`,
          [CLEANUP_BATCH],
        );

        batchCount = expired.length;
        if (!batchCount) break;

        for (const r of expired) {
          try {
            await inv.releaseReservation(r.id, { ownerAdminId: r.owner_admin_id, userId: null }, 'expired');
            released++;
          } catch (err) {
            console.log(JSON.stringify({
              ts: new Date().toISOString(), event: 'reservation_release_error',
              adminId: r.owner_admin_id, reservationId: r.id, error: err.message,
            }));
          }
        }
      } while (batchCount === CLEANUP_BATCH);

      if (released > 0) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(), event: 'reservation_cleanup_done',
          released, durationMs: Date.now() - start,
        }));
      }
    } catch (err) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), event: 'reservation_cleanup_error', error: err.message,
      }));
    }
  });
}

// ─── Job 2: alertas de stock bajo ────────────────────────────────────────────
function startLowStockAlertJob() {
  cron.schedule('*/15 * * * *', async () => {
    let created = 0;
    try {
      // Products/variants where disponible <= min_stock and no unresolved alert exists
      const { rows } = await db.query(`
        SELECT v.owner_admin_id,
               v.product_id,
               v.variant_id,
               v.disponible,
               v.stock_fisico,
               v.min_stock
        FROM v_stock_disponible v
        WHERE v.disponible <= COALESCE(v.min_stock, 0)
          AND NOT EXISTS (
            SELECT 1 FROM stock_alerts a
            WHERE a.product_id = v.product_id
              AND a.variant_id IS NOT DISTINCT FROM v.variant_id
              AND a.resolved   = false
              AND a.alert_type IN ('low_stock', 'out_of_stock')
          )
      `);

      for (const row of rows) {
        try {
          const alertType = row.stock_fisico <= 0 ? 'out_of_stock' : 'low_stock';
          await db.query(
            `INSERT INTO stock_alerts
               (owner_admin_id, product_id, variant_id, alert_type, threshold, current_value)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [row.owner_admin_id, row.product_id, row.variant_id,
             alertType, row.min_stock ?? 0, row.disponible],
          );
          created++;
        } catch (err) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(), event: 'stock_alert_create_error',
            productId: row.product_id, adminId: row.owner_admin_id, error: err.message,
          }));
        }
      }
      if (created > 0) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(), event: 'stock_alerts_created', count: created,
        }));
      }
    } catch (err) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), event: 'stock_alert_job_error', error: err.message,
      }));
    }
  });
}

// ─── Job 3: resumen diario de stock bajo por correo (09:00) ──────────────────
// Solo productos con mínimo configurado (min_stock > 0) y disponible <= mínimo.
// Se calcula desde el stock actual, no desde stock_alerts.
function startLowStockDigestJob() {
  cron.schedule('0 9 * * *', async () => {
    try {
      const { rows } = await db.query(`
        SELECT v.owner_admin_id, u.email, u.name,
               v.name, v.sku, v.variant_sku, v.stock_fisico,
               v.disponible_inmediato AS disponible, v.min_stock
          FROM v_stock_disponible v
          JOIN users u ON u.id = v.owner_admin_id
         WHERE u.is_active = true
           AND COALESCE(v.min_stock, 0) > 0
           AND v.disponible_inmediato <= v.min_stock
         ORDER BY v.owner_admin_id, v.name
      `);

      const byOwner = new Map();
      for (const r of rows) {
        if (!byOwner.has(r.owner_admin_id)) {
          byOwner.set(r.owner_admin_id, { email: r.email, name: r.name, items: [] });
        }
        byOwner.get(r.owner_admin_id).items.push({
          name: r.name,
          sku: r.variant_sku || r.sku,
          stock_fisico: r.stock_fisico,
          disponible: r.disponible,
          min_stock: r.min_stock,
        });
      }

      for (const [adminId, owner] of byOwner) {
        try {
          await sendLowStockDigestEmail(owner.email, owner.name, owner.items);
        } catch (err) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(), event: 'low_stock_digest_error',
            adminId, error: err.message,
          }));
        }
      }
      console.log(JSON.stringify({
        ts: new Date().toISOString(), event: 'low_stock_digest_done', owners: byOwner.size,
      }));
    } catch (err) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), event: 'low_stock_digest_job_error', error: err.message,
      }));
    }
  });
}

function startInventoryJobs() {
  startReservationCleanupJob();
  // startLowStockAlertJob(); — disabled: all products are hybrid, no static alerts needed
  startLowStockDigestJob();
  console.log('[inventory-jobs] reservation-cleanup (1min) + low-stock digest (09:00) iniciados');
}

module.exports = { startInventoryJobs };
