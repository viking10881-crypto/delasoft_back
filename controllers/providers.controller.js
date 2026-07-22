// controllers/providers.controller.js
"use strict";

const db          = require("../config/db");
const invSvc      = require("../services/inventory.service");
const procSvc     = require("../services/procurement.service");
const { emitDataUpdate } = require("../config/socket");

// ─────────────────────────────────────────────
// Helpers de scope
// ─────────────────────────────────────────────
const tenantClause = (req, alias, startIdx = 1) => {
  if (req.isSuperAdmin) return { clause: "", params: [], nextIdx: startIdx };
  const col = alias ? `${alias}.owner_admin_id` : "owner_admin_id";
  return {
    clause:  `AND ${col} = $${startIdx}`,
    params:  [req.adminId],
    nextIdx: startIdx + 1,
  };
};

// ─────────────────────────────────────────────
// GET /providers
// ─────────────────────────────────────────────
exports.getAll = async (req, res) => {
  const { is_active, category } = req.query;

  try {
    const tc = tenantClause(req, "p", 1);
    let idx = tc.nextIdx;

    let query = `
      SELECT
        p.id, p.name, p.category, p.phone, p.email, p.address,
        p.contact_person, p.tax_id, p.balance, p.credit_limit,
        p.payment_terms_days, p.reliability_score, p.lead_time_days,
        p.is_active, p.notes, p.created_at, p.updated_at, p.owner_admin_id,
        p.credit_limit - p.balance                              AS available_credit,
        COALESCE(SUM(po.total_cost), 0)                         AS total_purchases,
        COALESCE(COUNT(DISTINCT po.id), 0)                      AS total_orders,
        COALESCE(SUM(pp.amount), 0)                             AS total_payments,
        u.name                                                  AS owner_admin_name
      FROM providers p
      LEFT JOIN purchase_orders po
        ON po.provider_id = p.id AND po.status <> 'cancelled'
      LEFT JOIN provider_payments pp
        ON pp.provider_id = p.id
      LEFT JOIN users u
        ON u.id = p.owner_admin_id
      WHERE 1=1 ${tc.clause}
    `;
    const params = [...tc.params];

    if (is_active !== undefined) {
      query += ` AND p.is_active = $${idx++}`;
      params.push(is_active === "true");
    }
    if (category) {
      query += ` AND p.category = $${idx++}`;
      params.push(category);
    }

    query += " GROUP BY p.id, u.name ORDER BY p.name ASC";

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("GET PROVIDERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener proveedores" });
  }
};

