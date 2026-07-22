// src/controllers/variants.controller.js
const db = require("../config/db");
const cloudinary = require("../config/cloudinary");
const { emitDataUpdate } = require("../config/socket");
const inv = require("../services/inventory.service");

// ─── Helper: obtener variantes completas de un producto ──────────────────────
const getVariantsForProduct = async (productId) => {
  const result = await db.query(`
    WITH stock_per_variant AS (
      SELECT variant_id, disponible_inmediato
      FROM v_stock_disponible
      WHERE product_id = $1 AND variant_id IS NOT NULL
    ),
    product_mode AS (
      SELECT fulfillment_mode FROM products WHERE id = $1
    )
    SELECT
      pv.id, pv.product_id, pv.sku, pv.sale_price, pv.stock, pv.is_active,
      pv.created_at, pv.updated_at,
      COALESCE(spv.disponible_inmediato, 0) AS disponible_inmediato,
      (pm.fulfillment_mode != 'stock' OR COALESCE(spv.disponible_inmediato, 0) > 0) AS is_sellable,
      COALESCE(
        json_agg(
          json_build_object(
            'attribute_type',  at.name,
            'attribute_slug',  at.slug,
            'attribute_icon',  at.icon,
            'value',           av.value,
            'display_value',   COALESCE(av.display_value, av.value),
            'hex_color',       av.hex_color,
            'attribute_value_id', av.id
          ) ORDER BY at.id, av.sort_order
        ) FILTER (WHERE av.id IS NOT NULL),
        '[]'
      ) AS attributes,
      (
        SELECT json_agg(json_build_object('id', vi.id, 'url', vi.url, 'is_main', vi.is_main)
                        ORDER BY vi.is_main DESC, vi.display_order)
        FROM variant_images vi WHERE vi.variant_id = pv.id
      ) AS images
    FROM product_variants pv
    CROSS JOIN product_mode pm
    LEFT JOIN stock_per_variant spv ON spv.variant_id = pv.id
    LEFT JOIN variant_attribute_values vav ON vav.variant_id = pv.id
    LEFT JOIN attribute_values av  ON av.id  = vav.attribute_value_id
    LEFT JOIN attribute_types  at  ON at.id  = av.attribute_type_id
    WHERE pv.product_id = $1
    GROUP BY pv.id, spv.disponible_inmediato, pm.fulfillment_mode
    ORDER BY pv.id
  `, [productId]);
  return result.rows;
};
// GET /products/:productId/variants
exports.list = async (req, res) => {
  try {
    const variants = await getVariantsForProduct(req.params.productId);
    res.json({ success: true, data: variants });
  } catch (e) {
    console.error("[VARIANTS LIST]", e);
    res.status(500).json({ success: false, message: "Error al obtener variantes" });
  }
};

// POST /products/:productId/variants
// body: { sku?, sale_price?, stock, attribute_value_ids: [1,3,5] }
exports.create = async (req, res) => {
  const { productId } = req.params;
  const { sku, sale_price, stock = 0, attribute_value_ids = [] } = req.body;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Always insert with stock=0; initial stock goes through inventory service below
    const vRes = await client.query(
      `INSERT INTO product_variants (product_id, sku, sale_price, stock)
       VALUES ($1, $2, $3, 0) RETURNING id`,
      [productId, sku || null, sale_price || null]
    );
    const variantId = vRes.rows[0].id;

    for (const avId of attribute_value_ids) {
      await client.query(
        `INSERT INTO variant_attribute_values (variant_id, attribute_value_id) VALUES ($1, $2)`,
        [variantId, avId]
      );
    }

    await client.query(
      `UPDATE products SET has_variants = true WHERE id = $1`,
      [productId]
    );

    await client.query("COMMIT");

    // Route initial stock through inventory service so ledger is written
    if (Number(stock) > 0) {
      const { rows: [prod] } = await db.query(
        `SELECT owner_admin_id FROM products WHERE id = $1`, [productId]
      );
      await inv.registerInitialStock(
        {
          productId: parseInt(productId),
          variantId,
          quantity: Number(stock),
          purchasePrice: null,
          reason: 'Stock inicial de variante',
        },
        { ownerAdminId: prod?.owner_admin_id ?? req.adminId, userId: req.user?.id ?? 0 },
      );
    }

    const [variant] = await getVariantsForProduct(productId)
      .then(arr => arr.filter(v => v.id === variantId));
    emitDataUpdate("products", "updated", { id: parseInt(productId), variant_created: variantId }, req.adminId);
    res.status(201).json({ success: true, data: variant });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[VARIANT CREATE]", e);
    if (e.code === '23505') return res.status(400).json({ success: false, message: "SKU duplicado" });
    res.status(500).json({ success: false, message: "Error al crear variante" });
  } finally { client.release(); }
};

