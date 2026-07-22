// routes/notifications.routes.js
const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");
const ctrl     = require("../controllers/notifications.controller");
const pushCtrl = require("../controllers/pushSubscription.controller");
const { broadcast, notifyUser, Payloads } = require("../services/push.service");

const router = express.Router();

/** GET  /api/notifications          — Panel de alertas */
router.get("/",           auth, adminScope, requireManager, ctrl.getAll);

// ── WhatsApp settings ────────────────────────────────────────
/** GET  /api/notifications/settings — Configuración de notificaciones del tenant */
router.get ("/settings",       auth, adminScope, requireManager, ctrl.getSettings);
/** PUT  /api/notifications/settings — Actualizar configuración */
router.put ("/settings",       auth, adminScope, requireManager, ctrl.updateSettings);
/** POST /api/notifications/test-whatsapp — Enviar mensaje de prueba */
router.post("/test-whatsapp",  auth, adminScope, requireManager, ctrl.testWhatsapp);
/** GET  /api/notifications/webhook/whatsapp — Verificación del hub de Meta (configuración única) */
router.get ("/webhook/whatsapp", ctrl.verifyWebhookWhatsapp);
/** POST /api/notifications/webhook/whatsapp — Callbacks de Meta / Twilio */
router.post("/webhook/whatsapp", ctrl.webhookWhatsapp);

/** GET  /api/notifications/push-key — Clave pública VAPID (pública) */
router.get("/push-key",   pushCtrl.getPublicKey);

/** POST /api/notifications/subscribe   — Guardar suscripción push */
router.post("/subscribe",   auth, pushCtrl.subscribe);

/** POST /api/notifications/unsubscribe — Cancelar suscripción push */
router.post("/unsubscribe", auth, pushCtrl.unsubscribe);

// ── Endpoints de prueba (solo en desarrollo) ─────────────────
if (process.env.NODE_ENV !== "production") {

  /** POST /api/notifications/test/broadcast
   *  Body: { title, body, severity, url, type }
   *  Envía a TODOS los suscritos activos
   */
  router.post("/test/broadcast", auth, requireManager, async (req, res) => {
    try {
      const payload = {
        title:    req.body.title    ?? "🧪 Test broadcast",
        body:     req.body.body     ?? "Notificación de prueba enviada a todos",
        icon:     "/icon-192.png",
        badge:    "/badge-72.png",
        url:      req.body.url      ?? "/",
        tag:      "test-broadcast",
        severity: req.body.severity ?? "info",
        type:     req.body.type     ?? "test",
      };
      const result = await broadcast(payload);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  /** POST /api/notifications/test/me
   *  Envía una notificación solo al usuario autenticado
   */
  router.post("/test/me", auth, async (req, res) => {
    try {
      const payload = {
        title:    req.body.title    ?? "🧪 Test personal",
        body:     req.body.body     ?? "Solo para ti",
        icon:     "/icon-192.png",
        badge:    "/badge-72.png",
        url:      req.body.url      ?? "/",
        tag:      "test-personal",
        severity: req.body.severity ?? "info",
        type:     req.body.type     ?? "test",
      };
      await notifyUser(req.user.id, payload);
      res.json({ success: true, message: `Enviado a userId ${req.user.id}` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  /** POST /api/notifications/test/stock
   *  Simula una alerta de stock bajo
   */
  router.post("/test/stock", auth, requireManager, async (req, res) => {
    try {
      const { name = "Producto de prueba", stock = 2, minStock = 5, outOfStock = false } = req.body;
      const payload = outOfStock
        ? Payloads.outOfStock(name)
        : Payloads.lowStock(name, stock, minStock);
      const result = await broadcast(payload);
      res.json({ success: true, payload, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  /** POST /api/notifications/test/invoice
   *  Simula una factura vencida
   */
  router.post("/test/invoice", auth, requireManager, async (req, res) => {
    try {
      const { providerName = "Proveedor Ejemplo", amount = 1500000 } = req.body;
      const payload = Payloads.overdueInvoice(providerName, amount);
      const result  = await broadcast(payload);
      res.json({ success: true, payload, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
}

module.exports = router;


// ══════════════════════════════════════════════════════════════
// ARCHIVO 2: src/utils/testPush.js  (solo desarrollo, frontend)
// Pega esto en la consola del navegador o úsalo en un botón de prueba
// ══════════════════════════════════════════════════════════════

/*

// --- Copiar y pegar en consola del navegador ---

// 1. Verificar estado
const { getPushStatus } = await import('/src/utils/pushNotifications.js');
console.table(await getPushStatus());

// 2. Suscribirse
const { subscribeToPush } = await import('/src/utils/pushNotifications.js');
const result = await subscribeToPush();
console.log('Suscripción:', result);

// 3. Enviar push de prueba a ti mismo
const token = localStorage.getItem('token'); // o donde guardes el JWT
await fetch('/api/notifications/test/me', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ title: '🔔 Hola!', body: 'La notificación funciona ✅', severity: 'info' }),
}).then(r => r.json()).then(console.log);

// 4. Simular stock bajo
await fetch('/api/notifications/test/stock', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ name: 'Camiseta Azul XL', stock: 2, minStock: 5 }),
}).then(r => r.json()).then(console.log);

// 5. Simular stock agotado (critical)
await fetch('/api/notifications/test/stock', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ name: 'Pantalón Negro', outOfStock: true }),
}).then(r => r.json()).then(console.log);

// 6. Simular factura vencida
await fetch('/api/notifications/test/invoice', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ providerName: 'Textiles Colombia S.A.S', amount: 2300000 }),
}).then(r => r.json()).then(console.log);

*/