// controllers/sales.controller.js
const db         = require("../config/db");
const inv        = require("../services/inventory.service");
const cloudinary = require("../config/cloudinary");
const { sendOrderConfirmationEmail, sendPaymentConfirmedEmail, sendInvoiceEmail } = require("../config/emailConfig");
const { getAdminBranding } = require("../services/branding.service");
const { emitDataUpdate } = require("../config/socket");
const { notifyUser, notifyTenant, Payloads } = require("../services/push.service");
const procurement         = require("../services/procurement.service");
const { enqueueNotification } = require("../services/notification.service");

const fmt = (n) => Number(n ?? 0).toLocaleString("es-CO");

// ── Helpers ───────────────────────────────────────────────────
// adminScope siempre corre antes → req.isSuperAdmin y req.adminId
// siempre disponibles. Solo isManager sigue leyendo roles porque
// gerente también puede operar (no tiene isSuperAdmin ni es el owner).
const isManager = (req) =>
  req.user?.roles?.some((r) => ["superadmin", "admin", "gerente"].includes(r));

const tenantSalesClause = (req, startIdx = 1) => {
  if (req.isSuperAdmin) return { clause: "", params: [], nextIdx: startIdx };
  return {
    clause:  `AND s.owner_admin_id = $${startIdx}`,
    params:  [req.adminId],
    nextIdx: startIdx + 1,
  };
};

async function syncPaymentStatus(client, saleId) {
  const { rows: payRows } = await client.query(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM sale_payments WHERE sale_id = $1",
    [saleId]
  );
  const paid = Number(payRows[0].paid);

  const { rows: saleRows } = await client.query(
    "SELECT total FROM sales WHERE id = $1 FOR UPDATE", [saleId]
  );
  if (!saleRows.length) throw new Error(`Venta ${saleId} no encontrada al sincronizar`);
  const total = Number(saleRows[0].total);

  const status = paid <= 0 ? "pending" : paid < total ? "partial" : "paid";

  await client.query(
    "UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3",
    [paid, status, saleId]
  );
  return { paid, status };
}

async function checkSaleAccess(req, saleId, client = db) {
  const { rows } = await client.query(
    "SELECT id, owner_admin_id, customer_id FROM sales WHERE id = $1", [saleId]
  );
  if (!rows.length) return "not_found";

  if (req.isSuperAdmin) return "ok";

  if (isManager(req)) {
    return String(rows[0].owner_admin_id) === String(req.adminId) ? "ok" : "forbidden";
  }
  // Usuario final
  return String(rows[0].customer_id) === String(req.user.id) ? "ok" : "forbidden";
}

