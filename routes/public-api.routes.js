// routes/public-api.routes.js
const express        = require("express");
const router         = express.Router();
const db             = require("../config/db");
const {
  apiKeyAuth,
  requireApiPermission,
  auth,
  checkRateLimit,
} = require("../middleware/auth.middleware");
const storefrontAuth  = require("../controllers/storefront.auth.controller");
const reviewsCtrl     = require("../controllers/reviews.controller");
const wompiCtrl       = require("../controllers/wompi.controller");
const analyticsCtrl   = require("../controllers/analytics.controller");
const inv                   = require("../services/inventory.service");
const procurement           = require("../services/procurement.service");
const { notifyTenant, Payloads } = require("../services/push.service");
const { enqueueNotification }    = require("../services/notification.service");
const { createUpload }      = require("../middleware/upload.middleware");

router.use(apiKeyAuth);

// GET /public-api/v1/ping
router.get("/ping", (req, res) => {
  res.json({
    success:     true,
    message:     "API Key válida y activa",
    api_key:     req.apiKey.name,
    permissions: req.apiKey.permissions,
    timestamp:   new Date().toISOString(),
  });
});

// POST /public-api/v1/analytics/pageview
router.post("/analytics/pageview", analyticsCtrl.trackPageview);

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/profile
// ─────────────────────────────────────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         ap.business_name, ap.tagline, ap.description,
         ap.logo_url, ap.favicon_url,
         ap.primary_color, ap.secondary_color, ap.accent_color,
         ap.business_email, ap.business_phone, ap.website,
         ap.address, ap.city, ap.department, ap.country,
         ap.currency, ap.social_links,
         ap.store_navbar_bg, ap.store_navbar_text, ap.store_page_bg, ap.store_font
       FROM admin_profiles ap
       WHERE ap.user_id = $1`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows[0] ?? null });
  } catch (error) {
    console.error("[PUBLIC API] GET /profile", error);
    res.status(500).json({ success: false, message: "Error al obtener el perfil del negocio" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/products
// Incluye LATERAL JOIN para precio final con descuentos de scope 'web' o 'all'
// ─────────────────────────────────────────────────────────────────────────────
router.get("/products", requireApiPermission("products:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const { search, page = 1, limit = 20, sort = "name" } = req.query;
    const category = req.query.category || req.query.categoria;
    const safeLimit = Math.min(parseInt(limit) || 20, 100);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where = "WHERE p.is_active = true AND p.owner_admin_id = $1";

    if (category) {
      const { rows: catRows } = await db.query(
        `WITH RECURSIVE cat_tree AS (
           SELECT id FROM categories WHERE slug = $1 AND owner_admin_id = $2 AND is_active = true
           UNION ALL
           SELECT c.id FROM categories c
           JOIN cat_tree ct ON c.parent_id = ct.id
           WHERE c.is_active = true AND c.owner_admin_id = $2
         )
         SELECT id FROM cat_tree`,
        [category, adminId]
      );
      if (catRows.length === 0) {
        return res.json({ success: true, data: [], meta: { total: 0, page: parseInt(page), limit: safeLimit, pages: 0 } });
      }
      params.push(catRows.map(r => Number(r.id)));
      where += ` AND p.category_id = ANY($${params.length})`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
    }

    const orderMap = {
      name:       "p.name ASC",
      price_asc:  "p.sale_price ASC",
      price_desc: "p.sale_price DESC",
      newest:     "p.created_at DESC",
    };
    const orderBy = orderMap[sort] || "p.name ASC";

    params.push(safeLimit, offset);

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT
           p.id, p.name, p.sku, p.description,
           p.sale_price,
           p.sale_price AS price,
           p.stock,
           p.has_variants,
           p.fulfillment_mode,
           p.supplier_lead_time_days,
           CASE
             WHEN p.fulfillment_mode = 'on_demand' THEN 'normal'
             WHEN p.stock <= 0           THEN 'out'
             WHEN p.stock <= p.min_stock THEN 'low'
             ELSE 'normal'
           END AS stock_status,
           c.name AS category, c.name AS category_name, c.slug AS category_slug,
           (SELECT url FROM product_images
            WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
           COALESCE(
             json_agg(
               DISTINCT jsonb_build_object('url', pi.url, 'is_main', pi.is_main)
             ) FILTER (WHERE pi.id IS NOT NULL), '[]'
           ) AS images,
           COALESCE(
             (SELECT json_agg(DISTINCT jsonb_build_object(
               'variant_id',     pv.id,
               'attribute_slug', at.slug,
               'value',          av.value,
               'display_value',  COALESCE(av.display_value, av.value),
               'hex_color',      av.hex_color,
               'main_image',     (
                 SELECT vi.url FROM variant_images vi
                 WHERE vi.variant_id = pv.id AND vi.is_main = true LIMIT 1
               )
             ))
             FROM product_variants pv
             JOIN variant_attribute_values vav ON vav.variant_id = pv.id
             JOIN attribute_values av ON av.id = vav.attribute_value_id
             JOIN attribute_types  at ON at.id = av.attribute_type_id
             WHERE pv.product_id = p.id AND pv.is_active = true AND pv.stock > 0),
             '[]'
           ) AS variant_swatches,
           best_discount.type  AS discount_type,
           best_discount.value AS discount_value,
           COALESCE(best_discount.final_price, p.sale_price) AS final_price
         FROM products p
         LEFT JOIN categories c      ON c.id = p.category_id
         LEFT JOIN product_images pi ON pi.product_id = p.id
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
             AND (d.scope = 'web' OR d.scope = 'all')
           ORDER BY final_price ASC
           LIMIT 1
         ) best_discount ON true
         ${where}
         GROUP BY p.id, p.name, p.sku, p.description, p.sale_price,
                  p.stock, p.min_stock, p.has_variants, p.fulfillment_mode,
                  p.supplier_lead_time_days, c.name, c.slug,
                  p.created_at, p.owner_admin_id,
                  best_discount.type, best_discount.value, best_discount.final_price
         ORDER BY ${orderBy}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         ${where}`,
        params.slice(0, -2)
      ),
    ]);

    const total = parseInt(countRow.rows[0].count);

    return res.json({
      success: true,
      data:    rows.rows,
      meta: {
        total,
        page:  parseInt(page),
        limit: safeLimit,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    console.error("[PUBLIC API] GET /products", error);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/products/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/products/:id", requireApiPermission("products:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku, p.description,
         p.sale_price,
         p.sale_price AS price,
         p.stock,
         p.has_variants,
         p.fulfillment_mode,
         p.supplier_lead_time_days,
         CASE
           WHEN p.fulfillment_mode = 'on_demand' THEN 'normal'
           WHEN p.stock <= 0           THEN 'out'
           WHEN p.stock <= p.min_stock THEN 'low'
           ELSE 'normal'
         END AS stock_status,
         c.name AS category,
         c.name AS category_name,
         c.slug AS category_slug,
         (SELECT url FROM product_images
          WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
         COALESCE(
           (SELECT json_agg(jsonb_build_object('url', pi.url, 'is_main', pi.is_main))
            FROM product_images pi WHERE pi.product_id = p.id),
           '[]'
         ) AS images,
         COALESCE(
           (SELECT json_agg(
             jsonb_build_object(
               'id',         pv.id,
               'sku',        pv.sku,
               'sale_price', COALESCE(pv.sale_price, p.sale_price),
               'price',      COALESCE(pv.sale_price, p.sale_price),
               'stock',      pv.stock,
               'is_active',  pv.is_active,
               'attributes', (
                 SELECT COALESCE(json_agg(
                   jsonb_build_object(
                     'type',               at.name,
                     'slug',               at.slug,
                     'icon',               at.icon,
                     'value',              av.value,
                     'display_value',      COALESCE(av.display_value, av.value),
                     'hex_color',          av.hex_color,
                     'attribute_value_id', av.id
                   ) ORDER BY at.id, av.sort_order
                 ), '[]'::json)
                 FROM variant_attribute_values vav
                 JOIN attribute_values av ON av.id = vav.attribute_value_id
                 JOIN attribute_types  at ON at.id = av.attribute_type_id
                 WHERE vav.variant_id = pv.id
               ),
               'images', (
                 SELECT COALESCE(json_agg(
                   jsonb_build_object('id', vi.id, 'url', vi.url, 'is_main', vi.is_main)
                   ORDER BY vi.is_main DESC, vi.display_order
                 ), '[]'::json)
                 FROM variant_images vi WHERE vi.variant_id = pv.id
               )
             )
           )
           FROM product_variants pv
           WHERE pv.product_id = p.id AND pv.is_active = true),
           '[]'
         ) AS variants,
         d.name  AS discount_name,
         d.type  AS discount_type,
         d.value AS discount_value,
         CASE
           WHEN d.type = 'percentage'
             THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
           WHEN d.type = 'fixed' THEN p.sale_price - d.value
           ELSE p.sale_price
         END AS final_price
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN discount_targets dt ON (
         (dt.target_type = 'product'  AND dt.target_id = p.id::text) OR
         (dt.target_type = 'category' AND dt.target_id = p.category_id::text
          AND p.category_id IS NOT NULL)
       )
       LEFT JOIN discounts d
         ON dt.discount_id = d.id
         AND d.active = true
         AND NOW() BETWEEN d.starts_at AND d.ends_at
         AND (d.scope = 'web' OR d.scope = 'all')
       WHERE p.id = $1
         AND p.is_active = true
         AND p.owner_admin_id = $2
       LIMIT 1`,
      [req.params.id, adminId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("[PUBLIC API] GET /products/:id", error);
    res.status(500).json({ success: false, message: "Error al obtener producto" });
  }
});

// GET /public-api/v1/categories
router.get("/categories", requireApiPermission("categories:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         c.id, c.name, c.slug, c.description, c.image_url, c.parent_id,
         COUNT(p.id) FILTER (WHERE p.is_active = true)::int AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.owner_admin_id = $1
       WHERE c.is_active = true
         AND c.owner_admin_id = $1
       GROUP BY c.id, c.name, c.slug, c.description, c.image_url, c.parent_id
       ORDER BY c.name`,
      [adminId]
    );

    const rows = result.rows.map(r => ({
      ...r,
      id:        Number(r.id),
      parent_id: r.parent_id != null ? Number(r.parent_id) : null,
    }));

    const buildTree = (items, parentId = null) =>
      items
        .filter(i => i.parent_id === parentId)
        .map(i => ({ ...i, children: buildTree(items, i.id) }));

    return res.json({ success: true, data: buildTree(rows) });
  } catch (error) {
    console.error("[PUBLIC API] GET /categories", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías" });
  }
});

// GET /public-api/v1/inventory
router.get("/inventory", requireApiPermission("inventory:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const { low_stock } = req.query;

    let where = "WHERE p.is_active = true AND p.owner_admin_id = $1";
    if (low_stock === "true") where += " AND p.stock <= p.min_stock";

    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku,
         p.stock, p.min_stock, p.max_stock,
         CASE
           WHEN p.stock <= 0           THEN 'out'
           WHEN p.stock <= p.min_stock THEN 'low'
           ELSE 'normal'
         END AS stock_status,
         c.name AS category
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}
       ORDER BY p.stock ASC`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /inventory", error);
    res.status(500).json({ success: false, message: "Error al obtener inventario" });
  }
});

// GET /public-api/v1/banners
router.get("/banners", async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT id, title, description, image_url, button_text, button_link, display_order, is_active
       FROM banners
       WHERE is_active = true
         AND created_by = $1
       ORDER BY display_order ASC`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /banners", error);
    res.status(500).json({ success: false, message: "Error al obtener banners" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/discounts
// Solo retorna descuentos con scope 'web' o 'all', activos y vigentes.
// Incluye targets para que el frontend pueda aplicar descuentos por producto/categoría.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/discounts", async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const now     = new Date();

    const result = await db.query(
      `SELECT
         d.id, d.name, d.code, d.type, d.value, d.scope,
         d.min_purchase_amount, d.max_discount_amount,
         d.starts_at, d.ends_at,
         d.usage_limit, d.times_used,
         d.description,
         COALESCE(
           (SELECT json_agg(json_build_object(
             'target_type', dt.target_type,
             'target_id',   dt.target_id
           ))
           FROM discount_targets dt
           WHERE dt.discount_id = d.id),
           '[]'
         ) AS targets
       FROM discounts d
       WHERE d.active = true
         AND d.owner_admin_id = $1
         AND d.starts_at <= $2
         AND d.ends_at   >= $2
         AND (d.scope = 'web' OR d.scope = 'all')
         AND (d.usage_limit IS NULL OR d.times_used < d.usage_limit)
       ORDER BY d.ends_at ASC`,
      [adminId, now]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /discounts", error);
    res.status(500).json({ success: false, message: "Error al obtener descuentos" });
  }
});

// POST /public-api/v1/discounts/validate
router.post("/discounts/validate", async (req, res) => {
  try {
    const adminId          = req.apiKey.adminId;
    const { code, amount } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, message: "Código requerido" });
    }

    const now = new Date();

    const result = await db.query(
      `SELECT
         id, name, code, type, value,
         min_purchase_amount, max_discount_amount,
         usage_limit, times_used
       FROM discounts
       WHERE code = $1
         AND owner_admin_id = $2
         AND active = true
         AND starts_at <= $3
         AND ends_at   >= $3
         AND (scope = 'web' OR scope = 'all')
         AND (usage_limit IS NULL OR times_used < usage_limit)`,
      [code.toUpperCase().trim(), adminId, now]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Cupón inválido, expirado o no disponible",
        code:    "INVALID_COUPON",
      });
    }

    const discount = result.rows[0];

    if (amount && parseFloat(amount) < parseFloat(discount.min_purchase_amount)) {
      return res.status(400).json({
        success: false,
        message: `Compra mínima requerida: $${discount.min_purchase_amount}`,
        code:    "MIN_PURCHASE_NOT_MET",
      });
    }

    let discountAmount = 0;
    if (discount.type === "percentage") {
      discountAmount = (parseFloat(amount || 0) * discount.value) / 100;
      if (discount.max_discount_amount) {
        discountAmount = Math.min(discountAmount, parseFloat(discount.max_discount_amount));
      }
    } else {
      discountAmount = parseFloat(discount.value);
    }

    return res.json({
      success: true,
      data: {
        ...discount,
        discount_amount: parseFloat(discountAmount.toFixed(2)),
        final_amount:    parseFloat((parseFloat(amount || 0) - discountAmount).toFixed(2)),
      },
    });
  } catch (error) {
    console.error("[PUBLIC API] POST /discounts/validate", error);
    res.status(500).json({ success: false, message: "Error al validar cupón" });
  }
});

