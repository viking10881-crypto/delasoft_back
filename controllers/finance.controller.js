// controllers/finance.controller.js
"use strict";
const pool            = require("../config/db");
const invSvc          = require("../services/inventory.service");
const { emitDataUpdate } = require("../config/socket");
const fmtNum = (v) => parseFloat(v) || 0;

// ─────────────────────────────────────────────
// Helper de scope — igual que en providers
// ─────────────────────────────────────────────
const tc = (req, alias, startIdx = 1) => {
  if (req.isSuperAdmin) return { clause: "", params: [], next: startIdx };
  const col = alias ? `${alias}.owner_admin_id` : "owner_admin_id";
  return {
    clause: `AND ${col} = $${startIdx}`,
    params: [req.adminId],
    next:   startIdx + 1,
  };
};

// ============================================================
// 📊 RESUMEN FINANCIERO
// ============================================================
exports.getSummary = async (req, res) => {
  const { start_date, end_date } = req.query;
  const hasFilter = start_date && end_date;

  // Scope por tenant
  const saleScope    = tc(req, "s",    hasFilter ? 3 : 1);
  const invoiceScope = tc(req, "i",    hasFilter ? 3 : 1);
  const expScope     = tc(req, "e",    hasFilter ? 3 : 1);
  const provScope    = tc(req, "p",    1);
  const invScope     = tc(req, "prod", 1);

  const dateParams = hasFilter ? [start_date, end_date] : [];

  const salesDateFilter    = hasFilter ? "AND s.sale_date BETWEEN $1 AND $2"    : "";
  const invoiceDateFilter  = hasFilter ? "AND i.invoice_date BETWEEN $1 AND $2" : "";
  const expDateFilter      = hasFilter ? "AND e.expense_date BETWEEN $1 AND $2" : "";

  try {
    const [salesR, invoicesR, pendingR, inventoryR, expR, provR] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(s.total), 0)                    AS total_sales,
           COALESCE(SUM(si.unit_cost * si.quantity), 0) AS total_cogs,
           COUNT(DISTINCT s.id)                          AS sales_count
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         WHERE s.payment_status = 'paid'
           ${salesDateFilter} ${saleScope.clause}`,
        [...dateParams, ...saleScope.params]
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN i.invoice_type = 'service'  THEN i.total_amount - i.pending_amount ELSE 0 END), 0) AS services_paid,
           COALESCE(SUM(CASE WHEN i.invoice_type = 'purchase' THEN i.total_amount - i.pending_amount ELSE 0 END), 0) AS purchases_paid,
           COUNT(*) AS invoices_count
         FROM invoices i
         WHERE 1=1 ${invoiceDateFilter} ${invoiceScope.clause}`,
        [...dateParams, ...invoiceScope.params]
      ),
      pool.query(
        `SELECT COALESCE(SUM(pending_amount), 0) AS total_pending
         FROM invoices i
         WHERE payment_status != 'paid' ${tc(req, "i", 1).clause}`,
        tc(req, "i", 1).params
      ),
      pool.query(
        `SELECT COALESCE(SUM(prod.stock * COALESCE(prod.purchase_price,0)), 0) AS inventory_value,
                COUNT(*) AS products_count
         FROM products prod
         WHERE prod.is_active = true ${invScope.clause}`,
        invScope.params
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_expenses
         FROM expenses e
         WHERE 1=1 ${expDateFilter} ${expScope.clause}`,
        [...dateParams, ...expScope.params]
      ),
      pool.query(
        `SELECT COALESCE(SUM(balance), 0) AS provider_total,
                COUNT(*) FILTER (WHERE balance > 0) AS providers_with_debt
         FROM providers p
         WHERE p.is_active = true ${provScope.clause}`,
        provScope.params
      ),
    ]);

    const sales   = salesR.rows[0];
    const inv2    = invoicesR.rows[0];
    const pending = pendingR.rows[0];
    const invt    = inventoryR.rows[0];
    const exp     = expR.rows[0];
    const prov    = provR.rows[0];

    const totalSales  = fmtNum(sales.total_sales);
    const cogs        = fmtNum(sales.total_cogs);
    const grossProfit = totalSales - cogs;
    const opExpenses  = fmtNum(inv2.services_paid) + fmtNum(exp.total_expenses);
    const netProfit   = grossProfit - opExpenses;

    res.json({
      revenue: { total: totalSales, sales_count: parseInt(sales.sales_count || 0), cogs },
      profitability: {
        gross_profit:     grossProfit,
        gross_margin_pct: totalSales > 0 ? +((grossProfit / totalSales) * 100).toFixed(2) : 0,
        net_profit:       netProfit,
        net_margin_pct:   totalSales > 0 ? +((netProfit / totalSales) * 100).toFixed(2) : 0,
      },
      expenses: {
        operating: opExpenses,
        services:  fmtNum(inv2.services_paid),
        purchases: fmtNum(inv2.purchases_paid),
        direct:    fmtNum(exp.total_expenses),
      },
      debt: {
        pending_invoices:    fmtNum(pending.total_pending),
        provider_total:      fmtNum(prov.provider_total),
        providers_with_debt: parseInt(prov.providers_with_debt || 0),
      },
      assets: {
        inventory_value: fmtNum(invt.inventory_value),
        products_count:  parseInt(invt.products_count || 0),
      },
    });
  } catch (err) {
    console.error("[FINANCE] getSummary:", err);
    res.status(500).json({ message: "Error al obtener resumen financiero" });
  }
};

// ============================================================
// 📄 LISTAR FACTURAS
// ============================================================
exports.getInvoices = async (req, res) => {
  const { type, status, start_date, end_date, limit = 100, offset = 0 } = req.query;
  const where = []; const params = []; let i = 1;

  // Scope de tenant al inicio
  const scope = tc(req, "i", i);
  if (scope.clause) { where.push(scope.clause.replace("AND ", "")); params.push(...scope.params); i = scope.next; }

  if (type)                   { where.push(`i.invoice_type = $${i}`);                            params.push(type);            i++; }
  if (status)                 { where.push(`i.payment_status = $${i}`);                          params.push(status);          i++; }
  if (start_date && end_date) { where.push(`i.invoice_date BETWEEN $${i} AND $${i+1}`);          params.push(start_date, end_date); i += 2; }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const { rows } = await pool.query(
      `SELECT i.*,
              p.name AS provider_name,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'product_id', ii.product_id, 'product_name', prod.name,
                  'quantity', ii.quantity, 'unit_price', ii.unit_price, 'subtotal', ii.subtotal
                ))
                FROM invoice_items ii
                LEFT JOIN products prod ON prod.id = ii.product_id
                WHERE ii.invoice_id = i.id
              ), '[]'::json) AS items
       FROM invoices i
       LEFT JOIN providers p ON p.id = i.provider_id
       ${whereClause}
       ORDER BY i.invoice_date DESC, i.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json(rows);
  } catch (err) {
    console.error("[FINANCE] getInvoices:", err);
    res.status(500).json({ message: "Error al obtener facturas" });
  }
};

