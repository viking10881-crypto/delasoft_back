const db = require('../config/db');
const { isValidEmail, normalizeEmail } = require('../utils/validation');

const ALLOWED_PLANS = new Set(['basic', 'standard', 'pro', 'not_sure']);
const ALLOWED_STATUSES = new Set(['new', 'contacted', 'demo_scheduled', 'negotiating', 'converted', 'discarded']);

const cleanText = (value, maxLength) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const validationError = (res, message, field) => res.status(400).json({
  success: false,
  message,
  code: 'VALIDATION_ERROR',
  field,
});

// POST /api/public/leads — recibe prospectos desde la landing, sin autenticación.
exports.submit = async (req, res) => {
  try {
    // Honeypot: los visitantes reales nunca completan este campo.
    if (req.body?.website) {
      return res.status(201).json({
        success: true,
        message: 'Solicitud recibida correctamente.',
      });
    }

    const name = cleanText(req.body?.name, 120);
    const email = normalizeEmail(req.body?.email);
    const businessName = cleanText(req.body?.business_name, 160);
    const phone = cleanText(req.body?.phone, 40);
    const businessType = cleanText(req.body?.business_type, 100);
    const productCount = cleanText(req.body?.product_count, 50);
    const message = cleanText(req.body?.message, 1500);
    const interestedPlan = cleanText(req.body?.interested_plan, 30) || 'not_sure';

    if (!name) return validationError(res, 'El nombre es obligatorio.', 'name');
    if (!email || !isValidEmail(email) || email.length > 160) {
      return validationError(res, 'Ingresa un correo electrónico válido.', 'email');
    }
    if (req.body?.consent_accepted !== true) {
      return validationError(res, 'Debes autorizar el tratamiento de datos para enviar la solicitud.', 'consent_accepted');
    }
    if (!ALLOWED_PLANS.has(interestedPlan)) {
      return validationError(res, 'El plan seleccionado no es válido.', 'interested_plan');
    }
    if (phone) {
      const phoneDigits = phone.replace(/\D/g, '');
      if (phoneDigits.length < 7 || phoneDigits.length > 15) {
        return validationError(res, 'Ingresa un teléfono válido.', 'phone');
      }
    }

    const utmSource = cleanText(req.body?.utm_source, 120);
    const utmMedium = cleanText(req.body?.utm_medium, 120);
    const utmCampaign = cleanText(req.body?.utm_campaign, 160);
    const landingPage = cleanText(req.body?.landing_page, 255);

    // Evita registros idénticos por doble clic o reenvío inmediato.
    const { rows: recent } = await db.query(
      `SELECT id
         FROM contact_leads
        WHERE LOWER(email) = LOWER($1)
          AND created_at >= NOW() - INTERVAL '10 minutes'
        ORDER BY created_at DESC
        LIMIT 1`,
      [email]
    );

    if (recent.length) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: 'Ya recibimos tu solicitud. Nos comunicaremos contigo muy pronto.',
      });
    }

    const { rows } = await db.query(
      `INSERT INTO contact_leads (
         name, business_name, email, phone, business_type, product_count,
         interested_plan, message, status, source, consent_accepted,
         utm_source, utm_medium, utm_campaign, landing_page
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, 'new', 'landing', TRUE,
         $9, $10, $11, $12
       )
       RETURNING id, created_at`,
      [
        name, businessName, email, phone, businessType, productCount,
        interestedPlan, message, utmSource, utmMedium, utmCampaign, landingPage,
      ]
    );

    console.log(`[Leads] Nueva solicitud #${rows[0].id}`);

    return res.status(201).json({
      success: true,
      message: 'Solicitud recibida correctamente.',
    });
  } catch (error) {
    console.error(`[leads.controller] [${req.id || '-'}] submit:`, error.message);
    return res.status(500).json({
      success: false,
      message: 'No pudimos registrar la solicitud. Intenta nuevamente.',
      code: 'LEAD_SUBMISSION_FAILED',
    });
  }
};

