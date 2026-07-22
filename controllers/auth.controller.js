// controllers/auth.controller.js
const db     = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");
const { OAuth2Client } = require("google-auth-library");
const { generateVerificationCode, sendVerificationEmail } = require("../config/emailConfig");

// ============================================
// 🔐 CONFIGURACIÓN DE SEGURIDAD
// ============================================
const SALT_ROUNDS              = 12;
const JWT_ACCESS_EXPIRY        = "15m";
const JWT_REFRESH_EXPIRY       = "7d";
const MAX_LOGIN_ATTEMPTS       = 5;
const LOCKOUT_TIME             = 15 * 60 * 1000;
const VERIFICATION_CODE_EXPIRY = 10 * 60 * 1000;

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const isStrongPassword = (password) =>
  password.length >= 8 &&
  /[A-Z]/.test(password) &&
  /[a-z]/.test(password) &&
  /[0-9]/.test(password) &&
  /[^A-Za-z0-9]/.test(password);

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;

// ============================================
// 🎫 GENERACIÓN DE TOKENS
// ============================================
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

// ============================================
// 📊 OBTENER ROLES
// ============================================
const getUserRoles = async (userId) => {
  const client = await db.connect();
  try {
    const res = await client.query(
      `SELECT r.name, r.id
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [userId]
    );
    return {
      roles:   res.rows.map((r) => r.name),
      roleIds: res.rows.map((r) => r.id),
    };
  } finally {
    client.release();
  }
};

const getUserColumnPresence = async (client = db) => {
  const res = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
       AND column_name = ANY($1)`,
    [['profile_image_url', 'profile_image_public_id']]
  );

  const columns = new Set(res.rows.map((row) => row.column_name));
  return {
    profile_image_url:       columns.has('profile_image_url'),
    profile_image_public_id: columns.has('profile_image_public_id'),
  };
};

const buildProfilePayload = (user, roles, profileColumns) => ({
  id:                      user.id,
  email:                   user.email,
  name:                    user.name,
  phone:                   user.phone,
  cedula:                  user.cedula,
  city:                    user.city,
  address:                 user.address,
  profile_image_url:       profileColumns?.profile_image_url       ? user.profile_image_url       || null : null,
  avatar_url:              profileColumns?.profile_image_url       ? user.profile_image_url       || null : null,
  avatar:                  profileColumns?.profile_image_url       ? user.profile_image_url       || null : null,
  foto:                    profileColumns?.profile_image_url       ? user.profile_image_url       || null : null,
  profile_image_public_id: profileColumns?.profile_image_public_id ? user.profile_image_public_id || null : null,
  created_at:              user.created_at,
  last_login:              user.last_login,
  roles,
});

const getUserAuthSelectClause = async (client = db) => {
  const profileColumns = await getUserColumnPresence(client);
  const columns = [
    'id', 'email', 'password', 'name', 'phone', 'cedula', 'city', 'address',
    'failed_login_attempts', 'locked_until', 'is_active', 'is_verified',
  ];

  if (profileColumns.profile_image_url)       columns.push('profile_image_url');
  if (profileColumns.profile_image_public_id) columns.push('profile_image_public_id');

  return columns.join(', ');
};

const getUserProfileSelectClause = async (client = db) => {
  const profileColumns = await getUserColumnPresence(client);
  const columns = ['id', 'email', 'name', 'phone', 'cedula', 'city', 'address'];

  if (profileColumns.profile_image_url)       columns.push('profile_image_url');
  if (profileColumns.profile_image_public_id) columns.push('profile_image_public_id');
  columns.push('created_at', 'last_login');

  return columns.join(', ');
};

const issueSessionTokens = async (client, user, deviceInfo, roles) => {
  const tokenPayload = { id: user.id, email: user.email, name: user.name, roles };
  const accessToken  = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken({ id: user.id, email: user.email });

  await saveRefreshToken(client, user.id, refreshToken, deviceInfo);
  return { accessToken, refreshToken };
};

// ============================================
// 🔑 HELPER: GUARDAR REFRESH TOKEN
// ============================================
const saveRefreshToken = async (client, userId, refreshToken, deviceInfo) => {
  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
     ON CONFLICT DO NOTHING`,
    [userId, tokenHash, deviceInfo || "unknown"]
  );
};

// ============================================
// 🔍 HELPER: VERIFICAR TOKEN DE GOOGLE
// Soporta tanto id_token (flujo auth-code/popup)
// como access_token (flujo implicit) automáticamente
// ============================================
const verifyGoogleToken = async (token) => {
  // ── Intentar primero como id_token ──────────────────────────────────────
  // Un id_token de Google es un JWT con 3 segmentos separados por "."
  // y su payload tiene los campos "email", "name", "picture" directamente.
  const segments = token.split(".");
  if (segments.length === 3) {
    try {
      if (!googleClient) throw new Error("googleClient no inicializado");

      const ticket  = await googleClient.verifyIdToken({
        idToken:  token,
        audience: googleClientId,
      });
      const payload = ticket.getPayload();

      if (payload?.email) {
        return {
          email:   payload.email.toLowerCase().trim(),
          name:    payload.name || payload.given_name || payload.email.split("@")[0],
          picture: payload.picture || null,
        };
      }
    } catch {
      // No es un id_token válido → caer al flujo de access_token
    }
  }

  // ── Tratar como access_token (implicit flow) ─────────────────────────────
  // El flujo "implicit" de @react-oauth/google devuelve un access_token opaco
  // (no un JWT) que solo Google puede validar llamando a su endpoint userinfo.
  const response = await fetch(
    `https://www.googleapis.com/oauth2/v3/userinfo`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    throw new Error(`Google userinfo falló: ${response.status}`);
  }

  const info = await response.json();

  if (!info?.email) {
    throw new Error("Google no devolvió email en userinfo");
  }

  return {
    email:   info.email.toLowerCase().trim(),
    name:    info.name || info.given_name || info.email.split("@")[0],
    picture: info.picture || null,
  };
};

