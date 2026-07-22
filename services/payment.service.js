// services/payment.service.js
// Provider-agnostic payment gateway layer.
// Today: Wompi. Adding Mercado Pago / PayU = another implementation of the same interface.
//
// Interface each provider must satisfy:
//   buildCheckoutSession(sale, adminId)  → { public_key, reference, amount_in_cents, currency, signature, redirect_url, account_id }
//   validateWebhookSignature(rawBody, headers, eventsSecret) → boolean
//   deriveEventId(payload)               → string (stable, unique per event)
//   mapStatus(providerStatus)            → 'approved'|'declined'|'voided'|'error'|'pending'
const crypto = require("crypto");
const https  = require("https");
const db     = require("../config/db");
const { encrypt, decrypt } = require("../utils/crypto");

// ─── Wompi endpoints ──────────────────────────────────────────────────────────
// Evaluated lazily inside functions so tests can override process.env after module load.
function getWompiBase(environment) {
  const map = {
    sandbox:    process.env.WOMPI_SANDBOX_URL    || "https://sandbox.wompi.co/v1",
    production: process.env.WOMPI_PRODUCTION_URL || "https://production.wompi.co/v1",
  };
  return map[environment] || map.sandbox;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function wompiGet(path, environment, privateKey) {
  const url = `${getWompiBase(environment)}${path}`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { Authorization: `Bearer ${privateKey}` } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { reject(new Error("Non-JSON response from Wompi")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(new Error("Wompi request timed out")); });
  });
}

// ─── Store account helpers ────────────────────────────────────────────────────

/**
 * Load the active payment account for an admin.
 * Returns null if none exists or (when requireConnected=true) if not yet verified.
 */
async function getStoreAccount(adminId, { requireConnected = true } = {}) {
  const { rows } = await db.query(
    `SELECT id, provider, environment, status, public_key,
            private_key_encrypted, events_secret_encrypted, integrity_secret_encrypted, admin_id
     FROM store_payment_accounts
     WHERE admin_id = $1 AND is_active = true
     LIMIT 1`,
    [adminId]
  );
  if (!rows.length) return null;
  if (requireConnected && rows[0].status !== "connected") return null;
  return rows[0];
}

/**
 * Decrypt credentials from a store_payment_accounts row.
 * Call only when needed; never persist decrypted values beyond request scope.
 */
function decryptCredentials(acct) {
  return {
    private_key:      decrypt(acct.private_key_encrypted),
    events_secret:    decrypt(acct.events_secret_encrypted),
    integrity_secret: decrypt(acct.integrity_secret_encrypted),
  };
}

// ─── Wompi — provider implementation ─────────────────────────────────────────

/**
 * Compute the Wompi checkout integrity signature.
 * SHA-256( reference + amount_in_cents + currency + integrity_secret )
 */
function wompiIntegritySignature(reference, amountInCents, currency, integritySecret) {
  const chain = `${reference}${Math.round(Number(amountInCents))}${currency}${integritySecret}`;
  return crypto.createHash("sha256").update(chain).digest("hex");
}

/**
 * Validate a Wompi webhook event signature from raw body.
 * rawBody must be a Buffer (express.raw middleware).
 * Returns true if valid, false otherwise. Never throws.
 */
function wompiValidateWebhookSignature(rawBody, _headers, eventsSecret) {
  try {
    const payload   = JSON.parse(rawBody.toString("utf8"));
    const { signature, timestamp, data } = payload;
    if (!signature?.properties || !signature?.checksum) return false;

    const transaction = data?.transaction ?? {};
    const valuesStr   = signature.properties
      .map((prop) => {
        const key = prop.replace(/^transaction\./, "");
        return String(transaction[key] ?? "");
      })
      .join("");

    const chain    = `${valuesStr}${timestamp}${eventsSecret}`;
    const expected = crypto.createHash("sha256").update(chain).digest("hex");

    // timingSafeEqual requires equal-length buffers
    const expBuf = Buffer.from(expected);
    const chkBuf = Buffer.from(signature.checksum);
    if (expBuf.length !== chkBuf.length) return false;
    return crypto.timingSafeEqual(expBuf, chkBuf);
  } catch {
    return false;
  }
}

