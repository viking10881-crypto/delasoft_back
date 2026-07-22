// controllers/notifications.controller.js
const crypto   = require('crypto');
const db = require("../config/db");
const { getOrCreateSettings, enqueueNotification } = require("../services/notification.service");
const whatsapp = require("../services/providers/whatsapp.provider");

// Verifies X-Hub-Signature-256 sent by Meta on every webhook POST.
// Returns true if META_WA_APP_SECRET is not set (dev/unconfig mode).
function _verifyMetaSignature(req) {
  const appSecret = process.env.META_WA_APP_SECRET;
  if (!appSecret) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

exports.getAll = async (req, res) => {
  try {
    // adminScope garantiza que req.isSuperAdmin y req.adminId siempre están disponibles.
    const { isSuperAdmin = false, adminId } = req;

    // Helpers de scoping: superadmin ve todo; cada admin solo ve sus propios datos.
    const tf  = isSuperAdmin ? "" : "AND owner_admin_id = $1";       // tablas directas
    const stf = isSuperAdmin ? "" : "AND s.owner_admin_id = $1";     // tabla sales con alias s
    const itf = isSuperAdmin ? "" : "AND i.owner_admin_id = $1";     // tabla invoices con alias i
    const ptf = isSuperAdmin ? "" : "AND po.owner_admin_id = $1";    // tabla purchase_orders con alias po
    const p   = isSuperAdmin ? []  : [adminId];                      // parámetros de la query

    const [
      outOfStock,
      lowStock,
      pendingOrders,
      overdueInvoices,
      expiringDiscounts,
      expiredDiscounts,
      pendingPurchaseOrders,
      highDebtProviders,
    ] = await Promise.all([

      // 1. Productos sin stock
      db.query(`
        SELECT id, name, stock, sku
        FROM products
        WHERE is_active = true AND stock = 0 ${tf}
        ORDER BY updated_at DESC
        LIMIT 10
      `, p),

      // 2. Productos con stock bajo (stock > 0 pero <= min_stock)
      db.query(`
        SELECT id, name, stock, min_stock, sku
        FROM products
        WHERE is_active = true AND stock > 0 AND stock <= min_stock ${tf}
        ORDER BY stock ASC
        LIMIT 10
      `, p),

      // 3. Pedidos online pendientes de pago
      db.query(`
        SELECT s.id, s.sale_number, s.total, s.sale_date,
               u.name AS customer_name
        FROM sales s
        LEFT JOIN users u ON u.id = s.customer_id
        WHERE s.payment_status = 'pending'
          AND s.sale_type != 'fisica'
          ${stf}
        ORDER BY s.sale_date DESC
        LIMIT 10
      `, p),

      // 4. Facturas vencidas sin pagar
      db.query(`
        SELECT i.id, i.invoice_number, i.total_amount, i.pending_amount,
               i.due_date, i.invoice_type,
               p.name AS provider_name,
               EXTRACT(DAY FROM NOW() - i.due_date)::int AS days_overdue
        FROM invoices i
        LEFT JOIN providers p ON p.id = i.provider_id
        WHERE i.payment_status != 'paid'
          AND i.due_date < NOW()
          ${itf}
        ORDER BY i.due_date ASC
        LIMIT 10
      `, p),

      // 5. Descuentos que vencen en los próximos 3 días
      db.query(`
        SELECT id, name, ends_at,
               EXTRACT(HOUR FROM ends_at - NOW())::int AS hours_left
        FROM discounts
        WHERE active = true
          AND ends_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
          ${tf}
        ORDER BY ends_at ASC
        LIMIT 5
      `, p),

      // 6. Descuentos vencidos pero aún marcados como activos
      db.query(`
        SELECT id, name, ends_at
        FROM discounts
        WHERE active = true AND ends_at < NOW() ${tf}
        ORDER BY ends_at DESC
        LIMIT 5
      `, p),

      // 7. Órdenes de compra pendientes de recibir (> 7 días)
      db.query(`
        SELECT po.id, po.order_number, po.order_date,
               po.expected_delivery_date, po.total_cost,
               p.name AS provider_name,
               EXTRACT(DAY FROM NOW() - po.order_date)::int AS days_pending
        FROM purchase_orders po
        LEFT JOIN providers p ON p.id = po.provider_id
        WHERE po.status = 'pending'
          AND po.order_date < NOW() - INTERVAL '7 days'
          ${ptf}
        ORDER BY po.order_date ASC
        LIMIT 5
      `, p),

      // 8. Proveedores con deuda alta (> 80% del crédito)
      db.query(`
        SELECT id, name, balance, credit_limit,
               ROUND((balance / NULLIF(credit_limit, 0) * 100)::numeric, 1) AS credit_used_pct
        FROM providers
        WHERE is_active = true
          AND credit_limit > 0
          AND balance >= credit_limit * 0.8
          ${tf}
        ORDER BY credit_used_pct DESC
        LIMIT 5
      `, p),
    ]);

    // Construir array de notificaciones con tipo, severidad y enlace
    const notifications = [];

    outOfStock.rows.forEach(p => {
      notifications.push({
        id: `out-${p.id}`,
        type: "stock",
        severity: "critical",
        title: "Sin stock",
        message: `${p.name}${p.sku ? ` (${p.sku})` : ""} — 0 unidades`,
        link: `/products/${p.id}`,
        created_at: new Date().toISOString(),
      });
    });

    lowStock.rows.forEach(p => {
      notifications.push({
        id: `low-${p.id}`,
        type: "stock",
        severity: "warning",
        title: "Stock bajo",
        message: `${p.name} — ${p.stock} uds (mín. ${p.min_stock})`,
        link: `/products/${p.id}`,
        created_at: new Date().toISOString(),
      });
    });

    pendingOrders.rows.forEach(o => {
      notifications.push({
        id: `order-${o.id}`,
        type: "sale",
        severity: "info",
        title: "Pago pendiente",
        message: `${o.sale_number} — ${o.customer_name || "Cliente"} · $${Number(o.total).toLocaleString("es-CO")}`,
        link: `/history`,
        created_at: o.sale_date,
      });
    });

    overdueInvoices.rows.forEach(i => {
      notifications.push({
        id: `inv-${i.id}`,
        type: "finance",
        severity: i.days_overdue > 30 ? "critical" : "warning",
        title: `Factura vencida hace ${i.days_overdue} días`,
        message: `${i.provider_name || "Sin proveedor"} — $${Number(i.pending_amount).toLocaleString("es-CO")} pendiente`,
        link: `/tools/finance`,
        created_at: i.due_date,
      });
    });

    expiringDiscounts.rows.forEach(d => {
      const h = d.hours_left;
      const label = h < 24 ? `${h}h` : `${Math.ceil(h / 24)} días`;
      notifications.push({
        id: `disc-exp-${d.id}`,
        type: "discount",
        severity: h < 24 ? "warning" : "info",
        title: `Descuento vence en ${label}`,
        message: d.name,
        link: `/tools/discounts`,
        created_at: new Date().toISOString(),
      });
    });

    expiredDiscounts.rows.forEach(d => {
      notifications.push({
        id: `disc-dead-${d.id}`,
        type: "discount",
        severity: "warning",
        title: "Descuento vencido activo",
        message: `"${d.name}" venció pero sigue activo`,
        link: `/tools/discounts`,
        created_at: d.ends_at,
      });
    });

    pendingPurchaseOrders.rows.forEach(po => {
      notifications.push({
        id: `po-${po.id}`,
        type: "purchase",
        severity: "info",
        title: `Orden sin recibir (${po.days_pending} días)`,
        message: `${po.order_number} — ${po.provider_name}`,
        link: `/tools/providers`,
        created_at: po.order_date,
      });
    });

    highDebtProviders.rows.forEach(p => {
      notifications.push({
        id: `debt-${p.id}`,
        type: "finance",
        severity: p.credit_used_pct >= 100 ? "critical" : "warning",
        title: `Proveedor al ${p.credit_used_pct}% de crédito`,
        message: `${p.name} — $${Number(p.balance).toLocaleString("es-CO")} de deuda`,
        link: `/tools/finance`,
        created_at: new Date().toISOString(),
      });
    });

    // Ordenar: critical primero, luego warning, luego info
    const order = { critical: 0, warning: 1, info: 2 };
    notifications.sort((a, b) => order[a.severity] - order[b.severity]);

    res.json({
      success: true,
      count: notifications.length,
      critical: notifications.filter(n => n.severity === "critical").length,
      data: notifications,
    });

  } catch (error) {
    console.error("[NOTIFICATIONS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener notificaciones" });
  }
};

