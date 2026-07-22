// controllers/apikeys.controller.js
const db     = require("../config/db");
const crypto = require("crypto");

const AVAILABLE_PERMISSIONS = [
  "products:read",
  "categories:read",
  "inventory:read",
  "sales:read",
  "sales:write",
  "customers:read",
];

const generateApiKey = () => {
  const prefix  = crypto.randomBytes(6).toString("base64url").slice(0, 8);
  const secret  = crypto.randomBytes(32).toString("base64url");
  const fullKey = `ak_${prefix}_${secret}`;
  const hash    = crypto.createHash("sha256").update(fullKey).digest("hex");
  return { fullKey, prefix: `ak_${prefix}`, hash };
};

// ─── Helper: verifica que la key pertenece al admin ──────────
// superadmin puede ver/modificar cualquier key
const checkKeyOwnership = async (keyId, req) => {
  if (req.isSuperAdmin) {
    const r = await db.query("SELECT id, name FROM api_keys WHERE id = $1", [keyId]);
    return r.rowCount ? r.rows[0] : null;
  }
  const r = await db.query(
    "SELECT id, name FROM api_keys WHERE id = $1 AND admin_id = $2",
    [keyId, req.adminId]
  );
  return r.rowCount ? r.rows[0] : null;
};

// ============================================
// 📋 LISTAR API KEYS
// superadmin ve todas; admin ve las suyas
// ============================================
exports.getApiKeys = async (req, res) => {
  try {
    const whereClause = req.isSuperAdmin ? "" : "WHERE ak.admin_id = $1";
    const params      = req.isSuperAdmin ? []  : [req.adminId];

    const result = await db.query(
      `SELECT
         ak.id, ak.name, ak.description, ak.key_prefix, ak.permissions,
         ak.allowed_origins, ak.is_active, ak.last_used_at, ak.request_count,
         ak.expires_at, ak.created_at, ak.updated_at,
         u.name AS admin_name, u.email AS admin_email
       FROM api_keys ak
       JOIN users u ON u.id = ak.admin_id
       ${whereClause}
       ORDER BY ak.created_at DESC`,
      params
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[GET API KEYS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener API keys" });
  }
};

// ============================================
// ➕ CREAR API KEY
// ============================================
exports.createApiKey = async (req, res) => {
  try {
    const { name, description, permissions = ["products:read"], allowed_origins = [], expires_at } = req.body;

    if (!name?.trim())
      return res.status(400).json({ success: false, message: "El nombre es requerido", code: "MISSING_NAME" });

    if (!Array.isArray(permissions) || permissions.length === 0)
      return res.status(400).json({ success: false, message: "Debes asignar al menos un permiso", code: "MISSING_PERMISSIONS" });

    const invalidPerms = permissions.filter(p => !AVAILABLE_PERMISSIONS.includes(p) && p !== "all");
    if (invalidPerms.length > 0)
      return res.status(400).json({
        success: false,
        message: `Permisos no válidos: ${invalidPerms.join(", ")}`,
        code: "INVALID_PERMISSIONS",
        available: AVAILABLE_PERMISSIONS,
      });

    // Límite de 10 keys activas por admin (superadmin sin límite)
    if (!req.isSuperAdmin) {
      const countRes = await db.query(
        "SELECT COUNT(*) FROM api_keys WHERE admin_id = $1 AND is_active = true",
        [req.adminId]
      );
      if (parseInt(countRes.rows[0].count) >= 10)
        return res.status(429).json({
          success: false,
          message: "Límite de 10 API keys activas alcanzado. Elimina o desactiva alguna.",
          code: "API_KEY_LIMIT_REACHED",
        });
    }

    const { fullKey, prefix, hash } = generateApiKey();

    const result = await db.query(
      `INSERT INTO api_keys
         (admin_id, name, description, key_prefix, key_hash, permissions, allowed_origins, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, description, key_prefix, permissions,
                 allowed_origins, is_active, expires_at, created_at`,
      [
        req.adminId,
        name.trim(),
        description?.trim() || null,
        prefix,
        hash,
        JSON.stringify(permissions),
        allowed_origins,
        expires_at || null,
      ]
    );

    console.log(`[API KEY CREATED] Admin ${req.user.email} creó key "${name}" (prefix: ${prefix})`);

    res.status(201).json({
      success: true,
      message: "API Key creada. Guarda la clave, no se mostrará de nuevo.",
      data: { ...result.rows[0], api_key: fullKey },
    });
  } catch (error) {
    console.error("[CREATE API KEY ERROR]", error);
    res.status(500).json({ success: false, message: "Error al crear API Key" });
  }
};

// ============================================
// ✏️ ACTUALIZAR API KEY
// ============================================
exports.updateApiKey = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissions, allowed_origins, expires_at } = req.body;

    const key = await checkKeyOwnership(id, req);
    if (!key)
      return res.status(404).json({ success: false, message: "API Key no encontrada", code: "KEY_NOT_FOUND" });

    if (permissions) {
      const invalid = permissions.filter(p => !AVAILABLE_PERMISSIONS.includes(p) && p !== "all");
      if (invalid.length > 0)
        return res.status(400).json({
          success: false,
          message: `Permisos no válidos: ${invalid.join(", ")}`,
          code: "INVALID_PERMISSIONS",
        });
    }

    const result = await db.query(
      `UPDATE api_keys
       SET name            = COALESCE($1, name),
           description     = COALESCE($2, description),
           permissions     = COALESCE($3, permissions),
           allowed_origins = COALESCE($4, allowed_origins),
           expires_at      = $5,
           updated_at      = NOW()
       WHERE id = $6
       RETURNING id, name, description, key_prefix, permissions,
                 allowed_origins, is_active, expires_at, updated_at`,
      [
        name?.trim() || null,
        description?.trim() || null,
        permissions ? JSON.stringify(permissions) : null,
        allowed_origins || null,
        expires_at || null,
        id,
      ]
    );

    res.json({ success: true, message: "API Key actualizada", data: result.rows[0] });
  } catch (error) {
    console.error("[UPDATE API KEY ERROR]", error);
    res.status(500).json({ success: false, message: "Error al actualizar API Key" });
  }
};

