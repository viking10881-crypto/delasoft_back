// controllers/users.controller.js
// Cada admin gestiona ÚNICAMENTE sus propios usuarios registrados.
// El superadmin puede ver y gestionar todos (bypass automático en el middleware).
const db     = require("../config/db");
const bcrypt = require("bcryptjs");
const { emitDataUpdate } = require("../config/socket");

const SALT_ROUNDS = 10;

// ============================================
// 🔒 HELPER: Verificar propiedad del usuario
// ============================================
const assertOwnership = async (userId, adminId, isSuperAdmin) => {
  if (isSuperAdmin) return true;

  const res = await db.query(
    "SELECT id FROM users WHERE id = $1 AND owner_admin_id = $2",
    [userId, adminId]
  );
  return res.rowCount > 0;
};

// ============================================
// 📋 LISTAR USUARIOS DEL ADMIN
// Superadmin ve todos; admin solo los suyos
// ============================================
exports.getUsers = async (req, res) => {
  try {
    const isSuperAdmin = req.user.roles.includes("superadmin");
    const adminFilter  = isSuperAdmin ? "" : "AND u.owner_admin_id = $1";
    const params       = isSuperAdmin ? [] : [req.user.id];

    const result = await db.query(`
      SELECT
        u.id,
        u.email,
        u.name,
        u.phone,
        u.cedula,
        u.city,
        u.address,
        u.is_active,
        u.is_verified,
        u.created_at,
        u.last_login,
        owner.name  AS owner_admin_name,
        owner.email AS owner_admin_email,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
          FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r       ON r.id = ur.role_id
      LEFT JOIN users owner   ON owner.id = u.owner_admin_id
      WHERE r.name = 'user'
      ${adminFilter}
      GROUP BY u.id, owner.name, owner.email
      ORDER BY u.id DESC
    `, params);

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[GET USERS ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al obtener usuarios",
      code: "SERVER_ERROR",
    });
  }
};