/**
 * Derive a stable, unique event_id for idempotency.
 * Wompi doesn't expose a native event UUID; we derive from tx id + status.
 */
function wompiDeriveEventId(payload) {
  const tx = payload?.data?.transaction;
  if (!tx?.id || !tx?.status) return null;
  return `${tx.id}:${tx.status}`;
}

/**
 * Map a Wompi transaction status to our internal status.
 */
function wompiMapStatus(wompiStatus) {
  const map = {
    APPROVED: "approved",
    DECLINED: "declined",
    VOIDED:   "voided",
    ERROR:    "error",
    PENDING:  "pending",
  };
  return map[wompiStatus] || "pending";
}

/**
 * Verify Wompi credentials by calling the merchant endpoint.
 * publicKey goes in the URL path; privateKey goes only in the Authorization header.
 * Returns true only when the API responds 200 with a valid merchant id.
 */
async function verifyWompiCredentials(publicKey, privateKey, environment) {
  try {
    const { status, body } = await wompiGet(
      `/merchants/${encodeURIComponent(publicKey)}`,
      environment,
      privateKey
    );
    const ok = status === 200 && !!body?.data?.id;
    if (!ok) {
      console.warn("[payment.service] verifyWompiCredentials: status=%d body=%j", status, body);
    }
    return ok;
  } catch (err) {
    console.error("[payment.service] verifyWompiCredentials error:", err.message);
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the checkout session data for a sale.
 * Throws { status: 402, message } if the store has no connected payment account.
 * Registers the attempt in sale_payment_transactions (idempotent on reference).
 */
async function buildCheckoutSession(sale, adminId) {
  // Query without requireConnected so we can distinguish "no account" from "not verified"
  const acct = await getStoreAccount(adminId, { requireConnected: false });

  if (!acct) {
    console.error("[payment.service] buildCheckoutSession: no payment account found", { adminId, saleId: sale.id });
    const err = new Error("Esta tienda no tiene cuenta de pago configurada. El administrador debe conectar su cuenta de Wompi.");
    err.status = 402;
    err.code   = "NO_PAYMENT_ACCOUNT";
    throw err;
  }

  if (acct.status !== "connected") {
    console.error("[payment.service] buildCheckoutSession: account exists but not connected", {
      adminId, saleId: sale.id, accountId: acct.id, status: acct.status,
    });
    const msg = acct.status === "error"
      ? "Las credenciales de Wompi son inválidas. El administrador debe revisar y volver a verificar su cuenta de pago."
      : "La cuenta de pago aún no está verificada. El administrador debe completar la verificación de credenciales Wompi.";
    const err = new Error(msg);
    err.status = 402;
    err.code   = "PAYMENT_ACCOUNT_NOT_CONNECTED";
    throw err;
  }

  const { integrity_secret } = decryptCredentials(acct);
  const reference     = sale.sale_number;
  const amountInCents = Math.round(parseFloat(sale.total) * 100);
  const currency      = "COP";
  const signature     = wompiIntegritySignature(reference, amountInCents, currency, integrity_secret);

  // Register the transaction attempt — idempotent (reference is UNIQUE)
  // Register the transaction attempt — idempotent (reference is UNIQUE)
  await db.query(
    `INSERT INTO sale_payment_transactions
      (sale_id, owner_admin_id, store_payment_account_id, provider, reference, amount_in_cents, currency, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
    ON CONFLICT (reference) DO NOTHING`,
    [sale.id, adminId, acct.id, acct.provider, reference, amountInCents, currency]
  );

    return {
    public_key:      acct.public_key,
    reference,
    amount_in_cents: Math.round(amountInCents), // ← asegura entero
    currency,
    signature,
    redirect_url:    `${process.env.FRONTEND_URL}/order-success`,
    account_id:      acct.id,
  };
}

/**
 * Process a raw Wompi webhook payload (Buffer).
 * Returns { processed: boolean, reason: string, ... }.
 *
 * NEVER throws — all paths return a result object so the controller
 * can always respond 200 to Wompi, even on DB errors.
 *
 * Idempotency strategy:
 *   1. INSERT event with ON CONFLICT DO UPDATE → always get the row back.
 *   2. If the row was already processed=true, skip.
 *   3. If processed=false (previous attempt crashed), acquire FOR UPDATE lock
 *      inside a transaction before retrying so concurrent re-deliveries are
 *      serialized and only one wins.
 */
async function processWompiWebhook(rawBody) {
  // ── 1. Parse payload ───────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { processed: false, reason: "invalid_json" };
  }

  const { event, data, timestamp } = payload;
  const tx        = data?.transaction ?? {};
  const reference = tx.reference ?? "";
  const eventId   = wompiDeriveEventId(payload);

  if (!eventId) return { processed: false, reason: "no_event_id" };

  // ── 2. Load the sale_payment_transaction + store account ──────────────────
  let txRows = [];
  try {
    const res = await db.query(
      `SELECT spt.id AS tx_id, spt.sale_id, spt.account_id, spt.status AS tx_status,
              spa.events_secret_encrypted, spa.admin_id
       FROM sale_payment_transactions spt
       JOIN store_payment_accounts spa ON spa.id = spt.account_id
       WHERE spt.reference = $1`,
      [reference]
    );
    txRows = res.rows;
  } catch (err) {
    console.error("[payment.service] webhook: txRows query error:", err.message);
    return { processed: false, reason: "db_error" };
  }

  // ── 3. Validate webhook signature ──────────────────────────────────────────
  // We can only validate if we have the store's events_secret.
  // When the transaction is unknown, sig_valid stays null (can't validate).
  let sigValid = null;
  if (txRows.length) {
    try {
      const eventsSecret = decrypt(txRows[0].events_secret_encrypted);
      sigValid = wompiValidateWebhookSignature(rawBody, {}, eventsSecret);
    } catch (err) {
      console.error("[payment.service] webhook: signature validation error:", err.message);
      sigValid = false;
    }
  } else {
    console.warn("[payment.service] webhook: unknown reference '%s' — no transaction found", reference);
  }

  // ── 4. Record event with idempotency ───────────────────────────────────────
  // DO UPDATE ensures we always get the row back, even on conflict.
  // This lets us detect and retry events that were recorded but not processed
  // (e.g., server crash between INSERT here and COMMIT of the sale updates).
  let eventRow;
  try {
    const ins = await db.query(
      `INSERT INTO payment_webhook_events
         (provider, event_id, event_type, status, reference, processed, sig_valid, raw_payload)
       VALUES ('wompi', $1, $2, $3, $4, false, $5, $6)
       ON CONFLICT (provider, event_id)
         DO UPDATE SET updated_at = now()
       RETURNING id, processed`,
      [eventId, event ?? null, tx.status ?? null, reference, sigValid, payload]
    );
    eventRow = ins.rows[0];
  } catch (err) {
    console.error("[payment.service] webhook: event insert error:", err.message);
    return { processed: false, reason: "db_error_inserting_event" };
  }

  // Already successfully processed in a prior delivery
  if (eventRow.processed) return { processed: false, reason: "already_processed" };

  // Invalid or unverifiable signature → record but do not process
  if (sigValid === false) {
    return { processed: false, reason: "invalid_signature" };
  }

  // Only APPROVED transaction.updated events on known transactions get processed
  if (event !== "transaction.updated" || tx.status !== "APPROVED" || !txRows.length) {
    try {
      await db.query(
        "UPDATE payment_webhook_events SET processed = true WHERE id = $1",
        [eventRow.id]
      );
    } catch { /* non-critical */ }
    return { processed: false, reason: "not_applicable" };
  }

  const { tx_id, sale_id } = txRows[0];
  const amountCOP = Number(tx.amount_in_cents ?? 0) / 100;

  // ── 5. Transactional update ────────────────────────────────────────────────
  // Acquire a FOR UPDATE lock on the event row first so that concurrent
  // re-deliveries (both seeing processed=false) are serialized: one wins the
  // lock, processes, sets processed=true, commits; the other then sees
  // processed=true via the sale.payment_status === 'paid' check.
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Lock the event row to prevent concurrent processing of the same event
    const { rows: lockedEvent } = await client.query(
      "SELECT id, processed FROM payment_webhook_events WHERE id = $1 FOR UPDATE",
      [eventRow.id]
    );
    if (!lockedEvent.length || lockedEvent[0].processed) {
      await client.query("ROLLBACK");
      return { processed: false, reason: "already_processed_concurrent" };
    }

    // Update our transaction record
    await client.query(
      `UPDATE sale_payment_transactions
       SET status = 'approved', provider_transaction_id = $1, updated_at = now()  
       WHERE id = $2 AND status != 'approved'`,
      [String(tx.id ?? ""), tx_id]
    );

    // Lock the sale row to prevent concurrent payment processing
    const { rows: saleRows } = await client.query(
      `SELECT id, total, payment_status, customer_id, owner_admin_id
       FROM sales WHERE id = $1 FOR UPDATE`,
      [sale_id]
    );
    if (!saleRows.length) {
      await client.query("ROLLBACK");
      return { processed: false, reason: "sale_not_found" };
    }

    const sale = saleRows[0];

    // Idempotent — if the sale is already paid, mark event processed and exit
    if (sale.payment_status === "paid") {
      await client.query(
        "UPDATE payment_webhook_events SET processed = true WHERE id = $1",
        [eventRow.id]
      );
      await client.query("COMMIT");
      return { processed: true, reason: "already_paid" };
    }

    // Insert the gateway payment record
    await client.query(
      `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, created_by)
       VALUES ($1, $2, 'gateway', 'Pago aprobado por pasarela (Wompi)', NULL)`,
      [sale_id, amountCOP]
    );

    // Recompute paid total from all payment rows (handles partial + gateway combo)
    const { rows: sumRows } = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS paid FROM sale_payments WHERE sale_id = $1",
      [sale_id]
    );
    const totalPaid = Number(sumRows[0].paid);
    const saleTotal = Number(sale.total);
    const newStatus = totalPaid <= 0 ? "pending" : totalPaid < saleTotal ? "partial" : "paid";

    await client.query(
      "UPDATE sales SET amount_paid = $1, payment_status = $2, updated_at = now() WHERE id = $3",
      [totalPaid, newStatus, sale_id]
    );

    await client.query(
      "UPDATE payment_webhook_events SET processed = true WHERE id = $1",
      [eventRow.id]
    );

    await client.query("COMMIT");

    return {
      processed:   true,
      reason:      "approved",
      sale_id,
      admin_id:    sale.owner_admin_id,
      new_status:  newStatus,
      total_paid:  totalPaid,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[payment.service] webhook tx error:", err.message);
    return { processed: false, reason: "tx_error" };
  } finally {
    client.release();
  }
}

module.exports = {
  // Store account
  getStoreAccount,
  decryptCredentials,
  // Checkout
  buildCheckoutSession,
  // Webhook
  processWompiWebhook,
  wompiValidateWebhookSignature,
  wompiDeriveEventId,
  wompiMapStatus,
  // Credential verification
  verifyWompiCredentials,
  // Encryption (re-exported for use in paymentAccounts controller)
  encrypt,
};