// GET /public-api/v1/sales
router.get("/sales", requireApiPermission("sales:read"), async (req, res) => {
  try {
    const adminId                           = req.apiKey.adminId;
    const { page = 1, limit = 20, status } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 50);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where    = "WHERE s.owner_admin_id = $1";

    if (status) {
      params.push(status);
      where += ` AND s.payment_status = $${params.length}`;
    }

    params.push(safeLimit, offset);

    const result = await db.query(
      `SELECT
         s.id, s.sale_number, s.sale_date,
         s.subtotal, s.discount_amount, s.total,
         s.payment_method, s.payment_status, s.sale_type,
         s.shipping_address, s.customer_phone,
         COUNT(si.id)::int                  AS items_count,
         COALESCE(SUM(si.quantity), 0)::int AS units_total
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       ${where}
       GROUP BY s.id
       ORDER BY s.sale_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data:    result.rows,
      meta: { page: parseInt(page), limit: safeLimit },
    });
  } catch (error) {
    console.error("[PUBLIC API] GET /sales", error);
    res.status(500).json({ success: false, message: "Error al obtener ventas" });
  }
});

// POST /public-api/v1/sales
router.post("/sales", requireApiPermission("sales:write"), auth, async (req, res) => {
  const client = await db.connect();
  let clientReleased = false;
  try {
    const adminId = req.apiKey.adminId;
    const {
      items,
      session_id:     sessionId,
      customer_phone,
      shipping_address,
      shipping_city,
      shipping_notes,
      payment_method = "transfer",
      coupon_code,
      discount_id:    reqDiscountId,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Se requiere al menos un item", code: "MISSING_ITEMS" });
    }

    await client.query("BEGIN");

    let subtotal    = 0;
    const saleItems = [];

    for (const item of items) {
      if (!item.product_id || !item.quantity || item.quantity < 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Cada item requiere product_id y quantity válidos", code: "INVALID_ITEM" });
      }

      const productRes = await client.query(
        `SELECT id, name, sale_price, stock, stock_reserved, stock_safety, purchase_price, has_variants, fulfillment_mode
         FROM products
         WHERE id = $1 AND is_active = true AND owner_admin_id = $2`,
        [item.product_id, adminId]
      );

      if (productRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Producto ID ${item.product_id} no encontrado`, code: "PRODUCT_NOT_FOUND" });
      }

      const product = productRes.rows[0];
      let variantId = null;
      let unitPrice = Number(product.sale_price);
      const unitCost = Number(product.purchase_price ?? 0);
      let disponible = Math.max(0, product.stock - product.stock_reserved - (product.stock_safety ?? 0));

      if (product.has_variants) {
        if (!item.variant_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: `"${product.name}" tiene variantes — especifica variant_id`, code: "VARIANT_REQUIRED" });
        }
        const varRes = await client.query(
          `SELECT id, sale_price, stock, stock_reserved, stock_safety
           FROM product_variants WHERE id = $1 AND product_id = $2 AND is_active = true`,
          [item.variant_id, item.product_id]
        );
        if (!varRes.rowCount) {
          await client.query("ROLLBACK");
          return res.status(404).json({ success: false, message: `Variante ${item.variant_id} no encontrada o inactiva`, code: "VARIANT_NOT_FOUND" });
        }
        const variant = varRes.rows[0];
        variantId = variant.id;
        if (variant.sale_price != null) unitPrice = Number(variant.sale_price);
        disponible = Math.max(0, variant.stock - variant.stock_reserved - (variant.stock_safety ?? 0));
      }

      // Hybrid: if physical stock covers the order → stock path, otherwise → procurement
      const fulfillmentSnapshot = disponible >= item.quantity ? 'stock' : 'on_demand';

      const itemSubtotal = unitPrice * item.quantity;
      subtotal += itemSubtotal;
      saleItems.push({
        product_id:       product.id,
        variant_id:       variantId,
        quantity:         item.quantity,
        unit_price:       unitPrice,
        unit_cost:        unitCost,
        subtotal:         itemSubtotal,
        profit_unit:      unitPrice - unitCost,
        total_profit:     (unitPrice - unitCost) * item.quantity,
        fulfillment_mode: fulfillmentSnapshot,
      });
    }

    let discountAmount = 0;
    let discountId     = null;
    const now          = new Date();

    if (coupon_code) {
      const couponRes = await client.query(
        `SELECT id, type, value, min_purchase_amount, max_discount_amount
         FROM discounts
         WHERE code = $1 AND owner_admin_id = $2 AND active = true
           AND starts_at <= $3 AND ends_at >= $3
           AND (scope = 'web' OR scope = 'all')
           AND (usage_limit IS NULL OR times_used < usage_limit)
         FOR UPDATE`,
        [coupon_code.toUpperCase().trim(), adminId, now]
      );

      if (couponRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Cupón inválido o expirado", code: "INVALID_COUPON" });
      }

      const coupon = couponRes.rows[0];

      if (coupon.min_purchase_amount && subtotal < parseFloat(coupon.min_purchase_amount)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Compra mínima requerida: $${coupon.min_purchase_amount}`, code: "MIN_PURCHASE_NOT_MET" });
      }

      if (coupon.type === "percentage") {
        discountAmount = (subtotal * coupon.value) / 100;
        if (coupon.max_discount_amount) discountAmount = Math.min(discountAmount, parseFloat(coupon.max_discount_amount));
      } else {
        discountAmount = parseFloat(coupon.value);
      }
      discountAmount = Math.min(Math.round(discountAmount), subtotal);

      discountId = coupon.id;
      await client.query("UPDATE discounts SET times_used = times_used + 1 WHERE id = $1", [coupon.id]);

    } else if (reqDiscountId) {
      const discountRes = await client.query(
        `SELECT id, type, value, min_purchase_amount, max_discount_amount
         FROM discounts
         WHERE id = $1 AND owner_admin_id = $2 AND active = true
           AND starts_at <= $3 AND ends_at >= $3
           AND (scope = 'web' OR scope = 'all')
           AND (usage_limit IS NULL OR times_used < usage_limit)
         FOR UPDATE`,
        [reqDiscountId, adminId, now]
      );

      if (discountRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Descuento inválido, expirado o no disponible para canal web", code: "INVALID_DISCOUNT" });
      }

      const discount = discountRes.rows[0];

      if (discount.min_purchase_amount && subtotal < parseFloat(discount.min_purchase_amount)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Compra mínima requerida: $${discount.min_purchase_amount}`, code: "MIN_PURCHASE_NOT_MET" });
      }

      if (discount.type === "percentage") {
        discountAmount = (subtotal * discount.value) / 100;
        if (discount.max_discount_amount) discountAmount = Math.min(discountAmount, parseFloat(discount.max_discount_amount));
      } else {
        discountAmount = parseFloat(discount.value);
      }
      discountAmount = Math.min(Math.round(discountAmount), subtotal);

      discountId = discount.id;
      await client.query("UPDATE discounts SET times_used = times_used + 1 WHERE id = $1", [discount.id]);
    }

    const total      = Math.max(0, subtotal - discountAmount);
    const saleNumber = `WEB-${adminId}-${Date.now()}`;

    // MEDIO-1: liberar reservas activas de la sesión dentro de la misma tx
    // para que stock_reserved quede en sync antes del descuento de stock físico.
    if (sessionId) {
      const { rows: releasedRes } = await client.query(
        `DELETE FROM stock_reservations
         WHERE session_id = $1 AND status = 'active' AND owner_admin_id = $2
         RETURNING product_id, variant_id, quantity`,
        [sessionId, adminId]
      );
      for (const r of releasedRes) {
        if (r.variant_id) {
          await client.query(
            `UPDATE product_variants
             SET stock_reserved = GREATEST(0, stock_reserved - $1)
             WHERE id = $2`,
            [r.quantity, r.variant_id]
          );
        } else {
          await client.query(
            `UPDATE products
             SET stock_reserved = GREATEST(0, stock_reserved - $1)
             WHERE id = $2`,
            [r.quantity, r.product_id]
          );
        }
      }
    }

    const saleRes = await client.query(
      `INSERT INTO sales (
         sale_number, subtotal, discount_amount, discount_id, total,
         payment_method, payment_status, sale_type,
         shipping_address, shipping_city, shipping_notes,
         customer_phone, owner_admin_id, created_by, customer_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'pending','web',$7,$8,$9,$10,$11,$11,$12)
       RETURNING id, sale_number, subtotal, discount_amount, total`,
      [saleNumber, subtotal, discountAmount, discountId, total, payment_method,
       shipping_address || null, shipping_city || null,
       shipping_notes || null, customer_phone || null, adminId,
       req.user.id]
    );

    const saleId = saleRes.rows[0].id;

    for (const item of saleItems) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, variant_id, quantity, unit_price, unit_cost, subtotal, profit_per_unit, total_profit, discount_id, fulfillment_mode_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [saleId, item.product_id, item.variant_id ?? null, item.quantity, item.unit_price, item.unit_cost, item.subtotal, item.profit_unit, item.total_profit, discountId, item.fulfillment_mode]
      );
      // Only deduct physical stock for items that are fulfilled from inventory
      if (item.fulfillment_mode !== 'on_demand') {
        await inv.applyStockMovement(
          client,
          { productId: item.product_id, variantId: item.variant_id ?? null, quantity: item.quantity },
          -1, 'sale_confirmed',
          { ownerAdminId: adminId, userId: req.user?.id ?? 0,
            referenceType: 'sale', referenceId: saleId }
        );
      }
    }

    await client.query("COMMIT");
    client.release();
    clientReleased = true;

    const hasOnDemandItems = saleItems.some(i => i.fulfillment_mode === 'on_demand');

    // ── Auto-crear procurement orders (nueva tx, no bloquea la respuesta) ──────
    if (hasOnDemandItems) {
      const { rows: [prof] } = await db.query(
        `SELECT auto_create_procurement_orders FROM admin_profiles WHERE user_id = $1`,
        [adminId]
      );
      const autoCreate = prof?.auto_create_procurement_orders ?? true;

      if (autoCreate) {
        const procClient = await db.connect();
        try {
          await procClient.query('BEGIN');
          await procurement.createProcurementOrdersForSale(saleId, procClient);
          await procClient.query('COMMIT');
        } catch (procErr) {
          await procClient.query('ROLLBACK');
          console.error('[PUBLIC API] procurement auto-create error:', procErr.message);
          // Marcar la venta con procurement_status pending aunque falle la creación
          await db.query(
            `UPDATE sales SET procurement_status = 'pending', has_on_demand_items = true WHERE id = $1`,
            [saleId]
          ).catch(() => {});
        } finally {
          procClient.release();
        }
      }
    }

    // ── Push notification al admin (fire-and-forget) ───────────────────────────
    const pushPayload = hasOnDemandItems
      ? {
          title:    '🔔 Nueva venta — pedir al proveedor',
          body:     `${saleRes.rows[0].sale_number} · $${Number(saleRes.rows[0].total).toLocaleString('es-CO')}`,
          icon:     '/icon-192.png',
          badge:    '/badge-72.png',
          url:      '/procurement',
          tag:      'new-on-demand-sale',
          severity: 'warning',
        }
      : Payloads.newOnlineOrder(saleRes.rows[0].sale_number, saleRes.rows[0].total);
    notifyTenant(adminId, pushPayload).catch(() => {});

    // ── WhatsApp enqueue (fire-and-forget) ────────────────────────────────────
    const waEvent = hasOnDemandItems ? 'new_on_demand_sale' : 'new_sale';
    enqueueNotification({
      ownerAdminId:    adminId,
      recipientUserId: adminId,
      event:           waEvent,
      channel:         'whatsapp',
      payload: {
        sale_number:   saleRes.rows[0].sale_number,
        total:         `$${Number(saleRes.rows[0].total).toLocaleString('es-CO')}`,
        items_list:    saleItems.map(i => `• Producto #${i.product_id} × ${i.quantity}`).join('\n'),
        pending_count: String(saleItems.filter(i => i.fulfillment_mode === 'on_demand').length),
      },
      templateKey:   waEvent,
      referenceType: 'sale',
      referenceId:   saleId,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: "Venta registrada correctamente",
      data: {
        sale_id:         saleId,
        sale_number:     saleRes.rows[0].sale_number,
        subtotal:        saleRes.rows[0].subtotal,
        discount_amount: saleRes.rows[0].discount_amount,
        total:           saleRes.rows[0].total,
        has_on_demand_items: hasOnDemandItems,
      },
    });
  } catch (error) {
    if (!clientReleased) {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
    console.error("[PUBLIC API] POST /sales", error);
    res.status(500).json({ success: false, message: "Error al registrar la venta" });
  }
});

