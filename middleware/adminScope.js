// middleware/adminScope.js
// Inyecta req.isSuperAdmin y req.adminId en cada request protegido.
// Se usa en ABSOLUTAMENTE TODAS las rutas del panel excepto /auth y /setup.
//
// REGLA ÚNICA:
//   superadmin        → ve y gestiona TODO de TODOS los admins
//   admin raíz        → ve y gestiona SOLO sus propios datos
//   sub-usuario       → hereda el scope de su admin dueño (owner_admin_id)
//
// No hay excepciones: productos, categorías, proveedores, banners,
// gastos, ventas, órdenes, facturas, presupuestos, descuentos… todo.

const adminScope = (req, _res, next) => {
  if (!req.user) return next(); // auth middleware ya bloquea antes si falta token

  req.isSuperAdmin = req.user.roles.includes("superadmin");

  // Sub-usuarios (gerente, cajero, etc.) heredan el scope de su admin dueño.
  // owner_admin_id: null  → es admin raíz    → usa su propio id
  //                 valor → es sub-usuario   → usa el id del admin que lo creó
  req.adminId = req.user.owner_admin_id ?? req.user.id;

  next();
};

// ─── Helpers reutilizables en controllers ────────────────────────────────────
//
//   const { isSuperAdmin, adminId } = req;
//
//   // Para tablas con created_by (sales, expenses, banners…):
//   const { where, params } = scopeByCreator(isSuperAdmin, adminId);
//   await db.query(`SELECT * FROM sales s WHERE 1=1 ${where} ORDER BY s.sale_date DESC`, params);
//
//   // Para tablas con owner_admin_id (products, categories, providers…):
//   const { where, params } = scopeByOwner(isSuperAdmin, adminId);
//   await db.query(`SELECT * FROM products p WHERE p.is_active = true ${where}`, params);
//
//   // Con params previos (paramOffset):
//   const { where, params } = scopeByOwner(isSuperAdmin, adminId, "p.", existingParams.length);
//   await db.query(`SELECT * FROM products p WHERE p.category_id = $1 ${where}`, [...existingParams, ...params]);

/**
 * Filtra por `created_by`.
 * Tablas: sales, expenses, purchase_orders, invoices,
 *         banners, discounts, discount_coupons, financial_budgets,
 *         providers, categories, products, attribute_types.
 *
 * @param {boolean} isSuperAdmin
 * @param {number}  adminId
 * @param {string}  [alias=""]       - alias de tabla, p.ej. "s." → "s.created_by"
 * @param {number}  [paramOffset=0]  - cantidad de params ya usados en la query
 * @returns {{ where: string, params: any[] }}
 */
const scopeByCreator = (isSuperAdmin, adminId, alias = "", paramOffset = 0) => {
  if (isSuperAdmin) return { where: "", params: [] };
  return {
    where:  `AND ${alias}created_by = $${paramOffset + 1}`,
    params: [adminId],
  };
};

/**
 * Filtra por `owner_admin_id`.
 * Tablas: products, categories, providers, expenses, sales,
 *         discounts, discount_coupons, purchase_orders, invoices,
 *         financial_budgets, users (sub-usuarios del admin).
 *
 * @param {boolean} isSuperAdmin
 * @param {number}  adminId
 * @param {string}  [alias=""]
 * @param {number}  [paramOffset=0]
 * @returns {{ where: string, params: any[] }}
 */
const scopeByOwner = (isSuperAdmin, adminId, alias = "", paramOffset = 0) => {
  if (isSuperAdmin) return { where: "", params: [] };
  return {
    where:  `AND ${alias}owner_admin_id = $${paramOffset + 1}`,
    params: [adminId],
  };
};

/**
 * Filtra por `admin_id`.
 * Tablas: api_keys, subscriptions, subscription_invoices.
 *
 * @param {boolean} isSuperAdmin
 * @param {number}  adminId
 * @param {string}  [alias=""]
 * @param {number}  [paramOffset=0]
 * @returns {{ where: string, params: any[] }}
 */