// PUT /products/:productId/variants/:variantId
exports.update = async (req, res) => {
  const { variantId } = req.params;
  const { sku, sale_price, stock, is_active, attribute_value_ids } = req.body;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Read current stock before updating (needed for delta calculation)
    let currentStock = null;
    if (stock !== undefined) {
      const { rows: [cur] } = await client.query(
        `SELECT stock FROM product_variants WHERE id = $1`, [variantId]
      );
      currentStock = cur ? Number(cur.stock) : 0;
    }

    // Update metadata only — stock mutations go through inventory service
    await client.query(
      `UPDATE product_variants SET sku=$1, sale_price=$2, is_active=$3, updated_at=NOW()
       WHERE id=$4`,
      [sku || null, sale_price || null, is_active ?? true, variantId]
    );

    if (Array.isArray(attribute_value_ids)) {
      await client.query(`DELETE FROM variant_attribute_values WHERE variant_id = $1`, [variantId]);
      for (const avId of attribute_value_ids) {
        await client.query(
          `INSERT INTO variant_attribute_values (variant_id, attribute_value_id) VALUES ($1, $2)`,
          [variantId, avId]
        );
      }
    }

    await client.query("COMMIT");

    // Route stock change through inventory service so ledger is written and locks are respected
    if (stock !== undefined && currentStock !== null && Number(stock) !== currentStock) {
      const delta = Number(stock) - currentStock;
      const { rows: [vp] } = await db.query(
        `SELECT p.owner_admin_id, pv.product_id
         FROM product_variants pv JOIN products p ON p.id = pv.product_id
         WHERE pv.id = $1`,
        [variantId]
      );
      await inv.manualAdjustment(
        {
          productId: vp.product_id,
          variantId: parseInt(variantId),
          delta,
          reason: 'Ajuste desde edición de variante',
        },
        { ownerAdminId: vp.owner_admin_id ?? req.adminId, userId: req.user?.id ?? 0 },
      );
    }

    emitDataUpdate("products", "updated", { variant_updated: parseInt(variantId) }, req.adminId);
    res.json({ success: true, message: "Variante actualizada" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[VARIANT UPDATE]", e);
    res.status(500).json({ success: false, message: "Error al actualizar variante" });
  } finally { client.release(); }
};

// DELETE /products/:productId/variants/:variantId
exports.remove = async (req, res) => {
  const { productId, variantId } = req.params;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Eliminar imágenes de Cloudinary
    const imgs = await client.query(`SELECT url FROM variant_images WHERE variant_id=$1`, [variantId]);
    for (const img of imgs.rows) {
      const parts = img.url.split('/upload/');
      if (parts[1]) {
        const publicId = parts[1].split('/').filter(p => !p.startsWith('v')).join('/').replace(/\.[^/.]+$/, '');
        try { await cloudinary.uploader.destroy(publicId); } catch {}
      }
    }

    await client.query(`DELETE FROM product_variants WHERE id=$1`, [variantId]);

    // Si no quedan variantes, desactivar has_variants
    const remaining = await client.query(
      `SELECT COUNT(*) FROM product_variants WHERE product_id=$1`, [productId]
    );
    if (parseInt(remaining.rows[0].count) === 0) {
      await client.query(`UPDATE products SET has_variants=false WHERE id=$1`, [productId]);
    }

    await client.query("COMMIT");
    emitDataUpdate("products", "updated", { id: parseInt(productId), variant_deleted: parseInt(variantId) }, req.adminId);
    res.json({ success: true, message: "Variante eliminada" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[VARIANT DELETE]", e);
    res.status(500).json({ success: false, message: "Error al eliminar variante" });
  } finally { client.release(); }
};

// GET /attributes — tipos + valores para el selector
exports.getAttributeTypes = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT at.*, COALESCE(json_agg(
        json_build_object('id',av.id,'value',av.value,'display_value',COALESCE(av.display_value,av.value),'hex_color',av.hex_color,'sort_order',av.sort_order)
        ORDER BY av.sort_order
      ) FILTER (WHERE av.id IS NOT NULL), '[]') AS values
      FROM attribute_types at
      LEFT JOIN attribute_values av ON av.attribute_type_id = at.id
      GROUP BY at.id ORDER BY at.id
    `);
    res.json({ success: true, data: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, message: "Error al obtener atributos" });
  }
};

// POST /attributes/:typeId/values  — crear valor de atributo
exports.createAttributeValue = async (req, res) => {
  const { typeId } = req.params;
  const { value, display_value, hex_color, sort_order } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO attribute_values (attribute_type_id, value, display_value, hex_color, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [typeId, value, display_value || null, hex_color || null, sort_order || 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: "Error al crear valor" });
  }
};

// POST /products/:productId/variants/:variantId/images
exports.uploadVariantImages = async (req, res) => {
  const { variantId, productId } = req.params;
  const files = req.files || [];

  if (!files.length)
    return res.status(400).json({ success: false, message: "Sube al menos una imagen" });

  try {
    // Verificar que la variante pertenece al producto
    const { rowCount } = await db.query(
      "SELECT id FROM product_variants WHERE id = $1 AND product_id = $2",
      [variantId, productId]
    );
    if (!rowCount)
      return res.status(404).json({ success: false, message: "Variante no encontrada" });

    const maxOrder = (
      await db.query(
        "SELECT COALESCE(MAX(display_order), -1) AS m FROM variant_images WHERE variant_id = $1",
        [variantId]
      )
    ).rows[0].m;

    const hasMain = (
      await db.query(
        "SELECT id FROM variant_images WHERE variant_id = $1 AND is_main = true LIMIT 1",
        [variantId]
      )
    ).rowCount > 0;

    const inserted = [];
    for (let i = 0; i < files.length; i++) {
      const url = files[i].path || files[i].secure_url;
      const isMain = !hasMain && i === 0;
      const { rows } = await db.query(
        `INSERT INTO variant_images (variant_id, url, is_main, display_order)
         VALUES ($1, $2, $3, $4) RETURNING id, url, is_main`,
        [variantId, url, isMain, maxOrder + 1 + i]
      );
      inserted.push(rows[0]);
    }

    res.status(201).json({ success: true, data: inserted });
  } catch (e) {
    console.error("[VARIANT IMAGES UPLOAD]", e);
    res.status(500).json({ success: false, message: "Error al subir imágenes de variante" });
  }
};

// DELETE /products/:productId/variants/:variantId/images/:imageId
exports.deleteVariantImage = async (req, res) => {
  const { variantId, imageId, productId } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT vi.id, vi.url, vi.is_main
       FROM variant_images vi
       JOIN product_variants pv ON pv.id = vi.variant_id
       WHERE vi.id = $1 AND vi.variant_id = $2 AND pv.product_id = $3`,
      [imageId, variantId, productId]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: "Imagen no encontrada" });

    const img = rows[0];

    // Eliminar de Cloudinary
    const parts = img.url.split("/upload/");
    if (parts[1]) {
      const publicId = parts[1]
        .split("/").filter(p => !p.startsWith("v")).join("/")
        .replace(/\.[^/.]+$/, "");
      try { await cloudinary.uploader.destroy(publicId); } catch {}
    }

    await db.query("DELETE FROM variant_images WHERE id = $1", [imageId]);

    // Si era la principal, promover la siguiente
    if (img.is_main) {
      await db.query(
        `UPDATE variant_images SET is_main = true
         WHERE id = (
           SELECT id FROM variant_images WHERE variant_id = $1
           ORDER BY display_order LIMIT 1
         )`,
        [variantId]
      );
    }

    res.json({ success: true, message: "Imagen eliminada" });
  } catch (e) {
    console.error("[VARIANT IMAGE DELETE]", e);
    res.status(500).json({ success: false, message: "Error al eliminar imagen" });
  }
};