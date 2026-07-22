// controllers/stats.controller.js
const pool = require("../config/db");

// ─────────────────────────────────────────────
// Helper de scope (tenant isolation)
// ─────────────────────────────────────────────
const tc = (isSuperAdmin, adminId, alias, startIdx = 1) => {
  if (isSuperAdmin) return { clause: "", params: [], next: startIdx };
  const col = alias ? `${alias}.owner_admin_id` : "owner_admin_id";
  return {
    clause: `AND ${col} = $${startIdx}`,
    params: [adminId],
    next:   startIdx + 1,
  };
};

const getDashboardStats = async (req, res) => {
  const { isSuperAdmin, adminId } = req;

  try {
    const [
      revenueVsExpenses,
      cashflow,
      topProducts,
      marginByCategory,
      paymentMethods,
      expensesByType,
      kpiSummary,
      providerDebt,
      lowStock,
      pendingOrders,
    ] = await Promise.all([
      getRevenueVsExpenses(isSuperAdmin, adminId),
      getCashflow12Months(isSuperAdmin, adminId),
      getTopProductsByProfit(isSuperAdmin, adminId),
      getMarginByCategory(isSuperAdmin, adminId),
      getPaymentMethodDistribution(isSuperAdmin, adminId),
      getExpensesByType(isSuperAdmin, adminId),
      getKpiSummary(isSuperAdmin, adminId),
      getProviderDebt(isSuperAdmin, adminId),
      getLowStockProducts(isSuperAdmin, adminId),
      getPendingOrders(isSuperAdmin, adminId),
    ]);

    res.json({
      revenueVsExpenses, cashflow, topProducts, marginByCategory,
      paymentMethods, expensesByType, kpiSummary, providerDebt,
      lowStock, pendingOrders,
    });
  } catch (err) {
    console.error("[STATS /dashboard]", err);
    res.status(500).json({ error: "Error al cargar estadísticas del dashboard" });
  }
};

// ── Ingresos vs Gastos — últimas 8 semanas ────────────────────────
async function getRevenueVsExpenses(isSuperAdmin, adminId) {
  // eScope continúa el índice donde sScope terminó para evitar colisión de $N
  const sScope = tc(isSuperAdmin, adminId, "s");
  const eScope = tc(isSuperAdmin, adminId, "e", sScope.next);

  const { rows } = await pool.query(`
    WITH weeks AS (SELECT generate_series(0, 7) AS w),
    week_ranges AS (
      SELECT w,
        CURRENT_DATE - ((w + 1) * 7) AS week_start,
        CURRENT_DATE - (w * 7)        AS week_end,
        'S' || (8 - w)                AS label
      FROM weeks
    ),
    sales_agg AS (
      SELECT wr.label, wr.w,
        COALESCE(SUM(s.total), 0) AS ingresos
      FROM week_ranges wr
      LEFT JOIN sales s
        ON s.sale_date::date >= wr.week_start
        AND s.sale_date::date < wr.week_end
        AND s.payment_status = 'paid'
        ${sScope.clause}
      GROUP BY wr.label, wr.w
    ),
    expenses_agg AS (
      SELECT wr.label, wr.w,
        COALESCE(SUM(e.amount), 0) AS gastos
      FROM week_ranges wr
      LEFT JOIN expenses e
        ON e.expense_date >= wr.week_start
        AND e.expense_date < wr.week_end
        ${eScope.clause}
      GROUP BY wr.label, wr.w
    )
    SELECT
      sa.label                           AS name,
      ROUND(sa.ingresos, 0)              AS ingresos,
      ROUND(ea.gastos, 0)                AS gastos,
      ROUND(sa.ingresos - ea.gastos, 0)  AS utilidad
    FROM sales_agg sa
    JOIN expenses_agg ea USING (label, w)
    ORDER BY sa.w DESC
  `, [...sScope.params, ...eScope.params]);

  return rows;
}

