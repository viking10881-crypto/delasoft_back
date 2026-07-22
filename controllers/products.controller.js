// controllers/products.controller.js
const db         = require("../config/db");
const cloudinary = require("../config/cloudinary");
const { emitDataUpdate }              = require("../config/socket");
const { assertOwnership }             = require("../middleware/adminScope");

// ─────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────
const fetchFullProduct = async (id) => {
  const result = await db.query(`
    SELECT
      p.*,
      c.name AS category_name,
      c.slug AS category_slug,
      u.name AS owner_admin_name,
      (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
      best_discount.type  AS discount_type,
      best_discount.value AS discount_value,
      COALESCE(best_discount.final_price, p.sale_price) AS final_price
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN users      u ON u.id = p.owner_admin_id
    LEFT JOIN LATERAL (
      SELECT d.type, d.value,
        CASE
          WHEN d.type = 'percentage' THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
          WHEN d.type = 'fixed'      THEN p.sale_price - d.value
          ELSE p.sale_price
        END AS final_price
      FROM discount_targets dt
      JOIN discounts d ON d.id = dt.discount_id
      WHERE ((dt.target_type = 'product'  AND dt.target_id = p.id::text)
          OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
        AND d.active = true
        AND NOW() BETWEEN d.starts_at AND d.ends_at
        AND (d.scope = 'pos' OR d.scope = 'all')
      ORDER BY final_price ASC LIMIT 1
    ) best_discount ON true
    WHERE p.id = $1
  `, [id]);

  if (!result.rows.length) return null;
  return {
    ...result.rows[0],
    has_variants: result.rows[0].has_variants ?? false,
    is_bundle:    result.rows[0].is_bundle    ?? false,
  };
};

const getPublicIdFromUrl = (url) => {
  try {
    if (!url || typeof url !== "string") return null;
    const parts = url.split("/upload/");
    if (parts.length < 2) return null;
    return parts[1].split("/").filter(p => !p.startsWith("v")).join("/").replace(/\.[^/.]+$/, "");
  } catch { return null; }
};

const validateProductData = (data, isUpdate = false) => {
  const errors = [];
  if (!isUpdate || data.name !== undefined) {
    if (!data.name?.trim()) errors.push("Nombre es requerido");
    else if (data.name.length > 200) errors.push("Nombre demasiado largo");
  }
  if (!isUpdate || data.sale_price !== undefined) {
    const price = Number(data.sale_price);
    if (isNaN(price) || price < 0) errors.push("Precio inválido");
  }
  if (!isUpdate || data.stock !== undefined) {
    const stock = Number(data.stock);
    if (isNaN(stock) || stock < 0 || !Number.isInteger(stock)) errors.push("Stock debe ser entero positivo");
  }
  if (!isUpdate && !data.category_id) errors.push("Categoría es requerida");
  return { isValid: errors.length === 0, errors };
};