// ============================================================
// ➕ CREAR FACTURA
// ============================================================
exports.createInvoice = async (req, res) => {
  const {
    invoice_type, provider_id, invoice_number, invoice_date,
    due_date, description, items = [], total_amount, payment_method, notes,
  } = req.body;

  if (!invoice_type || !["service", "purchase"].includes(invoice_type))
    return res.status(400).json({ message: "Tipo de factura inválido" });
  if (!total_amount || total_amount <= 0)
    return res.status(400).json({ message: "El monto debe ser mayor a 0" });
  if (invoice_type === "purchase" && (!items?.length || !provider_id))
    return res.status(400).json({ message: "Las compras requieren proveedor e items" });

  const ownerAdminId = req.isSuperAdmin ? null : req.adminId;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows: [inv] } = await client.query(
      `INSERT INTO invoices
         (invoice_type, provider_id, invoice_number, invoice_date, due_date,
          description, total_amount, pending_amount, payment_status,
          payment_method, notes, created_by, owner_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        invoice_type, provider_id || null, invoice_number || null,
        invoice_date || new Date(), due_date || null,
        description || "Factura registrada", total_amount,
        payment_method === "credit" ? total_amount : 0,
        payment_method === "credit" ? "pending" : "paid",
        payment_method || "cash", notes || null,
        req.user?.id || null, ownerAdminId,
      ]
    );

    if (invoice_type === "purchase" && items.length > 0) {
      for (const item of items) {
        const { product_id, variant_id, quantity, unit_price } = item;
        if (!product_id || !quantity || !unit_price) throw new Error("Item incompleto");

        await client.query(
          `INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, subtotal)
           VALUES ($1,$2,$3,$4,$5)`,
          [inv.id, product_id, quantity, unit_price, quantity * unit_price]
        );

        const { rows: [prod] } = await client.query(
          `SELECT has_variants, purchase_price, sale_price FROM products WHERE id = $1`,
          [product_id]
        );

        // Stock movement through inventory service (ledger + FOR UPDATE)
        await invSvc.applyStockMovement(
          client,
          { productId: product_id, variantId: variant_id || null, quantity },
          +1, 'purchase_received',
          { ownerAdminId, userId: req.user?.id ?? 0,
            referenceType: 'invoice', referenceId: inv.id,
            notes: `Factura de compra` }
        );
        // purchase_price is a pricing update — separate from stock movement
        await client.query(
          `UPDATE products SET purchase_price = $1, updated_at = NOW() WHERE id = $2`,
          [unit_price, product_id]
        );

        if (prod && fmtNum(prod.purchase_price) !== fmtNum(unit_price)) {
          await client.query(
            `INSERT INTO product_price_history
               (product_id, old_purchase_price, new_purchase_price, old_sale_price, new_sale_price, reason, changed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [product_id, prod.purchase_price, unit_price, prod.sale_price, prod.sale_price, "Factura de compra", req.user?.id || null]
          );
        }
      }
    }

    if (payment_method === "credit" && provider_id) {
      await client.query(
        `UPDATE providers SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [total_amount, provider_id]
      );
    }

    await client.query("COMMIT");
    emitDataUpdate("invoices", "created", { id: inv.id, invoice_type }, req.adminId);
    res.status(201).json({
      message:    invoice_type === "service" ? "Factura de servicio registrada" : "Compra registrada",
      invoice_id: inv.id,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[FINANCE] createInvoice:", err);
    res.status(500).json({ message: err.message || "Error al crear factura" });
  } finally {
    client.release();
  }
};

// ============================================================
// 💳 PAGAR FACTURA
// ============================================================
exports.payInvoice = async (req, res) => {
  const { invoice_id, amount, payment_method, payment_date, notes } = req.body;
  if (!invoice_id || !amount || amount <= 0)
    return res.status(400).json({ message: "Datos de pago incompletos" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verificar que la factura pertenece al tenant
    const scope = tc(req, "i", 2);
    const { rows } = await client.query(
      `SELECT * FROM invoices i WHERE i.id = $1 ${scope.clause}`,
      [invoice_id, ...scope.params]
    );
    if (!rows.length) {
      const exists = await client.query("SELECT id FROM invoices WHERE id = $1", [invoice_id]);
      throw { status: exists.rowCount ? 403 : 404, message: exists.rowCount ? "No autorizado" : "Factura no encontrada" };
    }

    const invoice = rows[0];
    if (invoice.payment_status === "paid") throw new Error("Factura ya pagada");
    if (amount > invoice.pending_amount)   throw new Error("Monto supera lo pendiente");

    await client.query(
      `INSERT INTO invoice_payments (invoice_id, amount, payment_method, payment_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [invoice_id, amount, payment_method || "cash", payment_date || new Date(), notes || null, req.user?.id || null]
    );

    const newPending = fmtNum(invoice.pending_amount) - fmtNum(amount);
    const newStatus  = newPending <= 0 ? "paid" : newPending < fmtNum(invoice.total_amount) ? "partial" : "pending";

    await client.query(
      `UPDATE invoices SET pending_amount = $1, payment_status = $2, updated_at = NOW() WHERE id = $3`,
      [newPending, newStatus, invoice_id]
    );

    if (invoice.provider_id) {
      await client.query(
        `UPDATE providers SET balance = GREATEST(0, balance - $1), updated_at = NOW() WHERE id = $2`,
        [amount, invoice.provider_id]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "Pago registrado", new_pending: newPending, new_status: newStatus });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[FINANCE] payInvoice:", err);
    res.status(err.status || 500).json({ message: err.message || "Error al registrar pago" });
  } finally {
    client.release();
  }
};

