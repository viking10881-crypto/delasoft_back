const crypto = require('crypto');
const db = require('../config/db');
const { isValidEmail, normalizeEmail } = require('../utils/validation');

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

const gatewayConfig = () => ({
  publicKey: process.env.WOMPI_SUBSCRIPTIONS_PUBLIC_KEY,
  integritySecret: process.env.WOMPI_SUBSCRIPTIONS_INTEGRITY_SECRET,
  eventsSecret: process.env.WOMPI_SUBSCRIPTIONS_EVENTS_SECRET,
  landingUrl: (process.env.LANDING_URL || 'http://localhost:5173').replace(/\/$/, ''),
});

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

    const config = gatewayConfig();
    if (!config.publicKey || !config.integritySecret || !config.eventsSecret) {
      return res.status(503).json({
        success: false,
        message: 'Los pagos estarán disponibles cuando finalicemos la configuración de Wompi.',
        code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
      });
    }

    const plan = rows[0];
    const amountPesos = Number(billingCycle === 'yearly' ? plan.price_yearly : plan.price_monthly);
    if (!Number.isSafeInteger(amountPesos) || amountPesos <= 0) throw new Error('Precio de plan inválido');
    const amountCents = amountPesos * 100;
    const currency = plan.currency || 'COP';
    const reference = `DS-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const signature = sha256(`${reference}${amountCents}${currency}${config.integritySecret}`);

    await db.query(
      `INSERT INTO subscription_checkout_orders (
         reference, plan_id, plan_slug, plan_name, billing_cycle,
         buyer_name, business_name, email, phone, currency, amount_cents,
         consent_accepted
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,
      [reference, plan.id, plan.slug, plan.name, billingCycle, buyerName,
        businessName, email, phone, currency, amountCents]
    );

    return res.status(201).json({
      success: true,
      checkout: {
        url: 'https://checkout.wompi.co/p/',
        public_key: config.publicKey,
        currency,
        amount_in_cents: amountCents,
        reference,
        signature_integrity: signature,
        redirect_url: `${config.landingUrl}/?payment=return&reference=${encodeURIComponent(reference)}`,
      },
    });
  } catch (error) {
    console.error(`[subscriptionCheckout] [${req.id || '-'}] create:`, error.message);
    return res.status(500).json({ success: false, message: 'No pudimos iniciar el pago. Intenta nuevamente.' });
  }
};

exports.webhook = async (req, res) => {
  try {
    const event = req.body;
    const properties = event?.signature?.properties;
    const receivedChecksum = req.get('X-Event-Checksum') || event?.signature?.checksum;
    const eventsSecret = gatewayConfig().eventsSecret;

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
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(`[subscriptionCheckout] [${req.id || '-'}] webhook:`, error.message);
    return res.status(500).json({ success: false });
  }
};
