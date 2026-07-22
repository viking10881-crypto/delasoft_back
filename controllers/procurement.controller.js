// controllers/procurement.controller.js
'use strict';

const db          = require('../config/db');
const procurement = require('../services/procurement.service');

// ── Helpers ───────────────────────────────────────────────────────────────────

function _send(res, err) {
  const status = err.status ?? (err.code === 'NOT_FOUND' ? 404
    : err.code === 'FORBIDDEN'    ? 403
    : err.code === 'INVALID_STATE' || err.code === 'ALREADY_DONE' ? 400
    : 500);
  res.status(status).json({ success: false, message: err.message });
}

// ── Procurement orders ────────────────────────────────────────────────────────

/**
 * GET /api/procurement/pending
 * Returns all pending procurement orders grouped by supplier.
 */
exports.getPending = async (req, res) => {
  try {
    const ownerClause = req.isSuperAdmin ? '' : 'AND po.owner_admin_id = $1';
    const params      = req.isSuperAdmin ? [] : [req.adminId];

    const { rows } = await db.query(
      `SELECT
         po.id,
         po.sale_id,
         po.sale_item_id,
         po.product_id,
         po.variant_id,
         po.supplier_id,
         po.quantity,
         po.estimated_unit_cost,
         po.estimated_unit_cost * po.quantity AS estimated_total,
         po.status,
         po.created_at,
         p.name        AS product_name,
         p.sku         AS product_sku,
         prov.name     AS supplier_name,
         prov.lead_time_days,
         s.sale_number,
         EXTRACT(DAY FROM NOW() - po.created_at)::int AS days_waiting
       FROM procurement_orders po
       JOIN products p     ON p.id = po.product_id
       LEFT JOIN providers prov ON prov.id = po.supplier_id
       LEFT JOIN sales s        ON s.id    = po.sale_id
       WHERE po.status = 'pending'
         ${ownerClause}
       ORDER BY prov.name, po.created_at ASC`,
      params
    );

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[procurement.getPending]', err);
    res.status(500).json({ success: false, message: 'Error al obtener órdenes pendientes' });
  }
};

/**
 * GET /api/procurement/sales-awaiting
 * Returns sales waiting for fulfillment (has_on_demand_items, not yet delivered).
 */
exports.getSalesAwaiting = async (req, res) => {
  try {
    const ownerClause = req.isSuperAdmin ? '' : 'AND s.owner_admin_id = $1';
    const params      = req.isSuperAdmin ? [] : [req.adminId];

    const { rows } = await db.query(
      `SELECT
         s.id,
         s.sale_number,
         s.sale_date,
         s.total,
         s.procurement_status,
         s.delivery_status,
         s.estimated_delivery_date,
         s.has_on_demand_items,
         u.name AS customer_name,
         (SELECT COUNT(*) FROM procurement_orders po
          WHERE po.sale_id = s.id AND po.status = 'pending')::int     AS pending_pos,
         (SELECT COUNT(*) FROM procurement_orders po
          WHERE po.sale_id = s.id AND po.status != 'cancelled')::int  AS total_pos
       FROM sales s
       LEFT JOIN users u ON u.id = s.customer_id
       WHERE s.has_on_demand_items = true
         AND s.delivery_status NOT IN ('delivered', 'cancelled')
         ${ownerClause}
       ORDER BY s.sale_date DESC`,
      params
    );

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[procurement.getSalesAwaiting]', err);
    res.status(500).json({ success: false, message: 'Error al obtener ventas en espera' });
  }
};

/**
 * GET /api/procurement/purchase-orders
 * Returns active purchase orders (sent to supplier, not yet received/cancelled).
 */
exports.getPurchaseOrders = async (req, res) => {
  try {
    const ownerClause = req.isSuperAdmin ? '' : 'AND po.owner_admin_id = $1';
    const params      = req.isSuperAdmin ? [] : [req.adminId];

    const { rows } = await db.query(
      `SELECT
         po.id,
         po.order_number,
         po.status,
         po.total_cost,
         po.notes,
         po.created_at,
         prov.id   AS supplier_id,
         prov.name AS supplier_name,
         json_agg(
           json_build_object(
             'id',            poi.id,
             'product_id',    poi.product_id,
             'quantity',      poi.quantity,
             'unit_cost',     poi.unit_cost,
             'received_quantity', poi.received_quantity,
             'product_name',  p.name,
             'product_sku',   p.sku
           ) ORDER BY poi.id
         ) AS items
       FROM purchase_orders po
       LEFT JOIN providers prov ON prov.id = po.provider_id
       LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       LEFT JOIN products p ON p.id = poi.product_id
       WHERE po.status NOT IN ('received', 'cancelled')
         ${ownerClause}
       GROUP BY po.id, prov.id, prov.name
       ORDER BY po.created_at DESC`,
      params
    );

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[procurement.getPurchaseOrders]', err);
    res.status(500).json({ success: false, message: 'Error al obtener órdenes de compra' });
  }
};