// ============================================================
// 💳 PAGO DIRECTO A PROVEEDOR
// ============================================================
exports.payProvider = async (req, res) => {
  const { provider_id, amount, payment_method, notes } = req.body;
  if (!provider_id || !amount || amount <= 0)
    return res.status(400).json({ message: "Datos de pago incompletos" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verificar que el proveedor pertenece al tenant
    const scope = tc(req, "p", 2);
    const { rows } = await client.query(
      `SELECT id, name, balance FROM providers p
       WHERE p.id = $1 AND p.is_active = true ${scope.clause}`,
      [provider_id, ...scope.params]
    );
    if (!rows.length) {
      const exists = await client.query("SELECT id FROM providers WHERE id = $1", [provider_id]);
      throw { status: exists.rowCount ? 403 : 404, message: exists.rowCount ? "No autorizado" : "Proveedor no encontrado" };
    }

    const provider = rows[0];
    if (fmtNum(amount) > fmtNum(provider.balance)) throw new Error("Monto supera la deuda actual");

    await client.query(
      `INSERT INTO provider_payments (provider_id, amount, payment_method, notes, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [provider_id, amount, payment_method || "transfer", notes || null, req.user?.id || null]
    );
    await client.query(
      `UPDATE providers SET balance = GREATEST(0, balance - $1), updated_at = NOW() WHERE id = $2`,
      [amount, provider_id]
    );

    await client.query("COMMIT");
    res.json({
      message:     `Pago registrado para ${provider.name}`,
      new_balance: Math.max(0, fmtNum(provider.balance) - fmtNum(amount)),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[FINANCE] payProvider:", err);
    res.status(err.status || 500).json({ error: err.message || "Error al registrar pago" });
  } finally {
    client.release();
  }
};

// ============================================================
// 💸 CREAR GASTO
// ============================================================
exports.createExpense = async (req, res) => {
  const {
    expense_type, category, description, amount, payment_method,
    provider_id, product_id, quantity, utility_type, utility_value,
    notes, expense_date,
  } = req.body;

  if (!expense_type || !description || !amount || amount <= 0)
    return res.status(400).json({ message: "Datos del gasto incompletos" });

  const ownerAdminId = req.isSuperAdmin ? null : req.adminId;

  try {
    const { rows: [exp] } = await pool.query(
      `INSERT INTO expenses
         (expense_type, category, description, amount, payment_method,
          provider_id, product_id, quantity, utility_type, utility_value,
          notes, expense_date, created_by, owner_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        expense_type, category || null, description, amount,
        payment_method || "cash", provider_id || null, product_id || null,
        quantity || 1, utility_type || null, utility_value || 0,
        notes || null, expense_date || new Date(),
        req.user?.id || null, ownerAdminId,
      ]
    );

    if (expense_type === "purchase" && product_id && quantity > 0) {
      // Pricing metadata update (not a stock movement)
      await pool.query(
        `UPDATE products SET purchase_price = $1, updated_at = NOW() WHERE id = $2`,
        [amount / quantity, product_id]
      );
      // Stock movement in its own mini-transaction (expense has no surrounding tx)
      const sc = await pool.connect();
      try {
        await sc.query('BEGIN');
        const { rows: [pRow] } = await sc.query(
          `SELECT owner_admin_id FROM products WHERE id = $1`, [product_id]
        );
        if (pRow) {
          await invSvc.applyStockMovement(
            sc,
            { productId: product_id, variantId: null, quantity },
            +1, 'purchase_received',
            { ownerAdminId: pRow.owner_admin_id, userId: req.user?.id ?? 0,
              referenceType: 'expense', referenceId: exp.id,
              notes: description }
          );
        }
        await sc.query('COMMIT');
      } catch (se) {
        await sc.query('ROLLBACK');
        console.error('[finance] expense stock ledger failed:', se.message);
      } finally {
        sc.release();
      }
    }

    emitDataUpdate("expenses", "created", { id: exp.id, expense_type }, req.adminId);
    res.status(201).json({ message: "Gasto registrado", expense_id: exp.id });
  } catch (err) {
    console.error("[FINANCE] createExpense:", err);
    res.status(500).json({ message: err.message || "Error al registrar gasto" });
  }
};

// ============================================================
// 📋 LISTAR GASTOS
// ============================================================
exports.getExpenses = async (req, res) => {
  const { type, start_date, end_date, limit = 200, offset = 0 } = req.query;
  const where = []; const params = []; let i = 1;

  // Scope de tenant al inicio
  const scope = tc(req, "e", i);
  if (scope.clause) { where.push(scope.clause.replace("AND ", "")); params.push(...scope.params); i = scope.next; }

  if (type)                   { where.push(`e.expense_type = $${i}`);                        params.push(type); i++; }
  if (start_date && end_date) { where.push(`e.expense_date BETWEEN $${i} AND $${i+1}`);      params.push(start_date, end_date); i += 2; }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const { rows } = await pool.query(
      `SELECT e.*, p.name AS provider_name, prod.name AS product_name
       FROM expenses e
       LEFT JOIN providers p    ON p.id    = e.provider_id
       LEFT JOIN products  prod ON prod.id = e.product_id
       ${whereClause}
       ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json(rows);
  } catch (err) {
    console.error("[FINANCE] getExpenses:", err);
    res.status(500).json({ message: "Error al obtener gastos" });
  }
};

// ============================================================
// 📊 GASTOS POR CATEGORÍA
// ============================================================
exports.getExpensesByCategory = async (req, res) => {
  const scope = tc(req, "e", 1);
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(e.category, e.expense_type::text) AS category,
         e.expense_type::text,
         COUNT(*)    AS count,
         SUM(amount) AS total
       FROM expenses e
       WHERE e.expense_date >= NOW() - INTERVAL '3 months'
         ${scope.clause}
       GROUP BY COALESCE(e.category, e.expense_type::text), e.expense_type
       ORDER BY total DESC`,
      scope.params
    );
    res.json(rows);
  } catch (err) {
    console.error("[FINANCE] getExpensesByCategory:", err);
    res.status(500).json({ message: "Error al obtener gastos por categoría" });
  }
};

