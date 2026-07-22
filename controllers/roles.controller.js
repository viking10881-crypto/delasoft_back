// controllers/roles.controller.js
// Solo superadmin puede crear/eliminar roles.
// Admins pueden listar para poblar selectores en el frontend.
const db = require("../config/db");

// Roles del sistema que nunca deben eliminarse
const PROTECTED_ROLES = ["superadmin", "admin", "user"];

// ============================================
// 📋 LISTAR ROLES
// Acceso: admin, superadmin
// ============================================
exports.getRoles = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        r.id,
        r.name,
        r.description,
        r.created_at,
        COUNT(ur.user_id)::int AS user_count
      FROM roles r
      LEFT JOIN user_roles ur ON ur.role_id = r.id
      GROUP BY r.id
      ORDER BY r.id
    `);

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[GET ROLES ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al obtener roles",
      code: "SERVER_ERROR",
    });
  }
};

// ============================================
// ➕ CREAR ROL
// Acceso: solo superadmin
// ============================================
exports.createRole = async (req, res) => {
  const { name, description } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({
      success: false,
      message: "El nombre del rol es requerido",
      code: "MISSING_FIELDS",
    });
  }

  const slug = name.trim().toLowerCase().replace(/\s+/g, "_");

  try {
    const result = await db.query(
      `INSERT INTO roles (name, description)
       VALUES ($1, $2)
       RETURNING id, name, description, created_at`,
      [slug, description?.trim() || null]
    );

    console.log(`[ROLES] Rol creado: "${slug}" por superadmin ID: ${req.user.id}`);

    return res.status(201).json({
      success: true,
      message: "Rol creado correctamente",
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "El rol ya existe",
        code: "ROLE_EXISTS",
      });
    }
    console.error("[CREATE ROLE ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al crear rol",
      code: "SERVER_ERROR",
    });
  }
};

// ============================================
// 🗑️ ELIMINAR ROL
// Acceso: solo superadmin
// No se pueden eliminar roles del sistema
// ============================================
exports.deleteRole = async (req, res) => {
  const { id } = req.params;

  try {
    // Verificar que no sea un rol protegido
    const roleRes = await db.query("SELECT name FROM roles WHERE id = $1", [id]);

    if (roleRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Rol no encontrado",
        code: "ROLE_NOT_FOUND",
      });
    }

    if (PROTECTED_ROLES.includes(roleRes.rows[0].name)) {
      return res.status(403).json({
        success: false,
        message: `El rol "${roleRes.rows[0].name}" es del sistema y no puede eliminarse`,
        code: "PROTECTED_ROLE",
      });
    }

    // Verificar que no esté en uso
    const usageRes = await db.query(
      "SELECT COUNT(*) FROM user_roles WHERE role_id = $1",
      [id]
    );

    if (parseInt(usageRes.rows[0].count) > 0) {
      return res.status(409).json({
        success: false,
        message: "No se puede eliminar: el rol tiene usuarios asignados",
        code: "ROLE_IN_USE",
      });
    }

    await db.query("DELETE FROM roles WHERE id = $1", [id]);

    console.log(`[ROLES] Rol ID ${id} eliminado por superadmin ID: ${req.user.id}`);

    return res.json({ success: true, message: "Rol eliminado correctamente" });
  } catch (error) {
    console.error("[DELETE ROLE ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al eliminar rol",
      code: "SERVER_ERROR",
    });
  }
};