// ============================================
// 🔓 LOGIN
// ============================================
exports.login = async (req, res) => {
  const client = await db.connect();
  try {
    const { email, password, deviceInfo } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email y contraseña son requeridos",
        code:    "MISSING_FIELDS",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Formato de email inválido",
        code:    "INVALID_EMAIL",
      });
    }

    await client.query("BEGIN");

    const userSelectClause = await getUserAuthSelectClause(client);
    const userRes = await client.query(
      `SELECT ${userSelectClause} FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        message: "Credenciales inválidas",
        code:    "INVALID_CREDENTIALS",
      });
    }

    const user = userRes.rows[0];

    if (!user.is_verified) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Debes verificar tu email antes de iniciar sesión. Revisa tu bandeja de entrada.",
        code:    "EMAIL_NOT_VERIFIED",
        email:   user.email,
      });
    }

    if (!user.is_active) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Cuenta desactivada. Contacta al administrador.",
        code:    "USER_INACTIVE",
      });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await client.query("ROLLBACK");
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({
        success: false,
        message: `Cuenta bloqueada temporalmente. Intenta en ${minutesLeft} minuto${minutesLeft !== 1 ? "s" : ""}.`,
        code:    "ACCOUNT_LOCKED",
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
          `UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
          [newAttempts, lockUntil, user.id]
        );
        await client.query("COMMIT");
        return res.status(429).json({
          success: false,
          message: "Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos.",
          code:    "ACCOUNT_LOCKED",
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
        code:    "INVALID_CREDENTIALS",
        attemptsLeft: Math.max(0, attemptsLeft),
      });
    }

    await client.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1`,
      [user.id]
    );

    const { roles }                        = await getUserRoles(user.id);
    const profileColumns                   = await getUserColumnPresence(client);
    const { accessToken, refreshToken }    = await issueSessionTokens(client, user, deviceInfo, roles);
    await client.query("COMMIT");

    console.log(`[LOGIN SUCCESS] ${user.email} | Roles: ${roles.join(", ")}`);

    const profilePayload = buildProfilePayload(user, roles, profileColumns);

    return res.json({
      success: true,
      message: "Login exitoso",
      user:    profilePayload,
      data: {
        user:         profilePayload,
        token:        accessToken,
        refreshToken,
      },
      token:        accessToken,
      refreshToken,
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[LOGIN ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error en el servidor. Intenta nuevamente.",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🛠️ SETUP — CREAR PRIMER ADMIN
// ============================================
exports.setupAdmin = async (req, res) => {
  const client = await db.connect();
  try {
    const { email, password, name, secretKey } = req.body;

    const SETUP_KEY = process.env.SETUP_SECRET_KEY || "delasoft-setup-2024";
    if (secretKey !== SETUP_KEY) {
      return res.status(403).json({
        success: false,
        message: "Clave de configuración inválida",
        code:    "INVALID_SETUP_KEY",
      });
    }

    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        message: "Email, contraseña y nombre son requeridos",
        code:    "MISSING_FIELDS",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Formato de email inválido",
        code:    "INVALID_EMAIL",
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        success: false,
        message: "La contraseña debe tener mínimo 8 caracteres, mayúsculas, minúsculas, números y un carácter especial",
        code:    "WEAK_PASSWORD",
      });
    }

    await client.query("BEGIN");

    const adminCheck = await client.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE r.name = 'admin' LIMIT 1`
    );

    if (adminCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Ya existe un administrador en el sistema. Usa el login normal.",
        code:    "ADMIN_EXISTS",
      });
    }

    const emailCheck = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );

    if (emailCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "El email ya está registrado",
        code:    "EMAIL_TAKEN",
      });
    }

    const adminRoleRes = await client.query(
      "SELECT id FROM roles WHERE name = 'admin' LIMIT 1"
    );

    if (adminRoleRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({
        success: false,
        message: "El rol 'admin' no existe en la base de datos. Ejecuta las migraciones primero.",
        code:    "ROLE_NOT_FOUND",
      });
    }

    const adminRoleId = adminRoleRes.rows[0].id;

    if (!req.body.cedula) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "La cédula es requerida",
        code:    "MISSING_FIELDS",
      });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const userRes = await client.query(
      `INSERT INTO users (email, password, name, cedula, is_active, is_verified)
       VALUES ($1, $2, $3, $4, true, true)
       RETURNING id, email, name`,
      [email.toLowerCase().trim(), hashedPassword, name.trim(), req.body.cedula.trim()]
    );

    const newUser = userRes.rows[0];

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [newUser.id, adminRoleId]
    );

    await client.query("COMMIT");

    console.log(`[SETUP ADMIN] Admin creado: ${newUser.email} (ID: ${newUser.id})`);

    return res.status(201).json({
      success: true,
      message: "Administrador creado exitosamente. Ya puedes iniciar sesión.",
      data: {
        id:    newUser.id,
        email: newUser.email,
        name:  newUser.name,
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[SETUP ADMIN ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al crear el administrador",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🔄 VERIFICAR EMAIL
// ============================================
exports.verifyEmail = async (req, res) => {
  const client = await db.connect();
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: "Email y código son requeridos",
        code:    "MISSING_FIELDS",
      });
    }

    await client.query("BEGIN");

    const userRes = await client.query(
      `SELECT id, name, reset_token, reset_expires, is_verified FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
        code:    "USER_NOT_FOUND",
      });
    }

    const user = userRes.rows[0];

    if (user.is_verified) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Email ya verificado. Puedes iniciar sesión.",
        code:    "ALREADY_VERIFIED",
      });
    }

    if (user.reset_token !== code) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        message: "Código de verificación inválido",
        code:    "INVALID_CODE",
      });
    }

    if (new Date() > new Date(user.reset_expires)) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        message: "Código expirado. Solicita uno nuevo.",
        code:    "CODE_EXPIRED",
      });
    }

    await client.query(
      `UPDATE users SET is_verified = true, reset_token = NULL, reset_expires = NULL WHERE id = $1`,
      [user.id]
    );
    await client.query("COMMIT");

    console.log(`[EMAIL VERIFIED] ${email}`);
    return res.json({
      success: true,
      message: "Email verificado correctamente. Ya puedes iniciar sesión.",
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[VERIFY EMAIL ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al verificar email",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 📝 REGISTRO PÚBLICO
// ============================================
exports.register = async (req, res) => {
  const client = await db.connect();
  try {
    const { email, password, name, cedula, phone } = req.body;

    if (!email || !password || !name || !cedula) {
      return res.status(400).json({
        success: false,
        message: "Campos requeridos: email, password, name, cedula",
        code:    "MISSING_FIELDS",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Formato de email inválido",
        code:    "INVALID_EMAIL",
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        success: false,
        message: "La contraseña debe tener mínimo 8 caracteres, mayúsculas, minúsculas, números y un carácter especial",
        code:    "WEAK_PASSWORD",
      });
    }

    await client.query("BEGIN");

    const existingEmail = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    if (existingEmail.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "El email ya está registrado",
        code:    "EMAIL_TAKEN",
      });
    }

    const existingCedula = await client.query(
      "SELECT id FROM users WHERE cedula = $1",
      [cedula.trim()]
    );
    if (existingCedula.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "La cédula ya está registrada",
        code:    "CEDULA_TAKEN",
      });
    }

    const verificationCode = generateVerificationCode();
    const codeExpiry       = new Date(Date.now() + VERIFICATION_CODE_EXPIRY);
    const hashedPassword   = await bcrypt.hash(password, SALT_ROUNDS);

    const userRes = await client.query(
      `INSERT INTO users (email, password, name, cedula, phone, is_active, is_verified, reset_token, reset_expires)
       VALUES ($1, $2, $3, $4, $5, true, false, $6, $7)
       RETURNING id, email, name`,
      [
        email.toLowerCase().trim(),
        hashedPassword,
        name.trim(),
        cedula.trim(),
        phone?.trim() || null,
        verificationCode,
        codeExpiry,
      ]
    );

    const newUser = userRes.rows[0];

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)",
      [newUser.id]
    );
    await client.query("COMMIT");

    try {
      await sendVerificationEmail(newUser.email, verificationCode, newUser.name);
    } catch (emailError) {
      console.error("[REGISTER] Email send failed:", emailError.message);
    }

    return res.status(201).json({
      success: true,
      message: "Usuario registrado. Revisa tu email para verificar tu cuenta.",
      data: {
        id:                   newUser.id,
        email:                newUser.email,
        name:                 newUser.name,
        requiresVerification: true,
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[REGISTER ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al registrar usuario",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🔄 REENVIAR CÓDIGO DE VERIFICACIÓN
// ============================================
exports.resendVerificationCode = async (req, res) => {
  const client = await db.connect();
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email es requerido",
        code:    "MISSING_FIELDS",
      });
    }

    await client.query("BEGIN");

    const userRes = await client.query(
      "SELECT id, name, is_verified FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
        code:    "USER_NOT_FOUND",
      });
    }

    const user = userRes.rows[0];

    if (user.is_verified) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Email ya verificado",
        code:    "ALREADY_VERIFIED",
      });
    }

    const verificationCode = generateVerificationCode();
    const codeExpiry       = new Date(Date.now() + VERIFICATION_CODE_EXPIRY);

    await client.query(
      `UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3`,
      [verificationCode, codeExpiry, user.id]
    );
    await client.query("COMMIT");

    await sendVerificationEmail(email, verificationCode, user.name);

    return res.json({
      success: true,
      message: "Nuevo código enviado a tu email.",
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[RESEND CODE ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al reenviar código",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🔄 REFRESH TOKEN
// ============================================
exports.refreshToken = async (req, res) => {
  const client = await db.connect();
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: "Refresh token requerido",
        code:    "MISSING_TOKEN",
      });
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
        code:    "INVALID_REFRESH_TOKEN",
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
        code:    "TOKEN_REVOKED",
      });
    }

    const userRes = await client.query(
      "SELECT id, email, name, is_active FROM users WHERE id = $1",
      [decoded.id]
    );

    if (userRes.rowCount === 0 || !userRes.rows[0].is_active) {
      return res.status(401).json({
        success: false,
        message: "Usuario no encontrado o inactivo",
        code:    "USER_INACTIVE",
      });
    }

    const user              = userRes.rows[0];
    const { roles }         = await getUserRoles(user.id);
    const newAccessToken    = generateAccessToken({
      id:    user.id,
      email: user.email,
      name:  user.name,
      roles,
    });

    return res.json({
      success: true,
      data: { accessToken: newAccessToken },
    });

  } catch (error) {
    console.error("[REFRESH TOKEN ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error en el servidor",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🚪 LOGOUT
// ============================================
exports.logout = async (req, res) => {
  const client = await db.connect();
  try {
    const { refreshToken } = req.body;
    const userId = req.user?.id;

    if (refreshToken) {
      const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      await client.query(
        `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token_hash = $1`,
        [tokenHash]
      );
    }

    if (userId) {
      await client.query(
        `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW()
         WHERE user_id = $1 AND revoked = false`,
        [userId]
      );
    }

    return res.json({ success: true, message: "Logout exitoso" });

  } catch (error) {
    console.error("[LOGOUT ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al cerrar sesión",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🔵 LOGIN CON GOOGLE
// Soporta access_token (implicit flow) e id_token (auth-code/popup)
// ============================================
exports.googleLogin = async (req, res) => {
  const client = await db.connect();
  try {
    const { token, deviceInfo } = req.body || {};

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "El token de Google es requerido",
        code:    "MISSING_TOKEN",
      });
    }

    // Verificar el token con Google (auto-detecta id_token vs access_token)
    let googleUser;
    try {
      googleUser = await verifyGoogleToken(token);
    } catch (err) {
      console.error("[GOOGLE LOGIN] Token verification failed:", err.message);
      return res.status(401).json({
        success: false,
        message: "No se pudo verificar el token con Google",
        code:    "INVALID_GOOGLE_TOKEN",
      });
    }

    const { email, name, picture } = googleUser;

    await client.query("BEGIN");

    const profileColumns    = await getUserColumnPresence(client);
    const userSelectClause  = await getUserAuthSelectClause(client);
    const existingUserRes   = await client.query(
      `SELECT ${userSelectClause} FROM users WHERE email = $1`,
      [email]
    );

    let user;

    if (existingUserRes.rowCount > 0) {
      // ── Usuario existente ────────────────────────────────────────────────
      user = existingUserRes.rows[0];

      if (!user.is_active) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          success: false,
          message: "Cuenta desactivada. Contacta al administrador.",
          code:    "USER_INACTIVE",
        });
      }

      // Guardar foto de Google si el usuario no tiene una aún
      if (picture && profileColumns.profile_image_url && !user.profile_image_url) {
        await client.query(
          `UPDATE users SET profile_image_url = $1, updated_at = NOW() WHERE id = $2`,
          [picture, user.id]
        );
        user.profile_image_url = picture;
      }

      // Actualizar last_login
      await client.query(
        `UPDATE users SET last_login = NOW() WHERE id = $1`,
        [user.id]
      );

    } else {
      // ── Crear usuario nuevo ──────────────────────────────────────────────
      const roleRes = await client.query(
        "SELECT id FROM roles WHERE name = 'user' LIMIT 1"
      );

      if (roleRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(500).json({
          success: false,
          message: "Rol 'user' no configurado en la base de datos",
          code:    "ROLE_NOT_FOUND",
        });
      }

      const hashedPassword = await bcrypt.hash(
        crypto.randomBytes(24).toString("hex"),
        SALT_ROUNDS
      );

      // Construir INSERT dinámico según columnas disponibles
      const insertCols   = ['email', 'password', 'name', 'is_verified', 'is_active'];
      const insertValues = [email, hashedPassword, name, true, true];

      if (profileColumns.profile_image_url) {
        insertCols.push('profile_image_url');
        insertValues.push(picture || null);
      }
      if (profileColumns.profile_image_public_id) {
        insertCols.push('profile_image_public_id');
        insertValues.push(null);
      }

      const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
      const returning    = [
        'id', 'email', 'name', 'phone', 'cedula', 'city', 'address',
        'is_verified', 'is_active',
        ...(profileColumns.profile_image_url       ? ['profile_image_url']       : []),
        ...(profileColumns.profile_image_public_id ? ['profile_image_public_id'] : []),
      ].join(', ');

      const userRes = await client.query(
        `INSERT INTO users (${insertCols.join(', ')})
         VALUES (${placeholders})
         RETURNING ${returning}`,
        insertValues
      );

      user = userRes.rows[0];

      await client.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [user.id, roleRes.rows[0].id]
      );

      console.log(`[GOOGLE LOGIN] Nuevo usuario creado: ${email}`);
    }

    const { roles }                     = await getUserRoles(user.id);
    const { accessToken, refreshToken } = await issueSessionTokens(client, user, deviceInfo, roles);
    await client.query("COMMIT");

    console.log(`[GOOGLE LOGIN SUCCESS] ${email} | Roles: ${roles.join(", ")}`);

    const profilePayload = buildProfilePayload(user, roles, profileColumns);

    return res.json({
      success: true,
      message: "Login con Google exitoso",
      user:    profilePayload,
      data: {
        user:         profilePayload,
        token:        accessToken,
        refreshToken,
      },
      token:        accessToken,
      refreshToken,
    });

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[GOOGLE LOGIN ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al procesar el login con Google",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 👤 OBTENER PERFIL
// ============================================
exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const profileColumns   = await getUserColumnPresence();
    const userSelectClause = await getUserProfileSelectClause();
    const userRes = await db.query(
      `SELECT ${userSelectClause} FROM users WHERE id = $1`,
      [userId]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
        code:    "USER_NOT_FOUND",
      });
    }

    const user      = userRes.rows[0];
    const { roles } = await getUserRoles(userId);

    return res.json({
      success: true,
      data:    buildProfilePayload(user, roles, profileColumns),
    });

  } catch (error) {
    console.error("[GET PROFILE ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al obtener perfil",
      code:    "SERVER_ERROR",
    });
  }
};

// ============================================
// ✏️ ACTUALIZAR PERFIL PROPIO
// ============================================
exports.updateProfile = async (req, res) => {
  const client = await db.connect();
  try {
    const userId              = req.user.id;
    const { name, phone, city, address } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "El nombre es requerido",
        code:    "MISSING_FIELDS",
      });
    }

    await client.query(
      `UPDATE users
       SET name = $1, phone = $2, city = $3, address = $4, updated_at = NOW()
       WHERE id = $5`,
      [name.trim(), phone?.trim() || null, city?.trim() || null, address?.trim() || null, userId]
    );

    const profileColumns   = await getUserColumnPresence(client);
    const userSelectClause = await getUserProfileSelectClause(client);
    const updated = await client.query(
      `SELECT ${userSelectClause} FROM users WHERE id = $1`,
      [userId]
    );

    const { roles } = await getUserRoles(userId);

    return res.json({
      success: true,
      message: "Perfil actualizado correctamente",
      data:    buildProfilePayload(updated.rows[0], roles, profileColumns),
    });

  } catch (error) {
    console.error("[UPDATE PROFILE ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al actualizar perfil",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 📷 ACTUALIZAR FOTO DE PERFIL
// ============================================
exports.uploadProfileAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No se recibió ninguna imagen",
        code:    "NO_FILE",
      });
    }

    const userId         = req.user.id;
    const profileColumns = await getUserColumnPresence();
    const previousRes    = await db.query(
      "SELECT profile_image_public_id FROM users WHERE id = $1",
      [userId]
    );

    const previousPublicId = previousRes.rows[0]?.profile_image_public_id;
    const imageUrl         = req.file.path || req.file.secure_url || req.file.url || null;
    const publicId         = req.file.public_id || req.file.filename || null;

    if (!imageUrl || !publicId) {
      return res.status(502).json({
        success: false,
        message: "Cloudinary no devolvió la información de la imagen",
        code:    "CLOUDINARY_RESPONSE_ERROR",
      });
    }

    if (previousPublicId && previousPublicId !== publicId) {
      await cloudinary.uploader.destroy(previousPublicId).catch(() => {});
    }

    const updateCols   = ['updated_at = NOW()'];
    const updateValues = [];

    if (profileColumns.profile_image_url) {
      updateValues.push(imageUrl);
      updateCols.push(`profile_image_url = $${updateValues.length}`);
    }
    if (profileColumns.profile_image_public_id) {
      updateValues.push(publicId);
      updateCols.push(`profile_image_public_id = $${updateValues.length}`);
    }
    updateValues.push(userId);

    await db.query(
      `UPDATE users SET ${updateCols.join(', ')} WHERE id = $${updateValues.length}`,
      updateValues
    );

    const userSelectClause = await getUserProfileSelectClause();
    const updatedRes = await db.query(
      `SELECT ${userSelectClause} FROM users WHERE id = $1`,
      [userId]
    );

    const { roles } = await getUserRoles(userId);

    return res.json({
      success: true,
      message: "Foto de perfil actualizada correctamente",
      data:    buildProfilePayload(updatedRes.rows[0], roles, profileColumns),
    });

  } catch (error) {
    console.error("[UPLOAD PROFILE AVATAR ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "No se pudo actualizar la foto de perfil",
      code:    "UPLOAD_FAILED",
    });
  }
};

// ============================================
// 🔑 CAMBIAR CONTRASEÑA PROPIA
// ============================================
exports.changePassword = async (req, res) => {
  const client = await db.connect();
  try {
    const userId                        = req.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Contraseña actual y nueva son requeridas",
        code:    "MISSING_FIELDS",
      });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "La nueva contraseña debe tener mínimo 8 caracteres, mayúsculas, minúsculas, números y un carácter especial",
        code:    "WEAK_PASSWORD",
      });
    }

    const userRes = await client.query(
      "SELECT password FROM users WHERE id = $1",
      [userId]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
      });
    }

    const valid = await bcrypt.compare(currentPassword, userRes.rows[0].password);
    if (!valid) {
      return res.status(401).json({
        success: false,
        message: "La contraseña actual es incorrecta",
        code:    "INVALID_CURRENT_PASSWORD",
      });
    }

    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await client.query(
      "UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2",
      [hashed, userId]
    );

    await client.query(
      "UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE user_id = $1 AND revoked = false",
      [userId]
    );

    console.log(`[CHANGE PASSWORD] Usuario ID: ${userId}`);

    return res.json({
      success: true,
      message: "Contraseña actualizada. Por seguridad, inicia sesión de nuevo en otros dispositivos.",
    });

  } catch (error) {
    console.error("[CHANGE PASSWORD ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al cambiar contraseña",
      code:    "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};