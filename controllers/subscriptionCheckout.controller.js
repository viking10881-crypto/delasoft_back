const crypto = require('crypto');
const db = require('../config/db');
const subscriptionService = require('../services/subscription.service');
const { isValidEmail, normalizeEmail } = require('../utils/validation');
const { decrypt } = require('../utils/crypto');

const cleanText = (value, maxLength) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const getNestedValue = (source, path) => path.split('.').reduce(
  (current, key) => (current !== null && current !== undefined ? current[key] : undefined),
  source
);

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || '').toLowerCase());
  const b = Buffer.from(String(right || '').toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Las llaves de cobro de planes salen de la cuenta Wompi que el superadmin
// registra (y verifica) en Configuración → Pagos. Las variables
// WOMPI_SUBSCRIPTIONS_* quedan solo como respaldo.
const gatewayConfig = async () => {
  const landingUrl = (process.env.LANDING_URL || 'http://localhost:5173').replace(/\/$/, '');
  const { rows } = await db.query(
    `SELECT spa.public_key, spa.integrity_secret_encrypted, spa.events_secret_encrypted
       FROM store_payment_accounts spa
       JOIN user_roles ur ON ur.user_id = spa.admin_id
       JOIN roles r ON r.id = ur.role_id AND r.name = 'superadmin'
      WHERE spa.provider = 'wompi' AND spa.is_active = true AND spa.status = 'connected'
      ORDER BY spa.updated_at DESC
      LIMIT 1`
  );
  if (rows.length) {
    return {
      publicKey: rows[0].public_key,
      integritySecret: decrypt(rows[0].integrity_secret_encrypted),
      eventsSecret: decrypt(rows[0].events_secret_encrypted),
      landingUrl,
    };
  }
  return {
    publicKey: process.env.WOMPI_SUBSCRIPTIONS_PUBLIC_KEY,
    integritySecret: process.env.WOMPI_SUBSCRIPTIONS_INTEGRITY_SECRET,
    eventsSecret: process.env.WOMPI_SUBSCRIPTIONS_EVENTS_SECRET,
    landingUrl,
  };
};

// Crea la orden en subscription_checkout_orders y devuelve los parámetros del
// Web Checkout de Wompi. El monto siempre sale del plan en BD.
async function createCheckoutOrder({ plan, billingCycle, buyerName, businessName, email, phone, adminId = null, redirectUrl }) {
  const config = await gatewayConfig();
  if (!config.publicKey || !config.integritySecret || !config.eventsSecret) {
    const err = new Error('Los pagos estarán disponibles cuando finalicemos la configuración de Wompi.');
    err.status = 503;
    err.code = 'PAYMENT_GATEWAY_NOT_CONFIGURED';
    throw err;
  }

  const amountPesos = Number(billingCycle === 'yearly' ? plan.price_yearly : plan.price_monthly);
  if (!Number.isSafeInteger(amountPesos) || amountPesos <= 0) throw new Error('Precio de plan inválido');
  const amountCents = amountPesos * 100;
  const currency = plan.currency || 'COP';
  const reference = `DS-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const signature = sha256(`${reference}${amountCents}${currency}${config.integritySecret}`);

  // activated_admin_id: cuando la compra sale del panel ya sabemos a qué
  // administrador pertenece, así el webhook puede activar el plan solo.
  await db.query(
    `INSERT INTO subscription_checkout_orders (
       reference, plan_id, plan_slug, plan_name, billing_cycle,
       buyer_name, business_name, email, phone, currency, amount_cents,
       consent_accepted, activated_admin_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12)`,
    [reference, plan.id, plan.slug, plan.name, billingCycle, buyerName,
      businessName, email, phone, currency, amountCents, adminId]
  );

  return {
    url: 'https://checkout.wompi.co/p/',
    public_key: config.publicKey,
    currency,
    amount_in_cents: amountCents,
    reference,
    signature_integrity: signature,
    redirect_url: (redirectUrl || `${config.landingUrl}/?payment=return`) + `&reference=${encodeURIComponent(reference)}`,
  };
}

// Activa la suscripción de una orden ya "reclamada" (activation_started_at
// puesto). Si falla, libera el reclamo para poder reintentar.
async function runActivation(order, adminId, changedBy, { releaseAdmin }) {
  try {
    await subscriptionService.activateSubscription(adminId, {
      planSlug: order.plan_slug,
      billingCycle: order.billing_cycle,
      paymentMethod: 'wompi',
      paymentReference: order.reference,
      amountOverride: Number(order.amount_cents) / 100,
      changedBy,
    });
    const { rows } = await db.query(
      `UPDATE subscription_checkout_orders SET activated_at=now() WHERE id=$1 RETURNING *`,
      [order.id]
    );
    return rows[0];
  } catch (activationError) {
    await db.query(
      `UPDATE subscription_checkout_orders
          SET activation_started_at=NULL, activated_by=NULL
              ${releaseAdmin ? ', activated_admin_id=NULL' : ''}
        WHERE id=$1 AND activated_at IS NULL`,
      [order.id]
    );
    throw activationError;
  }
}

exports.create = async (req, res) => {
  try {
    if (req.body?.website) return res.status(201).json({ success: true });

    const planSlug = cleanText(req.body?.plan_slug, 30);
    const billingCycle = cleanText(req.body?.billing_cycle, 10);
    const buyerName = cleanText(req.body?.buyer_name, 120);
    const businessName = cleanText(req.body?.business_name, 160);
    const email = normalizeEmail(req.body?.email);
    const phone = cleanText(req.body?.phone, 40);

    if (!buyerName) return res.status(400).json({ success: false, message: 'El nombre es obligatorio.', field: 'buyer_name' });
    if (!email || !isValidEmail(email) || email.length > 160) {
      return res.status(400).json({ success: false, message: 'Ingresa un correo válido.', field: 'email' });
    }
    if (!['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ success: false, message: 'El ciclo de cobro no es válido.', field: 'billing_cycle' });
    }
    if (req.body?.consent_accepted !== true) {
      return res.status(400).json({ success: false, message: 'Debes autorizar el tratamiento de datos.', field: 'consent_accepted' });
    }
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) {
        return res.status(400).json({ success: false, message: 'Ingresa un teléfono válido.', field: 'phone' });
      }
    }

    const { rows } = await db.query(
      `SELECT id, name, slug, price_monthly, price_yearly, currency
         FROM subscription_plans
        WHERE slug = $1 AND is_active = true AND is_public = true
        LIMIT 1`,
      [planSlug]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'El plan seleccionado no está disponible.' });

    const checkout = await createCheckoutOrder({
      plan: rows[0], billingCycle, buyerName, businessName, email, phone,
    });
    return res.status(201).json({ success: true, checkout });
  } catch (error) {
    if (error.status === 503) return res.status(503).json({ success: false, message: error.message, code: error.code });
    console.error(`[subscriptionCheckout] [${req.id || '-'}] create:`, error.message);
    return res.status(500).json({ success: false, message: 'No pudimos iniciar el pago. Intenta nuevamente.' });
  }
};

// POST /api/subscriptions/checkout — el administrador ya registrado paga su
// plan desde el panel. Al aprobarse, el webhook activa la suscripción.
exports.createForAdmin = async (req, res) => {
  try {
    const adminId = req.user.owner_admin_id || req.user.id;
    const planSlug = cleanText(req.body?.plan_slug, 30);
    const billingCycle = cleanText(req.body?.billing_cycle, 10);
    if (!['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ success: false, message: 'El ciclo de cobro no es válido.' });
    }

    const { rows: plans } = await db.query(
      `SELECT id, name, slug, price_monthly, price_yearly, currency
         FROM subscription_plans
        WHERE slug = $1 AND is_active = true
        LIMIT 1`,
      [planSlug]
    );
    if (!plans.length) return res.status(404).json({ success: false, message: 'El plan seleccionado no está disponible.' });

    const { rows: users } = await db.query(
      `SELECT u.name, u.email, u.phone, ap.business_name, ap.business_phone
         FROM users u
         LEFT JOIN admin_profiles ap ON ap.user_id = u.id
        WHERE u.id = $1`,
      [adminId]
    );
    const buyer = users[0];
    const email = normalizeEmail(buyer?.email);
    if (!buyer || !email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Agrega un correo válido a tu cuenta antes de pagar.' });
    }

    const adminUrl = (process.env.ADMIN_URL || process.env.FRONTEND_URL || 'https://delasoftfront.vercel.app').replace(/\/$/, '');
    const checkout = await createCheckoutOrder({
      plan: plans[0],
      billingCycle,
      buyerName: cleanText(buyer.name, 120) || email,
      businessName: cleanText(buyer.business_name, 160),
      email: email.slice(0, 160),
      phone: cleanText(buyer.business_phone || buyer.phone, 40),
      adminId,
      redirectUrl: `${adminUrl}/subscription?payment=return`,
    });
    return res.status(201).json({ success: true, checkout });
  } catch (error) {
    if (error.status === 503) return res.status(503).json({ success: false, message: error.message, code: error.code });
    console.error(`[subscriptionCheckout] [${req.id || '-'}] createForAdmin:`, error.message);
    return res.status(500).json({ success: false, message: 'No pudimos iniciar el pago. Intenta nuevamente.' });
  }
};

// GET público: devuelve únicamente información no sensible de una referencia de alta entropía.
exports.getStatus = async (req, res) => {
  try {
    const reference = cleanText(req.params?.reference, 100);
    if (!reference || !/^DS-[A-Za-z0-9-]+$/.test(reference)) {
      return res.status(400).json({ success: false, message: 'Referencia inválida.' });
    }
    const { rows } = await db.query(
      `SELECT reference, plan_slug, plan_name, billing_cycle, currency, amount_cents,
              status, wompi_status, paid_at, activated_at, expires_at, created_at
         FROM subscription_checkout_orders
        WHERE reference = $1
        LIMIT 1`,
      [reference]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'No encontramos esta orden.' });
    return res.json({ success: true, order: rows[0] });
  } catch (error) {
    console.error(`[subscriptionCheckout] [${req.id || '-'}] getStatus:`, error.message);
    return res.status(500).json({ success: false, message: 'No pudimos consultar el pago.' });
  }
};

exports.listAdmin = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = (page - 1) * limit;
    const status = cleanText(req.query.status, 20);
    const search = cleanText(req.query.search, 120);
    const allowed = new Set(['pending', 'approved', 'declined', 'voided', 'error', 'expired', 'activated']);
    const conditions = [];
    const values = [];
    if (status && status !== 'all') {
      if (!allowed.has(status)) return res.status(400).json({ success: false, message: 'Estado inválido.' });
      if (status === 'activated') conditions.push('sco.activated_at IS NOT NULL');
      else { values.push(status); conditions.push(`sco.status = $${values.length}`); }
    }
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(sco.reference ILIKE $${values.length} OR sco.buyer_name ILIKE $${values.length} OR sco.business_name ILIKE $${values.length} OR sco.email ILIKE $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const listValues = [...values, limit, offset];
    const [items, total, counts] = await Promise.all([
      db.query(
        `SELECT sco.*, u.name AS activated_admin_name, u.email AS activated_admin_email
           FROM subscription_checkout_orders sco
           LEFT JOIN users u ON u.id = sco.activated_admin_id
           ${where}
          ORDER BY sco.created_at DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        listValues
      ),
      db.query(`SELECT COUNT(*)::int AS total FROM subscription_checkout_orders sco ${where}`, values),
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE status='pending')::int AS pending,
                       COUNT(*) FILTER (WHERE status='approved')::int AS approved,
                       COUNT(*) FILTER (WHERE status='declined')::int AS declined,
                       COUNT(*) FILTER (WHERE activated_at IS NOT NULL)::int AS activated
                  FROM subscription_checkout_orders`),
    ]);
    return res.json({ success: true, data: items.rows, counts: counts.rows[0], pagination: { page, limit, total: total.rows[0].total } });
  } catch (error) {
    console.error(`[subscriptionCheckout] [${req.id || '-'}] listAdmin:`, error.message);
    return res.status(500).json({ success: false, message: 'No pudimos cargar las órdenes.' });
  }
};

exports.activate = async (req, res) => {
  const orderId = Number(req.params.id);
  const adminId = Number(req.body?.admin_id);
  if (!Number.isSafeInteger(orderId) || !Number.isSafeInteger(adminId)) {
    return res.status(400).json({ success: false, message: 'Orden o administrador inválido.' });
  }
  try {
    const admin = await db.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
       WHERE u.id=$1 AND u.is_active=true AND r.name='admin' LIMIT 1`,
      [adminId]
    );
    if (!admin.rowCount) return res.status(404).json({ success: false, message: 'Administrador activo no encontrado.' });

    const claim = await db.query(
      `UPDATE subscription_checkout_orders
          SET activated_admin_id=$1, activation_started_at=now(), activated_by=$2
        WHERE id=$3 AND status='approved' AND activated_at IS NULL
          AND (activation_started_at IS NULL OR activation_started_at < now() - interval '15 minutes')
        RETURNING *`,
      [adminId, req.user.id, orderId]
    );
    if (!claim.rowCount) {
      return res.status(409).json({ success: false, message: 'La orden no está aprobada, ya fue activada o está siendo procesada.' });
    }
    const activated = await runActivation(claim.rows[0], adminId, req.user.id, { releaseAdmin: true });
    return res.json({ success: true, message: 'Suscripción activada correctamente.', data: activated });
  } catch (error) {
    console.error(`[subscriptionCheckout] [${req.id || '-'}] activate:`, error.message);
    return res.status(500).json({ success: false, message: 'No pudimos activar la suscripción.' });
  }
};