// ============================================
// 📋 OBTENER TODAS LAS VENTAS
// ============================================
exports.getAllSales = async (req, res) => {
  try {
    if (!isManager(req))
      return res.status(403).json({ success: false, message: "No autorizado" });

    const tc = tenantSalesClause(req, 1);
    const { page = 1, limit = 50, payment_status, sale_type, start_date, end_date } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let idx = tc.nextIdx;
    const params = [...tc.params];
    let filters = "";

    if (payment_status) { filters += ` AND s.payment_status = $${idx++}`; params.push(payment_status); }
    if (sale_type)      { filters += ` AND s.sale_type = $${idx++}`;      params.push(sale_type); }
    if (start_date)     { filters += ` AND s.sale_date >= $${idx++}`;     params.push(start_date); }
    if (end_date)       { filters += ` AND s.sale_date <= $${idx++}`;     params.push(end_date); }

    const query = `
      SELECT
        s.id, s.sale_number, s.customer_id,
        s.sale_date        AS created_at,
        s.total,           s.amount_paid,
        s.payment_status,  s.payment_method,
        s.sale_type,       s.subtotal,
        s.tax_amount,      s.discount_amount,
        s.credit_due_date, s.credit_notes,
        s.shipping_address, s.shipping_city, s.shipping_notes,
        u.name      AS customer_name,
        u.email     AS customer_email,
        seller.name AS seller_name,
        adm.name    AS owner_admin_name
      FROM sales s
      LEFT JOIN users u      ON u.id = s.customer_id
      LEFT JOIN users seller ON seller.id = s.created_by
      LEFT JOIN users adm    ON adm.id = s.owner_admin_id
      WHERE 1=1 ${tc.clause} ${filters}
      ORDER BY s.sale_date DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    params.push(parseInt(limit), offset);

    // Count con mismos filtros
    const countParams = [
      ...tc.params,
      ...(payment_status ? [payment_status] : []),
      ...(sale_type      ? [sale_type]      : []),
      ...(start_date     ? [start_date]     : []),
      ...(end_date       ? [end_date]       : []),
    ];

    const [salesRes, countRes] = await Promise.all([
      db.query(query, params),
      db.query(
        `SELECT COUNT(*) FROM sales s WHERE 1=1 ${tc.clause} ${filters}`,
        countParams
      ),
    ]);

    res.json({
      success: true,
      data: salesRes.rows,
      pagination: {
        total:      Number(countRes.rows[0].count),
        page:       parseInt(page),
        limit:      parseInt(limit),
        totalPages: Math.ceil(Number(countRes.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("GET ALL SALES ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener ventas" });
  }
};

// ============================================
// 📦 HISTORIAL DE PEDIDOS DEL USUARIO FINAL
// ============================================
exports.getUserOrderHistory = async (req, res) => {
  let { userId } = req.query;

  // Usuario final: nunca puede pasarse a sí mismo o a otro userId — siempre usa su propio id
  if (!req.isSuperAdmin && !isManager(req)) {
    userId = req.user.id;
  } else if (!userId) {
    return res.status(400).json({ success: false, message: "userId requerido" });
  }

  try {
    // Manager/admin: confirmar que el userId pertenece a su tenant
    if (!req.isSuperAdmin && isManager(req)) {
      const { rows } = await db.query(
        "SELECT id FROM users WHERE id = $1 AND owner_admin_id = $2",
        [userId, req.adminId]
      );
      if (!rows.length)
        return res.status(403).json({ success: false, message: "No autorizado para ver pedidos de este usuario" });
    }

    const histParams = [userId];
    const tenantFilter = req.isSuperAdmin ? '' : `AND s.owner_admin_id = $${histParams.push(req.adminId)}`;
    const { rows } = await db.query(
      `SELECT s.id, s.sale_number AS order_code, s.sale_date AS created_at,
              s.total, s.amount_paid, s.payment_status, s.payment_method,
              s.sale_type, s.subtotal, s.tax_amount, s.discount_amount,
              s.credit_due_date, s.shipping_address, s.shipping_city, s.shipping_notes
       FROM sales s
       WHERE s.customer_id = $1 ${tenantFilter}
       ORDER BY s.sale_date DESC`,
      histParams
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET USER ORDER HISTORY ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener historial" });
  }
};

// ============================================
// 📊 ESTADÍSTICAS DEL USUARIO
// ============================================
exports.getUserStats = async (req, res) => {
  let { userId } = req.query;

  // Mismo patrón que getUserOrderHistory: usuario final solo puede ver sus propios datos
  if (!req.isSuperAdmin && !isManager(req)) {
    userId = req.user.id;
  } else if (!userId) {
    return res.status(400).json({ success: false, message: "userId requerido" });
  }

  try {
    if (!req.isSuperAdmin && isManager(req)) {
      const { rows } = await db.query(
        "SELECT id FROM users WHERE id = $1 AND owner_admin_id = $2",
        [userId, req.adminId]
      );
      if (!rows.length)
        return res.status(403).json({ success: false, message: "No autorizado" });
    }

    const { rows } = await db.query(
      `SELECT
        COUNT(DISTINCT s.id) AS total_orders,
        COALESCE(SUM(CASE WHEN s.payment_status = 'paid'    THEN s.total ELSE 0 END), 0) AS total_invested,
        COALESCE(SUM(CASE WHEN s.payment_status = 'pending' THEN s.total ELSE 0 END), 0) AS pending_amount,
        COALESCE(SUM(CASE WHEN s.payment_status = 'partial' THEN (s.total - s.amount_paid) ELSE 0 END), 0) AS partial_pending,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'paid'    THEN s.id END) AS completed_orders,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'pending' THEN s.id END) AS pending_orders,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'partial' THEN s.id END) AS partial_orders
       FROM sales s WHERE s.customer_id = $1`,
      [userId]
    );
    res.json({ success: true, summary: rows[0] });
  } catch (err) {
    console.error("GET USER STATS ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener estadísticas" });
  }
};

// ============================================
// 🛒 CREAR PEDIDO / VENTA
// ============================================
exports.createOrder = async (req, res) => {
  const {
    customer_id, items, discount_amount: rawDiscountAmount = 0, tax_amount = 0,
    discount_id = null,
    sale_type = "online", payment_method = "cash",
    credit_due_date = null, credit_notes = null, initial_payment = 0,
    shipping_address, shipping_city, shipping_notes,
    reservation_ids = [],
    payment_schedule = [],
  } = req.body;

  if (!customer_id || !items?.length)
    return res.status(400).json({ success: false, message: "Datos incompletos" });

  // "fiado" is the legacy sentinel; new clients send "credit" + payment_schedule or credit_due_date
  const isFiado  = payment_method === "fiado"
    || (payment_method === "credit" && (
      credit_due_date != null
      || (Array.isArray(payment_schedule) && payment_schedule.length > 0)
    ));
  const isOnline = sale_type === "online" || sale_type === "web";

  // credit_due_date can be derived from the last schedule installment
  const derivedDueDate = credit_due_date
    ?? (isFiado && Array.isArray(payment_schedule) && payment_schedule.length > 0
        ? payment_schedule[payment_schedule.length - 1].date
        : null);

  if (isFiado && !derivedDueDate)
    return res.status(400).json({ success: false, message: "Se requiere fecha límite de pago para ventas a crédito" });

  if (!req.isSuperAdmin && isManager(req)) {
    const { rows: custCheck } = await db.query(
      "SELECT id FROM users WHERE id = $1 AND owner_admin_id = $2",
      [customer_id, req.adminId]
    );
    if (!custCheck.length)
      return res.status(403).json({ success: false, message: "El cliente no pertenece a tu panel" });
  }

  const ownerAdminId = req.isSuperAdmin ? null : req.adminId;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const { rows: custRows } = await client.query(
      "SELECT id, name, email FROM users WHERE id = $1", [customer_id]
    );
    if (!custRows.length) throw new Error("Cliente no encontrado");
    const customer = custRows[0];

    // Read per-tenant setting (column: user_id, not admin_id)
    let autoCreateProcurement = true;
    if (ownerAdminId) {
      const { rows: [prof] } = await client.query(
        `SELECT auto_create_procurement_orders FROM admin_profiles WHERE user_id = $1 LIMIT 1`,
        [ownerAdminId]
      );
      if (prof) autoCreateProcurement = prof.auto_create_procurement_orders;
    }

    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const ownerCheck = req.isSuperAdmin ? "" : "AND p.owner_admin_id = $2";
      const prodParams  = req.isSuperAdmin ? [item.product_id] : [item.product_id, req.adminId];

      const { rows: prodRows } = await client.query(
        `SELECT id, name, sku, sale_price, stock, stock_reserved, stock_safety,
                purchase_price, has_variants,
                fulfillment_mode, default_supplier_id,
                supplier_lead_time_days, supplier_cost_estimate
         FROM products p WHERE p.id = $1 AND p.is_active = true ${ownerCheck}`,
        prodParams
      );
      if (!prodRows.length)
        throw new Error(`Producto ${item.product_id} no encontrado, inactivo o no autorizado`);
      const product = prodRows[0];

      let variantId  = null;
      let unitCost   = Number(product.purchase_price ?? 0);
      let unitPrice  = item.unit_price != null ? Number(item.unit_price) : Number(product.sale_price);
      let availStock = Math.max(
        0,
        Number(product.stock) - Number(product.stock_reserved ?? 0) - Number(product.stock_safety ?? 0)
      );

      if (item.variant_id) {
        const { rows: varRows } = await client.query(
          `SELECT id, sku, sale_price, stock, stock_reserved, stock_safety
           FROM product_variants
           WHERE id = $1 AND product_id = $2 AND is_active = true`,
          [item.variant_id, item.product_id]
        );
        if (!varRows.length)
          throw new Error(`Variante ${item.variant_id} no encontrada o inactiva`);
        const v = varRows[0];
        variantId  = v.id;
        availStock = Math.max(
          0,
          Number(v.stock) - Number(v.stock_reserved ?? 0) - Number(v.stock_safety ?? 0)
        );
        if (item.unit_price == null && v.sale_price != null) unitPrice = Number(v.sale_price);
      } else if (product.has_variants) {
        throw new Error(`"${product.name}" tiene variantes — selecciona una`);
      }

      // Determine fulfillment snapshot using real-time disponible_inmediato from view
      const _svQ = variantId
        ? `SELECT disponible_inmediato AS disp
           FROM v_stock_disponible WHERE product_id = $1 AND variant_id = $2 LIMIT 1`
        : `SELECT disponible_inmediato AS disp
           FROM v_stock_disponible WHERE product_id = $1 AND variant_id IS NULL LIMIT 1`;
      const { rows: [_sv] } = await client.query(
        _svQ, variantId ? [item.product_id, variantId] : [item.product_id]
      );
      const disponibleInmediato = Number(_sv?.disp ?? availStock);

      if (product.fulfillment_mode === 'stock' && disponibleInmediato < item.quantity) {
        throw new Error(
          `"${product.name}" sin stock suficiente (disponible: ${disponibleInmediato}, solicitado: ${item.quantity})`
        );
      }

      const fulfillmentSnapshot = disponibleInmediato >= item.quantity ? 'stock' : 'on_demand';

      const leadDays = fulfillmentSnapshot === 'stock'
        ? 0
        : Number(product.supplier_lead_time_days ?? 0);
      const itemEstimatedDelivery = new Date();
      itemEstimatedDelivery.setDate(itemEstimatedDelivery.getDate() + leadDays);

      const itemSubtotal = unitPrice * item.quantity;
      subtotal += itemSubtotal;

      validatedItems.push({
        product_id: product.id, variant_id: variantId,
        name: product.name, sku: product.sku,
        quantity: item.quantity, unit_price: unitPrice, unit_cost: unitCost,
        subtotal: itemSubtotal,
        profit_per_unit: unitPrice - unitCost,
        total_profit:    (unitPrice - unitCost) * item.quantity,
        fulfillment_mode_snapshot: fulfillmentSnapshot,
        supplier_cost_at_sale:    Number(product.supplier_cost_estimate ?? 0),
        estimated_delivery_date:  itemEstimatedDelivery,
        lead_time_days:           leadDays,
      });
    }

    // Sale-level fulfillment aggregates
    const hasOnDemandItems = validatedItems.some(i => i.fulfillment_mode_snapshot !== 'stock');
    const saleEstimatedDelivery = validatedItems.reduce((max, i) => {
      const d = new Date(i.estimated_delivery_date);
      return d > max ? d : max;
    }, new Date());
    const initialProcurementStatus = hasOnDemandItems ? 'pending' : 'not_required';

    // ── Validar y resolver descuento ──────────────────────────────────────────
    let resolvedDiscountAmount = Number(rawDiscountAmount) || 0;
    let resolvedDiscountId     = null;

    if (discount_id) {
      const discOwnerClause = (!req.isSuperAdmin && req.adminId) ? " AND owner_admin_id = $2" : "";
      const discParams      = (!req.isSuperAdmin && req.adminId) ? [discount_id, req.adminId] : [discount_id];

      const { rows: [disc] } = await client.query(
        `SELECT id, name, type, value, scope, active, starts_at, ends_at,
                usage_limit, times_used, min_purchase_amount, max_discount_amount
         FROM discounts WHERE id = $1${discOwnerClause} FOR UPDATE`,
        discParams
      );

      if (!disc)
        throw Object.assign(new Error("Descuento no encontrado"), { status: 400 });
      if (!disc.active)
        throw Object.assign(new Error("El descuento está inactivo"), { status: 400 });

      const now = new Date();
      if (disc.starts_at && new Date(disc.starts_at) > now)
        throw Object.assign(new Error("El descuento aún no está vigente"), { status: 400 });
      if (disc.ends_at && new Date(disc.ends_at) < now)
        throw Object.assign(new Error("El descuento ha expirado"), { status: 400 });
      if (disc.usage_limit != null && disc.times_used >= disc.usage_limit)
        throw Object.assign(new Error("Este descuento ha alcanzado su límite de usos"), { status: 409, code: "DISCOUNT_EXHAUSTED" });

      // Validar scope vs canal de venta
      const isPosSale = ["fisica", "pos"].includes(sale_type);
      const isWebSale = ["web", "online"].includes(sale_type);
      const scopeOk   = disc.scope === "all"
        || (isPosSale && disc.scope === "pos")
        || (isWebSale && disc.scope === "web");
      if (!scopeOk)
        throw Object.assign(
          new Error(`Este descuento no aplica para ventas de tipo "${sale_type}" (scope: ${disc.scope})`),
          { status: 400, code: "SCOPE_MISMATCH" }
        );

      if (disc.min_purchase_amount && subtotal < Number(disc.min_purchase_amount))
        throw Object.assign(
          new Error(`Compra mínima requerida: $${Number(disc.min_purchase_amount).toLocaleString("es-CO")}`),
          { status: 400, code: "MIN_PURCHASE_NOT_MET" }
        );

      // Calcular monto de descuento
      if (disc.type === "percentage") {
        resolvedDiscountAmount = (subtotal * Number(disc.value)) / 100;
        if (disc.max_discount_amount)
          resolvedDiscountAmount = Math.min(resolvedDiscountAmount, Number(disc.max_discount_amount));
      } else {
        resolvedDiscountAmount = Number(disc.value);
      }
      resolvedDiscountAmount = Math.min(Math.round(resolvedDiscountAmount), subtotal);
      resolvedDiscountId = disc.id;

      // Incrementar usos atómicamente dentro de la misma tx
      await client.query(
        "UPDATE discounts SET times_used = times_used + 1 WHERE id = $1",
        [disc.id]
      );
    }

    const total   = Math.max(0, subtotal - resolvedDiscountAmount + Number(tax_amount));
    const initPay = Math.min(Number(initial_payment) || 0, total);

    let finalPaymentStatus, dbPaymentMethod, amountPaidInitial;
    if (isOnline) {
      finalPaymentStatus = "pending"; dbPaymentMethod = "credit"; amountPaidInitial = 0;
    } else if (isFiado) {
      dbPaymentMethod = "credit";
      if (initPay <= 0)        { finalPaymentStatus = "pending"; amountPaidInitial = 0; }
      else if (initPay < total){ finalPaymentStatus = "partial"; amountPaidInitial = initPay; }
      else                     { finalPaymentStatus = "paid";    amountPaidInitial = total; }
    } else {
      finalPaymentStatus = "paid";
      dbPaymentMethod    = ["cash","transfer","credit","check"].includes(payment_method)
        ? payment_method : "cash";
      amountPaidInitial  = total;
    }

    const { rows: numRows } = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(sale_number FROM 5) AS INTEGER)), 0) + 1 AS n
       FROM sales WHERE sale_number LIKE 'VEN-%'`
    );
    const saleNumber = `VEN-${String(numRows[0].n).padStart(6, "0")}`;

    const { rows: saleRows } = await client.query(
      `INSERT INTO sales (
        sale_number, customer_id, subtotal, tax_amount, discount_amount, discount_id,
        total, amount_paid, payment_method, payment_status, sale_type,
        created_by, owner_admin_id,
        shipping_address, shipping_city, shipping_notes,
        credit_due_date, credit_notes,
        has_on_demand_items, procurement_status, estimated_delivery_date, delivery_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'pending')
      RETURNING id`,
      [
        saleNumber, customer_id, subtotal, tax_amount, resolvedDiscountAmount, resolvedDiscountId,
        total, amountPaidInitial, dbPaymentMethod, finalPaymentStatus, sale_type,
        req.user?.id ?? customer_id, ownerAdminId,
        shipping_address ?? null, shipping_city ?? null, shipping_notes ?? null,
        isFiado ? derivedDueDate : null,
        isFiado ? credit_notes   : null,
        hasOnDemandItems, initialProcurementStatus, saleEstimatedDelivery,
      ]
    );
    const saleId = saleRows[0].id;

    for (const item of validatedItems) {
      await client.query(
        `INSERT INTO sale_items (
          sale_id, product_id, variant_id, quantity, unit_price, unit_cost,
          subtotal, profit_per_unit, total_profit,
          fulfillment_mode_snapshot, supplier_cost_at_sale,
          estimated_delivery_date, item_delivery_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
        [
          saleId, item.product_id, item.variant_id ?? null,
          item.quantity, item.unit_price, item.unit_cost,
          item.subtotal, item.profit_per_unit, item.total_profit,
          item.fulfillment_mode_snapshot, item.supplier_cost_at_sale,
          item.estimated_delivery_date,
        ]
      );

      // Stock movement only for items fulfilled from stock
      if (item.fulfillment_mode_snapshot === 'stock') {
        await inv.applyStockMovement(
          client,
          { productId: item.product_id, variantId: item.variant_id ?? null, quantity: item.quantity },
          -1, 'sale_confirmed',
          { ownerAdminId, userId: req.user?.id ?? 0,
            referenceType: 'sale', referenceId: saleId },
        );
      }
    }

    // Auto-create procurement orders if configured and sale has on_demand items
    if (hasOnDemandItems && autoCreateProcurement) {
      await procurement.createProcurementOrdersForSale(saleId, client);
    }

    if (amountPaidInitial > 0) {
      await client.query(
        `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [saleId, amountPaidInitial, dbPaymentMethod,
         isFiado ? "Abono inicial sobre crédito" : "Pago completo en tienda",
         req.user?.id ?? null]
      );
    }

    // Insert payment schedule if provided (fiado only)
    if (isFiado && Array.isArray(payment_schedule) && payment_schedule.length > 0) {
      const pendingAmt  = total - amountPaidInitial;
      const scheduleSum = payment_schedule.reduce((s, i) => s + Number(i.amount || 0), 0);
      if (Math.abs(scheduleSum - pendingAmt) > 1)
        throw Object.assign(
          new Error(`La suma de cuotas ($${scheduleSum.toLocaleString('es-CO')}) no coincide con el saldo pendiente ($${pendingAmt.toLocaleString('es-CO')})`),
          { status: 400 }
        );

      for (let i = 0; i < payment_schedule.length; i++) {
        const inst = payment_schedule[i];
        await client.query(
          `INSERT INTO credit_payment_schedule
             (sale_id, owner_admin_id, installment_num, due_date, expected_amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [saleId, ownerAdminId, i + 1, inst.date, Number(inst.amount)]
        );
      }
    }

    await client.query("COMMIT");

    // Release any checkout reservations so stock_reserved is freed immediately
    if (Array.isArray(reservation_ids) && reservation_ids.length) {
      const relCtx = { ownerAdminId, userId: req.user?.id ?? 0 };
      reservation_ids.forEach(id => {
        inv.releaseReservation(id, relCtx, 'sale_confirmed').catch(() => {});
      });
    }

    const orderCode = `AL-${saleNumber.slice(4)}`;

    if (customer.email) {
      (async () => {
        let branding = null;
        try { branding = await getAdminBranding(ownerAdminId); } catch {}
 
        const invoiceData = {
          orderCode,
          saleNumber,
          total,
          subtotal,
          discountAmount: resolvedDiscountAmount,
          taxAmount:      Number(tax_amount) || 0,
          items:          validatedItems,
          paymentMethod:  isFiado ? 'fiado' : dbPaymentMethod,
          paymentStatus:  finalPaymentStatus,
          shippingAddress: shipping_address ?? null,
          shippingCity:    shipping_city    ?? null,
          shippingNotes:   shipping_notes   ?? null,
        };
 
        const emailType = (finalPaymentStatus === 'paid' && !isFiado)
          ? 'payment_confirmed'
          : 'confirmation';
 
        try {
          await sendInvoiceEmail(customer.email, customer.name, invoiceData, emailType, branding);
        } catch (emailErr) {
          console.error(`[Email] Error enviando factura (venta ${saleNumber}):`, emailErr.message);
          // No bloquea la respuesta — el pedido ya fue creado
        }
      })();
    }

    emitDataUpdate("sales", "created", {
      id: saleId, sale_number: saleNumber, total,
      payment_status: finalPaymentStatus, sale_type,
    }, req.adminId);

    // Push al admin/gerentes del tenant
    const adminPush = isOnline
      ? Payloads.newOnlineOrder(saleNumber, total)
      : Payloads.newSale(saleNumber, total);
    notifyTenant(req.adminId, adminPush).catch(() => {});

    // Push al cliente confirmando su pedido
    notifyUser(customer_id, Payloads.orderConfirmed(orderCode, total)).catch(() => {});

    // WhatsApp al admin del tenant
    if (ownerAdminId) {
      const waEvent = hasOnDemandItems ? 'new_on_demand_sale' : 'new_sale';
      const items_formatted = validatedItems.map(i => {
        if (i.fulfillment_mode_snapshot === 'stock') return `• ${i.name} × ${i.quantity} (stock inmediato)`;
        const dias = i.lead_time_days > 0 ? ` · ~${i.lead_time_days} días` : '';
        return `• ${i.name} × ${i.quantity} (bajo pedido${dias})`;
      }).join('\n');
      const on_demand_count = String(validatedItems.filter(i => i.fulfillment_mode_snapshot !== 'stock').length);
      const allStock    = validatedItems.every(i => i.fulfillment_mode_snapshot === 'stock');
      const allOnDemand = validatedItems.every(i => i.fulfillment_mode_snapshot !== 'stock');
      const summary_line = allStock
        ? '✅ Todos los productos disponibles desde inventario'
        : allOnDemand
          ? '📦 Pedido bajo demanda — se ordenará al proveedor'
          : '⚠️ Pedido mixto: algunos ítems requieren orden a proveedor';
      enqueueNotification({
        ownerAdminId,
        recipientUserId: ownerAdminId,
        event:           waEvent,
        channel:         'whatsapp',
        payload: {
          sale_number:    saleNumber,
          customer_name:  customer.name,
          total:          `$${fmt(total)}`,
          items_formatted,
          on_demand_count,
          summary_line,
        },
        templateKey:    waEvent,
        referenceType:  'sale',
        referenceId:    saleId,
      }).catch(() => {});
    }

    res.status(201).json({
      success: true,
      message: isOnline
        ? "Pedido creado. Redirigiendo al pago…"
        : isFiado
          ? `Venta a crédito registrada${initPay > 0 ? `. Abono de $${fmt(initPay)} registrado.` : ""}`
          : "Venta registrada y pagada ✓",
      data: { sale_id: saleId, sale_number: saleNumber, order_code: orderCode,
              total, amount_paid: amountPaidInitial, payment_status: finalPaymentStatus },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CREATE ORDER ERROR:", err);
    const isClientError = err.message && !err.message.startsWith("Error");
    res.status(isClientError ? 400 : 500).json({ success: false, message: err.message || "Error al crear la venta" });
  } finally {
    client.release();
  }
};


// ============================================
// 💰 REGISTRAR ABONO
// ============================================
exports.registerPayment = async (req, res) => {
  const { id } = req.params;
  const { amount, payment_method = "cash", notes = null, payment_date } = req.body;

  if (!amount || Number(amount) <= 0)
    return res.status(400).json({ success: false, message: "Monto inválido" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const access = await checkSaleAccess(req, id, client);
    if (access === "not_found") { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Venta no encontrada" }); }
    if (access === "forbidden") { await client.query("ROLLBACK"); return res.status(403).json({ success: false, message: "No autorizado para registrar pagos en esta venta" }); }

    const { rows: saleRows } = await client.query(
      `SELECT s.id, s.sale_number, s.total, s.amount_paid, s.payment_status, s.customer_id,
              s.owner_admin_id,
              u.email AS customer_email,
              u.name  AS customer_name
      FROM sales s
      LEFT JOIN users u ON u.id = s.customer_id
      WHERE s.id = $1 FOR UPDATE`, [id]
    );
    const sale = saleRows[0];

    if (sale.payment_status === "paid")
      return res.status(400).json({ success: false, message: "Esta venta ya está pagada por completo" });
    if (sale.payment_status === "cancelled")
      return res.status(400).json({ success: false, message: "No se puede abonar a una venta cancelada" });

    const pending = Number(sale.total) - Number(sale.amount_paid);
    if (Number(amount) > pending)
      return res.status(400).json({ success: false, message: `El monto excede el saldo pendiente ($${fmt(pending)})` });

    await client.query(
      `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, payment_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, Number(amount), payment_method, notes,
       payment_date ?? new Date().toISOString().slice(0, 10),
       req.user?.id ?? null]
    );

    const { paid, status } = await syncPaymentStatus(client, id);
    await client.query("COMMIT");

    emitDataUpdate("sales", "updated", { id: parseInt(id), amount_paid: paid, payment_status: status }, req.adminId);

    notifyTenant(req.adminId, Payloads.paymentReceived(sale.sale_number, Number(amount))).catch(() => {});
    if (status === 'paid') {
      notifyUser(sale.customer_id, Payloads.paymentConfirmed(sale.sale_number)).catch(() => {});

      // ── Factura PDF al cliente cuando queda saldado ──
      if (sale.customer_email) {
        (async () => {
          try {
            const { rows: saleItems } = await db.query(
              `SELECT si.quantity, si.unit_price, si.subtotal,
                      p.name, p.sku
              FROM sale_items si
              JOIN products p ON p.id = si.product_id
              WHERE si.sale_id = $1`, [id]
            );
            // ⚠️ Branding del TENANT DUEÑO de la venta (sale.owner_admin_id),
            // NUNCA de req.adminId — quien registra el abono puede no ser el
            // mismo tenant dueño de la venta (ej. superadmin operando por un tenant).
            let branding = null;
            try { branding = await getAdminBranding(sale.owner_admin_id); } catch {}

            await sendInvoiceEmail(
              sale.customer_email,
              sale.customer_name,
              {
                orderCode:      `AL-${sale.sale_number.slice(4)}`,
                saleNumber:     sale.sale_number,
                total:          Number(sale.total),
                subtotal:       Number(sale.total),
                discountAmount: 0,
                taxAmount:      0,
                items:          saleItems,
                paymentMethod:  payment_method,
                paymentStatus:  'paid',
              },
              'payment_confirmed',
              branding
            );
          } catch (e) {
            console.error(`[Email] Factura abono final (venta ${sale.sale_number}):`, e.message);
          }
        })();
      }
    }

    res.json({
      success: true,
      message: status === "paid"
        ? "¡Venta saldada completamente! ✓"
        : `Abono de $${fmt(Number(amount))} registrado. Pendiente: $${fmt(Number(sale.total) - paid)}`,
      data: { amount_paid: paid, payment_status: status, new_payment: Number(amount) },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("REGISTER PAYMENT ERROR:", err);
    res.status(500).json({ success: false, message: err.message || "Error al registrar el pago" });
  } finally {
    client.release();
  }
};

// ============================================
// 📋 HISTORIAL DE PAGOS DE UNA VENTA
// ============================================
exports.getSalePayments = async (req, res) => {
  const { id } = req.params;
  try {
    const access = await checkSaleAccess(req, id);
    if (access === "not_found") return res.status(404).json({ success: false, message: "Venta no encontrada" });
    if (access === "forbidden") return res.status(403).json({ success: false, message: "No autorizado" });

    const { rows: saleRows } = await db.query(
      `SELECT s.id, s.sale_number, s.total, s.amount_paid, s.payment_status,
              s.payment_method, s.credit_due_date, s.credit_notes, s.sale_type,
              s.subtotal, s.discount_amount, s.tax_amount,
              u.name AS customer_name
       FROM sales s LEFT JOIN users u ON u.id = s.customer_id
       WHERE s.id = $1`,
      [id]
    );
    const sale = saleRows[0];

    const { rows: payments } = await db.query(
      `SELECT sp.id, sp.amount, sp.payment_method, sp.notes,
              sp.payment_date, sp.created_at,
              sp.proof_url, sp.proof_uploaded_at,
              u.name AS recorded_by
       FROM sale_payments sp
       LEFT JOIN users u ON u.id = sp.created_by
       WHERE sp.sale_id = $1
       ORDER BY sp.payment_date ASC, sp.created_at ASC`,
      [id]
    );

    res.json({
      success: true,
      data: {
        sale: { ...sale, pending_amount: Number(sale.total) - Number(sale.amount_paid), is_fiado: !!sale.credit_due_date },
        payments,
      },
    });
  } catch (err) {
    console.error("GET SALE PAYMENTS ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener pagos" });
  }
};

