// services/inventory.service.js
// Central inventory engine.
//
// Formula: disponible = stock_fisico − stock_reserved − stock_safety
//
// Design rules:
//   - Every write is atomic: SELECT FOR UPDATE → UPDATE → INSERT ledger.
//   - owner_admin_id validated on every operation (multi-tenant).
//   - applyStockMovement() embeds in a caller's existing transaction.
//   - High-level exports manage their own BEGIN/COMMIT/ROLLBACK.

'use strict';

const db = require('../config/db');

const RESERVATION_TTL_MIN = 15;

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function _err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── Ledger write ──────────────────────────────────────────────────────────────
async function _writeLedger(client, {
  productId, variantId, movementType, qtyDelta,
  qtyBefore, qtyAfter, referenceType, referenceId, notes, userId, ownerAdminId,
}) {
  await client.query(
    `INSERT INTO stock_ledger
       (product_id, variant_id, movement_type, qty_delta,
        qty_before, qty_after, reference_type, reference_id,
        notes, created_by, owner_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [productId, variantId ?? null, movementType, qtyDelta,
     qtyBefore, qtyAfter,
     referenceType ?? null, referenceId ?? null,
     notes ?? null, userId ?? null, ownerAdminId],
  );
}

// ── Stock delta (lock + update + ledger) ──────────────────────────────────────
async function _applyStockDelta(client, { productId, variantId, quantity }, deltaSign, movementType, ctx) {
  const delta = deltaSign * quantity;

  if (variantId) {
    const { rows } = await client.query(
      `SELECT pv.stock, p.owner_admin_id
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1 FOR UPDATE OF pv`,
      [variantId],
    );
    if (!rows.length) throw _err(`Variante ${variantId} no encontrada`, 'NOT_FOUND');
    if (ctx.ownerAdminId && rows[0].owner_admin_id !== ctx.ownerAdminId) throw _err('Variante de otro tenant', 'FORBIDDEN');

    const qtyBefore = rows[0].stock;
    const qtyAfter  = qtyBefore + delta;
    if (qtyAfter < 0) throw _err(`Stock insuficiente: ${qtyBefore} disponible, delta ${delta}`, 'INSUFFICIENT_STOCK');

    await client.query(
      `UPDATE product_variants SET stock = $1, updated_at = NOW() WHERE id = $2`,
      [qtyAfter, variantId],
    );
    // Keep parent product stock in sync (derived cache)
    await client.query(
      `UPDATE products
       SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_variants
                   WHERE product_id = $1 AND is_active = true),
           updated_at = NOW()
       WHERE id = $1`,
      [productId],
    );
    await _writeLedger(client, { productId, variantId, movementType, qtyDelta: delta, qtyBefore, qtyAfter, ...ctx });
    return { qtyBefore, qtyAfter };
  }

  const { rows } = await client.query(
    `SELECT stock, owner_admin_id FROM products WHERE id = $1 FOR UPDATE`,
    [productId],
  );
  if (!rows.length) throw _err(`Producto ${productId} no encontrado`, 'NOT_FOUND');
  if (ctx.ownerAdminId && rows[0].owner_admin_id !== ctx.ownerAdminId) throw _err('Producto de otro tenant', 'FORBIDDEN');

  const qtyBefore = rows[0].stock;
  const qtyAfter  = qtyBefore + delta;
  if (qtyAfter < 0) throw _err(`Stock insuficiente: ${qtyBefore} disponible, delta ${delta}`, 'INSUFFICIENT_STOCK');

  await client.query(`UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2`, [qtyAfter, productId]);
  await _writeLedger(client, { productId, variantId: null, movementType, qtyDelta: delta, qtyBefore, qtyAfter, ...ctx });
  return { qtyBefore, qtyAfter };
}

// ── stock_reserved adjuster ───────────────────────────────────────────────────
async function _adjustReserved(client, { productId, variantId, quantity }, deltaSign, ownerAdminId) {
  const delta = deltaSign * quantity;

  if (variantId) {
    const { rows } = await client.query(
      `SELECT stock_reserved, stock FROM product_variants WHERE id = $1 FOR UPDATE`, [variantId],
    );
    if (!rows.length) throw _err(`Variante ${variantId} no encontrada`, 'NOT_FOUND');
    const next = rows[0].stock_reserved + delta;
    if (next < 0)           throw _err('stock_reserved no puede ser negativo', 'INVARIANT');
    if (next > rows[0].stock) throw _err('stock_reserved excede stock físico', 'INVARIANT');
    await client.query(`UPDATE product_variants SET stock_reserved = $1 WHERE id = $2`, [next, variantId]);
    return;
  }

  const { rows } = await client.query(
    `SELECT stock_reserved, stock, owner_admin_id FROM products WHERE id = $1 FOR UPDATE`, [productId],
  );
  if (!rows.length) throw _err(`Producto ${productId} no encontrado`, 'NOT_FOUND');
  if (ownerAdminId && rows[0].owner_admin_id !== ownerAdminId) throw _err('Producto de otro tenant', 'FORBIDDEN');
  const next = rows[0].stock_reserved + delta;
  if (next < 0)            throw _err('stock_reserved no puede ser negativo', 'INVARIANT');
  if (next > rows[0].stock) throw _err('stock_reserved excede stock físico', 'INVARIANT');
  await client.query(`UPDATE products SET stock_reserved = $1 WHERE id = $2`, [next, productId]);
}

// ── Bundle expansion ──────────────────────────────────────────────────────────
async function _expandBundle(client, { productId, variantId, quantity }) {
  const { rows } = await client.query(`SELECT is_bundle FROM products WHERE id = $1`, [productId]);
  if (!rows.length || !rows[0].is_bundle) return [{ productId, variantId, quantity }];

  const { rows: comps } = await client.query(
    `SELECT product_id, variant_id, quantity AS comp_qty FROM bundle_items WHERE bundle_id = $1`,
    [productId],
  );
  if (!comps.length) throw _err(`Bundle ${productId} sin componentes`, 'BUNDLE_EMPTY');
  return comps.map(c => ({
    productId: c.product_id,
    variantId: c.variant_id ?? null,
    quantity:  c.comp_qty * quantity,
  }));
}

// ── Expense creation (idempotent on purchase_order_id) ────────────────────────
async function _createExpense(client, {
  expenseType, description, amount, paymentMethod = 'cash',
  providerId = null, productId = null, quantity = null,
  purchaseOrderId = null, notes = null, expenseDate = null,
  createdBy = null, ownerAdminId,
}) {
  // Deduplication: skip if an expense already exists for this PO
  if (purchaseOrderId) {
    const { rows } = await client.query(
      `SELECT id FROM expenses WHERE purchase_order_id = $1 LIMIT 1`,
      [purchaseOrderId],
    );
    if (rows.length) return null;
  }

  const { rows: [exp] } = await client.query(
    `INSERT INTO expenses
       (expense_type, description, amount, payment_method,
        provider_id, product_id, quantity, purchase_order_id,
        notes, expense_date, created_by, owner_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [expenseType, description, amount, paymentMethod,
     providerId, productId, quantity, purchaseOrderId,
     notes, expenseDate ?? new Date(), createdBy, ownerAdminId],
  );
  return exp?.id ?? null;
}