// ============================================
// ⚙️  CONFIGURACIÓN DE NOTIFICACIONES WHATSAPP
// ============================================

/**
 * GET /api/notifications/settings
 * Returns the current tenant's notification settings (creates defaults if missing).
 */
exports.getSettings = async (req, res) => {
  try {
    const settings = await getOrCreateSettings(req.adminId);
    res.json({ success: true, data: settings });
  } catch (err) {
    console.error("[NOTIFICATION SETTINGS GET]", err);
    res.status(500).json({ success: false, message: "Error al obtener configuración" });
  }
};

/**
 * PUT /api/notifications/settings
 * Updates WhatsApp and notification preferences for the current tenant.
 */
exports.updateSettings = async (req, res) => {
  const {
    whatsapp_enabled, whatsapp_phone, whatsapp_country_code,
    email_enabled, push_enabled,
    events_enabled, quiet_hours_start, quiet_hours_end, timezone,
  } = req.body;

  // Build SET clause only for provided fields
  const allowed = [
    'whatsapp_enabled', 'whatsapp_phone', 'whatsapp_country_code',
    'email_enabled', 'push_enabled',
    'events_enabled', 'quiet_hours_start', 'quiet_hours_end', 'timezone',
  ];
  const updates = [];
  const params  = [];
  let idx = 1;

  // Normalize empty strings to null for types that PostgreSQL rejects as ""
  const fieldMap = {
    whatsapp_enabled,
    whatsapp_phone:        whatsapp_phone        || null,
    whatsapp_country_code,
    email_enabled, push_enabled,
    events_enabled,
    quiet_hours_start: quiet_hours_start || null,
    quiet_hours_end:   quiet_hours_end   || null,
    timezone,
  };

  for (const field of allowed) {
    if (fieldMap[field] !== undefined) {
      const val = field === 'events_enabled'
        ? JSON.stringify(Array.isArray(fieldMap[field]) ? fieldMap[field] : [])
        : fieldMap[field];
      updates.push(`${field} = $${idx++}`);
      params.push(val);
    }
  }

  if (!updates.length) {
    return res.status(400).json({ success: false, message: "Sin campos para actualizar" });
  }

  // Phone format validation (only when a non-null phone is being set)
  if (fieldMap.whatsapp_phone != null) {
    const digits = String(fieldMap.whatsapp_phone).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      return res.status(400).json({
        success: false,
        message: "Número de teléfono inválido (entre 7 y 15 dígitos)",
      });
    }
  }

  try {
    updates.push(`updated_at = NOW()`);
    params.push(req.adminId);

    const { rows: [updated] } = await db.query(
      `INSERT INTO notification_settings (admin_id, created_at, updated_at)
       VALUES ($${idx}, NOW(), NOW())
       ON CONFLICT (admin_id) DO UPDATE
       SET ${updates.join(', ')}
       RETURNING *`,
      params
    );

    res.json({ success: true, message: "Configuración guardada", data: updated });
  } catch (err) {
    console.error("[NOTIFICATION SETTINGS PUT]", err);
    res.status(500).json({ success: false, message: "Error al guardar configuración" });
  }
};