// GET /public-api/v1/inventory/availability?productId=&variantId=
// Returns real-time disponible for the storefront without requiring admin JWT.
router.get("/inventory/availability", requireApiPermission("products:read"), async (req, res) => {
  try {
    const adminId   = req.apiKey.adminId;
    const productId = Number(req.query.productId);
    const variantId = req.query.variantId ? Number(req.query.variantId) : null;
    if (!productId) return res.status(400).json({ success: false, message: "productId requerido" });

    const conditions = variantId
      ? ["product_id = $1", "variant_id = $2", "owner_admin_id = $3"]
      : ["product_id = $1", "variant_id IS NULL", "owner_admin_id = $2"];
    const params = variantId ? [productId, variantId, adminId] : [productId, adminId];

    const { rows } = await db.query(
      `SELECT disponible, min_stock, stock_safety, fulfillment_mode
       FROM v_stock_disponible WHERE ${conditions.join(" AND ")} LIMIT 1`,
      params
    );
    const row = rows[0] ?? null;
    res.json({ success: true, data: row });
  } catch (err) {
    console.error("[PUBLIC API] GET /inventory/availability", err);
    res.status(500).json({ success: false, message: "Error al verificar disponibilidad" });
  }
});

// GET /public-api/v1/customers
router.get("/customers", requireApiPermission("customers:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const { search, page = 1, limit = 20 } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 50);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where = `WHERE u.owner_admin_id = $1 AND r.name = 'user' AND u.is_active = true`;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`;
    }

    params.push(safeLimit, offset);

    const result = await db.query(
      `SELECT
         u.id, u.name, u.email, u.phone,
         u.city, u.created_at,
         COUNT(DISTINCT s.id)::int          AS total_orders,
         COALESCE(SUM(s.total), 0)::numeric AS total_spent
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r       ON r.id = ur.role_id
       LEFT JOIN sales s       ON s.customer_id = u.id AND s.owner_admin_id = $1
       ${where}
       GROUP BY u.id
       ORDER BY total_spent DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /customers", error);
    res.status(500).json({ success: false, message: "Error al obtener clientes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH DEL STOREFRONT
// ─────────────────────────────────────────────────────────────────────────────

router.post("/auth/register", checkRateLimit("ip", 10, 60 * 60 * 1000), storefrontAuth.register);
router.post("/auth/verify", storefrontAuth.verifyEmail);
router.post("/auth/resend-code", checkRateLimit("email", 3, 60 * 60 * 1000), storefrontAuth.resendCode);
router.post("/auth/login", checkRateLimit("email", 5, 15 * 60 * 1000), storefrontAuth.login);
router.post("/auth/refresh", storefrontAuth.refreshToken);
router.post("/auth/logout", auth, storefrontAuth.logout);
router.get("/auth/profile", auth, storefrontAuth.getProfile);
router.put("/auth/profile", auth, storefrontAuth.updateProfile);

// ─────────────────────────────────────────────────────────────────────────────
// HISTORIAL Y ESTADÍSTICAS DEL USUARIO
// ─────────────────────────────────────────────────────────────────────────────

router.get("/sales/user/history", auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         s.id,
         s.sale_number     AS order_code,
         s.sale_date       AS created_at,
         s.total, s.amount_paid, s.payment_status, s.payment_method,
         s.sale_type, s.subtotal, s.tax_amount, s.discount_amount,
         s.credit_due_date, s.shipping_address, s.shipping_city, s.shipping_notes
       FROM sales s
       WHERE s.customer_id    = $1
         AND s.owner_admin_id = $2
       ORDER BY s.sale_date DESC`,
      [req.user.id, req.apiKey.adminId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[PUBLIC API] GET /sales/user/history:", err);
    res.status(500).json({ success: false, message: "Error al obtener historial" });
  }
});