// ── Alert resolver ─────────────────────────────────────────────────────────────
// Marks low_stock/out_of_stock alerts resolved for products whose disponible
// is now above min_stock. Called AFTER stock has been updated (same tx).
async function resolveAlerts(client, productIds, ownerAdminId) {
  if (!productIds.length) return;
  await client.query(
    `UPDATE stock_alerts sa
     SET resolved = true, resolved_at = NOW()
     FROM v_stock_disponible v
     WHERE sa.product_id     = v.product_id
       AND sa.variant_id     IS NOT DISTINCT FROM v.variant_id
       AND sa.owner_admin_id = $1
       AND sa.resolved       = false
       AND sa.alert_type     IN ('low_stock', 'out_of_stock')
       AND sa.product_id     = ANY($2)
       AND v.disponible      > COALESCE(v.min_stock, 0)`,
    [ownerAdminId, productIds],
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

// ── Low-level (embed in caller's tx) ─────────────────────────────────────────

/**
 * Apply a stock movement within an already-open transaction.
 * Expands bundles automatically. Does NOT commit.
 *
 * ctx = { ownerAdminId, userId, referenceType, referenceId, notes }
 */
async function applyStockMovement(client, { productId, variantId, quantity }, deltaSign, movementType, ctx) {
  const targets = await _expandBundle(client, { productId, variantId, quantity });
  for (const t of targets) {
    await _applyStockDelta(client, t, deltaSign, movementType, ctx);
  }
}

// ── High-level (own transaction) ──────────────────────────────────────────────

/**
 * Register initial stock for a product that currently has stock=0.
 * Creates ledger 'initial_stock' + expense 'inventory_initial' for accounting.
 *
 * ctx = { ownerAdminId, userId }
 */
async function registerInitialStock({ productId, variantId, quantity, purchasePrice, reason }, ctx) {
  if (!quantity || quantity <= 0)                  throw _err('quantity debe ser > 0', 'VALIDATION');
  if (!reason?.trim() || reason.trim().length < 3) throw _err('reason obligatorio (mín 3 chars)', 'VALIDATION');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the row and validate preconditions
    const { rows } = variantId
      ? await client.query(
          `SELECT pv.stock, p.owner_admin_id, p.purchase_price, p.name
           FROM product_variants pv JOIN products p ON p.id = pv.product_id
           WHERE pv.id = $1 FOR UPDATE OF pv`,
          [variantId])
      : await client.query(
          `SELECT stock, owner_admin_id, purchase_price, name
           FROM products WHERE id = $1 FOR UPDATE`,
          [productId]);

    if (!rows.length) throw _err('Producto/variante no encontrado', 'NOT_FOUND');
    const row = rows[0];
    if (row.owner_admin_id !== ctx.ownerAdminId) throw _err('Producto de otro tenant', 'FORBIDDEN');
    if (row.stock !== 0)
      throw _err(`Solo válido para productos con stock=0 (actual: ${row.stock})`, 'VALIDATION');

    await _applyStockDelta(
      client,
      { productId, variantId, quantity },
      +1, 'initial_stock',
      { ...ctx, referenceType: 'manual', notes: reason },
    );

    const effectivePrice = purchasePrice ?? row.purchase_price ?? 0;

    // Update purchase_price if changed
    if (purchasePrice != null && purchasePrice !== Number(row.purchase_price)) {
      await client.query(
        `UPDATE products SET purchase_price = $1, updated_at = NOW() WHERE id = $2`,
        [purchasePrice, productId],
      );
    }

    // Accounting: register inventory as an asset
    if (effectivePrice > 0) {
      await _createExpense(client, {
        expenseType:   'inventory_initial',
        description:   `Stock inicial: ${row.name ?? `Producto #${productId}`}`,
        amount:        quantity * effectivePrice,
        paymentMethod: 'cash',
        productId,
        quantity,
        notes:         reason,
        createdBy:     ctx.userId,
        ownerAdminId:  ctx.ownerAdminId,
      });
    }

    await client.query('COMMIT');
    return { ok: true, quantity, totalValue: quantity * effectivePrice };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Process a customer return: adds stock back, ledger 'return'.
 * items: [{ productId, variantId?, quantity }]
 */
async function processReturn(saleId, items, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const targets = await _expandBundle(client, item);
      for (const t of targets) {
        await _applyStockDelta(client, t, +1, 'return', {
          ...ctx, referenceType: 'sale', referenceId: saleId,
          notes: `Devolución venta #${saleId}`,
        });
      }
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

/**
 * Manual stock adjustment (physical count correction).
 * delta: positive = add, negative = subtract.
 * reason: required, min 3 chars.
 */
async function manualAdjustment({ productId, variantId, delta, reason }, ctx) {
  if (!delta || delta === 0)                       throw _err('delta no puede ser 0', 'VALIDATION');
  if (!reason?.trim() || reason.trim().length < 3) throw _err('reason obligatorio (mín 3 chars)', 'VALIDATION');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await _applyStockDelta(
      client,
      { productId, variantId, quantity: Math.abs(delta) },
      delta > 0 ? +1 : -1,
      'manual_adjustment',
      { ...ctx, referenceType: 'manual', notes: reason },
    );
    await client.query('COMMIT');
    return { ok: true, ...result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create a stock reservation (checkout initiated).
 * Validates disponible >= qty, increases stock_reserved, creates reservation row.
 * Returns { ok, reservationIds, expiresAt }
 */
async function createReservation({ items, sessionId, userId, ownerAdminId, ttlMinutes }) {
  const ttl       = ttlMinutes ?? RESERVATION_TTL_MIN;
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const reservationIds = [];

    for (const item of items) {
      const { productId, variantId, quantity } = item;

      // Read + lock to check disponible atomically
      const { rows: [row] } = variantId
        ? await client.query(
            `SELECT stock, stock_reserved, stock_safety
             FROM product_variants WHERE id = $1 FOR UPDATE`,
            [variantId])
        : await client.query(
            `SELECT stock, stock_reserved, stock_safety, owner_admin_id
             FROM products WHERE id = $1 FOR UPDATE`,
            [productId]);

      if (!row) throw _err('Producto/variante no existe', 'NOT_FOUND');
      if (!variantId && row.owner_admin_id !== ownerAdminId) throw _err('Producto de otro tenant', 'FORBIDDEN');

      const disponible = Math.max(0, row.stock - row.stock_reserved - (row.stock_safety ?? 0));
      if (disponible < quantity) continue; // hybrid: sin stock físico → procurement lo cubre

      await _adjustReserved(client, { productId, variantId, quantity }, +1, ownerAdminId);

      // Ledger: physical stock unchanged; record reservation event
      const snap = row.stock;
      await _writeLedger(client, {
        productId, variantId, movementType: 'reservation_created', qtyDelta: quantity,
        qtyBefore: snap, qtyAfter: snap,
        referenceType: 'reservation', referenceId: null,
        notes: `Reserva TTL ${ttl}min`, userId: userId ?? null, ownerAdminId,
      });

      const { rows: [res] } = await client.query(
        `INSERT INTO stock_reservations
           (owner_admin_id, session_id, user_id, product_id, variant_id, quantity, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ownerAdminId, sessionId ?? null, userId ?? null, productId, variantId ?? null, quantity, expiresAt],
      );
      reservationIds.push(res.id);
    }

    await client.query('COMMIT');
    return { ok: true, reservationIds, expiresAt };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Confirm a sale from existing reservations (checkout completed).
 * Decrements stock_reserved AND stock_fisico. Marks reservations confirmed.
 */
async function confirmSaleFromReservations(saleId, reservationIds, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: reservs } = await client.query(
      `SELECT id, owner_admin_id, product_id, variant_id, quantity, status, expires_at
       FROM stock_reservations WHERE id = ANY($1) FOR UPDATE`,
      [reservationIds],
    );
    if (reservs.length !== reservationIds.length) throw _err('Reservas no encontradas', 'NOT_FOUND');

    for (const r of reservs) {
      if (r.owner_admin_id !== ctx.ownerAdminId) throw _err('Reserva de otro tenant', 'FORBIDDEN');
      if (r.status !== 'active') throw _err(`Reserva ${r.id} no activa (${r.status})`, 'INVALID_STATE');
      if (r.expires_at < new Date()) throw _err(`Reserva ${r.id} expiró`, 'EXPIRED');

      const target = { productId: r.product_id, variantId: r.variant_id, quantity: r.quantity };
      await _adjustReserved(client, target, -1, ctx.ownerAdminId);
      await _applyStockDelta(client, target, -1, 'reservation_confirmed', {
        ...ctx, referenceType: 'sale', referenceId: saleId,
        notes: `Reserva #${r.id} → venta #${saleId}`,
      });

      await client.query(
        `UPDATE stock_reservations SET status='confirmed', sale_id=$1, confirmed_at=NOW() WHERE id=$2`,
        [saleId, r.id],
      );
    }

    await client.query('COMMIT');
    return { ok: true, count: reservs.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Direct sale (POS, no prior reservation).
 * Validates disponible, deducts stock, ledger 'sale_confirmed'. Expands bundles.
 */
async function directSale(saleId, items, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const targets = await _expandBundle(client, item);
      for (const t of targets) {
        await _applyStockDelta(client, t, -1, 'sale_confirmed', {
          ...ctx, referenceType: 'sale', referenceId: saleId,
        });
      }
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

/**
 * Cancel a confirmed sale: returns stock, ledger 'sale_cancelled'. Expands bundles.
 */
async function cancelConfirmedSale(saleId, items, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const targets = await _expandBundle(client, item);
      for (const t of targets) {
        await _applyStockDelta(client, t, +1, 'sale_cancelled', {
          ...ctx, referenceType: 'sale', referenceId: saleId,
          notes: `Reingreso por cancelación #${saleId}`,
        });
      }
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

/**
 * Release a reservation (customer cancels checkout or TTL expired).
 * reason: 'cancelled' | 'expired'
 */
async function releaseReservation(reservationId, ctx, reason = 'cancelled') {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [r] } = await client.query(
      `SELECT sr.*, p.stock
       FROM stock_reservations sr
       JOIN products p ON p.id = sr.product_id
       WHERE sr.id = $1 FOR UPDATE OF sr`,
      [reservationId],
    );
    if (!r) throw _err('Reserva no encontrada', 'NOT_FOUND');
    if (r.owner_admin_id !== ctx.ownerAdminId) throw _err('Reserva de otro tenant', 'FORBIDDEN');

    // Idempotent: already released
    if (r.status !== 'active') {
      await client.query('ROLLBACK');
      return { ok: true, skipped: true };
    }

    await _adjustReserved(client, { productId: r.product_id, variantId: r.variant_id, quantity: r.quantity }, -1, ctx.ownerAdminId);

    const snap = r.stock;
    await _writeLedger(client, {
      productId: r.product_id, variantId: r.variant_id,
      movementType: 'reservation_released', qtyDelta: -r.quantity,
      qtyBefore: snap, qtyAfter: snap,
      referenceType: 'reservation', referenceId: r.id,
      notes: `Reserva ${reason}`, userId: ctx.userId, ownerAdminId: ctx.ownerAdminId,
    });

    await client.query(
      `UPDATE stock_reservations SET status=$1, released_at=NOW() WHERE id=$2`,
      [reason === 'expired' ? 'expired' : 'cancelled', reservationId],
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record stock damage or loss.
 * - Deducts stock, ledger 'damage_loss'
 * - Creates expense 'other' for accounting (loss = cost × qty)
 * reason: required.
 */
async function recordDamage({ productId, variantId, qty, reason }, ctx) {
  if (!reason?.trim() || reason.trim().length < 3) throw _err('reason obligatorio (mín 3 chars)', 'VALIDATION');
  if (!qty || qty <= 0)                             throw _err('qty debe ser > 0', 'VALIDATION');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Read purchase_price before the stock update for expense amount
    const { rows: [prod] } = await client.query(
      `SELECT purchase_price, name FROM products WHERE id = $1`, [productId],
    );

    const result = await _applyStockDelta(
      client,
      { productId, variantId, quantity: qty },
      -1, 'damage_loss',
      { ...ctx, referenceType: 'damage', notes: reason },
    );

    // Accounting: register loss as an expense (always, even if cost price is zero)
    const purchasePrice = Number(prod?.purchase_price ?? 0);
    if (purchasePrice === 0) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), event: 'damage_no_cost_price',
        productId, ownerAdminId: ctx.ownerAdminId, qty,
        warning: 'expense registrado con amount=0 porque purchase_price no está configurado',
      }));
    }
    await _createExpense(client, {
      expenseType:  'other',
      description:  `Merma/daño: ${prod?.name ?? `Producto #${productId}`} — ${reason}`,
      amount:       qty * purchasePrice,
      paymentMethod:'cash',
      productId,
      quantity:     qty,
      notes:        purchasePrice > 0
        ? reason
        : `${reason} — ADVERTENCIA: precio de costo no configurado al momento de la merma`,
      createdBy:    ctx.userId,
      ownerAdminId: ctx.ownerAdminId,
    });

    await client.query('COMMIT');
    return { ok: true, ...result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Backwards-compat alias
const cancelSale = cancelConfirmedSale;

module.exports = {
  // Low-level (embed in caller's tx)
  applyStockMovement,
  resolveAlerts,
  // High-level (own transaction)
  registerInitialStock,
  processReturn,
  manualAdjustment,
  createReservation,
  confirmSaleFromReservations,
  directSale,
  cancelConfirmedSale,
  cancelSale,           // alias
  releaseReservation,
  recordDamage,
  // Constants
  RESERVATION_TTL_MIN,
};
