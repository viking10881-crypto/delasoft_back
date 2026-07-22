// src/controllers/pushSubscription.controller.js

const db = require("../config/db");

// ── POST /api/notifications/subscribe ────────────────────────
exports.subscribe = async (req, res) => {
  const { endpoint, keys, expirationTime } = req.body;
  const userId = req.user?.id ?? null;

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ success: false, message: "Suscripción inválida" });
  }

  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint)
       DO UPDATE SET user_id   = EXCLUDED.user_id,
                     p256dh    = EXCLUDED.p256dh,
                     auth      = EXCLUDED.auth,
                     is_active = true,
                     updated_at = NOW()`,
      [userId, endpoint, keys.p256dh, keys.auth, expirationTime ?? null]
    );

    res.json({ success: true, message: "Suscripción guardada" });
  } catch (err) {
    console.error("[Subscribe] Error:", err);
    res.status(500).json({ success: false, message: "Error al guardar suscripción" });
  }
};

// ── POST /api/notifications/unsubscribe ──────────────────────
exports.unsubscribe = async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ success: false, message: "endpoint requerido" });
  }

  try {
    await db.query(
      "UPDATE push_subscriptions SET is_active = false WHERE endpoint = $1",
      [endpoint]
    );
    res.json({ success: true, message: "Suscripción cancelada" });
  } catch (err) {
    console.error("[Unsubscribe] Error:", err);
    res.status(500).json({ success: false, message: "Error al cancelar suscripción" });
  }
};

// ── GET /api/notifications/push-key ──────────────────────────
// Devuelve la clave pública VAPID al cliente
exports.getPublicKey = (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(500).json({ success: false, message: "VAPID no configurado" });
  res.json({ success: true, data: { publicKey: key } });
};