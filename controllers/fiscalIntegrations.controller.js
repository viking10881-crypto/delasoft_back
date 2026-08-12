'use strict';

const db = require('../config/db');
const { encrypt } = require('../utils/crypto');
const { verifyIntegration } = require('../services/fiscalIntegration.service');

const MASKED = '••••••••••••';
const adminId = (req) => req.user.owner_admin_id ?? req.user.id;
const clean = (value, max = 255) => typeof value === 'string' ? value.trim().slice(0, max) : null;
const integer = (value) => value === '' || value == null ? null : Number.parseInt(value, 10);

exports.get = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id,provider,environment,status,client_id,tax_id,verification_digit,
              document_type_id,numbering_range_id,municipality_id,tribute_id,
              legal_organization_id,fiscal_regime_id,fiscal_responsibility_code,
              request_mode,is_active,last_verified_at,last_error,created_at,updated_at
       FROM store_fiscal_integrations WHERE admin_id=$1 AND provider='factus' LIMIT 1`,
      [adminId(req)]
    );
    return res.json({ success: true, data: rows[0] ? {
      ...rows[0], client_secret: MASKED, username: MASKED, password: MASKED,
    } : null });
  } catch (error) {
    console.error('[fiscalIntegrations] get:', error.message);
    return res.status(500).json({ success: false, message: 'No se pudo cargar la configuración fiscal' });
  }
};

exports.save = async (req, res) => {
  const body = req.body || {};
  const environment = clean(body.environment, 20) || 'sandbox';
  const requestMode = clean(body.request_mode, 20) || 'customer_request';
  if (!['sandbox', 'production'].includes(environment) || !['customer_request', 'always', 'manual'].includes(requestMode)) {
    return res.status(400).json({ success: false, message: 'Configuración inválida' });
  }
  if (!clean(body.client_id) || !clean(body.tax_id, 30)) {
    return res.status(400).json({ success: false, message: 'Client ID y NIT son obligatorios' });
  }
  try {
    const current = await db.query(
      `SELECT * FROM store_fiscal_integrations WHERE admin_id=$1 AND provider='factus' LIMIT 1`,
      [adminId(req)]
    );
    const existing = current.rows[0];
    for (const key of ['client_secret', 'username', 'password']) {
      if (!existing && !clean(body[key])) return res.status(400).json({ success: false, message: `${key} es obligatorio` });
    }
    const secret = (key) => clean(body[key]) && body[key] !== MASKED
      ? encrypt(clean(body[key])) : existing?.[`${key}_encrypted`];
    const values = [
      adminId(req), environment, clean(body.client_id), secret('client_secret'), secret('username'),
      secret('password'), clean(body.tax_id, 30), clean(body.verification_digit, 2),
      integer(body.document_type_id), integer(body.numbering_range_id), integer(body.municipality_id),
      integer(body.tribute_id), integer(body.legal_organization_id), integer(body.fiscal_regime_id),
      clean(body.fiscal_responsibility_code, 20), requestMode,
    ];
    const { rows } = await db.query(
      `INSERT INTO store_fiscal_integrations
       (admin_id,provider,environment,status,client_id,client_secret_encrypted,username_encrypted,
        password_encrypted,tax_id,verification_digit,document_type_id,numbering_range_id,
        municipality_id,tribute_id,legal_organization_id,fiscal_regime_id,
        fiscal_responsibility_code,request_mode,is_active,updated_at)
       VALUES ($1,'factus',$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,false,now())
       ON CONFLICT (admin_id,provider) DO UPDATE SET
        environment=EXCLUDED.environment,status='pending',client_id=EXCLUDED.client_id,
        client_secret_encrypted=EXCLUDED.client_secret_encrypted,username_encrypted=EXCLUDED.username_encrypted,
        password_encrypted=EXCLUDED.password_encrypted,tax_id=EXCLUDED.tax_id,
        verification_digit=EXCLUDED.verification_digit,document_type_id=EXCLUDED.document_type_id,
        numbering_range_id=EXCLUDED.numbering_range_id,municipality_id=EXCLUDED.municipality_id,
        tribute_id=EXCLUDED.tribute_id,legal_organization_id=EXCLUDED.legal_organization_id,
        fiscal_regime_id=EXCLUDED.fiscal_regime_id,fiscal_responsibility_code=EXCLUDED.fiscal_responsibility_code,
        request_mode=EXCLUDED.request_mode,is_active=false,last_error=NULL,updated_at=now()
       RETURNING id,provider,environment,status,client_id,tax_id,request_mode,is_active,updated_at`, values
    );
    return res.json({ success: true, message: 'Configuración guardada. Verifica la conexión para activarla.', data: rows[0] });
  } catch (error) {
    console.error('[fiscalIntegrations] save:', error.message);
    return res.status(500).json({ success: false, message: 'No se pudo guardar la configuración fiscal' });
  }
};

exports.verify = async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM store_fiscal_integrations WHERE admin_id=$1 AND provider='factus' LIMIT 1`, [adminId(req)]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'Guarda primero la configuración' });
    try {
      await verifyIntegration(result.rows[0]);
      await db.query(`UPDATE store_fiscal_integrations SET status='connected',is_active=true,last_verified_at=now(),last_error=NULL,updated_at=now() WHERE id=$1`, [result.rows[0].id]);
      return res.json({ success: true, message: `Conexión ${result.rows[0].environment} verificada correctamente` });
    } catch (providerError) {
      await db.query(`UPDATE store_fiscal_integrations SET status='error',is_active=false,last_error=$1,updated_at=now() WHERE id=$2`, [providerError.message.slice(0,1000), result.rows[0].id]);
      return res.status(422).json({ success: false, message: providerError.message });
    }
  } catch (error) {
    console.error('[fiscalIntegrations] verify:', error.message);
    return res.status(500).json({ success: false, message: 'No se pudo verificar la conexión' });
  }
};

