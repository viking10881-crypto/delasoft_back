// src/services/push.service.js  (backend Node.js)
const webpush = require("web-push");
const db = require("../config/db");

// ── Inicializar VAPID solo si las claves están configuradas ──
// Genera las claves con: npx web-push generate-vapid-keys
// y agrégalas al .env / variables de entorno en Render.
const VAPID_ENABLED = !!(
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY &&
  process.env.VAPID_EMAIL
);

if (VAPID_ENABLED) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn("[Push] VAPID keys no configuradas — push notifications deshabilitadas.");
}

// ── Enviar a UNA suscripción ──────────────────────────────────
async function sendPushToOne(subscription, payload) {
  if (!VAPID_ENABLED) return { ok: false, error: "VAPID no configurado" };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    // 410 Gone / 404 = suscripción expirada → limpiar BD
    if (err.statusCode === 410 || err.statusCode === 404) {
      return { ok: false, expired: true, endpoint: subscription.endpoint };
    }
    console.error("[Push] Error enviando:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Broadcast a TODOS los usuarios activos ──────────────────
async function broadcast(payload) {
  if (!VAPID_ENABLED) return { sent: 0, expired: 0 };
  const { rows } = await db.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE is_active = true"
  );

  const results = await Promise.allSettled(
    rows.map((row) =>
      sendPushToOne({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)
    )
  );

  // Desactivar suscripciones expiradas
  const expired = results
    .filter((r) => r.status === "fulfilled" && r.value?.expired)
    .map((r) => r.value.endpoint);

  if (expired.length) {
    await db.query(
      "UPDATE push_subscriptions SET is_active = false WHERE endpoint = ANY($1::text[])",
      [expired]
    );
  }

  return { sent: rows.length, expired: expired.length };
}

// ── Broadcast a UN usuario específico ───────────────────────
async function notifyUser(userId, payload) {
  if (!VAPID_ENABLED) return;
  const { rows } = await db.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 AND is_active = true",
    [userId]
  );

  const results = await Promise.allSettled(
    rows.map((row) =>
      sendPushToOne({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)
    )
  );

  // Desactivar expiradas
  const expired = results
    .filter((r) => r.status === "fulfilled" && r.value?.expired)
    .map((r) => r.value.endpoint);
  if (expired.length) {
    await db.query(
      "UPDATE push_subscriptions SET is_active = false WHERE endpoint = ANY($1::text[])",
      [expired]
    );
  }
}

// ── Notificar a todos los admin/gerentes de un tenant ────────
async function notifyTenant(adminId, payload) {
  if (!VAPID_ENABLED || !adminId) return;
  const { rows } = await db.query(
    `SELECT DISTINCT ur.user_id
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     JOIN users u ON u.id = ur.user_id
     WHERE r.name IN ('admin', 'gerente')
       AND u.is_active = true
       AND (u.id = $1 OR u.owner_admin_id = $1)`,
    [adminId]
  );
  if (!rows.length) return;
  await Promise.allSettled(rows.map((r) => notifyUser(r.user_id, payload)));
}

// ── Payloads reutilizables ───────────────────────────────────
const Payloads = {
  newChat: (senderName) => ({
    title: "💬 Nuevo mensaje",
    body: `${senderName} te envió un mensaje`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/chat",
    tag: "chat-message",
    severity: "info",
  }),

  outOfStock: (productName) => ({
    title: "📦 Sin stock",
    body: `${productName} se quedó sin unidades`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/products",
    tag: "stock-out",
    severity: "critical",
  }),

  lowStock: (productName, stock, minStock) => ({
    title: "⚠️ Stock bajo",
    body: `${productName} — ${stock} uds (mín. ${minStock})`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/products",
    tag: "stock-low",
    severity: "warning",
  }),

  overdueInvoice: (providerName, amount) => ({
    title: "💸 Factura vencida",
    body: `${providerName} — $${Number(amount).toLocaleString("es-CO")} pendiente`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/tools/finance",
    tag: "invoice-overdue",
    severity: "critical",
  }),

  expiringDiscount: (name, label) => ({
    title: `🏷️ Descuento vence en ${label}`,
    body: name,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/tools/discounts",
    tag: "discount-expiring",
    severity: "warning",
  }),

  newSale: (saleNumber, total) => ({
    title: "🛒 Nueva venta",
    body: `${saleNumber} — $${Number(total).toLocaleString("es-CO")}`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/sales",
    tag: "new-sale",
    severity: "info",
  }),

  newOnlineOrder: (saleNumber, total) => ({
    title: "🛍️ Nuevo pedido en línea",
    body: `${saleNumber} — $${Number(total).toLocaleString("es-CO")} pendiente de pago`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/sales",
    tag: "new-online-order",
    severity: "warning",
  }),

  paymentReceived: (saleNumber, amount) => ({
    title: "💰 Abono recibido",
    body: `${saleNumber} — $${Number(amount).toLocaleString("es-CO")}`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/sales",
    tag: "payment-received",
    severity: "info",
  }),

  orderConfirmed: (orderCode, total) => ({
    title: "✅ Pedido recibido",
    body: `Tu pedido ${orderCode} ($${Number(total).toLocaleString("es-CO")}) fue registrado`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/orders",
    tag: "order-confirmed",
    severity: "info",
  }),

  paymentConfirmed: (orderCode) => ({
    title: "✅ Pago confirmado",
    body: `Tu pedido ${orderCode} está pagado`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/orders",
    tag: "payment-confirmed",
    severity: "info",
  }),
};

module.exports = { sendPushToOne, broadcast, notifyUser, notifyTenant, Payloads, VAPID_ENABLED };