router.get("/sales/user/stats", auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(DISTINCT s.id) AS total_orders,
         COALESCE(SUM(CASE WHEN s.payment_status = 'paid'    THEN s.total ELSE 0 END), 0) AS total_invested,
         COALESCE(SUM(CASE WHEN s.payment_status = 'pending' THEN s.total ELSE 0 END), 0) AS pending_amount,
         COALESCE(SUM(CASE WHEN s.payment_status = 'partial' THEN (s.total - s.amount_paid) ELSE 0 END), 0) AS partial_pending,
         COUNT(DISTINCT CASE WHEN s.payment_status = 'paid'    THEN s.id END) AS completed_orders,
         COUNT(DISTINCT CASE WHEN s.payment_status = 'pending' THEN s.id END) AS pending_orders,
         COUNT(DISTINCT CASE WHEN s.payment_status = 'partial' THEN s.id END) AS partial_orders
       FROM sales s
       WHERE s.customer_id    = $1
         AND s.owner_admin_id = $2`,
      [req.user.id, req.apiKey.adminId]
    );
    res.json({ success: true, summary: rows[0] });
  } catch (err) {
    console.error("[PUBLIC API] GET /sales/user/stats:", err);
    res.status(500).json({ success: false, message: "Error al obtener estadísticas" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESEÑAS
// ─────────────────────────────────────────────────────────────────────────────

router.get("/products/:productId/reviews", reviewsCtrl.getProductReviews);
router.get("/reviews/my/:productId", auth, reviewsCtrl.getUserReviewForProduct);
router.post("/reviews", auth, reviewsCtrl.createReview);

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD
// ─────────────────────────────────────────────────────────────────────────────

const _uploadStorefront = createUpload("storefront", 5);

router.post("/upload", auth, _uploadStorefront.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No se recibió ningún archivo", code: "NO_FILE" });
  }
  res.json({
    success: true,
    data: { url: req.file.path, public_id: req.file.filename },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESERVAS DE STOCK
// ─────────────────────────────────────────────────────────────────────────────

router.post("/inventory/reservations",
  checkRateLimit((req) => `rl:rsv:${req.apiKey?.id ?? req.ip}`, 10, 60_000),
  async (req, res) => {
  try {
    const { items, sessionId, ttlMinutes } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: "items es requerido", code: "MISSING_ITEMS" });
    }
    const result = await inv.createReservation({
      items,
      sessionId:    sessionId ?? null,
      userId:       req.user?.id ?? null,
      ownerAdminId: req.apiKey.adminId,
      ttlMinutes,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err?.code === 'INSUFFICIENT_STOCK') return res.status(409).json({ success: false, message: err.message, code: err.code });
    res.status(400).json({ success: false, message: err.message ?? 'Error al crear reserva' });
  }
});

router.delete("/inventory/reservations/:id", async (req, res) => {
  try {
    const { rows: [r] } = await db.query(
      `SELECT owner_admin_id FROM stock_reservations WHERE id = $1`,
      [req.params.id],
    );
    if (!r) return res.status(404).json({ success: false, message: "Reserva no encontrada" });
    if (r.owner_admin_id !== req.apiKey.adminId) {
      return res.status(403).json({ success: false, message: "No autorizado" });
    }
    const result = await inv.releaseReservation(
      Number(req.params.id),
      { ownerAdminId: req.apiKey.adminId, userId: req.user?.id ?? 0 },
      'cancelled',
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message ?? 'Error al liberar reserva' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WOMPI
// ─────────────────────────────────────────────────────────────────────────────

router.get("/wompi/session/:sale_id", auth, wompiCtrl.getSession);
router.get("/wompi/verify/:reference", auth, wompiCtrl.verifyByReference);

module.exports = router;