// ─────────────────────────────────────────────
// GET /providers/:id
// ─────────────────────────────────────────────
exports.getById = async (req, res) => {
  const { id } = req.params;

  try {
    const tc = tenantClause(req, "p", 2);

    const result = await db.query(`
      SELECT
        p.id, p.name, p.category, p.phone, p.email, p.address,
        p.contact_person, p.tax_id, p.balance, p.credit_limit,
        p.payment_terms_days, p.reliability_score, p.lead_time_days,
        p.is_active, p.notes, p.created_at, p.updated_at, p.owner_admin_id,
        p.credit_limit - p.balance                              AS available_credit,
        COALESCE(SUM(po.total_cost), 0)                         AS total_purchases,
        COALESCE(COUNT(DISTINCT po.id), 0)                      AS total_orders,
        COALESCE(SUM(pp.amount), 0)                             AS total_payments,
        u.name                                                  AS owner_admin_name
      FROM providers p
      LEFT JOIN purchase_orders po
        ON po.provider_id = p.id AND po.status <> 'cancelled'
      LEFT JOIN provider_payments pp
        ON pp.provider_id = p.id
      LEFT JOIN users u
        ON u.id = p.owner_admin_id
      WHERE p.id = $1 ${tc.clause}
      GROUP BY p.id, u.name
    `, [id, ...tc.params]);

    if (result.rowCount === 0) {
      if (!req.isSuperAdmin) {
        const exists = await db.query("SELECT id FROM providers WHERE id = $1", [id]);
        if (exists.rowCount) return res.status(403).json({ message: "No autorizado" });
      }
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("GET PROVIDER BY ID ERROR:", error);
    res.status(500).json({ message: "Error al obtener proveedor" });
  }
};

// ─────────────────────────────────────────────
// POST /providers
// ─────────────────────────────────────────────
exports.create = async (req, res) => {
  const {
    name, category, phone, email, address, contact_person,
    tax_id, credit_limit, payment_terms_days, lead_time_days, notes,
  } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ message: "El nombre del proveedor es obligatorio." });
  }

  const ownerAdminId = req.isSuperAdmin ? null : req.adminId;

  try {
    const result = await db.query(
      `INSERT INTO providers
         (name, category, phone, email, address, contact_person, tax_id,
          credit_limit, payment_terms_days, lead_time_days, notes,
          created_by, owner_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        name.trim(), category,
        phone || null, email || null, address || null,
        contact_person || null, tax_id || null,
        credit_limit || 0, payment_terms_days || 30,
        lead_time_days || 7, notes || null,
        req.user.id, ownerAdminId,
      ]
    );

    emitDataUpdate("providers", "created", result.rows[0], req.adminId);
    res.status(201).json({ message: "Proveedor creado exitosamente", provider: result.rows[0] });
  } catch (error) {
    console.error("CREATE PROVIDER ERROR:", error);
    res.status(500).json({ message: "Error al crear proveedor" });
  }
};

// ─────────────────────────────────────────────
// PUT /providers/:id
// ─────────────────────────────────────────────
exports.update = async (req, res) => {
  const { id } = req.params;
  const {
    name, category, phone, email, address, contact_person, tax_id,
    credit_limit, payment_terms_days, lead_time_days,
    reliability_score, is_active, notes,
  } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ message: "El nombre del proveedor es obligatorio." });
  }

  try {
    const owns = await _checkOwnership(req, id);
    if (owns === "not_found") return res.status(404).json({ message: "Proveedor no encontrado" });
    if (owns === "forbidden") return res.status(403).json({ message: "No autorizado para modificar este proveedor" });

    const result = await db.query(
      `UPDATE providers SET
         name               = $1,
         category           = $2,
         phone              = $3,
         email              = $4,
         address            = $5,
         contact_person     = $6,
         tax_id             = $7,
         credit_limit       = $8,
         payment_terms_days = $9,
         lead_time_days     = $10,
         reliability_score  = $11,
         is_active          = $12,
         notes              = $13,
         updated_at         = NOW()
       WHERE id = $14
       RETURNING *`,
      [
        name.trim(), category,
        phone || null, email || null, address || null,
        contact_person || null, tax_id || null,
        credit_limit ?? 0, payment_terms_days ?? 30, lead_time_days ?? 7,
        reliability_score ?? 5, is_active ?? true,
        notes || null, id,
      ]
    );

    emitDataUpdate("providers", "updated", result.rows[0], req.adminId);
    res.json({ message: "Proveedor actualizado exitosamente", provider: result.rows[0] });
  } catch (error) {
    console.error("UPDATE PROVIDER ERROR:", error);
    res.status(500).json({ message: "Error al actualizar proveedor" });
  }
};

// ─────────────────────────────────────────────
// PATCH /providers/:id/toggle-active
// ─────────────────────────────────────────────
exports.toggleActive = async (req, res) => {
  const { id } = req.params;

  try {
    const owns = await _checkOwnership(req, id);
    if (owns === "not_found") return res.status(404).json({ message: "Proveedor no encontrado" });
    if (owns === "forbidden") return res.status(403).json({ message: "No autorizado" });

    const result = await db.query(
      `UPDATE providers SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1 RETURNING id, name, is_active`,
      [id]
    );

    const { name, is_active } = result.rows[0];
    emitDataUpdate("providers", "updated", result.rows[0], req.adminId);
    res.json({
      message:  `Proveedor "${name}" ${is_active ? "activado" : "desactivado"} exitosamente`,
      provider: result.rows[0],
    });
  } catch (error) {
    console.error("TOGGLE ACTIVE ERROR:", error);
    res.status(500).json({ message: "Error al cambiar estado del proveedor" });
  }
};

// ─────────────────────────────────────────────
// DELETE /providers/:id
// ─────────────────────────────────────────────
exports.remove = async (req, res) => {
  const { id } = req.params;

  try {
    const owns = await _checkOwnership(req, id);
    if (owns === "not_found") return res.status(404).json({ message: "Proveedor no encontrado" });
    if (owns === "forbidden") return res.status(403).json({ message: "No autorizado para eliminar este proveedor" });

    const ordersCheck = await db.query(
      "SELECT COUNT(*) AS count FROM purchase_orders WHERE provider_id = $1", [id]
    );
    if (parseInt(ordersCheck.rows[0].count) > 0) {
      return res.status(400).json({
        message: "No se puede eliminar: el proveedor tiene órdenes de compra asociadas. Considere desactivarlo.",
      });
    }

    await db.query("DELETE FROM providers WHERE id = $1", [id]);
    emitDataUpdate("providers", "deleted", { id: parseInt(id) }, req.adminId);
    res.json({ message: "Proveedor eliminado exitosamente" });
  } catch (error) {
    console.error("DELETE PROVIDER ERROR:", error);
    res.status(500).json({ message: "Error al eliminar proveedor" });
  }
};

// ─────────────────────────────────────────────
// POST /providers/payments
// ─────────────────────────────────────────────
exports.registerPayment = async (req, res) => {
  const { provider_id, amount, payment_method, reference_number, notes, purchase_order_id } = req.body;

  if (!provider_id || !amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ message: "Datos de pago inválidos." });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const ownerClause = req.isSuperAdmin ? "" : "AND owner_admin_id = $2";
    const checkParams = req.isSuperAdmin ? [provider_id] : [provider_id, req.adminId];

    const providerRes = await client.query(
      `SELECT id, name, balance FROM providers WHERE id = $1 ${ownerClause} FOR UPDATE`,
      checkParams
    );

    if (providerRes.rowCount === 0) {
      const exists = await client.query("SELECT id FROM providers WHERE id = $1", [provider_id]);
      throw {
        status:  exists.rowCount ? 403 : 404,
        message: exists.rowCount ? "No autorizado para operar con este proveedor" : "Proveedor no encontrado",
      };
    }

    const currentBalance = parseFloat(providerRes.rows[0].balance);
    if (parseFloat(amount) > currentBalance) {
      throw { status: 400, message: "El monto excede el saldo pendiente del proveedor" };
    }

    await client.query(
      `INSERT INTO provider_payments
         (provider_id, purchase_order_id, amount, payment_method, reference_number, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [provider_id, purchase_order_id || null, amount, payment_method,
       reference_number || null, notes || null, req.user.id]
    );

    await client.query(
      "UPDATE providers SET balance = balance - $1, updated_at = NOW() WHERE id = $2",
      [amount, provider_id]
    );

    if (purchase_order_id) {
      const orderRes = await client.query(
        "SELECT total_cost FROM purchase_orders WHERE id = $1", [purchase_order_id]
      );
      if (orderRes.rowCount > 0) {
        const totalCost = parseFloat(orderRes.rows[0].total_cost);
        const paidRes   = await client.query(
          "SELECT COALESCE(SUM(amount),0) AS total_paid FROM provider_payments WHERE purchase_order_id = $1",
          [purchase_order_id]
        );
        const totalPaid = parseFloat(paidRes.rows[0].total_paid);
        const newStatus = totalPaid >= totalCost ? "paid" : totalPaid > 0 ? "partial" : "pending";
        await client.query(
          "UPDATE purchase_orders SET payment_status = $1 WHERE id = $2", [newStatus, purchase_order_id]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ message: "Pago registrado exitosamente", new_balance: currentBalance - parseFloat(amount) });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("REGISTER PAYMENT ERROR:", error);
    res.status(error.status || 500).json({ message: error.message || "Error al registrar pago" });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// GET /providers/:id/payments
// ─────────────────────────────────────────────
exports.getPaymentHistory = async (req, res) => {
  const { id } = req.params;
  const { start_date, end_date } = req.query;

  try {
    const owns = await _checkOwnership(req, id);
    if (owns === "not_found") return res.status(404).json({ message: "Proveedor no encontrado" });
    if (owns === "forbidden") return res.status(403).json({ message: "No autorizado" });

    let query = `
      SELECT pp.*, po.order_number, u.name AS registered_by
      FROM provider_payments pp
      LEFT JOIN purchase_orders po ON po.id = pp.purchase_order_id
      LEFT JOIN users u            ON u.id  = pp.created_by
      WHERE pp.provider_id = $1
    `;
    const params = [id];
    let idx = 2;

    if (start_date) { query += ` AND pp.created_at >= $${idx++}`; params.push(start_date); }
    if (end_date)   { query += ` AND pp.created_at <= $${idx++}`; params.push(end_date); }
    query += " ORDER BY pp.created_at DESC";

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("GET PAYMENT HISTORY ERROR:", error);
    res.status(500).json({ message: "Error al obtener historial de pagos" });
  }
};

// ─────────────────────────────────────────────
// GET /providers/:id/purchases
// ─────────────────────────────────────────────
exports.getPurchaseHistory = async (req, res) => {
  const { id } = req.params;
  const { start_date, end_date, status } = req.query;

  try {
    const owns = await _checkOwnership(req, id);
    if (owns === "not_found") return res.status(404).json({ message: "Proveedor no encontrado" });
    if (owns === "forbidden") return res.status(403).json({ message: "No autorizado" });

    let query = `SELECT * FROM v_purchase_orders_summary WHERE provider_id = $1`;
    const params = [id];
    let idx = 2;

    if (start_date) { query += ` AND order_date >= $${idx++}`; params.push(start_date); }
    if (end_date)   { query += ` AND order_date <= $${idx++}`; params.push(end_date); }
    if (status)     { query += ` AND status = $${idx++}`;      params.push(status); }
    query += " ORDER BY order_date DESC";

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("GET PURCHASE HISTORY ERROR:", error);
    res.status(500).json({ message: "Error al obtener historial de compras" });
  }
};

// ─────────────────────────────────────────────
// GET /providers/price-comparison?product_id=X
// ─────────────────────────────────────────────
exports.getPriceComparison = async (req, res) => {
  const { product_id } = req.query;
  if (!product_id) {
    return res.status(400).json({ message: "product_id es requerido" });
  }

  try {
    const tc = tenantClause(req, "prov", 2);

    const result = await db.query(
      `SELECT
         prov.id              AS provider_id,
         prov.name            AS provider_name,
         prov.category,
         prov.reliability_score,
         prov.lead_time_days,
         poi.unit_cost        AS last_price,
         po.order_date        AS last_order_date,
         AVG(poi.unit_cost)   AS avg_price,
         MIN(poi.unit_cost)   AS min_price,
         MAX(poi.unit_cost)   AS max_price,
         COUNT(DISTINCT po.id) AS times_purchased
       FROM providers prov
       JOIN purchase_orders po
         ON po.provider_id = prov.id AND po.status != 'cancelled'
       JOIN purchase_order_items poi
         ON poi.purchase_order_id = po.id AND poi.product_id = $1
       WHERE 1=1 ${tc.clause}
       GROUP BY prov.id, prov.name, prov.category, prov.reliability_score,
                prov.lead_time_days, poi.unit_cost, po.order_date
       ORDER BY prov.name, po.order_date DESC`,
      [product_id, ...tc.params]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("GET PRICE COMPARISON ERROR:", error);
    res.status(500).json({ message: "Error al obtener comparación de precios" });
  }
};

// ─────────────────────────────────────────────
// GET /providers/:id/stats
// ─────────────────────────────────────────────
exports.getStats = async (req, res) => {
  const { id } = req.params;

  try {
    const owns = await _checkOwnership(req, id);
    if (owns === "not_found") return res.status(404).json({ message: "Proveedor no encontrado" });
    if (owns === "forbidden") return res.status(403).json({ message: "No autorizado" });

    const [ordersRes, paymentsRes, topProductsRes] = await Promise.all([
      db.query(
        `SELECT
           COUNT(DISTINCT po.id)                                              AS total_orders,
           COUNT(DISTINCT CASE WHEN po.status = 'received'  THEN po.id END)  AS completed_orders,
           COUNT(DISTINCT CASE WHEN po.status = 'pending'   THEN po.id END)  AS pending_orders,
           COALESCE(SUM(CASE WHEN po.status = 'received' THEN po.total_cost ELSE 0 END), 0) AS total_spent,
           AVG(CASE WHEN po.status = 'received' THEN po.total_cost END)      AS avg_order_value
         FROM purchase_orders po
         WHERE po.provider_id = $1`,
        [id]
      ),
      db.query(
        `SELECT
           COALESCE(SUM(amount), 0) AS total_paid,
           (SELECT balance FROM providers WHERE id = $1) AS current_balance
         FROM provider_payments WHERE provider_id = $1`,
        [id]
      ),
      db.query(
        `SELECT p.id, p.name, p.sku,
           SUM(poi.quantity)  AS total_quantity,
           AVG(poi.unit_cost) AS avg_cost
         FROM purchase_order_items poi
         JOIN products p         ON p.id  = poi.product_id
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE po.provider_id = $1 AND po.status != 'cancelled'
         GROUP BY p.id, p.name, p.sku
         ORDER BY total_quantity DESC LIMIT 10`,
        [id]
      ),
    ]);

    res.json({
      summary: {
        ...ordersRes.rows[0],
        total_paid:      paymentsRes.rows[0].total_paid,
        current_balance: paymentsRes.rows[0].current_balance,
      },
      top_products: topProductsRes.rows,
    });
  } catch (error) {
    console.error("GET PROVIDER STATS ERROR:", error);
    res.status(500).json({ message: "Error al obtener estadísticas" });
  }
};

// ─────────────────────────────────────────────
// PATCH /providers/:id/purchase-orders/:orderId/receive
// Recibe una PO — bifurca entre ítems on_demand (solo costo) e ítems de stock.
// ─────────────────────────────────────────────
exports.receivePurchaseOrder = async (req, res) => {
  const { orderId } = req.params;
  // received_quantities: { [purchase_order_item_id]: qty_received }
  // actual_unit_costs:   { [purchase_order_item_id]: unit_cost }
  // Si no se envía received_quantities, se asume "recibir todo".
  const { received_quantities, actual_unit_costs } = req.body;

  try {
    // Fetch PO items to build the items array for the service
    const ownerClause = req.isSuperAdmin ? "" : "AND po.owner_admin_id = $2";
    const checkParams = req.isSuperAdmin ? [orderId] : [orderId, req.adminId];

    const { rows: poItems, rowCount: poExists } = await db.query(
      `SELECT poi.id, poi.quantity, poi.received_quantity, poi.unit_cost,
              po.provider_id, po.order_number, po.status
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE poi.purchase_order_id = $1 ${ownerClause}`,
      checkParams
    );

    if (!poExists) {
      const exists = await db.query("SELECT id FROM purchase_orders WHERE id = $1", [orderId]);
      return res.status(exists.rowCount ? 403 : 404).json({
        message: exists.rowCount ? "No autorizado" : "Orden no encontrada",
      });
    }

    const po = poItems[0]; // status and order info from first row
    if (po?.status === "received")
      return res.status(400).json({ message: "Esta orden ya fue recibida anteriormente" });
    if (po?.status === "cancelled")
      return res.status(400).json({ message: "No se puede recibir una orden cancelada" });

    // Build items array expected by procurementService.receivePurchaseOrder
    const items = poItems.map(item => {
      const maxPending = Math.max(0, item.quantity - (item.received_quantity || 0));
      const receivedQty = received_quantities
        ? Math.min(Math.max(0, parseInt(received_quantities[item.id] ?? 0) || 0), maxPending)
        : maxPending;
      const actualUnitCost = actual_unit_costs?.[item.id] ?? item.unit_cost;
      return { poItemId: item.id, actualUnitCost, receivedQty };
    }).filter(i => i.receivedQty > 0);

    if (!items.length) {
      return res.status(400).json({ message: "No hay cantidades válidas para recibir" });
    }

    const result = await procSvc.receivePurchaseOrder(
      parseInt(orderId), items, req.user.id, req.isSuperAdmin ? null : req.adminId
    );

    emitDataUpdate("purchase_orders", "updated", { id: parseInt(orderId), status: "received" }, req.adminId);

    res.json({
      success: true,
      message: `Orden recibida exitosamente`,
      data:    result,
    });
  } catch (error) {
    console.error("RECEIVE PO ERROR:", error);
    res.status(error.status || 500).json({ message: error.message || "Error al recibir la orden" });
  }
};

// ─────────────────────────────────────────────
// HELPER PRIVADO
// ─────────────────────────────────────────────
const _checkOwnership = async (req, id) => {
  if (req.isSuperAdmin) {
    const r = await db.query("SELECT id FROM providers WHERE id = $1", [id]);
    return r.rowCount ? "ok" : "not_found";
  }

  const r = await db.query(
    "SELECT id, owner_admin_id FROM providers WHERE id = $1", [id]
  );
  if (!r.rowCount) return "not_found";
  if (String(r.rows[0].owner_admin_id) !== String(req.adminId)) return "forbidden";
  return "ok";
};

module.exports = exports;