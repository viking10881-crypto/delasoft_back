// services/procurement.service.js
'use strict';

const db = require('../config/db');
const { applyStockMovement, resolveAlerts } = require('./inventory.service');

function _err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _recalculateSaleProcurementStatus(client, saleId) {
  const { rows: pos } = await client.query(
    `SELECT status FROM procurement_orders
     WHERE sale_id = $1 AND status != 'cancelled'`,
    [saleId]
  );

  let status;
  if (!pos.length) {
    status = 'not_required';
  } else if (pos.every(r => r.status === 'received')) {
    status = 'complete';
  } else if (pos.some(r => ['ordered_to_supplier', 'received'].includes(r.status))) {
    status = 'partial';
  } else {
    status = 'pending';
  }

  await client.query(
    `UPDATE sales SET procurement_status = $1, updated_at = NOW() WHERE id = $2`,
    [status, saleId]
  );
  return status;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Creates procurement_orders for every on_demand/hybrid sale_item.
 * Must be called within the caller's open transaction (client = pg client).
 */
async function createProcurementOrdersForSale(saleId, client) {
  const { rows: [sale] } = await client.query(
    `SELECT id, owner_admin_id, created_by FROM sales WHERE id = $1 FOR UPDATE`,
    [saleId]
  );
  if (!sale) throw _err(`Venta ${saleId} no encontrada`, 'NOT_FOUND');

  const { rows: items } = await client.query(
    `SELECT si.id, si.product_id, si.variant_id, si.quantity,
            si.supplier_cost_at_sale, si.fulfillment_mode_snapshot,
            p.default_supplier_id, p.supplier_lead_time_days
     FROM sale_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = $1
       AND COALESCE(si.fulfillment_mode_snapshot, 'stock') != 'stock'`,
    [saleId]
  );

  if (!items.length) return { created: 0 };

  let maxLeadDays = 0;

  for (const item of items) {
    const { rows: [po] } = await client.query(
      `INSERT INTO procurement_orders
         (owner_admin_id, sale_id, sale_item_id, product_id, variant_id,
          supplier_id, quantity, estimated_unit_cost, status, created_by,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,NOW(),NOW())
       RETURNING id`,
      [
        sale.owner_admin_id, saleId, item.id,
        item.product_id, item.variant_id ?? null,
        item.default_supplier_id ?? null,
        item.quantity,
        Number(item.supplier_cost_at_sale ?? 0),
        sale.created_by ?? null,
      ]
    );

    await client.query(
      `DELETE FROM stock_alerts
       WHERE owner_admin_id = $1
         AND product_id = $2
         AND COALESCE(variant_id, 0) = COALESCE($3::int, 0)
         AND alert_type = 'procurement_needed'`,
      [sale.owner_admin_id, item.product_id, item.variant_id ?? null]
    );
    await client.query(
      `INSERT INTO stock_alerts
         (owner_admin_id, product_id, variant_id, sale_id,
          procurement_order_id, alert_type, threshold, current_value, created_at)
       VALUES ($1,$2,$3,$4,$5,'procurement_needed',$6,$7,NOW())`,
      [
        sale.owner_admin_id, item.product_id,
        item.variant_id ?? null, saleId, po.id,
        item.quantity, 0,
      ]
    );

    const leadDays = Number(item.supplier_lead_time_days ?? 0);
    if (leadDays > maxLeadDays) maxLeadDays = leadDays;
  }

  const estimatedDelivery = new Date();
  estimatedDelivery.setDate(estimatedDelivery.getDate() + maxLeadDays);

  await client.query(
    `UPDATE sales
     SET has_on_demand_items = true,
         procurement_status = 'pending',
         estimated_delivery_date = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [estimatedDelivery, saleId]
  );

  return { created: items.length };
}

/**
 * Groups pending procurement_orders into a new purchase_order and sends to supplier.
 * All POs must be 'pending', same supplier, same owner.
 */
async function groupAndCreatePurchaseOrder({ procurementOrderIds, supplierId, ownerAdminId, createdBy, notes }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: pos } = await client.query(
      `SELECT po.id, po.status, po.supplier_id, po.owner_admin_id,
              po.quantity, po.estimated_unit_cost, po.sale_id,
              po.product_id, po.variant_id, po.sale_item_id,
              p.supplier_lead_time_days
       FROM procurement_orders po
       JOIN products p ON p.id = po.product_id
       WHERE po.id = ANY($1)
       FOR UPDATE OF po`,
      [procurementOrderIds]
    );

    if (pos.length !== procurementOrderIds.length)
      throw _err('Una o más órdenes de procurement no encontradas', 'NOT_FOUND');

    for (const po of pos) {
      if (po.owner_admin_id !== ownerAdminId)
        throw _err('Orden de procurement de otro tenant', 'FORBIDDEN');
      if (po.status !== 'pending')
        throw _err(`Orden ${po.id} no está pendiente (${po.status})`, 'INVALID_STATE');
      if (po.supplier_id !== supplierId)
        throw _err(`Orden ${po.id} pertenece a un proveedor diferente`, 'SUPPLIER_MISMATCH');
    }

    // Generate order number
    const { rows: [numRow] } = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(order_number FROM 4) AS INTEGER)), 0) + 1 AS n
       FROM purchase_orders WHERE order_number LIKE 'OC-%'`
    );
    const orderNumber = `OC-${String(numRow.n).padStart(6, '0')}`;

    const totalCost = pos.reduce(
      (sum, p) => sum + p.quantity * Number(p.estimated_unit_cost ?? 0), 0
    );

    const maxLead = Math.max(0, ...pos.map(p => Number(p.supplier_lead_time_days ?? 0)));
    const expectedDelivery = new Date();
    expectedDelivery.setDate(expectedDelivery.getDate() + maxLead);

    const { rows: [purchaseOrder] } = await client.query(
      `INSERT INTO purchase_orders
         (order_number, status, provider_id, owner_admin_id, total_cost,
          payment_status, expected_delivery_date, order_date, notes, created_by,
          created_at, updated_at)
       VALUES ($1,'pending',$2,$3,$4,'pending',$5,NOW(),$6,$7,NOW(),NOW())
       RETURNING id, order_number`,
      [orderNumber, supplierId, ownerAdminId, totalCost,
       expectedDelivery, notes ?? null, createdBy ?? null]
    );

    for (const po of pos) {
      const subtotal = po.quantity * Number(po.estimated_unit_cost ?? 0);
      await client.query(
        `INSERT INTO purchase_order_items
           (purchase_order_id, product_id, variant_id, quantity, unit_cost, subtotal,
            procurement_order_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())`,
        [
          purchaseOrder.id, po.product_id, po.variant_id ?? null,
          po.quantity, Number(po.estimated_unit_cost ?? 0), subtotal, po.id,
        ]
      );
    }

    await client.query(
      `UPDATE procurement_orders
       SET status = 'ordered_to_supplier',
           purchase_order_id = $1,
           ordered_at = NOW(),
           updated_at = NOW()
       WHERE id = ANY($2)`,
      [purchaseOrder.id, procurementOrderIds]
    );

    const affectedSaleIds = [...new Set(pos.map(p => p.sale_id).filter(Boolean))];
    for (const saleId of affectedSaleIds) {
      await _recalculateSaleProcurementStatus(client, saleId);
    }

    await client.query('COMMIT');
    return { purchaseOrder };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Receives a purchase order with per-item bifurcation:
 *   - item.procurement_order_id set → on_demand path (cost only, no stock)
 *   - item.procurement_order_id null → stock path (stock movement)
 *
 * items: [{ poItemId, actualUnitCost, receivedQty }]
 */
async function receivePurchaseOrder(purchaseOrderId, items, userId, ownerAdminId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [po] } = await client.query(
      `SELECT id, order_number, status, provider_id, owner_admin_id, payment_status, total_cost
       FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [purchaseOrderId]
    );
    if (!po) throw _err('OC no encontrada', 'NOT_FOUND');
    if (ownerAdminId && po.owner_admin_id !== ownerAdminId)
      throw _err('OC de otro tenant', 'FORBIDDEN');
    if (po.status === 'received')  throw _err('OC ya recibida', 'ALREADY_DONE');
    if (po.status === 'cancelled') throw _err('OC cancelada', 'INVALID_STATE');

    const affectedSaleIds      = new Set();
    const affectedStockProducts = new Set();
    let totalActual = 0;

    for (const { poItemId, actualUnitCost, receivedQty } of items) {
      const qty = Number(receivedQty);
      if (qty <= 0) continue;

      const { rows: [poItem] } = await client.query(
        `SELECT poi.id, poi.product_id, poi.variant_id, poi.quantity,
                poi.received_quantity, poi.unit_cost, poi.procurement_order_id
         FROM purchase_order_items poi
         WHERE poi.id = $1 AND poi.purchase_order_id = $2`,
        [poItemId, purchaseOrderId]
      );
      if (!poItem) throw _err(`Ítem ${poItemId} no encontrado en esta OC`, 'NOT_FOUND');

      const unitCost = Number(actualUnitCost ?? poItem.unit_cost ?? 0);
      totalActual += qty * unitCost;

      await client.query(
        `UPDATE purchase_order_items
         SET received_quantity = COALESCE(received_quantity, 0) + $1,
             unit_cost = $2
         WHERE id = $3`,
        [qty, unitCost, poItemId]
      );

      if (poItem.procurement_order_id) {
        // ── ON_DEMAND PATH ─────────────────────────────────────────────────
        const { rows: [procOrder] } = await client.query(
          `SELECT id, sale_id, sale_item_id, owner_admin_id
           FROM procurement_orders WHERE id = $1 FOR UPDATE`,
          [poItem.procurement_order_id]
        );

        if (procOrder) {
          await client.query(
            `UPDATE procurement_orders
             SET status = 'received', actual_unit_cost = $1,
                 received_at = NOW(), updated_at = NOW()
             WHERE id = $2`,
            [unitCost, procOrder.id]
          );

          if (procOrder.sale_item_id) {
            await client.query(
              `UPDATE sale_items
               SET actual_supplier_cost = $1, updated_at = NOW()
               WHERE id = $2`,
              [unitCost, procOrder.sale_item_id]
            );
          }

          if (procOrder.sale_id) {
            affectedSaleIds.add(procOrder.sale_id);

            const { rows: dup } = await client.query(
              `SELECT id FROM expenses WHERE procurement_order_id = $1 LIMIT 1`,
              [procOrder.id]
            );
            if (!dup.length) {
              await client.query(
                `INSERT INTO expenses
                   (expense_type, description, amount, payment_method,
                    provider_id, product_id, sale_id, sale_item_id,
                    procurement_order_id, expense_date, created_by, owner_admin_id,
                    created_at, updated_at)
                 VALUES ('cogs_direct',$1,$2,'credit',$3,$4,$5,$6,$7,NOW(),$8,$9,NOW(),NOW())`,
                [
                  `COGS directo OC #${po.order_number}`,
                  qty * unitCost,
                  po.provider_id, poItem.product_id,
                  procOrder.sale_id, procOrder.sale_item_id, procOrder.id,
                  userId, po.owner_admin_id,
                ]
              );
            }
          }
        }
      } else {
        // ── STOCK PATH ──────────────────────────────────────────────────────
        await applyStockMovement(
          client,
          { productId: poItem.product_id, variantId: poItem.variant_id ?? null, quantity: qty },
          +1, 'purchase_received',
          {
            ownerAdminId: po.owner_admin_id, userId,
            referenceType: 'purchase_order', referenceId: purchaseOrderId,
            notes: `OC #${po.order_number}`,
          }
        );

        if (unitCost > 0) {
          await client.query(
            `UPDATE products SET purchase_price = $1, updated_at = NOW()
             WHERE id = $2 AND purchase_price IS DISTINCT FROM $1::numeric`,
            [unitCost, poItem.product_id]
          );
        }

        affectedStockProducts.add(poItem.product_id);
      }
    }

    // Resolve stock alerts for products replenished via the stock path
    if (affectedStockProducts.size > 0) {
      await resolveAlerts(client, [...affectedStockProducts], ownerAdminId);
    }

    // Mark PO received
    await client.query(
      `UPDATE purchase_orders
       SET status = 'received', received_date = CURRENT_DATE, updated_at = NOW()
       WHERE id = $1`,
      [purchaseOrderId]
    );

    // Update provider balance if not already paid
    if (po.payment_status !== 'paid' && totalActual > 0) {
      await client.query(
        `UPDATE providers SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [totalActual, po.provider_id]
      );
    }

    // Recalculate affected sales → flip to ready_to_deliver if complete
    for (const saleId of affectedSaleIds) {
      const newStatus = await _recalculateSaleProcurementStatus(client, saleId);
      if (newStatus === 'complete') {
        await client.query(
          `UPDATE sales
           SET delivery_status = 'ready_to_deliver', updated_at = NOW()
           WHERE id = $1
             AND delivery_status NOT IN ('delivered', 'cancelled')`,
          [saleId]
        );
      }
    }

    await client.query('COMMIT');
    return { ok: true, purchaseOrderId, affectedSales: [...affectedSaleIds] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Marks a sale as fully delivered and recognizes revenue.
 * Requires procurement_status IN ('not_required', 'complete').
 */
async function markSaleAsDelivered(saleId, userId, ownerAdminId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [sale] } = await client.query(
      `SELECT id, owner_admin_id, procurement_status, delivery_status
       FROM sales WHERE id = $1 FOR UPDATE`,
      [saleId]
    );
    if (!sale) throw _err('Venta no encontrada', 'NOT_FOUND');
    if (ownerAdminId && sale.owner_admin_id !== ownerAdminId)
      throw _err('Venta de otro tenant', 'FORBIDDEN');
    if (sale.delivery_status === 'delivered') throw _err('Venta ya entregada', 'ALREADY_DONE');
    if (sale.delivery_status === 'cancelled') throw _err('Venta cancelada', 'INVALID_STATE');

    if (!['not_required', 'complete'].includes(sale.procurement_status)) {
      throw _err(
        `No se puede entregar: procurement aún en estado "${sale.procurement_status}". Deben recibirse todos los ítems del proveedor.`,
        'PROCUREMENT_INCOMPLETE'
      );
    }

    const now = new Date();

    await client.query(
      `UPDATE sales
       SET delivery_status = 'delivered',
           delivered_at = $1,
           revenue_recognized_at = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [now, saleId]
    );

    await client.query(
      `UPDATE sale_items
       SET item_delivery_status = 'delivered', delivered_at = $1, updated_at = NOW()
       WHERE sale_id = $2`,
      [now, saleId]
    );

    await client.query('COMMIT');
    return { ok: true, deliveredAt: now };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancels a pending procurement order.
 */
async function cancelProcurementOrder(id, reason, userId, ownerAdminId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [po] } = await client.query(
      `SELECT id, status, owner_admin_id, sale_id
       FROM procurement_orders WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!po) throw _err('Orden de procurement no encontrada', 'NOT_FOUND');
    if (ownerAdminId && po.owner_admin_id !== ownerAdminId)
      throw _err('Orden de otro tenant', 'FORBIDDEN');
    if (po.status !== 'pending')
      throw _err(`Solo se pueden cancelar órdenes pendientes (actual: ${po.status})`, 'INVALID_STATE');

    await client.query(
      `UPDATE procurement_orders
       SET status = 'cancelled',
           cancellation_reason = $1,
           cancelled_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [reason, id]
    );

    if (po.sale_id) {
      await _recalculateSaleProcurementStatus(client, po.sale_id);
    }

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createProcurementOrdersForSale,
  groupAndCreatePurchaseOrder,
  receivePurchaseOrder,
  markSaleAsDelivered,
  cancelProcurementOrder,
};