// ============================================
// ➕ CREAR USUARIO
// Queda vinculado al admin que lo crea (owner_admin_id)
// ============================================
exports.createUser = async (req, res) => {
  const client = await db.connect();
  try {
    const { email, password, name, phone, cedula, city, address } = req.body;

    if (!name?.trim() || !cedula?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Nombre y cédula son requeridos",
        code: "MISSING_FIELDS",
      });
    }

    await client.query("BEGIN");

    // Rol 'user'
    const roleRes = await client.query(
      "SELECT id FROM roles WHERE name = 'user' LIMIT 1"
    );
    if (roleRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({
        success: false,
        message: "Rol 'user' no configurado en la BD",
        code: "ROLE_NOT_FOUND",
      });
    }

    // Contraseña: la proporcionada, o la cédula como default
    const rawPassword    = password?.trim() || cedula.trim();
    const hashedPassword = await bcrypt.hash(rawPassword, SALT_ROUNDS);

    const userRes = await client.query(
      `INSERT INTO users
         (email, password, name, phone, cedula, city, address,
          is_verified, is_active, owner_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, $8)
       RETURNING id, name, email, cedula`,
      [
        email?.toLowerCase().trim() || null,
        hashedPassword,
        name.trim(),
        phone?.trim() || null,
        cedula.trim(),
        city?.trim() || null,
        address?.trim() || null,
        req.user.id, // <-- vínculo con el admin
      ]
    );

    const newUser = userRes.rows[0];

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [newUser.id, roleRes.rows[0].id]
    );

    await client.query("COMMIT");

    console.log(
      `[USERS] Usuario creado: ${newUser.email || newUser.cedula} por admin ID: ${req.user.id}`
    );

    emitDataUpdate("users", "created", { id: newUser.id, name: newUser.name }, req.adminId);

    return res.status(201).json({
      success: true,
      message: "Usuario creado correctamente",
      data: { id: newUser.id, name: newUser.name, email: newUser.email },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    let message = "Error al crear usuario";
    if (error.code === "23505") {
      if (error.constraint?.includes("email"))  message = "El email ya está registrado";
      if (error.constraint?.includes("cedula")) message = "La cédula ya está registrada";
    }

    console.error("[CREATE USER ERROR]", error);
    return res.status(error.code === "23505" ? 409 : 500).json({
      success: false,
      message,
      code: error.code === "23505" ? "DUPLICATE_ENTRY" : "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// ✏️ ACTUALIZAR USUARIO
// El admin solo puede editar sus propios usuarios
// ============================================
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, cedula, city, address, password, is_active } = req.body;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Verificar propiedad
    const owned = await assertOwnership(id, req.user.id, req.user.roles.includes("superadmin"));
    if (!owned) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "No tienes permisos para editar este usuario",
        code: "FORBIDDEN",
      });
    }

    // Proteger contra edición de admins/superadmins
    const roleCheck = await client.query(
      `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [id]
    );
    const roles = roleCheck.rows.map((r) => r.name);
    if (roles.includes("admin") || roles.includes("superadmin")) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "No puedes editar admins desde este panel",
        code: "FORBIDDEN_ROLE",
      });
    }

    await client.query(
      `UPDATE users
       SET name      = COALESCE($1, name),
           email     = COALESCE($2, email),
           phone     = $3,
           cedula    = COALESCE($4, cedula),
           city      = $5,
           address   = $6,
           is_active = COALESCE($7, is_active),
           updated_at = NOW()
       WHERE id = $8`,
      [
        name?.trim() || null,
        email?.toLowerCase().trim() || null,
        phone?.trim() || null,
        cedula?.trim() || null,
        city?.trim() || null,
        address?.trim() || null,
        is_active ?? null,
        id,
      ]
    );

    if (password?.trim()) {
      const hashed = await bcrypt.hash(password.trim(), SALT_ROUNDS);
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [hashed, id]);
    }

    await client.query("COMMIT");

    emitDataUpdate("users", "updated", { id: parseInt(id) }, req.adminId);

    return res.json({ success: true, message: "Usuario actualizado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE USER ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al actualizar usuario",
      code: "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🔒 ACTIVAR / DESACTIVAR USUARIO
// ============================================
exports.toggleUserStatus = async (req, res) => {
  const { id } = req.params;

  try {
    const owned = await assertOwnership(id, req.user.id, req.user.roles.includes("superadmin"));
    if (!owned) {
      return res.status(403).json({
        success: false,
        message: "No tienes permisos sobre este usuario",
        code: "FORBIDDEN",
      });
    }

    const result = await db.query(
      `UPDATE users
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, is_active`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }

    const user   = result.rows[0];
    const action = user.is_active ? "activado" : "desactivado";

    emitDataUpdate("users", "updated", { id: parseInt(id) }, req.adminId);

    return res.json({
      success: true,
      message: `Usuario ${action} correctamente`,
      data: { id: user.id, is_active: user.is_active },
    });
  } catch (error) {
    console.error("[TOGGLE USER ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al cambiar estado del usuario",
      code: "SERVER_ERROR",
    });
  }
};

// ============================================
// 🗑️ ELIMINAR USUARIO
// ============================================
exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const owned = await assertOwnership(id, req.user.id, req.user.roles.includes("superadmin"));
    if (!owned) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "No tienes permisos para eliminar este usuario",
        code: "FORBIDDEN",
      });
    }

    // Proteger admins
    const roleCheck = await client.query(
      `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [id]
    );
    const roles = roleCheck.rows.map((r) => r.name);
    if (roles.includes("admin") || roles.includes("superadmin")) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "No puedes eliminar admins desde este panel",
        code: "FORBIDDEN_ROLE",
      });
    }

    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);

    const result = await client.query(
      "DELETE FROM users WHERE id = $1 RETURNING id, email",
      [id]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }

    await client.query("COMMIT");

    console.log(
      `[USERS] Usuario ${result.rows[0].email} eliminado por admin ID: ${req.user.id}`
    );

    emitDataUpdate("users", "deleted", { id: parseInt(id) }, req.adminId);

    return res.json({ success: true, message: "Usuario eliminado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE USER ERROR]", error);

    const message =
      error.code === "23503"
        ? "No se puede eliminar: el usuario tiene registros vinculados. Desactívalo en su lugar."
        : "Error al eliminar usuario";

    return res.status(error.code === "23503" ? 409 : 500).json({
      success: false,
      message,
      code: error.code === "23503" ? "HAS_DEPENDENCIES" : "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};