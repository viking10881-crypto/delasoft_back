// controllers/wompi.controller.js
// Thin controller — all gateway logic lives in services/payment.service.js.
// Credentials are NEVER read from .env here; each store loads its own account from the DB.
const db = require("../config/db");
const { buildCheckoutSession, processWompiWebhook } = require("../services/payment.service");
const { emitDataUpdate } = require("../config/socket");
const { sendPaymentConfirmedEmail }             = require("../config/emailConfig");
const { getAdminBranding }                     = require("../services/branding.service");
const { notifyUser, notifyTenant, Payloads }    = require("../services/push.service");

// ── GET /api/wompi/session/:sale_id ──────────────────────────────────────────
// Returns checkout parameters for the Wompi Widget / Redirect.
// Amount always comes from the DB — never from the client.
const getSession = async (req, res) => {
  try {
    const { sale_id } = req.params;

    const { rows } = await db.query(
      `SELECT id, sale_number, total, payment_status, owner_admin_id, customer_id
       FROM sales WHERE id = $1`,
      [sale_id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Venta no encontrada" });

    const sale = rows[0];

    // Ownership check: must be the customer who owns the sale, or an admin/manager
    // of the store that owns the sale. Superadmin bypasses.
    const isSuperAdmin = req.user.roles?.includes("superadmin");
    const isManager    = req.user.roles?.some((r) => ["admin", "gerente"].includes(r));
    const adminId      = req.user.owner_admin_id ?? req.user.id;

    if (!isSuperAdmin) {
      if (isManager) {
        if (String(sale.owner_admin_id) !== String(adminId)) {
          return res.status(403).json({ success: false, message: "No autorizado para esta venta" });
        }
      } else {
        // Customer: must own the sale
        if (String(sale.customer_id) !== String(req.user.id)) {
          return res.status(403).json({ success: false, message: "No autorizado para esta venta" });
        }
      }
    }

    if (sale.payment_status === "paid")
      return res.status(400).json({ success: false, message: "Esta venta ya fue pagada" });

    if (sale.payment_status === "cancelled")
      return res.status(400).json({ success: false, message: "Esta venta está cancelada" });

    let sessionData;
    try {
      sessionData = await buildCheckoutSession(sale, sale.owner_admin_id);
    } catch (err) {
      const status = err.status === 402 ? 402 : 500;
      return res.status(status).json({ success: false, message: err.message });
    }

    return res.json({ success: true, data: sessionData });
  } catch (err) {
    console.error("[wompi] getSession error:", err.message);
    return res.status(500).json({ success: false, message: "Error interno al preparar el pago" });
  }
};

// ── POST /api/wompi/webhook ───────────────────────────────────────────────────
// Raw body (Buffer) — express.raw() is applied in app.js BEFORE express.json().
// Always responds 200; side-effects (email, push, socket) fire after DB commit.
const handleWebhook = async (req, res) => {
  const rawBody = req.body; // Buffer from express.raw()

  if (!Buffer.isBuffer(rawBody) || !rawBody.length) {
    console.warn("[wompi] webhook: received non-raw body — body parser ordering issue?");
    return res.sendStatus(200);
  }

  const result = await processWompiWebhook(rawBody);

  // Side-effects run after DB commit — failures must not cause a non-200 response
  if (result.processed && result.reason === "approved" && result.sale_id) {
    try {
      const { rows: info } = await db.query(
        `SELECT s.total, s.sale_number, s.customer_id, s.owner_admin_id,
                u.name, u.email
         FROM sales s
         JOIN users u ON u.id = s.customer_id
         WHERE s.id = $1`,
        [result.sale_id]
      );
      if (info.length) {
        const { email, name, customer_id, owner_admin_id, total, sale_number } = info[0];
        const orderCode = `AL-${sale_number?.slice(4)}`;

        if (email) {
          (async () => {
            let branding = null;
            try { branding = await getAdminBranding(owner_admin_id); } catch {}
            sendPaymentConfirmedEmail?.(email, name, { orderCode, total, items: [] }, branding).catch(() => {});
          })();
        }
        notifyUser(customer_id, Payloads.paymentConfirmed(orderCode)).catch(() => {});
        if (owner_admin_id) {
          notifyTenant(owner_admin_id, Payloads.paymentReceived(sale_number, total)).catch(() => {});
          emitDataUpdate("sales", "updated", { id: result.sale_id, payment_status: result.new_status }, owner_admin_id);
        }
      }
    } catch (sideErr) {
      console.error("[wompi] webhook side-effect error:", sideErr.message);
    }
  }

  return res.sendStatus(200);
};

// ── GET /api/wompi/verify/:reference ─────────────────────────────────────────
// Polling endpoint — storefront calls this after Wompi redirect.
// Returns the sale's current payment status by reference (sale_number).
const verifyByReference = async (req, res) => {
  try {
    const { reference } = req.params;

    const { rows } = await db.query(
      `SELECT s.id, s.sale_number, s.total, s.payment_status, s.created_at,
              s.customer_id, s.owner_admin_id,
              spt.status AS tx_status, spt.provider_tx_id
       FROM sales s
       LEFT JOIN sale_payment_transactions spt ON spt.reference = s.sale_number
       WHERE s.sale_number = $1
       LIMIT 1`,
      [reference]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Venta no encontrada" });

    const sale = rows[0];

    // Ownership check — same rules as getSession
    const isSuperAdmin = req.user.roles?.includes("superadmin");
    const isManager    = req.user.roles?.some((r) => ["admin", "gerente"].includes(r));
    const adminId      = req.user.owner_admin_id ?? req.user.id;

    if (!isSuperAdmin) {
      if (isManager) {
        if (String(sale.owner_admin_id) !== String(adminId)) {
          return res.status(403).json({ success: false, message: "No autorizado para esta venta" });
        }
      } else {
        if (String(sale.customer_id) !== String(req.user.id)) {
          return res.status(403).json({ success: false, message: "No autorizado para esta venta" });
        }
      }
    }

    // Never expose internal admin fields to end consumers
    const { customer_id, owner_admin_id, ...publicData } = sale;

    return res.json({ success: true, data: publicData });
  } catch (err) {
    console.error("[wompi] verifyByReference error:", err.message);
    return res.status(500).json({ success: false, message: "Error interno" });
  }
};

module.exports = { getSession, handleWebhook, verifyByReference };