// ── Flujo de caja — últimos 12 meses ─────────────────────────────
async function getCashflow12Months(isSuperAdmin, adminId) {
  const sScope = tc(isSuperAdmin, adminId, "s");
  const eScope = tc(isSuperAdmin, adminId, "e", sScope.next);

  const { rows } = await pool.query(`
    SELECT
      TO_CHAR(month_start, 'Mon')     AS name,
      TO_CHAR(month_start, 'YYYY-MM') AS period,
      ROUND(COALESCE(SUM(CASE WHEN type = 'income'  THEN amount END), 0), 0) AS ingresos,
      ROUND(COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0), 0) AS gastos
    FROM (
      SELECT DATE_TRUNC('month', s.sale_date) AS month_start,
             'income' AS type, s.total AS amount
      FROM sales s
      WHERE s.payment_status = 'paid'
        AND s.sale_date >= NOW() - INTERVAL '12 months'
        ${sScope.clause}

      UNION ALL

      SELECT DATE_TRUNC('month', e.expense_date::timestamp) AS month_start,
             'expense' AS type, e.amount
      FROM expenses e
      WHERE e.expense_date >= NOW() - INTERVAL '12 months'
        ${eScope.clause}
    ) combined
    GROUP BY month_start
    ORDER BY month_start ASC
  `, [...sScope.params, ...eScope.params]);

  return rows;
}

// ── Top 6 productos por utilidad (variante-aware) ─────────────────
// La utilidad y unidades se suman desde sale_items (que incluye variant_id),
// agrupando por product_id para tener la vista consolidada por producto.
// Para productos con variantes se expone has_variants y el precio promedio
// de sus variantes activas; para productos simples, el precio directo.
async function getTopProductsByProfit(isSuperAdmin, adminId) {
  const scope = tc(isSuperAdmin, adminId, "p");

  const { rows } = await pool.query(`
    SELECT
      p.id,
      CASE
        WHEN LENGTH(p.name) > 16 THEN SUBSTRING(p.name, 1, 14) || '…'
        ELSE p.name
      END AS name,
      p.has_variants,
      p.is_bundle,
      -- Utilidad y unidades ya contemplan todas las variantes vendidas
      ROUND(COALESCE(SUM(si.total_profit), 0), 0) AS revenue,
      COALESCE(SUM(si.quantity), 0)::int           AS units,
      -- Precio de referencia: promedio de variantes activas o precio base
      CASE
        WHEN p.has_variants THEN
          ROUND(COALESCE((
            SELECT AVG(COALESCE(pv.sale_price, p.sale_price))
            FROM product_variants pv
            WHERE pv.product_id = p.id AND pv.is_active = true
          ), p.sale_price), 0)
        WHEN p.is_bundle THEN ROUND(COALESCE(p.bundle_price, p.sale_price), 0)
        ELSE ROUND(p.sale_price, 0)
      END AS price,
      -- Margen por unidad (sólo significativo en productos simples/bundle)
      CASE
        WHEN p.has_variants THEN NULL
        ELSE ROUND(p.sale_price - p.purchase_price, 0)
      END AS margin_per_unit,
      -- % margen sobre costo (sólo para productos sin variantes y con costo > 0)
      CASE
        WHEN NOT p.has_variants AND p.purchase_price > 0 THEN
          ROUND((p.sale_price - p.purchase_price) / p.purchase_price * 100, 1)
        ELSE NULL
      END AS margin_pct,
      -- Stock total: suma de variantes activas o stock simple
      CASE
        WHEN p.has_variants THEN
          COALESCE((
            SELECT SUM(pv.stock)
            FROM product_variants pv
            WHERE pv.product_id = p.id AND pv.is_active = true
          ), 0)
        ELSE p.stock
      END AS total_stock
    FROM products p
    LEFT JOIN sale_items si ON si.product_id = p.id
    WHERE p.is_active = true ${scope.clause}
    GROUP BY p.id, p.name, p.sale_price, p.purchase_price, p.has_variants,
             p.is_bundle, p.bundle_price, p.stock
    ORDER BY revenue DESC
    LIMIT 6
  `, scope.params);

  return rows;
}

