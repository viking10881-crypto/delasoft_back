// controllers/categories.controller.js
"use strict";

const db = require("../config/db");
const { emitDataUpdate }  = require("../config/socket");
const { assertOwnership } = require("../middleware/adminScope");

// ─────────────────────────────────────────────
// GET /categories  — árbol jerárquico
// ─────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const { isSuperAdmin, adminId } = req;

    const tenantClause = isSuperAdmin ? "" : "AND owner_admin_id = $1";
    const params       = isSuperAdmin ? [] : [adminId];

    const result = await db.query(`
      SELECT id, name, slug, description, image_url, parent_id,
             is_active, created_at, updated_at
      FROM categories
      WHERE is_active = true ${tenantClause}
      ORDER BY name
    `, params);

    const rows = result.rows.map((r) => ({
      ...r,
      id:        Number(r.id),
      parent_id: r.parent_id != null ? Number(r.parent_id) : null,
    }));

    const buildTree = (items, parentId = null) =>
      items
        .filter((item) => item.parent_id === parentId)
        .map((item) => ({ ...item, children: buildTree(items, item.id) }));

    res.json(buildTree(rows));
  } catch (error) {
    console.error("GET CATEGORIES ERROR:", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías" });
  }
};

// ─────────────────────────────────────────────
// GET /categories/flat  — lista plana para <select>
// ─────────────────────────────────────────────
exports.getFlat = async (req, res) => {
  try {
    const { isSuperAdmin, adminId } = req;

    const tenantClause = isSuperAdmin ? "" : "AND owner_admin_id = $1";
    const params       = isSuperAdmin ? [] : [adminId];

    const result = await db.query(`
      WITH RECURSIVE category_paths AS (
        SELECT id, name, slug, parent_id, owner_admin_id,
               CAST(name AS TEXT) AS full_path, 1 AS level
        FROM categories
        WHERE parent_id IS NULL AND is_active = true ${tenantClause}

        UNION ALL

        SELECT c.id, c.name, c.slug, c.parent_id, c.owner_admin_id,
               CAST(cp.full_path || ' > ' || c.name AS TEXT),
               cp.level + 1
        FROM categories c
        INNER JOIN category_paths cp ON c.parent_id = cp.id
        WHERE c.is_active = true
      )
      SELECT id, name, slug, parent_id, full_path, level
      FROM category_paths
      ORDER BY full_path
    `, params);

    res.json(result.rows);
  } catch (error) {
    console.error("GET FLAT CATEGORIES ERROR:", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías planas" });
  }
};

// ─────────────────────────────────────────────
// POST /categories
// ─────────────────────────────────────────────
exports.create = async (req, res) => {
  const { name, slug, description, image_url, parent_id } = req.body;
  const { isSuperAdmin, adminId } = req;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: "El nombre es obligatorio" });
  }

  try {
    if (parent_id && !isSuperAdmin) {
      const parentOwned = await db.query(
        "SELECT id FROM categories WHERE id = $1 AND owner_admin_id = $2",
        [parent_id, adminId]
      );
      if (parentOwned.rowCount === 0) {
        return res.status(403).json({
          success: false,
          message: "La categoría padre no te pertenece",
          code: "FORBIDDEN",
        });
      }
    }

    const finalSlug = (slug && slug.trim())
      ? slug.trim()
      : name
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");

    const ownerAdminId = isSuperAdmin ? null : adminId;

    const result = await db.query(
      `INSERT INTO categories
         (name, slug, description, image_url, parent_id, created_by, owner_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        name.trim(), finalSlug,
        description || null, image_url || null,
        parent_id  || null,  req.user.id, ownerAdminId,
      ]
    );

    const newCategory = result.rows[0];
    emitDataUpdate("categories", "created", newCategory, req.adminId);
    res.status(201).json(newCategory);
  } catch (error) {
    console.error("CREATE CATEGORY ERROR:", error);
    if (error.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "El slug ya existe. Elige uno diferente.",
      });
    }
    res.status(500).json({ success: false, message: "Error al crear categoría" });
  }
};

// ─────────────────────────────────────────────
// PUT /categories/:id
// ─────────────────────────────────────────────
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, slug, description, image_url, parent_id, is_active } = req.body;
  const { isSuperAdmin, adminId } = req;
  const categoryId  = Number(id);
  const newParentId = parent_id ? Number(parent_id) : null;

  try {
    if (!isSuperAdmin) {
      const owned = await assertOwnership(db, "categories", categoryId, adminId, "owner_admin_id");
      if (!owned) {
        const exists = (await db.query(
          "SELECT id FROM categories WHERE id = $1", [categoryId]
        )).rowCount;
        return exists
          ? res.status(403).json({ success: false, message: "No tienes permisos sobre esta categoría", code: "FORBIDDEN" })
          : res.status(404).json({ success: false, message: "Categoría no encontrada" });
      }
    }

    if (newParentId && newParentId === categoryId) {
      return res.status(400).json({
        success: false,
        message: "Una categoría no puede ser padre de sí misma",
      });
    }

    if (newParentId) {
      const cycleCheck = await db.query(`
        WITH RECURSIVE descendants AS (
          SELECT id FROM categories WHERE parent_id = $1
          UNION ALL
          SELECT c.id FROM categories c
          INNER JOIN descendants d ON c.parent_id = d.id
        )
        SELECT 1 FROM descendants WHERE id = $2
      `, [categoryId, newParentId]);

      if (cycleCheck.rowCount > 0) {
        return res.status(400).json({
          success: false,
          message: "No se puede asignar un descendiente como categoría superior (referencia circular)",
        });
      }
    }

    const result = await db.query(
      `UPDATE categories
       SET name        = $1, slug      = $2, description = $3,
           image_url   = $4, parent_id = $5, is_active   = $6,
           updated_at  = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [name, slug, description || null, image_url || null,
       newParentId, is_active ?? true, categoryId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Categoría no encontrada" });
    }

    emitDataUpdate("categories", "updated", result.rows[0], req.adminId);
    res.json(result.rows[0]);
  } catch (error) {
    console.error("UPDATE CATEGORY ERROR:", error);
    if (error.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "El slug ya existe. Elige uno diferente.",
      });
    }
    res.status(500).json({ success: false, message: "Error al actualizar categoría" });
  }
};