// ─────────────────────────────────────────────
// GET /products
// ─────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const { isSuperAdmin, adminId } = req;

    const { categoria, search, min_price, max_price } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 12);
    const offset = (page - 1) * limit;

    const queryParams = [];
    let pi = 1;

    let tenantClause = "";
    if (!isSuperAdmin) {
      tenantClause = `AND p.owner_admin_id = $${pi++}`;
      queryParams.push(adminId);
    }

    let filtersClause = "";
    if (categoria) {
      filtersClause += ` AND c.slug = $${pi++}`;
      queryParams.push(categoria);
    }
    if (search) {
      filtersClause += ` AND (p.name ILIKE $${pi} OR p.description ILIKE $${pi})`;
      queryParams.push(`%${search}%`);
      pi++;
    }
    if (min_price) {
      filtersClause += ` AND p.sale_price >= $${pi++}`;
      queryParams.push(Number(min_price));
    }
    if (max_price) {
      filtersClause += ` AND p.sale_price <= $${pi++}`;
      queryParams.push(Number(max_price));
    }

    const limitIdx  = pi;
    const offsetIdx = pi + 1;
    queryParams.push(limit, offset);

    const queryText = `
      SELECT
        p.*,
        c.name AS category_name,
        c.slug AS category_slug,
        u.name AS owner_admin_name,
        (SELECT url FROM product_images
         WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        best_discount.type  AS discount_type,
        best_discount.value AS discount_value,
        COALESCE(best_discount.final_price, p.sale_price) AS final_price,
        -- POS availability: real available units from ledger view
        CASE WHEN NOT p.has_variants
          THEN COALESCE(vsd_simple.disponible_inmediato, 0)
          ELSE NULL
        END AS disponible_inmediato,
        CASE
          WHEN p.has_variants
            THEN (p.fulfillment_mode != 'stock' OR COALESCE(vsd_variants.has_available, false))
          ELSE
            (p.fulfillment_mode != 'stock' OR COALESCE(vsd_simple.disponible_inmediato, 0) > 0)
        END AS is_sellable,
        p.fulfillment_mode IN ('hybrid', 'on_demand') AS can_order_on_demand
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN users      u ON u.id = p.owner_admin_id
      LEFT JOIN LATERAL (
        SELECT d.type, d.value,
          CASE
            WHEN d.type = 'percentage'
              THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
            WHEN d.type = 'fixed'
              THEN p.sale_price - d.value
            ELSE p.sale_price
          END AS final_price
        FROM discount_targets dt
        JOIN discounts d ON d.id = dt.discount_id
        WHERE (
          (dt.target_type = 'product'  AND dt.target_id = p.id::text)
          OR
          (dt.target_type = 'category' AND dt.target_id = p.category_id::text
           AND p.category_id IS NOT NULL)
        )
          AND d.active = true
          AND NOW() BETWEEN d.starts_at AND d.ends_at
          AND (d.scope = 'pos' OR d.scope = 'all')
        ORDER BY final_price ASC
        LIMIT 1
      ) best_discount ON true
      LEFT JOIN LATERAL (
        SELECT disponible_inmediato
        FROM v_stock_disponible
        WHERE product_id = p.id AND variant_id IS NULL
        LIMIT 1
      ) vsd_simple ON true
      LEFT JOIN LATERAL (
        SELECT bool_or(vsd.disponible_inmediato > 0) AS has_available
        FROM v_stock_disponible vsd
        JOIN product_variants pv ON pv.id = vsd.variant_id AND pv.is_active = true
        WHERE vsd.product_id = p.id AND vsd.variant_id IS NOT NULL
      ) vsd_variants ON true
      WHERE p.is_active = true
        ${tenantClause}
        ${filtersClause}
      ORDER BY p.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    // Count
    const countParams = [];
    let ci = 1;
    let countTenant  = "";
    let countFilters = "";

    if (!isSuperAdmin) {
      countTenant = `AND p.owner_admin_id = $${ci++}`;
      countParams.push(adminId);
    }
    if (categoria) { countFilters += ` AND c.slug = $${ci++}`; countParams.push(categoria); }
    if (search) {
      countFilters += ` AND (p.name ILIKE $${ci} OR p.description ILIKE $${ci})`;
      countParams.push(`%${search}%`); ci++;
    }

    const [result, countResult] = await Promise.all([
      db.query(queryText, queryParams),
      db.query(
        `SELECT COUNT(*) FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.is_active = true ${countTenant} ${countFilters}`,
        countParams
      ),
    ]);

    const rows = result.rows.map(row => ({
      ...row,
      has_variants: row.has_variants ?? false,
      is_bundle:    row.is_bundle    ?? false,
    }));

    const total = Number(countResult.rows[0].count);

    res.json({
      success: true,
      data: rows,
      pagination: {
        total,
        totalPages: Math.ceil(total / limit),
        page,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      },
    });
  } catch (error) {
    console.error("[GET PRODUCTS ERROR]", error.message, error.stack);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
};

// ─────────────────────────────────────────────
// GET /products/:id
// ─────────────────────────────────────────────
exports.getById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });

    const { isSuperAdmin, adminId } = req;
    const ownerClause = isSuperAdmin ? "" : "AND p.owner_admin_id = $2";
    const queryParams = isSuperAdmin ? [id] : [id, adminId];

    const result = await db.query(`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug,
        u.name AS owner_admin_name,
        d.name AS discount_name, d.type AS discount_type, d.value AS discount_value,
        CASE
          WHEN d.type = 'percentage'
            THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
          WHEN d.type = 'fixed' THEN p.sale_price - d.value
          ELSE p.sale_price
        END AS final_price
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN users      u ON u.id = p.owner_admin_id
      LEFT JOIN discount_targets dt ON (
        (dt.target_type = 'product'  AND dt.target_id = p.id::text) OR
        (dt.target_type = 'category' AND dt.target_id = p.category_id::text
         AND p.category_id IS NOT NULL)
      )
      LEFT JOIN discounts d
        ON dt.discount_id = d.id
        AND d.active = true
        AND NOW() BETWEEN d.starts_at AND d.ends_at
        AND (d.scope = 'pos' OR d.scope = 'all')
      WHERE p.id = $1 ${ownerClause}
      LIMIT 1
    `, queryParams);

    if (!result.rows.length)
      return res.status(404).json({ success: false, message: "Producto no encontrado" });

    const product = result.rows[0];

    const imagesResult = await db.query(
      `SELECT id, url, is_main FROM product_images
       WHERE product_id = $1 ORDER BY is_main DESC, display_order ASC`,
      [id]
    );

    let variants = [];
    if (product.has_variants) {
      try {
        const vResult = await db.query(`
          SELECT
            pv.id, pv.sku, pv.sale_price, pv.stock, pv.is_active,
            COALESCE(
              json_agg(
                json_build_object(
                  'type',               at.name,
                  'attribute_type',     at.name,
                  'value',              av.value,
                  'display_value',      COALESCE(av.display_value, av.value),
                  'hex_color',          av.hex_color,
                  'attribute_value_id', av.id
                ) ORDER BY at.id
              ) FILTER (WHERE av.id IS NOT NULL), '[]'
            ) AS attributes,
            (
              SELECT COALESCE(
                json_agg(
                  json_build_object('id', vi.id, 'url', vi.url, 'is_main', vi.is_main)
                  ORDER BY vi.is_main DESC, vi.display_order
                ), '[]'
              )
              FROM variant_images vi
              WHERE vi.variant_id = pv.id
            ) AS images
          FROM product_variants pv
          LEFT JOIN variant_attribute_values vav ON vav.variant_id = pv.id
          LEFT JOIN attribute_values av ON av.id = vav.attribute_value_id
          LEFT JOIN attribute_types  at ON at.id = av.attribute_type_id
          WHERE pv.product_id = $1
          GROUP BY pv.id ORDER BY pv.id
        `, [id]);
        variants = vResult.rows;
      } catch (e) { console.warn("[VARIANTS]", e.message); }
    }

    let bundleItems = [];
    if (product.is_bundle) {
      try {
        const bResult = await db.query(`
          SELECT bi.id, bi.quantity, bi.is_gift,
            p2.id AS product_id, p2.name AS product_name, p2.sale_price AS product_price,
            (SELECT url FROM product_images pi
             WHERE pi.product_id = p2.id AND pi.is_main = true LIMIT 1) AS product_image
          FROM bundle_items bi
          JOIN products p2 ON p2.id = bi.product_id
          WHERE bi.bundle_id = $1 ORDER BY bi.is_gift ASC, bi.id
        `, [id]);
        bundleItems = bResult.rows;
      } catch (e) { console.warn("[BUNDLE ITEMS]", e.message); }
    }

    res.json({
      success: true,
      data: { ...product, images: imagesResult.rows, variants, bundle_items: bundleItems },
    });
  } catch (error) {
    console.error("[GET PRODUCT BY ID ERROR]", error.message, error.stack);
    res.status(500).json({ success: false, message: "Error al obtener producto" });
  }
};

// ─────────────────────────────────────────────
// GET /products/:id/ledger
// ─────────────────────────────────────────────
exports.getLedger = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });

    const { isSuperAdmin, adminId } = req;
    const variant_id = req.query.variant_id || null;
    const limit      = Math.min(200, parseInt(req.query.limit) || 50);
    const offset     = Math.max(0,   parseInt(req.query.offset) || 0);

    // Verificar ownership del producto
    const ownerClause = isSuperAdmin ? "" : "AND owner_admin_id = $2";
    const checkParams = isSuperAdmin ? [id] : [id, adminId];
    const check = await db.query(
      `SELECT id FROM products WHERE id = $1 ${ownerClause}`, checkParams
    );
    if (!check.rowCount)
      return res.status(404).json({ success: false, message: "Producto no encontrado" });

    const params = [id];
    let idx = 2;
    let variantFilter = "";

    if (variant_id) {
      variantFilter = `AND sl.variant_id = $${idx++}`;
      params.push(variant_id);
    }

    params.push(limit, offset);

    const result = await db.query(`
      SELECT
        sl.id,
        sl.movement_type,
        sl.qty_delta,
        sl.qty_before,
        sl.qty_after,
        sl.reference_id,
        sl.reference_type,
        sl.notes,
        sl.created_at,
        sl.variant_id,
        u.name AS created_by_name,
        (
          SELECT json_agg(
            json_build_object(
              'type',          at.name,
              'display_value', COALESCE(av.display_value, av.value),
              'hex_color',     av.hex_color
            ) ORDER BY at.id
          )
          FROM variant_attribute_values vav
          JOIN attribute_values av ON av.id = vav.attribute_value_id
          JOIN attribute_types  at ON at.id = av.attribute_type_id
          WHERE vav.variant_id = sl.variant_id
        ) AS variant_attrs
      FROM stock_ledger sl
      LEFT JOIN users u ON u.id = sl.created_by
      WHERE sl.product_id = $1
        ${variantFilter}
      ORDER BY sl.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const countParams = [id];
    let ci = 2;
    let cvf = "";
    if (variant_id) { cvf = `AND variant_id = $${ci++}`; countParams.push(variant_id); }
    const countRes = await db.query(
      `SELECT COUNT(*) FROM stock_ledger WHERE product_id = $1 ${cvf}`, countParams
    );

    res.json({
      success: true,
      data: result.rows,
      total: Number(countRes.rows[0].count),
      limit,
      offset,
    });
  } catch (error) {
    console.error("[GET LEDGER ERROR]", error.message, error.stack);
    res.status(500).json({ success: false, message: "Error al obtener movimientos de stock" });
  }
};