// ── Margen por categoría ──────────────────────────────────────────
// Usa el precio base del producto; para categorías con variantes los
// precios de variante pueden diferir pero el precio base sigue siendo
// el ancla de la categoría.
async function getMarginByCategory(isSuperAdmin, adminId) {
  const scope = tc(isSuperAdmin, adminId, "p");

  const { rows } = await pool.query(`
    SELECT
      COALESCE(c.name, 'Sin categoría') AS name,
      ROUND(
        CASE WHEN SUM(p.sale_price) > 0
          THEN (SUM(p.sale_price - p.purchase_price) / SUM(p.sale_price)) * 100
          ELSE 0
        END, 1
      ) AS margin
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = true AND p.purchase_price > 0 AND NOT p.is_bundle
      ${scope.clause}
    GROUP BY c.name
    HAVING SUM(p.sale_price) > 0
    ORDER BY margin DESC
    LIMIT 6
  `, scope.params);

  return rows;
}

// ── Distribución de métodos de pago ──────────────────────────────
async function getPaymentMethodDistribution(isSuperAdmin, adminId) {
  const scope = tc(isSuperAdmin, adminId, "s");

  const { rows } = await pool.query(`
    SELECT
      COALESCE(s.payment_method::text, 'other') AS name,
      COUNT(*)::int                              AS value,
      ROUND(SUM(s.total), 0)                     AS total_amount
    FROM sales s
    WHERE s.payment_status = 'paid'
      AND s.created_at >= NOW() - INTERVAL '90 days'
      ${scope.clause}
    GROUP BY s.payment_method
    ORDER BY value DESC
  `, scope.params);

  return rows;
}

// ── Gastos por tipo (mes actual) ──────────────────────────────────
async function getExpensesByType(isSuperAdmin, adminId) {
  const scope = tc(isSuperAdmin, adminId, "e");

  const { rows } = await pool.query(`
    SELECT
      e.expense_type::text    AS name,
      ROUND(SUM(e.amount), 0) AS value,
      COUNT(*)::int           AS count
    FROM expenses e
    WHERE e.expense_date >= DATE_TRUNC('month', CURRENT_DATE)
      ${scope.clause}
    GROUP BY e.expense_type
    ORDER BY value DESC
  `, scope.params);

  return rows;
}

