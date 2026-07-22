// controllers/financePin.controller.js
const bcrypt = require("bcryptjs");
const pool   = require("../config/db");
const {
  setFinanceUnlocked,
  clearFinanceUnlocked,
  getFinanceExpiresAt,
} = require("../middleware/auth.middleware");

const SALT_ROUNDS    = 12;                // mismo que auth.controller.js
const FINANCE_TTL_MS = 15 * 60 * 1000;

// Resuelve siempre al admin-raíz del tenant, no al sub-usuario
const _adminId = (req) => req.user.owner_admin_id ?? req.user.id;

// ─── GET /api/finance-pin/status ──────────────────────────────────────────────
const getStatus = async (req, res) => {
  try {
    const adminId = _adminId(req);

    const { rows } = await pool.query(
      "SELECT finance_pin_hash IS NOT NULL AS has_pin FROM admin_profiles WHERE user_id = $1",
      [adminId]
    );

    const hasPin     = rows[0]?.has_pin ?? false;
    const expiresAt  = getFinanceExpiresAt(adminId);
    const isUnlocked = !!expiresAt && Date.now() < expiresAt;

    return res.json({
      hasPin,
      isUnlocked,
      financeUnlockedUntil: isUnlocked ? expiresAt : null,
    });
  } catch (err) {
    console.error("[financePin.getStatus]", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};

// ─── POST /api/finance-pin/setup ──────────────────────────────────────────────
// Body: { newPin: "1234", currentPin?: "0000" }
const setPin = async (req, res) => {
  try {
    const adminId = _adminId(req);
    const { newPin, currentPin } = req.body;

    if (!newPin || !/^\d{4,6}$/.test(String(newPin))) {
      return res.status(400).json({ error: "El PIN debe tener entre 4 y 6 dígitos numéricos." });
    }

    const { rows } = await pool.query(
      "SELECT finance_pin_hash FROM admin_profiles WHERE user_id = $1",
      [adminId]
    );
    const profile = rows[0];

    // Si ya tiene PIN, exige el actual para cambiarlo
    if (profile?.finance_pin_hash) {
      if (!currentPin) {
        return res.status(400).json({ error: "Debes ingresar el PIN actual para cambiarlo." });
      }
      const valid = await bcrypt.compare(String(currentPin), profile.finance_pin_hash);
      if (!valid) {
        return res.status(401).json({ error: "PIN actual incorrecto." });
      }
    }

    const hash = await bcrypt.hash(String(newPin), SALT_ROUNDS);

    // UPSERT: crea la fila si no existe, actualiza si ya existe
    await pool.query(
      `INSERT INTO admin_profiles (user_id, finance_pin_hash, updated_at)
       VALUES ($2, $1, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET finance_pin_hash = EXCLUDED.finance_pin_hash,
             updated_at       = NOW()`,
      [hash, adminId]
    );

    // Unlock inmediato tras el setup
    setFinanceUnlocked(adminId);
    const financeUnlockedUntil = Date.now() + FINANCE_TTL_MS;

    return res.json({
      success: true,
      message: "PIN configurado correctamente.",
      financeUnlockedUntil,
    });
  } catch (err) {
    console.error("[financePin.setPin]", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};

// ─── POST /api/finance-pin/verify ─────────────────────────────────────────────
// Body: { pin: "1234" }
const verifyPin = async (req, res) => {
  try {
    const adminId = _adminId(req);
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({ error: "PIN requerido." });
    }

    const { rows } = await pool.query(
      "SELECT finance_pin_hash FROM admin_profiles WHERE user_id = $1",
      [adminId]
    );
    const profile = rows[0];

    if (!profile?.finance_pin_hash) {
      // Sin PIN configurado → acceso libre
      setFinanceUnlocked(adminId);
      return res.json({ valid: true, noPinConfigured: true, financeUnlockedUntil: Date.now() + FINANCE_TTL_MS });
    }

    const valid = await bcrypt.compare(String(pin), profile.finance_pin_hash);
    if (!valid) {
      return res.json({ valid: false });
    }

    setFinanceUnlocked(adminId);
    return res.json({ valid: true, financeUnlockedUntil: Date.now() + FINANCE_TTL_MS });
  } catch (err) {
    console.error("[financePin.verifyPin]", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};

// ─── POST /api/finance-pin/lock ───────────────────────────────────────────────
// Invalida la sesión financiera explícitamente (botón "Bloquear ahora")
const lockPin = (req, res) => {
  try {
    const adminId = _adminId(req);
    clearFinanceUnlocked(adminId);
    return res.json({ success: true });
  } catch (err) {
    console.error("[financePin.lockPin]", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};

module.exports = { getStatus, setPin, verifyPin, lockPin };
