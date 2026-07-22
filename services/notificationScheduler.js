// src/services/notificationScheduler.js
const cron = require("node-cron");
const db   = require("../config/db");
const { notifyUser, Payloads } = require("./push.service");

// ─────────────────────────────────────────────────────────────
// HELPER: devuelve Map<adminId → userId[]> con todos los
// admins/gerentes activos agrupados por tenant.
// ─────────────────────────────────────────────────────────────
async function getAllTenantManagers() {
  const { rows } = await db.query(`
    SELECT DISTINCT
      COALESCE(u.owner_admin_id, u.id) AS admin_id,
      u.id AS user_id
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    WHERE r.name IN ('admin', 'gerente')
      AND u.is_active = true
  `);

  const map = new Map();
  for (const row of rows) {
    const key = String(row.admin_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row.user_id);
  }
  return map;
}

async function notifyTenantManagers(adminId, payload, managerMap) {
  const ids = managerMap.get(String(adminId)) ?? [];
  if (!ids.length) return;
  await Promise.allSettled(ids.map((id) => notifyUser(id, payload)));
}

// TAREA 1 (deshabilitada): alertas de stock — modo hybrid hace innecesario este cron

// ─────────────────────────────────────────────────────────────
// TAREA 2: Facturas vencidas — diario a las 9:00
// ─────────────────────────────────────────────────────────────
cron.schedule("0 9 * * *", async () => {
  try {
    const managerMap = await getAllTenantManagers();
    if (!managerMap.size) return;

    const { rows } = await db.query(`
      SELECT i.id, i.pending_amount, i.owner_admin_id,
             p.name AS provider_name,
             EXTRACT(DAY FROM NOW() - i.due_date)::int AS days_overdue
      FROM invoices i
      LEFT JOIN providers p ON p.id = i.provider_id
      WHERE i.payment_status != 'paid'
        AND i.due_date < NOW()
        AND i.owner_admin_id IS NOT NULL
      ORDER BY days_overdue DESC
      LIMIT 50
    `);

    for (const inv of rows) {
      const payload = Payloads.overdueInvoice(inv.provider_name, inv.pending_amount);
      await notifyTenantManagers(inv.owner_admin_id, payload, managerMap).catch(console.error);
    }

    if (rows.length) {
      console.log(`[Scheduler/Invoices] ${rows.length} facturas vencidas notificadas`);
    }
  } catch (err) {
    console.error("[Scheduler/Invoices] Error:", err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// TAREA 3: Descuentos que vencen pronto — cada hora
// ─────────────────────────────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  try {
    const managerMap = await getAllTenantManagers();
    if (!managerMap.size) return;

    const { rows: soon } = await db.query(`
      SELECT id, name, owner_admin_id
      FROM discounts
      WHERE active = true
        AND owner_admin_id IS NOT NULL
        AND ends_at BETWEEN NOW() + INTERVAL '23 hours 25 minutes'
                        AND NOW() + INTERVAL '24 hours 35 minutes'
    `);

    for (const d of soon) {
      const payload = Payloads.expiringDiscount(d.name, "24h");
      await notifyTenantManagers(d.owner_admin_id, payload, managerMap).catch(console.error);
    }

    const { rows: urgent } = await db.query(`
      SELECT id, name, owner_admin_id
      FROM discounts
      WHERE active = true
        AND owner_admin_id IS NOT NULL
        AND ends_at BETWEEN NOW() + INTERVAL '25 minutes'
                        AND NOW() + INTERVAL '1 hour 35 minutes'
    `);

    for (const d of urgent) {
      const payload = Payloads.expiringDiscount(d.name, "1h");
      await notifyTenantManagers(d.owner_admin_id, payload, managerMap).catch(console.error);
    }
  } catch (err) {
    console.error("[Scheduler/Discounts] Error:", err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// TAREA 4: Órdenes de compra sin recibir — diario a las 8:00
// ─────────────────────────────────────────────────────────────
cron.schedule("0 8 * * *", async () => {
  try {
    const managerMap = await getAllTenantManagers();
    if (!managerMap.size) return;

    const { rows } = await db.query(`
      SELECT po.order_number, po.owner_admin_id,
             p.name AS provider_name,
             EXTRACT(DAY FROM NOW() - po.order_date)::int AS days_pending
      FROM purchase_orders po
      LEFT JOIN providers p ON p.id = po.provider_id
      WHERE po.status = 'pending'
        AND po.owner_admin_id IS NOT NULL
        AND po.order_date < NOW() - INTERVAL '7 days'
      LIMIT 50
    `);

    for (const po of rows) {
      const payload = {
        title:    `📦 Orden sin recibir (${po.days_pending} días)`,
        body:     `${po.order_number} — ${po.provider_name}`,
        icon:     "/icon-192.png",
        badge:    "/badge-72.png",
        url:      "/tools/providers",
        tag:      "purchase-order-pending",
        severity: po.days_pending > 14 ? "critical" : "warning",
      };
      await notifyTenantManagers(po.owner_admin_id, payload, managerMap).catch(console.error);
    }
  } catch (err) {
    console.error("[Scheduler/PurchaseOrders] Error:", err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// TAREA 5: Limpiar suscripciones expiradas — semanal (lunes 3 AM)
// ─────────────────────────────────────────────────────────────
cron.schedule("0 3 * * 1", async () => {
  try {
    const { rowCount } = await db.query(`
      DELETE FROM push_subscriptions
      WHERE is_active = false
        AND updated_at < NOW() - INTERVAL '30 days'
    `);
    console.log(`[Scheduler/Cleanup] ${rowCount} suscripciones expiradas eliminadas`);
  } catch (err) {
    console.error("[Scheduler/Cleanup] Error:", err.message);
  }
});

console.log("[Scheduler] ✅ Tareas cron registradas");