/**
 * POST /api/notifications/test-whatsapp
 * Sends a test WhatsApp message to the phone configured in settings.
 */
exports.testWhatsapp = async (req, res) => {
  try {
    const settings = await getOrCreateSettings(req.adminId);

    if (!settings.whatsapp_enabled) {
      return res.status(400).json({
        success: false,
        message: "Activa las notificaciones de WhatsApp antes de enviar la prueba",
      });
    }

    if (!settings.whatsapp_phone) {
      return res.status(400).json({
        success: false,
        message: "Configura tu número de WhatsApp antes de enviar la prueba",
      });
    }

    const code  = String(settings.whatsapp_country_code || '+57').replace(/\D/g, '');
    const local = String(settings.whatsapp_phone).replace(/\D/g, '');
    const phone = local.startsWith(code) ? local : code + local;

    const result = await whatsapp.send(phone, '✅ Notificaciones de WhatsApp funcionando correctamente en Delasoft.');

    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: `Error al enviar: ${result.error}`,
      });
    }

    res.json({ success: true, message: "Mensaje de prueba enviado", providerMessageId: result.providerMessageId });
  } catch (err) {
    console.error("[TEST WHATSAPP]", err);
    res.status(500).json({ success: false, message: "Error al enviar prueba" });
  }
};

/**
 * GET /api/notifications/webhook/whatsapp
 * Meta webhook hub verification challenge — required once during webhook setup.
 * Meta sends: ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
 */
exports.verifyWebhookWhatsapp = (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
};

/**
 * POST /api/notifications/webhook/whatsapp
 * Receives delivery status callbacks from Meta or Twilio.
 * Updates notification_queue.status by provider_message_id.
 */
exports.webhookWhatsapp = async (req, res) => {
  const provider = process.env.WHATSAPP_PROVIDER || 'meta_cloud';

  // Verify HMAC signature for Meta (skip if APP_SECRET not configured)
  if (provider === 'meta_cloud' && !_verifyMetaSignature(req)) {
    console.warn('[WEBHOOK WHATSAPP] Firma HMAC inválida — request rechazado');
    return res.sendStatus(403);
  }

  try {

    if (provider === 'meta_cloud') {
      const entry  = req.body?.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const statuses = change?.statuses ?? [];

      for (const s of statuses) {
        if (!s.id) continue;
        const dbStatus = s.status === 'delivered' || s.status === 'read' ? 'sent' : null;
        if (!dbStatus) continue;
        await db.query(
          `UPDATE notification_queue SET status = $1, updated_at = NOW()
           WHERE provider_message_id = $2 AND status != 'failed'`,
          [dbStatus, s.id]
        );
      }
    } else if (provider === 'twilio') {
      const msgSid  = req.body?.MessageSid;
      const status  = req.body?.MessageStatus;
      if (msgSid && ['delivered', 'read', 'sent'].includes(status)) {
        await db.query(
          `UPDATE notification_queue SET status = 'sent', updated_at = NOW()
           WHERE provider_message_id = $1 AND status != 'failed'`,
          [msgSid]
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK WHATSAPP]", err);
    res.sendStatus(200); // always 200 so provider doesn't retry indefinitely
  }
};