// ─────────────────────────────────────────────
// POST /products
// ─────────────────────────────────────────────
exports.create = async (req, res) => {
  const client = await db.connect();
  try {
    const { name, sale_price, stock = 0, category_id, description, has_variants = false,
            default_supplier_id, supplier_lead_time_days, supplier_cost_estimate } = req.body;
    const images = Array.isArray(req.files) ? req.files : [];

    const validation = validateProductData(req.body);
    if (!validation.isValid)
      return res.status(400).json({ success: false, message: validation.errors.join(", ") });

    if (images.length === 0 && !(has_variants === "true" || has_variants === true))
      return res.status(400).json({ success: false, message: "Sube al menos una imagen" });

    const { isSuperAdmin, adminId } = req;
    const ownerAdminId = isSuperAdmin ? null : adminId;

    await client.query("BEGIN");

    if (Number(stock) > 0) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(400).json({
        success: false,
        message: "Crea el producto con stock=0 y luego usa POST /inventory/initial-stock para registrar el stock inicial con su entrada en el ledger.",
        code: "USE_INITIAL_STOCK_ENDPOINT",
      });
    }

    const productResult = await client.query(
      `INSERT INTO products
         (name, sale_price, stock, category_id, description, owner_admin_id, created_by,
          default_supplier_id, supplier_lead_time_days, supplier_cost_estimate)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [name.trim(), Number(sale_price), category_id,
       description?.trim() || null, ownerAdminId, req.user.id,
       default_supplier_id || null,
       supplier_lead_time_days ? Number(supplier_lead_time_days) : null,
       supplier_cost_estimate  ? Number(supplier_cost_estimate)  : null]
    );
    const productId = productResult.rows[0].id;

    if (has_variants === "true" || has_variants === true) {
      await client.query("UPDATE products SET has_variants = true WHERE id = $1", [productId]);
    }

    for (let i = 0; i < images.length; i++) {
      await client.query(
        `INSERT INTO product_images (product_id, url, is_main, display_order)
         VALUES ($1, $2, $3, $4)`,
        [productId, images[i].path || images[i].secure_url, i === 0, i]
      );
    }

    await client.query("COMMIT");

    try {
      const fullProduct = await fetchFullProduct(productId);
      emitDataUpdate("products", "created", { id: productId, product: fullProduct }, req.adminId);
    } catch (emitErr) {
      console.warn("[Socket] emit fallback:", emitErr.message);
      emitDataUpdate("products", "created", { id: productId, product: null }, req.adminId);
    }

    res.status(201).json({ success: true, message: "Producto creado correctamente", data: { id: productId } });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[CREATE PRODUCT ERROR]", error.message, error.stack);
    if (error.code === "23503")
      return res.status(400).json({ success: false, message: "Categoría no existe" });
    res.status(500).json({ success: false, message: "Error al crear producto" });
  } finally { client.release(); }
};

// ─────────────────────────────────────────────
// PUT /products/:id
// ─────────────────────────────────────────────
exports.update = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { name, sale_price, stock, category_id, description, deleted_image_ids,
            default_supplier_id, supplier_lead_time_days, supplier_cost_estimate } = req.body;
    const newImages = req.files || [];

    if (!id || isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });

    const validation = validateProductData(req.body, true);
    if (!validation.isValid)
      return res.status(400).json({ success: false, message: validation.errors.join(", ") });

    await client.query("BEGIN");

    const { isSuperAdmin, adminId } = req;

    if (!isSuperAdmin) {
      const owned = await assertOwnership(client, "products", id, adminId, "owner_admin_id");
      if (!owned) {
        await client.query("ROLLBACK");
        const exists = (await client.query("SELECT id FROM products WHERE id = $1", [id])).rowCount;
        return exists
          ? res.status(403).json({ success: false, message: "No autorizado para modificar este producto" })
          : res.status(404).json({ success: false, message: "Producto no encontrado" });
      }
    } else {
      const exists = (await client.query("SELECT id FROM products WHERE id = $1", [id])).rowCount;
      if (!exists) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Producto no encontrado" });
      }
    }

    const currentImages = (
      await client.query("SELECT id, url FROM product_images WHERE product_id = $1", [id])
    ).rows;

    let idsToDelete = [];
    if (deleted_image_ids) {
      try {
        idsToDelete = Array.isArray(deleted_image_ids)
          ? deleted_image_ids
          : JSON.parse(deleted_image_ids);
      } catch {
        return res.status(400).json({ success: false, message: "deleted_image_ids inválido" });
      }
    }

    const remaining = currentImages.filter(
      img => !idsToDelete.includes(img.id.toString()) && !idsToDelete.includes(img.id)
    ).length;

    if (remaining + newImages.length < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "El producto debe tener al menos una imagen" });
    }

    await client.query(
      `UPDATE products
       SET name                    = COALESCE($1, name),
           sale_price              = COALESCE($2, sale_price),
           stock                   = COALESCE($3, stock),
           category_id             = COALESCE($4, category_id),
           description             = $5,
           default_supplier_id     = COALESCE($7, default_supplier_id),
           supplier_lead_time_days = COALESCE($8, supplier_lead_time_days),
           supplier_cost_estimate  = COALESCE($9, supplier_cost_estimate),
           updated_at              = NOW()
       WHERE id = $6`,
      [name?.trim() || null, sale_price !== undefined ? Number(sale_price) : null,
       stock !== undefined ? Number(stock) : null, category_id || null,
       description?.trim() ?? null, id,
       default_supplier_id || null,
       supplier_lead_time_days ? Number(supplier_lead_time_days) : null,
       supplier_cost_estimate  ? Number(supplier_cost_estimate)  : null]
    );

    for (const img of currentImages.filter(
      img => idsToDelete.includes(img.id.toString()) || idsToDelete.includes(img.id)
    )) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) { try { await cloudinary.uploader.destroy(publicId); } catch {} }
      await client.query("DELETE FROM product_images WHERE id = $1", [img.id]);
    }

    if (newImages.length > 0) {
      const maxOrder = (
        await client.query(
          "SELECT COALESCE(MAX(display_order), -1) AS m FROM product_images WHERE product_id = $1", [id]
        )
      ).rows[0].m;

      for (let i = 0; i < newImages.length; i++) {
        await client.query(
          `INSERT INTO product_images (product_id, url, is_main, display_order)
           VALUES ($1, $2, $3, $4)`,
          [id, newImages[i].path || newImages[i].secure_url, remaining === 0 && i === 0, maxOrder + 1 + i]
        );
      }
    }

    const hasMain = await client.query(
      "SELECT id FROM product_images WHERE product_id = $1 AND is_main = true LIMIT 1", [id]
    );
    if (!hasMain.rowCount) {
      await client.query(
        `UPDATE product_images SET is_main = true
         WHERE id = (SELECT id FROM product_images WHERE product_id = $1 ORDER BY display_order LIMIT 1)`,
        [id]
      );
    }

    await client.query("COMMIT");

    try {
      const fullProduct = await fetchFullProduct(parseInt(id));
      emitDataUpdate("products", "updated", { id: parseInt(id), product: fullProduct }, req.adminId);
    } catch (emitErr) {
      console.warn("[Socket] emit fallback:", emitErr.message);
      emitDataUpdate("products", "updated", { id: parseInt(id), product: null }, req.adminId);
    }

    res.json({ success: true, message: "Producto actualizado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE PRODUCT ERROR]", error.message, error.stack);
    if (error.code === "23503")
      return res.status(400).json({ success: false, message: "Categoría no existe" });
    res.status(500).json({ success: false, message: "Error al actualizar producto" });
  } finally { client.release(); }
};

// ─────────────────────────────────────────────
// DELETE /products/:id
//   Estrategia:
//   1. Verifica ownership.
//   2. Detecta "blockers duros" (ventas, compras, facturas, bundles, reservas activas).
//      Si los hay → SOFT DELETE (is_active = false) y avisa al usuario.
//   3. Si no hay blockers → limpia referencias blandas (ledger, expenses iniciales,
//      historial de precios, alertas, reservas viejas) y hace HARD DELETE.
//   Soporta query param ?force=soft para forzar soft delete explícitamente.
// ─────────────────────────────────────────────
exports.remove = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const forceSoft = req.query.force === "soft";

    if (!id || isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });

    await client.query("BEGIN");

    const { isSuperAdmin, adminId } = req;

    // 1) Ownership + existencia
    if (!isSuperAdmin) {
      const owned = await assertOwnership(client, "products", id, adminId, "owner_admin_id");
      if (!owned) {
        await client.query("ROLLBACK");
        const exists = (await client.query("SELECT id FROM products WHERE id = $1", [id])).rowCount;
        return exists
          ? res.status(403).json({ success: false, message: "No autorizado para eliminar este producto" })
          : res.status(404).json({ success: false, message: "Producto no encontrado" });
      }
    } else {
      const exists = (await client.query("SELECT id FROM products WHERE id = $1", [id])).rowCount;
      if (!exists) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Producto no encontrado" });
      }
    }

    // 2) Detectar blockers duros
    const blockersRes = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM sale_items           WHERE product_id = $1)::int AS sales,
        (SELECT COUNT(*) FROM purchase_order_items WHERE product_id = $1)::int AS purchases,
        (SELECT COUNT(*) FROM invoice_items        WHERE product_id = $1)::int AS invoices,
        (SELECT COUNT(*) FROM bundle_items         WHERE product_id = $1)::int AS bundles,
        (SELECT COUNT(*) FROM stock_reservations   WHERE product_id = $1 AND status = 'active')::int AS active_reservations
    `, [id]);

    const b = blockersRes.rows[0];
    const hasBlockers =
      b.sales > 0 || b.purchases > 0 || b.invoices > 0 ||
      b.bundles > 0 || b.active_reservations > 0;

    // 3) Si hay blockers o se pidió soft → soft delete
    if (hasBlockers || forceSoft) {
      await client.query(
        "UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1",
        [id]
      );
      await client.query("COMMIT");

      emitDataUpdate("products", "deleted", { id: parseInt(id) }, req.adminId);

      return res.json({
        success: true,
        message: hasBlockers
          ? "Producto desactivado (tiene movimientos asociados y no puede eliminarse permanentemente)"
          : "Producto desactivado correctamente",
        soft_deleted: true,
        blockers: hasBlockers ? b : null,
      });
    }

    // 4) Sin blockers → hard delete: limpiar referencias blandas
    // (estas tablas no tienen ON DELETE CASCADE configurado en el FK del product_id)
    await client.query("DELETE FROM stock_ledger          WHERE product_id = $1", [id]);
    await client.query("DELETE FROM stock_reservations    WHERE product_id = $1", [id]);
    await client.query("DELETE FROM stock_alerts          WHERE product_id = $1", [id]);
    await client.query("DELETE FROM product_price_history WHERE product_id = $1", [id]);
    await client.query(
      "DELETE FROM expenses WHERE product_id = $1 AND expense_type = 'inventory_initial'",
      [id]
    );
    // Otros expenses (compras reales, etc.) NO se borran: rompería contabilidad.
    // Si existen, los marcamos como huérfanos (product_id = NULL).
    await client.query(
      "UPDATE expenses SET product_id = NULL WHERE product_id = $1",
      [id]
    );

    // 5) Borrar imágenes en Cloudinary (las filas en product_images y product_variants
    //    caen solas por ON DELETE CASCADE)
    const imgs = await client.query(
      "SELECT url FROM product_images WHERE product_id = $1", [id]
    );
    for (const img of imgs.rows) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) {
        try { await cloudinary.uploader.destroy(publicId); } catch (e) {
          console.warn("[Cloudinary destroy fail]", publicId, e.message);
        }
      }
    }

    // También imágenes de variantes
    const variantImgs = await client.query(`
      SELECT vi.url FROM variant_images vi
      JOIN product_variants pv ON pv.id = vi.variant_id
      WHERE pv.product_id = $1
    `, [id]);
    for (const img of variantImgs.rows) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) {
        try { await cloudinary.uploader.destroy(publicId); } catch (e) {
          console.warn("[Cloudinary destroy fail]", publicId, e.message);
        }
      }
    }

      
    // 6) Borrar producto 
    await client.query("DELETE FROM products WHERE id = $1", [id]);

    await client.query("COMMIT");

    emitDataUpdate("products", "deleted", { id: parseInt(id) }, req.adminId);
    res.json({
      success: true,
      message: "Producto eliminado permanentemente",
      soft_deleted: false,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE PRODUCT ERROR]",
      error.message,
      "| code:", error.code,
      "| constraint:", error.constraint,
      "| table:", error.table,
      "| detail:", error.detail
    );

    if (error.code === "23503") {
      return res.status(400).json({
        success: false,
        message: `No se puede eliminar: el producto está referenciado en "${error.table || 'otra tabla'}". Intenta desactivarlo en su lugar.`,
        detail: error.detail || null,
        constraint: error.constraint || null,
        suggestion: "soft_delete",
      });
    }

    res.status(500).json({ success: false, message: "Error al eliminar producto" });
  } finally { client.release(); }
};