// ============================================
// 📄 DETALLE DE ÍTEMS
// ============================================
exports.getOrderDetail = async (req, res) => {
  const { id } = req.params;
  try {
    const access = await checkSaleAccess(req, id);
    if (access === "not_found") return res.status(404).json({ success: false, message: "Venta no encontrada" });
    if (access === "forbidden") return res.status(403).json({ success: false, message: "No autorizado" });

    const { rows } = await db.query(
      `SELECT
        si.id, si.product_id, si.variant_id, si.quantity,
        si.unit_price, si.subtotal, si.discount_amount,
        p.name, p.sku,
        pv.sku AS variant_sku,
        COALESCE((
          SELECT json_agg(json_build_object(
            'attribute_type', at.name, 'value', av.value,
            'display_value',  COALESCE(av.display_value, av.value),
            'hex_color',      av.hex_color
          ) ORDER BY at.id)
          FROM variant_attribute_values vav
          JOIN attribute_values av ON av.id = vav.attribute_value_id
          JOIN attribute_types  at ON at.id = av.attribute_type_id
          WHERE vav.variant_id = si.variant_id
        ), '[]') AS variant_attributes,
        (SELECT pi.url FROM product_images pi
         WHERE pi.product_id = p.id AND pi.is_main = true LIMIT 1) AS main_image
       FROM sale_items si
       INNER JOIN products p ON si.product_id = p.id
       LEFT  JOIN product_variants pv ON pv.id = si.variant_id
       WHERE si.sale_id = $1
       ORDER BY si.id`,
      [id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET ORDER DETAIL ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener detalle" });
  }
};

// ============================================
// ❌ CANCELAR PEDIDO
// ============================================
exports.cancelOrder = async (req, res) => {
  const { id }      = req.params;
  const { user_id } = req.body;
  const client      = await db.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT id, customer_id, payment_status, owner_admin_id, discount_id FROM sales WHERE id = $1", [id]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Pedido no encontrado" });
    }
    const order = rows[0];

    if (!req.isSuperAdmin) {
      if (isManager(req)) {
        if (String(order.owner_admin_id) !== String(req.adminId)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ success: false, message: "No autorizado para cancelar este pedido" });
        }
      } else {
        if (String(order.customer_id) !== String(user_id ?? req.user?.id)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ success: false, message: "Sin permiso para cancelar este pedido" });
        }
      }
    }

    if (!["pending", "partial"].includes(order.payment_status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Solo se pueden cancelar pedidos pendientes o parciales" });
    }

    const { rows: items } = await client.query(
      "SELECT product_id, variant_id, quantity FROM sale_items WHERE sale_id = $1", [id]
    );

    for (const item of items) {
      await inv.applyStockMovement(
        client,
        { productId: item.product_id, variantId: item.variant_id ?? null, quantity: item.quantity },
        +1, 'sale_cancelled',
        { ownerAdminId: order.owner_admin_id, userId: req.user?.id ?? 0,
          referenceType: 'sale', referenceId: Number(id),
          notes: `Reingreso por cancelación #${id}` },
      );
    }

    await client.query(
      "UPDATE sales SET payment_status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]
    );

    // Revertir uso del descuento si la venta tenía uno vinculado
    if (order.discount_id) {
      await client.query(
        "UPDATE discounts SET times_used = GREATEST(0, times_used - 1) WHERE id = $1",
        [order.discount_id]
      );
    }

    await client.query("COMMIT");

    res.json({ success: true, message: "Pedido cancelado. Stock restaurado." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CANCEL ORDER ERROR:", err);
    res.status(500).json({ success: false, message: "Error al cancelar el pedido" });
  } finally {
    client.release();
  }
};

// ============================================
// 📎 SUBIR COMPROBANTE DE PAGO
// POST /api/sales/:id/payments/:paymentId/proof
// ============================================
exports.uploadPaymentProof = async (req, res) => {
  const { id: saleId, paymentId } = req.params;

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Se requiere un archivo (imagen JPG/PNG/WebP o PDF)",
    });
  }

  try {
    const access = await checkSaleAccess(req, saleId);
    if (access === "not_found")
      return res.status(404).json({ success: false, message: "Venta no encontrada" });
    if (access === "forbidden")
      return res.status(403).json({ success: false, message: "No autorizado" });

    // Verificar que el pago pertenece a esta venta
    const { rows } = await db.query(
      "SELECT id, proof_url FROM sale_payments WHERE id = $1 AND sale_id = $2",
      [paymentId, saleId]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: "Pago no encontrado en esta venta" });

    // Eliminar comprobante anterior de Cloudinary si existe
    const prev = rows[0].proof_url;
    if (prev) {
      const parts = prev.split("/upload/");
      if (parts[1]) {
        const publicId = parts[1]
          .split("/").filter((p) => !p.startsWith("v")).join("/")
          .replace(/\.[^/.]+$/, "");
        await cloudinary.uploader.destroy(publicId).catch(() => {});
      }
    }

    const proofUrl = req.file.path || req.file.secure_url;

    await db.query(
      `UPDATE sale_payments
         SET proof_url = $1, proof_uploaded_at = NOW()
       WHERE id = $2`,
      [proofUrl, paymentId]
    );

    emitDataUpdate("sales", "updated", { id: parseInt(saleId), payment_proof: parseInt(paymentId) }, req.adminId);

    return res.json({
      success: true,
      message: "Comprobante subido correctamente",
      data: { payment_id: parseInt(paymentId), proof_url: proofUrl },
    });
  } catch (err) {
    console.error("[UPLOAD PROOF]", err);
    res.status(500).json({ success: false, message: "Error al subir el comprobante" });
  }
};

