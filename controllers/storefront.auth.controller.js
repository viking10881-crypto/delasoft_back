// controllers/storefront.auth.controller.js
// Auth de clientes finales en el storefront.
// Todas las rutas que usan este controller llegan protegidas por apiKeyAuth,
// por lo que req.apiKey.adminId = owner_admin_id del tenant.
// NUNCA se acepta owner_admin_id del cuerpo del request.

const db     = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const crypto = require("crypto");
const { generateVerificationCode, sendVerificationEmail } = require("../config/emailConfig");

const SALT_ROUNDS              = 12;
const JWT_ACCESS_EXPIRY        = "15m";
const JWT_REFRESH_EXPIRY       = "7d";
const MAX_LOGIN_ATTEMPTS       = 5;
const LOCKOUT_TIME             = 15 * 60 * 1000;
const VERIFICATION_CODE_EXPIRY = 10 * 60 * 1000;

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const isStrongPassword = (p) =>
  p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);

const generateAccessToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRY,
    issuer:    "delasoft-api",
    audience:  "delasoft-client",
  });

const generateRefreshToken = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRY,
    issuer:    "delasoft-api",
    audience:  "delasoft-client",
  });

const saveRefreshToken = async (client, userId, refreshToken, deviceInfo) => {
  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
     ON CONFLICT DO NOTHING`,
    [userId, tokenHash, deviceInfo || "storefront"]
  );
};

// ============================================================
// 📝 REGISTRO
// ============================================================
exports.register = async (req, res) => {
  const client = await db.connect();
  try {
    const ownerAdminId = req.apiKey.adminId;
    const { email, password, name, cedula, phone } = req.body;

    if (!email || !password || !name || !cedula) {
      return res.status(400).json({
        success: false,
        message: "Campos requeridos: email, password, name, cedula",
        code: "MISSING_FIELDS",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Formato de email inválido",
        code: "INVALID_EMAIL",
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        success: false,
        message: "La contraseña debe tener mínimo 8 caracteres, mayúsculas, minúsculas, números y un carácter especial",
        code: "WEAK_PASSWORD",
      });
    }

    await client.query("BEGIN");

    // Unicidad scopeada al tenant
    const emailCheck = await client.query(
      "SELECT id FROM users WHERE email = $1 AND owner_admin_id = $2",
      [email.toLowerCase().trim(), ownerAdminId]
    );
    if (emailCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ya existe una cuenta con este correo en esta tienda",
        code: "EMAIL_TAKEN",
      });
    }

    const cedulaCheck = await client.query(
      "SELECT id FROM users WHERE cedula = $1 AND owner_admin_id = $2",
      [cedula.trim(), ownerAdminId]
    );
    if (cedulaCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ya existe una cuenta con esta cédula en esta tienda",
        code: "CEDULA_TAKEN",
      });
    }

    // Rol por nombre, nunca hardcodeado
    const roleRes = await client.query("SELECT id FROM roles WHERE name = 'user' LIMIT 1");
    if (roleRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({
        success: false,
        message: "Configuración de roles incompleta en el servidor",
        code: "ROLE_NOT_FOUND",
      });
    }
    const userRoleId = roleRes.rows[0].id;

    const verificationCode = generateVerificationCode();
    const codeExpiry       = new Date(Date.now() + VERIFICATION_CODE_EXPIRY);
    const hashedPassword   = await bcrypt.hash(password, SALT_ROUNDS);

    const userRes = await client.query(
      `INSERT INTO users
         (email, password, name, cedula, phone, is_active, is_verified,
          owner_admin_id, reset_token, reset_expires)
       VALUES ($1, $2, $3, $4, $5, true, false, $6, $7, $8)
       RETURNING id, email, name`,
      [
        email.toLowerCase().trim(),
        hashedPassword,
        name.trim(),
        cedula.trim(),
        phone?.trim() || null,
        ownerAdminId,
        verificationCode,
        codeExpiry,
      ]
    );

    const newUser = userRes.rows[0];

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [newUser.id, userRoleId]
    );

    await client.query("COMMIT");

    // Fire-and-forget: no bloquear respuesta si el email falla
    sendVerificationEmail(newUser.email, verificationCode, newUser.name).catch((e) =>
      console.error("[STOREFRONT REGISTER] Email error:", e.message)
    );

    console.log(`[STOREFRONT REGISTER] ${newUser.email} → tenant ${ownerAdminId}`);

    return res.status(201).json({
      success: true,
      message: "Cuenta creada. Revisa tu email para verificar tu cuenta.",
      data: {
        id:                   newUser.id,
        email:                newUser.email,
        name:                 newUser.name,
        requiresVerification: true,
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    // Captura violación de índice único parcial como fallback
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Ya existe una cuenta con ese email o cédula en esta tienda",
        code: "DUPLICATE_USER",
      });
    }
    console.error("[STOREFRONT REGISTER ERROR]", error);
    return res.status(500).json({ success: false, message: "Error al registrar usuario", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

// ============================================================
// 🔄 VERIFICAR EMAIL
// ============================================================
exports.verifyEmail = async (req, res) => {
  const client = await db.connect();
  try {
    const ownerAdminId = req.apiKey.adminId;
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: "Email y código son requeridos",
        code: "MISSING_FIELDS",
      });
    }

    await client.query("BEGIN");

    const userRes = await client.query(
      `SELECT id, name, reset_token, reset_expires, is_verified
       FROM users WHERE email = $1 AND owner_admin_id = $2`,
      [email.toLowerCase().trim(), ownerAdminId]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Usuario no encontrado", code: "USER_NOT_FOUND" });
    }

    const user = userRes.rows[0];

    if (user.is_verified) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Email ya verificado. Puedes iniciar sesión.",
        code: "ALREADY_VERIFIED",
      });
    }

    if (user.reset_token !== code) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        message: "Código de verificación inválido",
        code: "INVALID_CODE",
      });
    }

    if (new Date() > new Date(user.reset_expires)) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        message: "Código expirado. Solicita uno nuevo.",
        code: "CODE_EXPIRED",
      });
    }

    await client.query(
      "UPDATE users SET is_verified = true, reset_token = NULL, reset_expires = NULL WHERE id = $1",
      [user.id]
    );
    await client.query("COMMIT");

    return res.json({ success: true, message: "Email verificado correctamente. Ya puedes iniciar sesión." });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[STOREFRONT VERIFY EMAIL ERROR]", error);
    return res.status(500).json({ success: false, message: "Error al verificar email", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

// ============================================================
// 🔄 REENVIAR CÓDIGO DE VERIFICACIÓN
// ============================================================
exports.resendCode = async (req, res) => {
  const client = await db.connect();
  try {
    const ownerAdminId = req.apiKey.adminId;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email es requerido", code: "MISSING_FIELDS" });
    }

    await client.query("BEGIN");

    const userRes = await client.query(
      "SELECT id, name, is_verified FROM users WHERE email = $1 AND owner_admin_id = $2",
      [email.toLowerCase().trim(), ownerAdminId]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Usuario no encontrado", code: "USER_NOT_FOUND" });
    }

    const user = userRes.rows[0];

    if (user.is_verified) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Email ya verificado", code: "ALREADY_VERIFIED" });
    }

    const verificationCode = generateVerificationCode();
    const codeExpiry       = new Date(Date.now() + VERIFICATION_CODE_EXPIRY);

    await client.query(
      "UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3",
      [verificationCode, codeExpiry, user.id]
    );
    await client.query("COMMIT");

    sendVerificationEmail(email, verificationCode, user.name).catch((e) =>
      console.error("[STOREFRONT RESEND CODE] Email error:", e.message)
    );

    return res.json({ success: true, message: "Nuevo código enviado a tu email." });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[STOREFRONT RESEND CODE ERROR]", error);
    return res.status(500).json({ success: false, message: "Error al reenviar código", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

// ============================================================
// 🔓 LOGIN
// ============================================================
exports.login = async (req, res) => {
  const client = await db.connect();
  try {
    const ownerAdminId = req.apiKey.adminId;
    const { email, password, deviceInfo } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email y contraseña son requeridos",
        code: "MISSING_FIELDS",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Formato de email inválido", code: "INVALID_EMAIL" });
    }

    await client.query("BEGIN");

    // Búsqueda SIEMPRE scopeada al tenant — nunca solo por email
    const userRes = await client.query(
      `SELECT id, email, password, name, phone, cedula, city, address,
              failed_login_attempts, locked_until, is_active, is_verified
       FROM users
       WHERE email = $1 AND owner_admin_id = $2`,
      [email.toLowerCase().trim(), ownerAdminId]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(401).json({ success: false, message: "Credenciales inválidas", code: "INVALID_CREDENTIALS" });
    }

    const user = userRes.rows[0];

    if (!user.is_verified) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Debes verificar tu email antes de iniciar sesión.",
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
    }

    if (!user.is_active) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Cuenta desactivada. Contacta al administrador de la tienda.",
        code: "USER_INACTIVE",
      });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await client.query("ROLLBACK");
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({
        success: false,
        message: `Cuenta bloqueada temporalmente. Intenta en ${minutesLeft} minuto${minutesLeft !== 1 ? "s" : ""}.`,
        code: "ACCOUNT_LOCKED",
        retryAfter: minutesLeft,
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      const newAttempts  = (user.failed_login_attempts || 0) + 1;
      const attemptsLeft = MAX_LOGIN_ATTEMPTS - newAttempts;

      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_TIME);
        await client.query(
          "UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3",
          [newAttempts, lockUntil, user.id]
        );
        await client.query("COMMIT");
        return res.status(429).json({
          success: false,
          message: "Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos.",
          code: "ACCOUNT_LOCKED",
          retryAfter: 15,
        });
      }

      await client.query(
        "UPDATE users SET failed_login_attempts = $1 WHERE id = $2",
        [newAttempts, user.id]
      );
      await client.query("COMMIT");
      return res.status(401).json({
        success: false,
        message: "Credenciales inválidas",
        code: "INVALID_CREDENTIALS",
        attemptsLeft: Math.max(0, attemptsLeft),
      });
    }

    // Login exitoso
    await client.query(
      "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1",
      [user.id]
    );

    const rolesRes = await client.query(
      `SELECT r.name FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [user.id]
    );
    const roles = rolesRes.rows.map((r) => r.name);

    // owner_admin_id en el payload: ata el token al tenant desde el origen
    const tokenPayload = {
      id:             user.id,
      email:          user.email,
      name:           user.name,
      roles,
      owner_admin_id: ownerAdminId,
    };
    const accessToken  = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken({ id: user.id, email: user.email });

    await saveRefreshToken(client, user.id, refreshToken, deviceInfo);
    await client.query("COMMIT");

    console.log(`[STOREFRONT LOGIN] ${user.email} → tenant ${ownerAdminId}`);

    return res.json({
      success: true,
      message: "Login exitoso",
      user: {
        id:             user.id,
        email:          user.email,
        name:           user.name || "Usuario",
        phone:          user.phone,
        cedula:         user.cedula,
        city:           user.city,
        address:        user.address,
        roles,
        owner_admin_id: ownerAdminId,
      },
      token:        accessToken,
      refreshToken,
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[STOREFRONT LOGIN ERROR]", error);
    return res.status(500).json({ success: false, message: "Error en el servidor.", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

// ============================================================
// 🔄 REFRESH TOKEN
// ============================================================
exports.refreshToken = async (req, res) => {
  const client = await db.connect();
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ success: false, message: "Refresh token requerido", code: "MISSING_TOKEN" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, {
        issuer:   "delasoft-api",
        audience: "delasoft-client",
      });
    } catch {
      return res.status(401).json({
        success: false,
        message: "Refresh token inválido o expirado",
        code: "INVALID_REFRESH_TOKEN",
      });
    }

    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const tokenRes  = await client.query(
      `SELECT id FROM refresh_tokens
       WHERE user_id = $1 AND token_hash = $2 AND revoked = false AND expires_at > NOW()`,
      [decoded.id, tokenHash]
    );

    if (tokenRes.rowCount === 0) {
      return res.status(401).json({
        success: false,
        message: "Refresh token inválido o revocado",
        code: "TOKEN_REVOKED",
      });
    }

    const userRes = await client.query(
      "SELECT id, email, name, is_active, owner_admin_id FROM users WHERE id = $1",
      [decoded.id]
    );

    if (userRes.rowCount === 0 || !userRes.rows[0].is_active) {
      return res.status(401).json({ success: false, message: "Usuario no encontrado o inactivo", code: "USER_INACTIVE" });
    }

    const user = userRes.rows[0];

    // Garantizar que el refresh pertenece a un usuario del tenant que llama
    if (user.owner_admin_id && String(user.owner_admin_id) !== String(req.apiKey.adminId)) {
      return res.status(403).json({
        success: false,
        message: "Token no válido para esta tienda",
        code: "TENANT_MISMATCH",
      });
    }

    const rolesRes = await client.query(
      `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
      [user.id]
    );
    const roles = rolesRes.rows.map((r) => r.name);

    const newAccessToken = generateAccessToken({
      id:             user.id,
      email:          user.email,
      name:           user.name,
      roles,
      owner_admin_id: user.owner_admin_id,
    });

    return res.json({ success: true, data: { accessToken: newAccessToken } });

  } catch (error) {
    console.error("[STOREFRONT REFRESH TOKEN ERROR]", error);
    return res.status(500).json({ success: false, message: "Error en el servidor", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

// ============================================================
// 🚪 LOGOUT
// ============================================================
exports.logout = async (req, res) => {
  const client = await db.connect();
  try {
    const { refreshToken } = req.body;
    const userId = req.user?.id;

    if (refreshToken) {
      const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      await client.query(
        "UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token_hash = $1",
        [tokenHash]
      );
    }

    if (userId) {
      await client.query(
        "UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE user_id = $1 AND revoked = false",
        [userId]
      );
    }

    return res.json({ success: true, message: "Logout exitoso" });

  } catch (error) {
    console.error("[STOREFRONT LOGOUT ERROR]", error);
    return res.status(500).json({ success: false, message: "Error al cerrar sesión", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

// ============================================================
// 👤 PERFIL DEL CLIENTE
// ============================================================
exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const userRes = await db.query(
      `SELECT id, email, name, phone, cedula, city, address, created_at, last_login
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado", code: "USER_NOT_FOUND" });
    }

    const rolesRes = await db.query(
      `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
      [userId]
    );

    return res.json({
      success: true,
      data: { ...userRes.rows[0], roles: rolesRes.rows.map((r) => r.name) },
    });

  } catch (error) {
    console.error("[STOREFRONT GET PROFILE ERROR]", error);
    return res.status(500).json({ success: false, message: "Error al obtener perfil", code: "SERVER_ERROR" });
  }
};

// ============================================================
// ✏️ ACTUALIZAR PERFIL
// ============================================================
exports.updateProfile = async (req, res) => {
  const client = await db.connect();
  try {
    const userId = req.user.id;
    const { name, phone, city, address } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "El nombre es requerido", code: "MISSING_FIELDS" });
    }

    await client.query(
      `UPDATE users
       SET name = $1, phone = $2, city = $3, address = $4, updated_at = NOW()
       WHERE id = $5`,
      [name.trim(), phone?.trim() || null, city?.trim() || null, address?.trim() || null, userId]
    );

    const updated = await client.query(
      "SELECT id, email, name, phone, cedula, city, address FROM users WHERE id = $1",
      [userId]
    );

    return res.json({
      success: true,
      message: "Perfil actualizado correctamente",
      data: updated.rows[0],
    });

  } catch (error) {
    console.error("[STOREFRONT UPDATE PROFILE ERROR]", error);
    return res.status(500).json({ success: false, message: "Error al actualizar perfil", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};