// ============================================================
// 🏦 DEUDAS CON PROVEEDORES
// ============================================================
exports.getProviderDebts = async (req, res) => {
  const scope = tc(req, "p", 1);
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id, p.name, p.category::text, p.phone, p.email,
         p.balance AS current_balance, p.credit_limit,
         p.credit_limit - p.balance AS available_credit,
         CASE WHEN p.credit_limit > 0
           THEN ROUND((p.balance / p.credit_limit * 100)::numeric, 1)
           ELSE 0 END AS credit_used_pct,
         COUNT(DISTINCT CASE WHEN i.payment_status != 'paid' THEN i.id END) AS pending_invoices,
         COALESCE(SUM(CASE WHEN i.payment_status != 'paid' THEN i.pending_amount ELSE 0 END), 0) AS total_pending_invoices
       FROM providers p
       LEFT JOIN invoices i ON i.provider_id = p.id
       WHERE p.is_active = true AND p.balance > 0
         ${scope.clause}
       GROUP BY p.id ORDER BY p.balance DESC`,
      scope.params
    );
    res.json({
      providers: rows,
      summary: {
        total_debt:      rows.reduce((s, r) => s + fmtNum(r.current_balance), 0),
        providers_count: rows.length,
      },
    });
  } catch (err) {
    console.error("[FINANCE] getProviderDebts:", err);
    res.status(500).json({ message: "Error al obtener deudas" });
  }
};

// ============================================================
// 📈 ANÁLISIS DE PROVEEDORES
// ============================================================
exports.getProviderAnalysis = async (req, res) => {
  const scope = tc(req, "p", 1);
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id, p.name, p.category::text, p.reliability_score,
         COUNT(DISTINCT po.id)          AS total_orders,
         COALESCE(SUM(po.total_cost),0) AS total_spent,
         COALESCE(AVG(po.total_cost),0) AS avg_order_value,
         p.balance                      AS current_debt
       FROM providers p
       LEFT JOIN purchase_orders po ON po.provider_id = p.id AND po.status != 'cancelled'
       WHERE p.is_active = true ${scope.clause}
       GROUP BY p.id ORDER BY total_spent DESC LIMIT 10`,
      scope.params
    );
    res.json(rows);
  } catch (err) {
    console.error("[FINANCE] getProviderAnalysis:", err);
    res.status(500).json({ message: "Error al obtener análisis de proveedores" });
  }
};