const scopeByAdminId = (isSuperAdmin, adminId, alias = "", paramOffset = 0) => {
  if (isSuperAdmin) return { where: "", params: [] };
  return {
    where:  `AND ${alias}admin_id = $${paramOffset + 1}`,
    params: [adminId],
  };
};

/**
 * Filtra por `user_id`.
 * Tablas: agent_conversations, push_subscriptions.
 *
 * @param {boolean} isSuperAdmin
 * @param {number}  adminId
 * @param {string}  [alias=""]
 * @param {number}  [paramOffset=0]
 * @returns {{ where: string, params: any[] }}
 */
const scopeByUserId = (isSuperAdmin, adminId, alias = "", paramOffset = 0) => {
  if (isSuperAdmin) return { where: "", params: [] };
  return {
    where:  `AND ${alias}user_id = $${paramOffset + 1}`,
    params: [adminId],
  };
};

// Tablas y columnas permitidas en assertOwnership (evita interpolación arbitraria)
const _OWNERSHIP_TABLES = new Set([
  "products", "categories", "providers", "sales", "expenses",
  "discounts", "discount_coupons", "purchase_orders", "invoices",
  "financial_budgets", "users", "api_keys", "banners",
  "attribute_types", "agent_conversations", "push_subscriptions",
  "subscriptions", "subscription_invoices",
]);

const _OWNERSHIP_COLS = new Set([
  "created_by", "owner_admin_id", "admin_id", "user_id",
]);

/**
 * Verifica ownership antes de UPDATE / DELETE.
 * El superadmin siempre puede; para el resto comprueba la columna indicada.
 *
 * @param {object}  db
 * @param {string}  table
 * @param {number}  recordId
 * @param {number}  adminId
 * @param {string}  [col="created_by"]
 * @param {boolean} [isSuperAdmin=false]
 * @returns {Promise<boolean>}
 */
const assertOwnership = async (
  db,
  table,
  recordId,
  adminId,
  col = "created_by",
  isSuperAdmin = false
) => {
  if (isSuperAdmin) return true;
  if (!_OWNERSHIP_TABLES.has(table)) throw new Error(`assertOwnership: tabla "${table}" no permitida`);
  if (!_OWNERSHIP_COLS.has(col))    throw new Error(`assertOwnership: columna "${col}" no permitida`);
  const res = await db.query(
    `SELECT id FROM ${table} WHERE id = $1 AND ${col} = $2`,
    [recordId, adminId]
  );
  return res.rowCount > 0;
};

/**
 * Construye SET clause + params para UPDATE dinámico.
 * Solo actualiza los campos permitidos (allowedFields).
 * Útil para no tener que escribir el SET a mano en cada controller.
 *
 * Uso:
 *   const { set, params, next } = buildUpdate(req.body, ["name","price","is_active"], 1);
 *   if (!set) return res.status(400).json({ message: "Sin campos para actualizar" });
 *   await db.query(`UPDATE products SET ${set} WHERE id = $${next}`, [...params, productId]);
 *
 * @param {object}   body          - req.body
 * @param {string[]} allowedFields - campos permitidos para actualizar
 * @param {number}   [startIdx=1]  - índice inicial del placeholder ($1, $2…)
 * @returns {{ set: string, params: any[], next: number }}
 */
const buildUpdate = (body, allowedFields, startIdx = 1) => {
  const entries = Object.entries(body).filter(
    ([k, v]) => allowedFields.includes(k) && v !== undefined
  );

  if (!entries.length) return { set: "", params: [], next: startIdx };

  const set    = entries.map(([k], i) => `"${k}" = $${startIdx + i}`).join(", ");
  const params = entries.map(([, v]) => v);

  return { set, params, next: startIdx + entries.length };
};

module.exports = {
  adminScope,
  scopeByCreator,
  scopeByOwner,
  scopeByAdminId,
  scopeByUserId,
  assertOwnership,
  buildUpdate,
};