// ── KPIs de resumen ───────────────────────────────────────────────
async function getKpiSummary(isSuperAdmin, adminId) {
  // Cada subquery es independiente → cada una usa su propio scope con startIdx=1
  const sS  = tc(isSuperAdmin, adminId, "s");
  const eS  = tc(isSuperAdmin, adminId, "e");
  const pS  = tc(isSuperAdmin, adminId, "p");
  const prS = tc(isSuperAdmin, adminId, "pr");
  const poS = tc(isSuperAdmin, adminId, "po");

  const [
    salesToday, salesYesterday, monthSales, lastMonth,
    monthExpenses, inventory, lowStockCnt, pendingPO, providerDebt,
  ] = await Promise.all([

    pool.query(
      `SELECT COALESCE(SUM(s.total), 0) AS total FROM sales s
       WHERE s.sale_date::date = CURRENT_DATE AND s.payment_status = 'paid' ${sS.clause}`,
      sS.params
    ),

    pool.query(
      `SELECT COALESCE(SUM(s.total), 0) AS total FROM sales s
       WHERE s.sale_date::date = CURRENT_DATE - 1 AND s.payment_status = 'paid' ${sS.clause}`,
      sS.params
    ),

    pool.query(
      `SELECT COALESCE(SUM(s.total), 0) AS revenue,
              COALESCE(AVG(s.total), 0)  AS avg_ticket,
              COUNT(*)                    AS count
       FROM sales s
       WHERE DATE_TRUNC('month', s.sale_date) = DATE_TRUNC('month', NOW())
         AND s.payment_status = 'paid' ${sS.clause}`,
      sS.params
    ),

    pool.query(
      `SELECT COALESCE(SUM(s.total), 0) AS revenue FROM sales s
       WHERE DATE_TRUNC('month', s.sale_date) = DATE_TRUNC('month', NOW() - INTERVAL '1 month')
         AND s.payment_status = 'paid' ${sS.clause}`,
      sS.params
    ),

    pool.query(
      `SELECT COALESCE(SUM(e.amount), 0) AS total FROM expenses e
       WHERE DATE_TRUNC('month', e.expense_date::timestamp) = DATE_TRUNC('month', NOW())
         ${eS.clause}`,
      eS.params
    ),

    // ── Inventario variante-aware ─────────────────────────────────
    // Valor: para productos con variantes, suma stock_variante × precio_variante (fallback al precio base).
    // SKUs:  productos simples cuentan como 1; productos con variantes suman sus variantes activas.
    pool.query(
      `SELECT
         COALESCE(SUM(
           CASE WHEN p.has_variants THEN
             COALESCE((
               SELECT SUM(pv.stock * COALESCE(pv.sale_price, p.sale_price))
               FROM product_variants pv
               WHERE pv.product_id = p.id AND pv.is_active = true
             ), 0)
           ELSE p.stock * p.sale_price
           END
         ), 0) AS value,
         SUM(
           CASE WHEN p.has_variants THEN
             COALESCE((
               SELECT COUNT(*) FROM product_variants pv
               WHERE pv.product_id = p.id AND pv.is_active = true
             ), 0)
           ELSE 1
           END
         )::int AS sku_count
       FROM products p WHERE p.is_active = true ${pS.clause}`,
      pS.params
    ),

    // ── Conteo de items con stock bajo (variante-aware) ───────────
    // Para productos simples: stock del producto.
    // Para productos con variantes: cada variante cuenta individualmente.
    // La misma cláusula $1 aplica en ambas mitades de la UNION porque
    // ambas referencian p.owner_admin_id con el mismo parámetro.
    pool.query(
      `SELECT COUNT(*) AS cnt FROM (
         -- Productos sin variantes con stock bajo
         SELECT p.id::text AS uid
         FROM products p
         WHERE p.is_active = true
           AND p.has_variants = false
           AND p.stock <= COALESCE(p.min_stock, 5)
           ${pS.clause}

         UNION ALL

         -- Variantes con stock bajo
         SELECT (p.id::text || '-' || pv.id::text) AS uid
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         WHERE p.is_active = true
           AND p.has_variants = true
           AND pv.is_active = true
           AND pv.stock <= COALESCE(p.min_stock, 5)
           ${pS.clause}
       ) low_items`,
      pS.params
    ),

    pool.query(
      `SELECT COUNT(*) AS cnt FROM purchase_orders po
       WHERE po.status IN ('pending', 'draft') ${poS.clause}`,
      poS.params
    ),

    pool.query(
      `SELECT COALESCE(SUM(pr.balance), 0) AS total,
              COUNT(*) FILTER (WHERE pr.balance > 0) AS cnt
       FROM providers pr WHERE pr.is_active = true ${prS.clause}`,
      prS.params
    ),
  ]);

  const ms  = monthSales.rows[0];
  const me  = monthExpenses.rows[0];
  const inv = inventory.rows[0];
  const pd  = providerDebt.rows[0];

  return {
    sales_today:        Number(salesToday.rows[0].total),
    sales_yesterday:    Number(salesYesterday.rows[0].total),
    month_revenue:      Number(ms.revenue),
    last_month_revenue: Number(lastMonth.rows[0].revenue),
    avg_ticket:         Number(ms.avg_ticket),
    month_sales_count:  Number(ms.count),
    month_expenses:     Number(me.total),
    net_margin: Number(ms.revenue) > 0
      ? +((Number(ms.revenue) - Number(me.total)) / Number(ms.revenue) * 100).toFixed(1)
      : 0,
    inventory_value:  Number(inv.value),
    sku_count:        Number(inv.sku_count),
    low_stock_count:  Number(lowStockCnt.rows[0].cnt),
    pending_orders:   Number(pendingPO.rows[0].cnt),
    total_debt:       Number(pd.total),
    active_providers: Number(pd.cnt),
  };
}