// ============================================================
// 📈 FLUJO DE CAJA MENSUAL
// ============================================================
exports.getCashflow = async (req, res) => {
  const salScope = tc(req, "s",  1);
  const invScope = tc(req, "inv",1);
  const expScope = tc(req, "e",  1);

  try {
    const { rows } = await pool.query(`
      WITH monthly_data AS (
        SELECT DATE_TRUNC('month', s.sale_date) AS month_date,
               SUM(s.total) AS revenue, 0 AS costs
        FROM sales s
        WHERE s.payment_status = 'paid'
          AND s.sale_date >= NOW() - INTERVAL '6 months'
          ${salScope.clause}
        GROUP BY DATE_TRUNC('month', s.sale_date)

        UNION ALL

        SELECT DATE_TRUNC('month', inv.invoice_date) AS month_date,
               0 AS revenue, SUM(inv.total_amount - inv.pending_amount) AS costs
        FROM invoices inv
        WHERE inv.invoice_date >= NOW() - INTERVAL '6 months'
          ${invScope.clause}
        GROUP BY DATE_TRUNC('month', inv.invoice_date)

        UNION ALL

        SELECT DATE_TRUNC('month', e.expense_date::timestamp) AS month_date,
               0 AS revenue, SUM(e.amount) AS costs
        FROM expenses e
        WHERE e.expense_date >= NOW() - INTERVAL '6 months'
          ${expScope.clause}
        GROUP BY DATE_TRUNC('month', e.expense_date::timestamp)
      )
      SELECT
        TO_CHAR(month_date, 'Mon YY') AS month,
        COALESCE(SUM(revenue), 0)          AS revenue,
        COALESCE(SUM(costs), 0)            AS costs,
        COALESCE(SUM(revenue - costs), 0)  AS profit
      FROM monthly_data
      GROUP BY month_date
      ORDER BY month_date
    `, [...salScope.params, ...invScope.params, ...expScope.params]);

    res.json(rows);
  } catch (err) {
    console.error("[FINANCE] getCashflow:", err);
    res.status(500).json({ message: "Error al obtener flujo de caja" });
  }
};

