// routes/inventory.routes.js
// All routes require JWT (auth) + adminScope. Superadmin bypasses tenant checks.
const express  = require('express');
const router   = express.Router();
const db       = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth.middleware');
const { requireFeature } = require("../middleware/subscription.middleware");
const { adminScope }         = require('../middleware/adminScope');
const inv      = require('../services/inventory.service');
const procCtrl = require('../controllers/procurement.controller');

router.use(auth, adminScope);
router.use(requireFeature("has_inventory"));

// ─── Util ─────────────────────────────────────────────────────────────────────
function send(res, err) {
  if (err?.code === 'INSUFFICIENT_STOCK') return res.status(409).json({ success: false, message: err.message, code: err.code });
  if (err?.code === 'NOT_FOUND')          return res.status(404).json({ success: false, message: err.message });
  if (err?.code === 'FORBIDDEN')          return res.status(403).json({ success: false, message: err.message });
  if (err?.code === 'VALIDATION')         return res.status(400).json({ success: false, message: err.message });
  if (err?.code === 'ALREADY_DONE')       return res.status(409).json({ success: false, message: err.message });
  if (err?.code === 'INVALID_STATE')      return res.status(409).json({ success: false, message: err.message });
  console.error('[inventory]', err);
  return res.status(500).json({ success: false, message: err.message ?? 'Error de inventario' });
}

// ─── LECTURA ──────────────────────────────────────────────────────────────────

// GET /api/inventory/products
router.get('/products', requireAdmin, async (req, res) => {
  try {
    const ownerId = req.adminId;
    const { rows } = await db.query(
      `SELECT
         v.*,
         CASE WHEN v.variant_id IS NOT NULL THEN (
           SELECT string_agg(
             COALESCE(av.display_value, av.value),
             ' / '
             ORDER BY av.sort_order NULLS LAST, at.id
           )
           FROM variant_attribute_values vav
           JOIN attribute_values av ON av.id = vav.attribute_value_id
           JOIN attribute_types  at ON at.id = av.attribute_type_id
           WHERE vav.variant_id = v.variant_id
         ) ELSE NULL END AS variant_label
       FROM v_stock_disponible v
       WHERE v.owner_admin_id = $1
       ORDER BY v.name ASC, v.variant_id ASC NULLS FIRST`,
      [ownerId],
    );
    res.json({ success: true, data: rows });
  } catch (err) { send(res, err); }
});

// GET /api/inventory/availability?productId=&variantId=
router.get('/availability', async (req, res) => {
  try {
    const productId = Number(req.query.productId);
    const variantId = req.query.variantId ? Number(req.query.variantId) : null;
    if (!productId) return res.status(400).json({ success: false, message: 'productId requerido' });

    const conditions = variantId
      ? ['product_id = $1', 'variant_id = $2']
      : ['product_id = $1', 'variant_id IS NULL'];
    const params = variantId ? [productId, variantId] : [productId];

    if (!req.isSuperAdmin) {
      conditions.push(`owner_admin_id = $${params.length + 1}`);
      params.push(req.adminId);
    }

    const { rows } = await db.query(
      `SELECT * FROM v_stock_disponible WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params,
    );
    res.json({ success: true, data: rows[0] ?? null });
  } catch (err) { send(res, err); }
});

// GET /api/inventory/ledger?productId=&limit=50
router.get('/ledger', requireAdmin, async (req, res) => {
  try {
    const ownerId   = req.adminId;
    const productId = req.query.productId ? Number(req.query.productId) : null;
    const limit     = Math.min(Number(req.query.limit) || 50, 500);
    const offset    = Number(req.query.offset) || 0;

    const params   = productId ? [ownerId, productId, limit, offset] : [ownerId, limit, offset];
    const filter   = productId ? 'AND sl.product_id = $2' : '';
    const limitPh  = productId ? '$3' : '$2';
    const offsetPh = productId ? '$4' : '$3';

    const { rows } = await db.query(
      `SELECT sl.*, p.name AS product_name, pv.sku AS variant_sku
       FROM stock_ledger sl
       JOIN products p ON p.id = sl.product_id
       LEFT JOIN product_variants pv ON pv.id = sl.variant_id
       WHERE sl.owner_admin_id = $1 ${filter}
       ORDER BY sl.created_at DESC
       LIMIT ${limitPh} OFFSET ${offsetPh}`,
      params,
    );
    res.json({ success: true, data: rows });
  } catch (err) { send(res, err); }
});

// GET /api/inventory/valuation
router.get('/valuation', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM v_inventory_valuation WHERE owner_admin_id = $1`,
      [req.adminId],
    );
    res.json({ success: true, data: rows });
  } catch (err) { send(res, err); }
});

// ─── ENTRADAS ─────────────────────────────────────────────────────────────────

// POST /api/inventory/purchase-order/:id/receive
router.post('/purchase-order/:id/receive', requireAdmin, procCtrl.receivePurchaseOrder);

