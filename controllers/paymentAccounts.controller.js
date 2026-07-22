// controllers/paymentAccounts.controller.js
// CRUD for store payment gateway accounts.
// Secrets are always stored AES-256-GCM encrypted; never returned in plaintext.
const db = require("../config/db");
const { encrypt }              = require("../utils/crypto");
const { decryptCredentials, verifyWompiCredentials } = require("../services/payment.service");

const ALLOWED_PROVIDERS    = ["wompi"];
const ALLOWED_ENVIRONMENTS = ["sandbox", "production"];

const MASKED = "••••••••••••";

// ── GET /api/payment-accounts ──────────────────────────────────────────────
exports.getAccount = async (req, res) => {
  try {
    const adminId = req.user.owner_admin_id ?? req.user.id;

    const { rows } = await db.query(
      `SELECT id, provider, environment, status, public_key,
              last_verified_at, is_active, created_at, updated_at
       FROM store_payment_accounts
       WHERE admin_id = $1
       ORDER BY is_active DESC, updated_at DESC
       LIMIT 1`,
      [adminId]
    );

    if (!rows.length) return res.json({ success: true, data: null });

    const row = rows[0];
    return res.json({
      success: true,
      data: {
        id:               row.id,
        provider:         row.provider,
        environment:      row.environment,
        status:           row.status,
        public_key:       row.public_key,
        private_key:      MASKED,
        events_secret:    MASKED,
        integrity_secret: MASKED,
        last_verified_at: row.last_verified_at,
        is_active:        row.is_active,
        created_at:       row.created_at,
        updated_at:       row.updated_at,
      },
    });
  } catch (err) {
    console.error("[paymentAccounts] getAccount:", err.message);
    return res.status(500).json({ success: false, message: "Error al obtener cuenta de pago" });
  }
};

// ── POST /api/payment-accounts ─────────────────────────────────────────────
exports.createOrUpdate = async (req, res) => {
  const {
    provider = "wompi",
    environment = "sandbox",
    public_key,
    private_key,
    events_secret,
    integrity_secret,
  } = req.body;

  if (!public_key || !private_key || !events_secret || !integrity_secret) {
    return res.status(400).json({
      success: false,
      message: "Se requieren: public_key, private_key, events_secret, integrity_secret",
    });
  }

  if (!ALLOWED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ success: false, message: `Proveedor no soportado. Use: ${ALLOWED_PROVIDERS.join(", ")}` });
  }

  if (!ALLOWED_ENVIRONMENTS.includes(environment)) {
    return res.status(400).json({ success: false, message: `Ambiente inválido. Use: ${ALLOWED_ENVIRONMENTS.join(", ")}` });
  }

  const adminId = req.user.owner_admin_id ?? req.user.id;
  const client  = await db.connect();
  try {
    await client.query("BEGIN");

    const private_key_encrypted      = encrypt(private_key);
    const events_secret_encrypted    = encrypt(events_secret);
    const integrity_secret_encrypted = encrypt(integrity_secret);

    const { rows } = await client.query(
      `INSERT INTO store_payment_accounts
         (admin_id, provider, environment, status, public_key,
          private_key_encrypted, events_secret_encrypted, integrity_secret_encrypted, updated_at)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,now())
       ON CONFLICT (admin_id, provider, environment) DO UPDATE SET
         status               = 'pending',
         public_key           = EXCLUDED.public_key,
         private_key_encrypted      = EXCLUDED.private_key_encrypted,
         events_secret_encrypted    = EXCLUDED.events_secret_encrypted,
         integrity_secret_encrypted = EXCLUDED.integrity_secret_encrypted,
         updated_at           = now()
       RETURNING id, provider, environment, status, public_key, created_at, updated_at`,
      [adminId, provider, environment, public_key,
       private_key_encrypted, events_secret_encrypted, integrity_secret_encrypted]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Cuenta de pago guardada. Usa /verify para confirmar las credenciales con Wompi.",
      data: rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[paymentAccounts] POST error:", {
      adminId,
      code:    err.code,
      message: err.message,
      stack:   err.stack,
    });
    return res.status(500).json({ success: false, message: "Error al guardar la cuenta de pago" });
  } finally {
    client.release();
  }
};