// ── Deuda con proveedores ─────────────────────────────────────────
async function getProviderDebt(isSuperAdmin, adminId) {
  const scope = tc(isSuperAdmin, adminId, "p");

  const { rows } = await pool.query(`
    SELECT
      p.id, p.name, p.category::text,
      ROUND(p.balance, 0)      AS balance,
      ROUND(p.credit_limit, 0) AS credit_limit,
      p.payment_terms_days     AS terms,
      CASE WHEN p.credit_limit > 0
        THEN ROUND((p.balance / p.credit_limit) * 100, 1)
        ELSE 0
      END AS usage_pct
    FROM providers p
    WHERE p.balance > 0 AND p.is_active = true ${scope.clause}
    ORDER BY p.balance DESC
    LIMIT 6
  `, scope.params);

  return rows;
}

// ── Productos / variantes con stock bajo (variante-aware) ─────────
// Retorna una fila por cada item con stock bajo:
//   - Productos sin variantes → fila normal (variant_id = null)
//   - Productos con variantes → una fila por cada variante en stock bajo
//     con sus atributos concatenados en variant_attrs (ej. "Rojo / L")
async function getLowStockProducts(isSuperAdmin, adminId) {
  const scope = tc(isSuperAdmin, adminId, "p");

  const { rows } = await pool.query(`
    -- ── Productos simples con stock bajo ────────────────────────
    SELECT
      p.id,
      p.name,
      false                              AS has_variants,
      NULL::int                          AS variant_id,
      p.sku                              AS variant_sku,
      NULL::text                         AS variant_attrs,
      p.stock,
      p.min_stock,
      p.max_stock,
      COALESCE(c.name, 'Sin categoría')  AS category_name,
      CASE
        WHEN p.stock = 0            THEN 'out'
        WHEN p.stock <= p.min_stock THEN 'low'
        ELSE 'normal'
      END AS stock_status
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = true
      AND p.has_variants = false
      AND p.stock <= COALESCE(p.min_stock, 5)
      ${scope.clause}

    UNION ALL

    -- ── Variantes con stock bajo ──────────────────────────────────
    SELECT
      p.id,
      p.name,
      true                               AS has_variants,
      pv.id                              AS variant_id,
      pv.sku                             AS variant_sku,
      -- Concatena todos los atributos de la variante (ej. "Negro / XL")
      (
        SELECT STRING_AGG(
          COALESCE(av.display_value, av.value),
          ' / '
          ORDER BY at2.name
        )
        FROM variant_attribute_values vav
        JOIN attribute_values av  ON av.id  = vav.attribute_value_id
        JOIN attribute_types   at2 ON at2.id = av.attribute_type_id
        WHERE vav.variant_id = pv.id
      )                                  AS variant_attrs,
      pv.stock,
      p.min_stock,
      p.max_stock,
      COALESCE(c.name, 'Sin categoría')  AS category_name,
      CASE
        WHEN pv.stock = 0             THEN 'out'
        WHEN pv.stock <= p.min_stock  THEN 'low'
        ELSE 'normal'
      END AS stock_status
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = true
      AND p.has_variants = true
      AND pv.is_active = true
      AND pv.stock <= COALESCE(p.min_stock, 5)
      ${scope.clause}

    ORDER BY stock ASC
    LIMIT 10
  `, scope.params);

  return rows;
}

// ── Órdenes de compra pendientes ──────────────────────────────────
async function getPendingOrders(isSuperAdmin, adminId) {
  const scope = tc(isSuperAdmin, adminId, "po");

  const { rows } = await pool.query(`
    SELECT
      po.id, po.order_number,
      po.status::text,
      po.payment_status::text,
      ROUND(po.total_cost, 0)       AS total_cost,
      po.order_date,
      po.expected_delivery_date,
      pr.name                        AS provider_name,
      CASE
        WHEN po.expected_delivery_date < CURRENT_DATE
          AND po.status NOT IN ('received', 'cancelled')
        THEN true ELSE false
      END AS is_late
    FROM purchase_orders po
    JOIN providers pr ON pr.id = po.provider_id
    WHERE po.status IN ('pending', 'draft') ${scope.clause}
    ORDER BY po.expected_delivery_date ASC NULLS LAST
    LIMIT 5
  `, scope.params);

  return rows;
}

module.exports = { getDashboardStats };