exports.webhook = async (req, res) => {
  try {
    const event = req.body;
    const properties = event?.signature?.properties;
    const receivedChecksum = req.get('X-Event-Checksum') || event?.signature?.checksum;
    const eventsSecret = (await gatewayConfig()).eventsSecret;

    if (!eventsSecret || !Array.isArray(properties) || !properties.length || !event?.data || !event?.timestamp || !receivedChecksum) {
      return res.status(400).json({ success: false, message: 'Evento inválido.' });
    }

    const signedValues = properties.map((path) => getNestedValue(event.data, path));
    if (signedValues.some((value) => value === undefined || value === null)) {
      return res.status(400).json({ success: false, message: 'Propiedades de firma inválidas.' });
    }
    const expectedChecksum = sha256(`${signedValues.join('')}${event.timestamp}${eventsSecret}`);
    if (!safeEqual(expectedChecksum, receivedChecksum)) {
      return res.status(401).json({ success: false, message: 'Firma de evento inválida.' });
    }

    if (event.event !== 'transaction.updated') return res.status(200).json({ received: true });
    const transaction = event.data.transaction;
    const statusMap = { APPROVED: 'approved', DECLINED: 'declined', VOIDED: 'voided', ERROR: 'error' };
    const status = statusMap[transaction.status] || 'pending';

    const result = await db.query(
      `UPDATE subscription_checkout_orders
          SET status = $1,
              wompi_transaction_id = $2,
              wompi_status = $3,
              wompi_payment_method = $4,
              wompi_event_id = $5,
              paid_at = CASE WHEN $1 = 'approved' THEN COALESCE(paid_at, now()) ELSE paid_at END
        WHERE reference = $6
          AND amount_cents = $7
          AND currency = $8
        RETURNING id`,
      [status, transaction.id, transaction.status, transaction.payment_method_type || null,
        event.id || null, transaction.reference, transaction.amount_in_cents, transaction.currency]
    );

    if (!result.rowCount) console.warn(`[subscriptionCheckout] Evento sin orden coincidente: ${transaction.reference}`);

    // Órdenes creadas desde el panel ya traen el administrador: se activan solas.
    // Las de la landing (sin administrador) siguen esperando en Contrataciones.
    if (result.rowCount && status === 'approved') {
      const claim = await db.query(
        `UPDATE subscription_checkout_orders
            SET activation_started_at=now(), activated_by=activated_admin_id
          WHERE id=$1 AND status='approved' AND activated_at IS NULL
            AND activated_admin_id IS NOT NULL
            AND (activation_started_at IS NULL OR activation_started_at < now() - interval '15 minutes')
          RETURNING *`,
        [result.rows[0].id]
      );
      if (claim.rowCount) {
        const order = claim.rows[0];
        try {
          await runActivation(order, Number(order.activated_admin_id), Number(order.activated_admin_id), { releaseAdmin: false });
        } catch (activationError) {
          // El pago queda aprobado; el superadmin puede activarlo desde Contrataciones.
          console.error(`[subscriptionCheckout] Activación automática fallida ${order.reference}:`, activationError.message);
        }
      }
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(`[subscriptionCheckout] [${req.id || '-'}] webhook:`, error.message);
    return res.status(500).json({ success: false });
  }
};