// ============================================================
// 🏷️ RENTABILIDAD POR PRODUCTO
// ============================================================
exports.getProfitByProduct = async (req, res) => {
  const scope = tc(req, "p", 1);
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id, p.name, p.sku, p.stock,
         COALESCE(p.purchase_price, 0) AS cost_price,
         COALESCE(p.sale_price, 0)     AS sale_price,
         COALESCE(p.sale_price - p.purchase_price, 0) AS unit_profit,
         CASE WHEN COALESCE(p.sale_price, 0) > 0
           THEN ROUND(((p.sale_price - p.purchase_price) / p.sale_price * 100)::numeric, 2)
           ELSE 0 END AS margin_pct,
         COALESCE(s.units_sold, 0)    AS units_sold,
         COALESCE(s.total_revenue, 0) AS total_revenue,
         COALESCE(s.total_profit, 0)  AS realized_profit,
         p.stock * COALESCE(p.purchase_price, 0) AS inventory_value
       FROM products p
       LEFT JOIN (
         SELECT product_id, SUM(quantity) AS units_sold,
                SUM(subtotal) AS total_revenue, SUM(total_profit) AS total_profit
         FROM sale_items GROUP BY product_id
       ) s ON s.product_id = p.id
       WHERE p.is_active = true ${scope.clause}
       ORDER BY realized_profit DESC NULLS LAST
       LIMIT 100`,
      scope.params
    );
    res.json(rows);
  } catch (err) {
    console.error("[FINANCE] getProfitByProduct:", err);
    res.status(500).json({ message: "Error al obtener rentabilidad" });
  }
};

module.exports = exports;