// GET /api/superadmin/leads — listado comercial protegido.
exports.list = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = (page - 1) * limit;
    const status = cleanText(req.query.status, 30);
    const plan = cleanText(req.query.plan, 30);
    const search = cleanText(req.query.search, 120);
    const conditions = [];
    const values = [];

    if (status && status !== 'all') {
      if (!ALLOWED_STATUSES.has(status)) return validationError(res, 'El estado no es válido.', 'status');
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    if (plan && plan !== 'all') {
      if (!ALLOWED_PLANS.has(plan)) return validationError(res, 'El plan no es válido.', 'plan');
      values.push(plan);
      conditions.push(`interested_plan = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(
        name ILIKE $${values.length}
        OR business_name ILIKE $${values.length}
        OR email ILIKE $${values.length}
        OR phone ILIKE $${values.length}
      )`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const listValues = [...values, limit, offset];
    const [itemsResult, filteredTotalResult, totalsResult] = await Promise.all([
      db.query(
        `SELECT id, name, business_name, email, phone, business_type, product_count,
                interested_plan, message, status, source, notes, assigned_admin_id,
                converted_user_id, converted_business_id, consent_accepted,
                contacted_at, demo_scheduled_at, converted_at,
                utm_source, utm_medium, utm_campaign, landing_page,
                created_at, updated_at
           FROM contact_leads
           ${where}
          ORDER BY created_at DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        listValues
      ),
      db.query(`SELECT COUNT(*)::int AS total FROM contact_leads ${where}`, values),
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'new')::int AS new,
                COUNT(*) FILTER (WHERE status = 'contacted')::int AS contacted,
                COUNT(*) FILTER (WHERE status = 'demo_scheduled')::int AS demo_scheduled,
                COUNT(*) FILTER (WHERE status = 'negotiating')::int AS negotiating,
                COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
                COUNT(*) FILTER (WHERE status = 'discarded')::int AS discarded
           FROM contact_leads`
      ),
    ]);

    return res.json({
      success: true,
      data: itemsResult.rows,
      counts: totalsResult.rows[0],
      pagination: {
        page,
        limit,
        total: Number(filteredTotalResult.rows[0].total),
      },
    });
  } catch (error) {
    console.error(`[leads.controller] [${req.id || '-'}] list:`, error.message);
    return res.status(500).json({ success: false, message: 'No pudimos cargar los prospectos.' });
  }
};

// PATCH /api/superadmin/leads/:id — seguimiento comercial protegido.
exports.update = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return validationError(res, 'Identificador inválido.', 'id');

    const status = cleanText(req.body?.status, 30);
    if (status && !ALLOWED_STATUSES.has(status)) {
      return validationError(res, 'El estado no es válido.', 'status');
    }

    const hasNotes = Object.prototype.hasOwnProperty.call(req.body || {}, 'notes');
    const hasDemoDate = Object.prototype.hasOwnProperty.call(req.body || {}, 'demo_scheduled_at');
    const notes = req.body?.notes === null ? null : cleanText(req.body?.notes, 5000);
    const demoScheduledAt = req.body?.demo_scheduled_at || null;
    if (demoScheduledAt && Number.isNaN(Date.parse(demoScheduledAt))) {
      return validationError(res, 'La fecha de demostración no es válida.', 'demo_scheduled_at');
    }

    const { rows } = await db.query(
      `UPDATE contact_leads
          SET status = COALESCE($1, status),
              notes = CASE WHEN $2 THEN $3 ELSE notes END,
              demo_scheduled_at = CASE WHEN $4 THEN $5 ELSE demo_scheduled_at END,
              contacted_at = CASE
                WHEN $1 IN ('contacted', 'demo_scheduled', 'negotiating', 'converted')
                  THEN COALESCE(contacted_at, NOW())
                ELSE contacted_at
              END,
              converted_at = CASE
                WHEN $1 = 'converted' THEN COALESCE(converted_at, NOW())
                WHEN $1 IS NOT NULL AND $1 <> 'converted' THEN NULL
                ELSE converted_at
              END
        WHERE id = $6
        RETURNING *`,
      [status, hasNotes, notes, hasDemoDate, demoScheduledAt, id]
    );

    if (!rows.length) return res.status(404).json({ success: false, message: 'Prospecto no encontrado.' });
    return res.json({ success: true, data: rows[0], message: 'Prospecto actualizado.' });
  } catch (error) {
    console.error(`[leads.controller] [${req.id || '-'}] update:`, error.message);
    return res.status(500).json({ success: false, message: 'No pudimos actualizar el prospecto.' });
  }
};