// POST /api/inventory/adjustment
// body: { productId | product_id, variantId? | variant_id?, delta, reason }
router.post('/adjustment', requireAdmin, async (req, res) => {
  try {
    // Acepta tanto camelCase como snake_case para compatibilidad con todos los clientes
    const productId = req.body.productId ?? req.body.product_id;
    const variantId = req.body.variantId ?? req.body.variant_id ?? null;
    const { delta, reason } = req.body;

    if (!productId || delta == null) {
      return res.status(400).json({ success: false, message: 'productId y delta son requeridos' });
    }
    const parsedDelta = Number(delta);
    if (!Number.isFinite(parsedDelta) || !Number.isInteger(parsedDelta)) {
      return res.status(400).json({ success: false, message: 'delta debe ser un número entero válido', code: 'VALIDATION' });
    }
    const result = await inv.manualAdjustment(
      {
        productId: Number(productId),
        variantId: variantId ? Number(variantId) : null,
        delta:     parsedDelta,
        reason,
      },
      { ownerAdminId: req.adminId, userId: req.user.id },
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/damage
// body: { productId | product_id, variantId? | variant_id?, quantity, reason }
router.post('/damage', requireAdmin, async (req, res) => {
  try {
    // Acepta tanto camelCase como snake_case para compatibilidad con todos los clientes
    const productId = req.body.productId ?? req.body.product_id;
    const variantId = req.body.variantId ?? req.body.variant_id ?? null;
    const { quantity, reason } = req.body;

    if (!productId || !quantity) {
      return res.status(400).json({ success: false, message: 'productId y quantity son requeridos' });
    }
    const parsedQty = Number(quantity);
    if (!Number.isFinite(parsedQty) || !Number.isInteger(parsedQty) || parsedQty <= 0) {
      return res.status(400).json({ success: false, message: 'quantity debe ser un entero positivo válido', code: 'VALIDATION' });
    }
    const result = await inv.recordDamage(
      {
        productId: Number(productId),
        variantId: variantId ? Number(variantId) : null,
        qty:       parsedQty,
        reason,
      },
      { ownerAdminId: req.adminId, userId: req.user.id },
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/return
// body: { saleId, items: [{ productId, variantId?, quantity }] }
router.post('/return', requireAdmin, async (req, res) => {
  try {
    const { saleId, items } = req.body;
    if (!saleId || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'saleId e items son requeridos' });
    }
    const result = await inv.processReturn(Number(saleId), items, {
      ownerAdminId: req.adminId,
      userId:       req.user.id,
    });
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/initial-stock
// body: { productId, variantId?, quantity, purchasePrice?, reason }
router.post('/initial-stock', requireAdmin, async (req, res) => {
  try {
    const { productId, variantId, quantity, purchasePrice, reason } = req.body;
    if (!productId || !quantity) {
      return res.status(400).json({ success: false, message: 'productId y quantity son requeridos' });
    }
    const result = await inv.registerInitialStock(
      {
        productId:     Number(productId),
        variantId:     variantId ? Number(variantId) : null,
        quantity:      Number(quantity),
        purchasePrice: purchasePrice != null ? Number(purchasePrice) : null,
        reason,
      },
      { ownerAdminId: req.adminId, userId: req.user.id },
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// ─── RESERVAS (admin) ─────────────────────────────────────────────────────────

// GET /api/inventory/reservations/active?productId=
router.get('/reservations/active', requireAdmin, async (req, res) => {
  try {
    const productId = req.query.productId ? Number(req.query.productId) : null;
    const params    = [req.adminId];
    const filter    = productId ? `AND sr.product_id = $2` : '';
    if (productId) params.push(productId);

    const { rows } = await db.query(
      `SELECT
         sr.id, sr.session_id, sr.user_id, sr.product_id, sr.variant_id,
         sr.quantity, sr.status, sr.expires_at, sr.created_at,
         p.name     AS product_name,
         pv.sku     AS variant_sku,
         u.name     AS user_name,
         u.email    AS user_email,
         (sr.expires_at < NOW()) AS is_expired
       FROM stock_reservations sr
       JOIN products p           ON p.id  = sr.product_id
       LEFT JOIN product_variants pv ON pv.id = sr.variant_id
       LEFT JOIN users u         ON u.id  = sr.user_id
       WHERE sr.status = 'active' AND sr.owner_admin_id = $1 ${filter}
       ORDER BY sr.expires_at ASC`,
      params,
    );
    res.json({ success: true, data: rows });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/reservations/release-expired
router.post('/reservations/release-expired', requireAdmin, async (req, res) => {
  try {
    const { rows: expired } = await db.query(
      `SELECT id, owner_admin_id FROM stock_reservations
       WHERE status = 'active' AND expires_at < NOW() AND owner_admin_id = $1`,
      [req.adminId],
    );

    let released = 0;
    const errors = [];
    for (const r of expired) {
      try {
        await inv.releaseReservation(r.id, { ownerAdminId: r.owner_admin_id, userId: null }, 'expired');
        released++;
      } catch (err) {
        errors.push({ id: r.id, error: err.message });
      }
    }
    res.json({ success: true, data: { released, total: expired.length, errors } });
  } catch (err) { send(res, err); }
});

// DELETE /api/inventory/reservations/:id
router.delete('/reservations/:id', requireAdmin, async (req, res) => {
  try {
    const result = await inv.releaseReservation(
      Number(req.params.id),
      { ownerAdminId: req.adminId, userId: req.user.id },
      'cancelled',
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/sales/:id/confirm-from-reservations
// body: { reservationIds: number[] }
router.post('/sales/:id/confirm-from-reservations', async (req, res) => {
  try {
    const { reservationIds } = req.body;
    if (!Array.isArray(reservationIds) || !reservationIds.length) {
      return res.status(400).json({ success: false, message: 'reservationIds es requerido' });
    }
    const result = await inv.confirmSaleFromReservations(
      Number(req.params.id),
      reservationIds,
      { ownerAdminId: req.adminId, userId: req.user.id },
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

module.exports = router;