// ── Shared verify logic ────────────────────────────────────────────────────
async function _runVerify(acct, res, label) {
  let private_key;
  try {
    ({ private_key } = decryptCredentials(acct));
  } catch (decryptErr) {
    console.error(`[paymentAccounts] ${label}: decrypt failed —`, decryptErr.message, decryptErr.stack);
    return res.status(500).json({
      success: false,
      message: "Error al desencriptar las credenciales. Verifica que PAYMENTS_ENCRYPTION_KEY sea correcta.",
    });
  }

  const ok     = await verifyWompiCredentials(acct.public_key, private_key, acct.environment);
  const status = ok ? "connected" : "error";
  const now    = new Date();

  await db.query(
    `UPDATE store_payment_accounts
     SET status = $1, last_verified_at = $2, updated_at = $2
     WHERE id = $3`,
    [status, now, acct.id]
  );

  return res.json({
    success: true,
    message: ok
      ? "Credenciales verificadas correctamente. Tu cuenta está conectada."
      : "Las credenciales no son válidas en Wompi. Revísalas y vuelve a intentarlo.",
    data: { status, last_verified_at: now },
  });
}

// ── POST /api/payment-accounts/verify ─────────────────────────────────────
// Legacy route — no :id. Tests credentials against Wompi.
exports.verify = async (req, res) => {
  const adminId = req.user.owner_admin_id ?? req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT id, provider, environment, public_key,
              private_key_encrypted, events_secret_encrypted, integrity_secret_encrypted
       FROM store_payment_accounts
       WHERE admin_id = $1 AND is_active = true
       LIMIT 1`,
      [adminId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "No tienes cuenta de pago configurada. Guárdala primero." });
    }

    return await _runVerify(rows[0], res, "verify");
  } catch (err) {
    console.error("[paymentAccounts] verify:", err.message, err.stack);
    return res.status(500).json({ success: false, message: "Error interno al verificar credenciales" });
  }
};

// ── POST /api/payment-accounts/:id/verify ─────────────────────────────────
// Validates ownership then tests credentials. public_key in URL, private_key in header.
exports.verifyById = async (req, res) => {
  const adminId = req.user.owner_admin_id ?? req.user.id;
  const { id }  = req.params;

  try {
    const { rows } = await db.query(
      `SELECT id, provider, environment, public_key,
              private_key_encrypted, events_secret_encrypted, integrity_secret_encrypted
       FROM store_payment_accounts
       WHERE id = $1 AND admin_id = $2`,
      [id, adminId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Cuenta de pago no encontrada.",
      });
    }

    return await _runVerify(rows[0], res, "verifyById");
  } catch (err) {
    console.error("[paymentAccounts] verifyById:", err.message, err.stack);
    return res.status(500).json({ success: false, message: "Error interno al verificar credenciales" });
  }
};

// ── PATCH /api/payment-accounts/:id/toggle ────────────────────────────────
// Alternates is_active for the payment account. Status resets to 'pending' on re-activation
// so the admin must re-verify credentials before payments go live again.
exports.toggle = async (req, res) => {
  const adminId = req.user.owner_admin_id ?? req.user.id;
  const { id }  = req.params;

  try {
    const { rows } = await db.query(
      `SELECT id, is_active, status FROM store_payment_accounts
       WHERE id = $1 AND admin_id = $2`,
      [id, adminId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Cuenta de pago no encontrada" });
    }

    const current     = rows[0].is_active;
    const nextActive  = !current;
    // Re-activation resets to 'pending' so admin must re-verify before payments resume
    const nextStatus  = nextActive ? "pending" : rows[0].status ?? "pending";

    const { rows: updated } = await db.query(
      `UPDATE store_payment_accounts
       SET is_active = $1, status = $2, updated_at = now()
       WHERE id = $3
       RETURNING id, is_active, status`,
      [nextActive, nextStatus, id]
    );

    const msg = nextActive ? "Cuenta de pagos activada" : "Cuenta de pagos desactivada";
    return res.json({ success: true, message: msg, data: updated[0] });
  } catch (err) {
    console.error("[paymentAccounts] toggle:", err.message);
    return res.status(500).json({ success: false, message: "Error al cambiar el estado de la cuenta" });
  }
};

// ── PUT /api/payment-accounts/:id ─────────────────────────────────────────
// Update credentials on an existing account. Secrets are optional — omit to keep
// existing encrypted values. Always resets status to 'pending' until re-verified.
exports.updateById = async (req, res) => {
  const adminId = req.user.owner_admin_id ?? req.user.id;
  const { id }  = req.params;
  const { environment, public_key, private_key, events_secret, integrity_secret } = req.body;

  if (!public_key?.trim()) {
    return res.status(400).json({ success: false, message: "La llave pública es requerida" });
  }

  if (environment && !ALLOWED_ENVIRONMENTS.includes(environment)) {
    return res.status(400).json({ success: false, message: `Ambiente inválido. Use: ${ALLOWED_ENVIRONMENTS.join(", ")}` });
  }

  try {
    const { rows } = await db.query(
      `SELECT id FROM store_payment_accounts WHERE id = $1 AND admin_id = $2`,
      [id, adminId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Cuenta de pago no encontrada" });
    }

    // Build the SET clause dynamically — only update secrets that were provided
    const sets   = [
      "status = 'pending'",
      "public_key = $1",
      "updated_at = now()",
    ];
    const params = [public_key.trim()];
    let   idx    = 2;

    if (environment)      { sets.push(`environment = $${idx++}`);               params.push(environment); }
    if (private_key?.trim())      { sets.push(`private_key_encrypted = $${idx++}`);      params.push(encrypt(private_key.trim())); }
    if (events_secret?.trim())    { sets.push(`events_secret_encrypted = $${idx++}`);    params.push(encrypt(events_secret.trim())); }
    if (integrity_secret?.trim()) { sets.push(`integrity_secret_encrypted = $${idx++}`); params.push(encrypt(integrity_secret.trim())); }

    params.push(id);
    const { rows: result } = await db.query(
      `UPDATE store_payment_accounts SET ${sets.join(", ")}
       WHERE id = $${idx}
       RETURNING id, provider, environment, status, public_key, updated_at`,
      params
    );

    return res.json({
      success: true,
      message: "Credenciales actualizadas. Verifica la conexión con Wompi para re-activar los pagos.",
      data: result[0],
    });
  } catch (err) {
    console.error("[paymentAccounts] updateById:", err.message);
    return res.status(500).json({ success: false, message: "Error al actualizar la cuenta de pago" });
  }
};

// ── DELETE /api/payment-accounts ──────────────────────────────────────────
exports.deactivate = async (req, res) => {
  const adminId = req.user.owner_admin_id ?? req.user.id;

  try {
    const { rowCount } = await db.query(
      `UPDATE store_payment_accounts
       SET is_active = false, updated_at = now()
       WHERE admin_id = $1 AND is_active = true`,
      [adminId]
    );

    if (!rowCount) {
      return res.status(404).json({ success: false, message: "No hay cuenta de pago activa para desactivar" });
    }

    return res.json({ success: true, message: "Cuenta de pago desactivada correctamente" });
  } catch (err) {
    console.error("[paymentAccounts] deactivate:", err.message);
    return res.status(500).json({ success: false, message: "Error al desactivar la cuenta de pago" });
  }
};