// ─────────────────────────────────────────────
// DELETE /categories/:id
// ─────────────────────────────────────────────
exports.remove = async (req, res) => {
  const { id } = req.params;
  const { isSuperAdmin, adminId } = req;

  try {
    if (!isSuperAdmin) {
      const owned = await assertOwnership(db, "categories", id, adminId, "owner_admin_id");
      if (!owned) {
        const exists = (await db.query(
          "SELECT id FROM categories WHERE id = $1", [id]
        )).rowCount;
        return exists
          ? res.status(403).json({ success: false, message: "No tienes permisos sobre esta categoría", code: "FORBIDDEN" })
          : res.status(404).json({ success: false, message: "Categoría no encontrada" });
      }
    }

    const childCount = parseInt(
      (await db.query(
        "SELECT COUNT(*) AS count FROM categories WHERE parent_id = $1 AND is_active = true", [id]
      )).rows[0].count
    );
    if (childCount > 0) {
      return res.status(400).json({
        success: false,
        message: "No se puede eliminar. Esta categoría tiene subcategorías asociadas",
      });
    }

    const productCount = parseInt(
      (await db.query(
        "SELECT COUNT(*) AS count FROM products WHERE category_id = $1", [id]
      )).rows[0].count
    );
    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        message: "No se puede eliminar. Esta categoría tiene productos asociados",
      });
    }

    const result = await db.query(
      "DELETE FROM categories WHERE id = $1 RETURNING id", [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Categoría no encontrada" });
    }

    emitDataUpdate("categories", "deleted", { id: parseInt(id) }, req.adminId);
    res.json({ success: true, message: "Categoría eliminada correctamente" });
  } catch (error) {
    console.error("DELETE CATEGORY ERROR:", error);
    res.status(500).json({ success: false, message: "Error al eliminar categoría" });
  }
};