// ============================================
// 🗑️  ELIMINAR COMPROBANTE DE PAGO
// DELETE /api/sales/:id/payments/:paymentId/proof
// ============================================
exports.deletePaymentProof = async (req, res) => {
  const { id: saleId, paymentId } = req.params;

  try {
    const access = await checkSaleAccess(req, saleId);
    if (access === "not_found")
      return res.status(404).json({ success: false, message: "Venta no encontrada" });
    if (access === "forbidden")
      return res.status(403).json({ success: false, message: "No autorizado" });

    const { rows } = await db.query(
      "SELECT id, proof_url FROM sale_payments WHERE id = $1 AND sale_id = $2",
      [paymentId, saleId]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: "Pago no encontrado en esta venta" });

    if (!rows[0].proof_url)
      return res.status(400).json({ success: false, message: "Este pago no tiene comprobante" });

    const parts = rows[0].proof_url.split("/upload/");
    if (parts[1]) {
      const publicId = parts[1]
        .split("/").filter((p) => !p.startsWith("v")).join("/")
        .replace(/\.[^/.]+$/, "");
      await cloudinary.uploader.destroy(publicId).catch(() => {});
    }

    await db.query(
      "UPDATE sale_payments SET proof_url = NULL, proof_uploaded_at = NULL WHERE id = $1",
      [paymentId]
    );

    emitDataUpdate("sales", "updated", { id: parseInt(saleId), proof_deleted: parseInt(paymentId) }, req.adminId);

    res.json({ success: true, message: "Comprobante eliminado" });
  } catch (err) {
    console.error("[DELETE PROOF]", err);
    res.status(500).json({ success: false, message: "Error al eliminar el comprobante" });
  }
};

// ============================================
// 📦 MARCAR COMO ENTREGADA
// POST /api/sales/:id/mark-delivered
// ============================================
exports.markSaleAsDelivered = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await procurement.markSaleAsDelivered(
      Number(id), req.user?.id ?? null, req.adminId
    );
    res.json({
      success: true,
      message: 'Venta marcada como entregada. Ingreso reconocido.',
      data:    result,
    });
  } catch (err) {
    console.error('MARK DELIVERED ERROR:', err);
    const status = err.code === 'NOT_FOUND' ? 404
      : err.code === 'FORBIDDEN' ? 403
      : ['ALREADY_DONE', 'INVALID_STATE', 'PROCUREMENT_INCOMPLETE'].includes(err.code) ? 400
      : 500;
    res.status(status).json({ success: false, message: err.message || 'Error al marcar como entregada' });
  }
};

module.exports = exports;