// ============================================
// 🔄 ROTAR API KEY
// ============================================
exports.rotateApiKey = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const key = await checkKeyOwnership(id, req);
    if (!key) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "API Key no encontrada" });
    }

    const { fullKey, prefix, hash } = generateApiKey();

    await client.query(
      `UPDATE api_keys
       SET key_prefix = $1, key_hash = $2, request_count = 0,
           last_used_at = NULL, updated_at = NOW()
       WHERE id = $3`,
      [prefix, hash, id]
    );

    await client.query("COMMIT");

    console.log(`[API KEY ROTATED] Admin ${req.user.email} rotó key ID ${id}`);

    res.json({
      success: true,
      message: "API Key regenerada. La clave anterior ya no funciona. Guarda la nueva.",
      data: { id, key_prefix: prefix, api_key: fullKey },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[ROTATE API KEY ERROR]", error);
    res.status(500).json({ success: false, message: "Error al rotar API Key" });
  } finally {
    client.release();
  }
};

// ============================================
// 🔒 TOGGLE ACTIVO / INACTIVO
// ============================================
exports.toggleApiKey = async (req, res) => {
  try {
    const { id } = req.params;

    const key = await checkKeyOwnership(id, req);
    if (!key)
      return res.status(404).json({ success: false, message: "API Key no encontrada" });

    const result = await db.query(
      `UPDATE api_keys SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, key_prefix, is_active`,
      [id]
    );

    const updated = result.rows[0];
    res.json({
      success: true,
      message: `API Key ${updated.is_active ? "activada" : "desactivada"}`,
      data: updated,
    });
  } catch (error) {
    console.error("[TOGGLE API KEY ERROR]", error);
    res.status(500).json({ success: false, message: "Error al cambiar estado de API Key" });
  }
};

// ============================================
// 🗑️ ELIMINAR API KEY
// ============================================
exports.deleteApiKey = async (req, res) => {
  try {
    const { id } = req.params;

    const key = await checkKeyOwnership(id, req);
    if (!key)
      return res.status(404).json({ success: false, message: "API Key no encontrada" });

    await db.query("DELETE FROM api_keys WHERE id = $1", [id]);

    res.json({
      success: true,
      message: `API Key "${key.name}" eliminada permanentemente`,
    });
  } catch (error) {
    console.error("[DELETE API KEY ERROR]", error);
    res.status(500).json({ success: false, message: "Error al eliminar API Key" });
  }
};

// ============================================
// 📊 LOGS DE USO
// ============================================
exports.getApiKeyLogs = async (req, res) => {
  try {
    const { id }  = req.params;
    const limit   = Math.min(parseInt(req.query.limit) || 50, 200);

    const key = await checkKeyOwnership(id, req);
    if (!key)
      return res.status(404).json({ success: false, message: "API Key no encontrada" });

    const logs = await db.query(
      `SELECT id, endpoint, method, ip_address, origin, status_code, created_at
       FROM api_key_logs
       WHERE api_key_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [id, limit]
    );

    res.json({ success: true, data: logs.rows });
  } catch (error) {
    console.error("[API KEY LOGS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener logs" });
  }
};

// ============================================
// 📋 PERMISOS DISPONIBLES
// ============================================
exports.getAvailablePermissions = (_req, res) => {
  res.json({
    success: true,
    data: {
      "products:read":   "Ver productos y catálogo",
      "categories:read": "Ver categorías",
      "inventory:read":  "Ver inventario y stock",
      "sales:read":      "Ver historial de ventas",
      "sales:write":     "Crear ventas (punto de venta externo)",
      "customers:read":  "Ver clientes",
      "all":             "Acceso completo",
    },
  });
};