/**
 * POST /api/procurement/group-purchase-order
 * Body: { procurementOrderIds: number[], supplierId: number, notes?: string }
 */
exports.groupPurchaseOrder = async (req, res) => {
  const { procurementOrderIds, supplierId, notes } = req.body;

  if (!Array.isArray(procurementOrderIds) || !procurementOrderIds.length)
    return res.status(400).json({ success: false, message: 'procurementOrderIds requerido (array)' });
  if (!supplierId)
    return res.status(400).json({ success: false, message: 'supplierId requerido' });

  try {
    const result = await procurement.groupAndCreatePurchaseOrder({
      procurementOrderIds: procurementOrderIds.map(Number),
      supplierId:          Number(supplierId),
      ownerAdminId:        req.adminId,
      createdBy:           req.user?.id ?? null,
      notes:               notes ?? null,
    });

    res.status(201).json({
      success: true,
      message: `Orden de compra ${result.purchaseOrder.order_number} creada`,
      data:    result.purchaseOrder,
    });
  } catch (err) {
    console.error('[procurement.groupPurchaseOrder]', err);
    _send(res, err);
  }
};

/**
 * POST /api/procurement/:id/cancel
 * Body: { reason: string }
 */
exports.cancel = async (req, res) => {
  const { id }     = req.params;
  const { reason } = req.body;

  if (!reason?.trim())
    return res.status(400).json({ success: false, message: 'El motivo de cancelación es requerido' });

  try {
    await procurement.cancelProcurementOrder(
      Number(id), reason, req.user?.id ?? null, req.adminId
    );
    res.json({ success: true, message: 'Orden de procurement cancelada' });
  } catch (err) {
    console.error('[procurement.cancel]', err);
    _send(res, err);
  }
};

/**
 * POST /api/procurement/purchase-orders/:id/receive
 * Body: {
 *   received_quantities?: { [poItemId]: number }  — omit to receive all pending
 *   actual_unit_costs?:   { [poItemId]: number }  — omit to use PO unit_cost
 * }
 */
exports.receivePurchaseOrder = async (req, res) => {
  try {
    const purchaseOrderId       = Number(req.params.id);
    const { received_quantities, actual_unit_costs } = req.body;

    const { rows: poItems } = await db.query(
      `SELECT id, quantity, received_quantity, unit_cost
       FROM purchase_order_items WHERE purchase_order_id = $1`,
      [purchaseOrderId]
    );

    if (!poItems.length) {
      return res.status(404).json({
        success: false,
        message: 'Orden de compra no encontrada o sin ítems',
      });
    }

    const items = poItems
      .map(item => {
        const maxPending  = Math.max(0, item.quantity - (item.received_quantity || 0));
        const receivedQty = received_quantities
          ? Math.min(Math.max(0, parseInt(received_quantities[item.id] ?? 0) || 0), maxPending)
          : maxPending;
        const actualUnitCost = actual_unit_costs
          ? Number(actual_unit_costs[item.id] ?? item.unit_cost ?? 0)
          : Number(item.unit_cost ?? 0);
        return { poItemId: item.id, actualUnitCost, receivedQty };
      })
      .filter(i => i.receivedQty > 0);

    if (!items.length) {
      return res.status(400).json({
        success: false,
        message: 'No hay ítems pendientes de recibir en esta orden',
      });
    }

    const result = await procurement.receivePurchaseOrder(
      purchaseOrderId, items, req.user.id, req.adminId
    );

    res.json({
      success: true,
      message: 'Orden de compra recibida correctamente',
      data:    result,
    });
  } catch (err) {
    console.error('[procurement.receivePurchaseOrder]', err);
    _send(res, err);
  }
};

/**
 * POST /api/sales/:id/mark-delivered
 * Marks a sale as delivered and recognizes revenue.
 */
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
    console.error('[procurement.markSaleAsDelivered]', err);
    _send(res, err);
  }
};