exports.getForSale = async (req, res) => {
  const saleId = Number(req.params.saleId);
  if (!Number.isSafeInteger(saleId)) return res.status(400).json({ success: false, message: 'Venta inválida' });
  try {
    const sale = await db.query(`SELECT id FROM sales WHERE id=$1 AND owner_admin_id=$2 LIMIT 1`, [saleId, adminId(req)]);
    if (!sale.rowCount) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    const [integration, invoice] = await Promise.all([
      db.query(`SELECT status,is_active,environment,request_mode FROM store_fiscal_integrations WHERE admin_id=$1 AND provider='factus' LIMIT 1`, [adminId(req)]),
      db.query(`SELECT id,status,invoice_number,cufe,pdf_url,xml_url,error_message,requested_at,issued_at FROM sale_electronic_invoices WHERE sale_id=$1 LIMIT 1`, [saleId]),
    ]);
    return res.json({ success: true, data: { integration: integration.rows[0] || null, invoice: invoice.rows[0] || null } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'No se pudo consultar la factura electrónica' });
  }
};

exports.requestForSale = async (req, res) => {
  const saleId = Number(req.params.saleId);
  if (!Number.isSafeInteger(saleId)) return res.status(400).json({ success: false, message: 'Venta inválida' });
  try {
    const integration = await db.query(`SELECT id,provider,environment,status,is_active FROM store_fiscal_integrations WHERE admin_id=$1 AND provider='factus' LIMIT 1`, [adminId(req)]);
    if (!integration.rowCount || !integration.rows[0].is_active || integration.rows[0].status !== 'connected') {
      return res.status(409).json({ success: false, message: 'Configura y verifica Factus antes de solicitar una factura electrónica' });
    }
    const sale = await db.query(`SELECT id,payment_status FROM sales WHERE id=$1 AND owner_admin_id=$2 LIMIT 1`, [saleId, adminId(req)]);
    if (!sale.rowCount) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (sale.rows[0].payment_status === 'cancelled') return res.status(409).json({ success: false, message: 'No se puede facturar una venta cancelada' });
    const cfg = integration.rows[0];
    const { rows } = await db.query(
      `INSERT INTO sale_electronic_invoices (sale_id,owner_admin_id,integration_id,provider,environment,status,requested_by)
       VALUES ($1,$2,$3,$4,$5,'requested',$6)
       ON CONFLICT (sale_id) DO UPDATE SET requested_at=now(),requested_by=EXCLUDED.requested_by,updated_at=now()
       RETURNING id,status,requested_at`, [saleId,adminId(req),cfg.id,cfg.provider,cfg.environment,req.user.id]
    );
    await db.query(`UPDATE sales SET electronic_invoice_requested=true,updated_at=now() WHERE id=$1`, [saleId]);
    return res.status(201).json({ success: true, message: 'Solicitud registrada. Quedó pendiente de emisión y validación.', data: rows[0] });
  } catch (error) {
    console.error('[fiscalIntegrations] requestForSale:', error.message);
    return res.status(500).json({ success: false, message: 'No se pudo solicitar la factura electrónica' });
  }
};
