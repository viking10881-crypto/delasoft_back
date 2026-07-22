// config/emailConfig.js

const SENDER = {
  name:  "Delasoft Boutique",
  email: process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM,
};

// ============================================
// 🔧 INICIALIZACIÓN LAZY
// ============================================
let _apiInstance = null;
let _SendSmtpEmail = null;

function getBrevoClient() {
  if (_apiInstance) return { apiInstance: _apiInstance, SendSmtpEmail: _SendSmtpEmail };

  const brevo = require('@getbrevo/brevo');

  _SendSmtpEmail = brevo.SendSmtpEmail;

  if (!brevo.TransactionalEmailsApi || !_SendSmtpEmail) {
    throw new Error('Brevo: exports inválidos (TransactionalEmailsApi o SendSmtpEmail no encontrados)');
  }

  _apiInstance = new brevo.TransactionalEmailsApi();

  _apiInstance.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  console.log('[Brevo] API key cargada:', !!process.env.BREVO_API_KEY ? '✓' : '✗ VACÍA');

  return { apiInstance: _apiInstance, SendSmtpEmail: _SendSmtpEmail };
}

// ============================================
// 🎨 BRANDING HELPERS (internos)
// ============================================
const DELASOFT_BRANDING = {
  businessName:   'Delasoft Boutique',
  logoUrl:        null,
  tagline:        null,
  primaryColor:   '#0f172a',
  secondaryColor: '#1e3a5f',
  accentColor:    '#3b82f6',
  businessEmail:  null,
};

function getContrastTextColor(hex) {
  const clean = (hex || '#3B82F6').replace('#', '');
  if (clean.length !== 6) return '#ffffff';
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? '#000000' : '#ffffff';
}

function buildBrandedEmail({ branding, badge, body }) {
  const { businessName, logoUrl, tagline, primaryColor, secondaryColor, businessEmail } = branding;
  const txtColor  = getContrastTextColor(primaryColor);
  const year      = new Date().getFullYear();
  const logoHtml  = logoUrl
    ? `<img src="${logoUrl}" alt="${businessName}" style="max-height:56px;max-width:200px;object-fit:contain;margin-bottom:14px;display:block;margin-left:auto;margin-right:auto;" />`
    : '';
  const nameStyle = `color:${txtColor};font-size:${logoUrl ? '22px' : '36px'};font-weight:${logoUrl ? '700' : '900'};letter-spacing:-1px;margin:0;`;
  const emailLink = businessEmail
    ? `<div style="color:#94a3b8;font-size:12px;margin-bottom:6px;">¿Consultas? <a href="mailto:${businessEmail}" style="color:#cbd5e1;text-decoration:none;font-weight:700;">${businessEmail}</a></div>`
    : '';
  return `<!DOCTYPE html><html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background:linear-gradient(135deg,${primaryColor} 0%,${secondaryColor} 100%);padding:48px 40px;border-radius:20px 20px 0 0;text-align:center;">
            ${logoHtml}
            <div style="${nameStyle}">${businessName}</div>
            ${tagline ? `<div style="color:${txtColor};opacity:0.75;font-size:13px;margin-top:6px;">${tagline}</div>` : ''}
            <div style="width:40px;height:3px;background:rgba(255,255,255,0.4);margin:16px auto 24px;border-radius:2px;"></div>
            <div style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:50px;display:inline-block;padding:10px 28px;">
              <span style="color:${txtColor};font-size:13px;font-weight:800;">${badge}</span>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:white;padding:48px 40px;">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="background:#1e293b;padding:28px 40px;border-radius:0 0 20px 20px;text-align:center;">
            ${emailLink}
            <div style="color:#475569;font-size:12px;">© ${year} ${businessName} · Todos los derechos reservados</div>
            <div style="color:#334155;font-size:10px;margin-top:5px;">Gestionado con <span style="color:#64748b;">Delasoft</span></div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ============================================
// 🔐 CÓDIGO DE VERIFICACIÓN  (plataforma — branding Delasoft fijo)
// ============================================
const generateVerificationCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const sendVerificationEmail = async (email, code, userName) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const sendSmtpEmail = new SendSmtpEmail();

  sendSmtpEmail.subject     = "🔐 Verifica tu cuenta - Delasoft Boutique";
  sendSmtpEmail.to          = [{ email, name: userName || 'Usuario' }];
  sendSmtpEmail.sender      = SENDER;
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html><html lang="es">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:48px 40px;border-radius:20px 20px 0 0;text-align:center;">
                <div style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:50px;display:inline-block;padding:6px 20px;margin-bottom:20px;">
                  <span style="color:#93c5fd;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">Boutique Premium · 2026</span>
                </div>
                <div style="color:white;font-size:40px;font-weight:900;letter-spacing:-2px;text-transform:uppercase;margin:0;">DELASOFT</div>
                <div style="width:40px;height:3px;background:#3b82f6;margin:16px auto 24px;border-radius:2px;"></div>
                <div style="background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.4);border-radius:50px;display:inline-block;padding:10px 28px;">
                  <span style="color:#c7d2fe;font-size:13px;font-weight:700;">🔐 &nbsp;VERIFICACIÓN DE CUENTA</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="background:white;padding:48px 40px;">
                <p style="font-size:24px;color:#0f172a;font-weight:800;margin:0 0 12px;">¡Hola, ${userName || 'bienvenido/a'}! 👋</p>
                <p style="font-size:15px;color:#64748b;line-height:1.75;margin:0 0 36px;">
                  Estás a un paso de unirte a <strong style="color:#0f172a;">Delasoft Boutique</strong>.
                  Usa el código de abajo para activar tu cuenta. Es válido por <strong>10 minutos</strong>.
                </p>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#f8fafc,#f1f5f9);border:2px dashed #cbd5e1;border-radius:20px;margin-bottom:36px;">
                  <tr>
                    <td style="padding:36px;text-align:center;">
                      <div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:3px;text-transform:uppercase;margin-bottom:16px;">Tu código de verificación</div>
                      <div style="font-size:52px;font-weight:900;color:#0f172a;letter-spacing:10px;font-family:'Courier New',monospace;line-height:1;">${code}</div>
                      <div style="margin-top:20px;display:inline-block;background:#3b82f6;color:white;padding:7px 20px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:1px;">⏱ VÁLIDO POR 10 MINUTOS</div>
                    </td>
                  </tr>
                </table>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef9ec;border-left:4px solid #f59e0b;border-radius:0 12px 12px 0;margin-bottom:32px;">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="font-size:13px;color:#78350f;margin:0;line-height:1.7;">
                        🔒 <strong>No compartas este código</strong> con nadie — Delasoft nunca te lo pedirá.<br>
                        ❌ Si no creaste esta cuenta, puedes ignorar este mensaje con total tranquilidad.
                      </p>
                    </td>
                  </tr>
                </table>
                ${process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM ? `<p style="font-size:13px;color:#94a3b8;text-align:center;margin:0;">
                  ¿Necesitas ayuda? Escríbenos a <a href="mailto:${process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM}" style="color:#3b82f6;text-decoration:none;font-weight:700;">${process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM}</a>
                </p>` : ''}
              </td>
            </tr>
            <tr>
              <td style="background:#0f172a;padding:28px 40px;border-radius:0 0 20px 20px;text-align:center;">
                <div style="color:#475569;font-size:12px;">© 2026 Delasoft Boutique · Todos los derechos reservados</div>
                <div style="color:#334155;font-size:11px;margin-top:6px;">Este es un correo automático, por favor no respondas directamente.</div>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body></html>
  `;

  try {
    const { body } = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('[Email] Verificación enviada — messageId:', body?.messageId ?? '(sin id)');
    return true;
  } catch (error) {
    console.error('[Email] Error enviando verificación:', error?.message ?? error);
    throw new Error('No se pudo enviar el código de verificación');
  }
};

// ============================================
// 📦 EMAIL DE CONFIRMACIÓN DE PEDIDO
// ============================================
const sendOrderConfirmationEmail = async (email, userName, orderData, branding = null) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const { orderCode, total, items = [], shippingAddress, shippingCity, shippingNotes, paymentMethod } = orderData;
  const b = branding ?? DELASOFT_BRANDING;

  const paymentLabels = { transfer:'🏦 Transferencia bancaria', cash:'💵 Efectivo', credit:'💳 Crédito', check:'📄 Cheque' };
  const paymentLabel  = paymentLabels[paymentMethod] || paymentMethod || 'Por confirmar';

  const itemsRows = items.map(item => `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:700;color:#0f172a;font-size:14px;">${item.name}</div>
        ${item.sku ? `<div style="font-size:11px;color:#94a3b8;margin-top:3px;">SKU: ${item.sku}</div>` : ''}
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:center;color:#64748b;font-weight:700;font-size:14px;">x${item.quantity}</td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:900;color:#0f172a;font-size:14px;">$${Number(item.unit_price * item.quantity).toLocaleString('es-CO')}</td>
    </tr>
  `).join('');

  const htmlBody = `
    <p style="font-size:24px;color:#0f172a;font-weight:800;margin:0 0 12px;">¡Gracias, ${userName}! 🎉</p>
    <p style="font-size:15px;color:#64748b;line-height:1.75;margin:0 0 36px;">
      Recibimos tu pedido correctamente. Nuestro equipo lo revisará y se pondrá en contacto
      contigo para coordinar el pago y el envío. Guarda tu código para cualquier consulta.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:16px;margin-bottom:36px;">
      <tr>
        <td style="padding:22px 28px;">
          <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Código de pedido</div>
          <div style="font-size:30px;font-weight:900;color:#0f172a;letter-spacing:2px;font-family:'Courier New',monospace;">${orderCode}</div>
        </td>
        <td style="padding:22px 28px;text-align:right;border-left:1px solid #e2e8f0;">
          <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Fecha</div>
          <div style="font-size:14px;font-weight:700;color:#475569;">${new Date().toLocaleDateString('es-CO',{year:'numeric',month:'long',day:'numeric'})}</div>
        </td>
      </tr>
    </table>
    <div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">Resumen del pedido</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:36px;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Producto</th>
        <th style="padding:10px 16px;text-align:center;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Cant.</th>
        <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Subtotal</th>
      </tr></thead>
      <tbody>${itemsRows}</tbody>
      <tfoot><tr style="background:#0f172a;">
        <td colspan="2" style="padding:16px 18px;color:rgba(255,255,255,0.6);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Total del pedido</td>
        <td style="padding:16px 18px;text-align:right;color:white;font-size:22px;font-weight:900;">$${Number(total).toLocaleString('es-CO')}</td>
      </tr></tfoot>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;margin-bottom:${shippingAddress ? '32px' : '0'};">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:800;color:#92400e;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Método de pago</div>
        <div style="font-size:15px;font-weight:700;color:#78350f;">${paymentLabel}</div>
      </td></tr>
    </table>
    ${shippingAddress ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;margin-top:24px;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:800;color:#166534;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Dirección de envío</div>
        <div style="font-weight:800;color:#14532d;font-size:15px;margin-bottom:4px;">📍 ${shippingCity || ''}</div>
        <div style="color:#166534;font-size:14px;line-height:1.6;">${shippingAddress}</div>
        ${shippingNotes ? `<div style="color:#15803d;font-size:13px;margin-top:8px;font-style:italic;">📝 ${shippingNotes}</div>` : ''}
      </td></tr>
    </table>` : ''}
  `;

  const sendSmtpEmail = new SendSmtpEmail();
  sendSmtpEmail.subject     = `✅ Tu pedido ${orderCode} fue recibido - ${b.businessName}`;
  sendSmtpEmail.to          = [{ email, name: userName }];
  sendSmtpEmail.sender      = SENDER;
  if (b.businessEmail) sendSmtpEmail.replyTo = { email: b.businessEmail, name: b.businessName };
  sendSmtpEmail.htmlContent = buildBrandedEmail({ branding: b, badge: '✓  PEDIDO RECIBIDO', body: htmlBody });

  try {
    const { body } = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('[Email] Confirmación de pedido enviada — messageId:', body?.messageId ?? '(sin id)');
    return true;
  } catch (error) {
    console.error('[Email] Error enviando confirmación de pedido:', error?.message ?? error);
    return false;
  }
};

// ============================================
// ✅ EMAIL DE PAGO CONFIRMADO (Admin → Cliente)
// ============================================
const sendPaymentConfirmedEmail = async (email, userName, orderData, branding = null) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const { orderCode, total, items = [], shippingAddress, shippingCity, shippingNotes, paymentMethod } = orderData;
  const b = branding ?? DELASOFT_BRANDING;

  const paymentLabels = { transfer:'🏦 Transferencia bancaria', cash:'💵 Efectivo', credit:'💳 Tarjeta', check:'📄 Cheque' };
  const paymentLabel  = paymentLabels[paymentMethod] || paymentMethod || 'Confirmado';

  const itemsRows = items.map(item => `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:700;color:#0f172a;font-size:14px;">${item.name}</div>
        ${item.sku ? `<div style="font-size:11px;color:#94a3b8;margin-top:3px;">SKU: ${item.sku}</div>` : ''}
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:center;color:#64748b;font-weight:700;font-size:14px;">x${item.quantity}</td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:900;color:#0f172a;font-size:14px;">$${Number(item.unit_price * item.quantity).toLocaleString('es-CO')}</td>
    </tr>
  `).join('');

  const htmlBody = `
    <p style="font-size:24px;color:#0f172a;font-weight:800;margin:0 0 12px;">¡Excelente noticia, ${userName}! 🎉</p>
    <p style="font-size:15px;color:#64748b;line-height:1.75;margin:0 0 36px;">
      Tu pago fue <strong style="color:#059669;">verificado y aprobado</strong> por nuestro equipo.
      Tu pedido está siendo preparado y pronto nos comunicaremos contigo para coordinar la entrega.
      ¡Gracias por tu confianza!
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:2px solid #86efac;border-radius:16px;margin-bottom:36px;">
      <tr>
        <td style="padding:22px 28px;">
          <div style="font-size:11px;font-weight:700;color:#059669;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Código de pedido</div>
          <div style="font-size:30px;font-weight:900;color:#064e3b;letter-spacing:2px;font-family:'Courier New',monospace;">${orderCode}</div>
        </td>
        <td style="padding:22px 28px;text-align:right;border-left:1px solid #86efac;">
          <div style="font-size:11px;font-weight:700;color:#059669;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Estado</div>
          <div style="background:#16a34a;color:white;font-size:13px;font-weight:800;padding:8px 18px;border-radius:50px;display:inline-block;">✅ Pagado</div>
        </td>
      </tr>
    </table>
    <div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">Resumen del pedido</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:36px;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Producto</th>
        <th style="padding:10px 16px;text-align:center;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Cant.</th>
        <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Subtotal</th>
      </tr></thead>
      <tbody>${itemsRows}</tbody>
      <tfoot><tr style="background:#064e3b;">
        <td colspan="2" style="padding:16px 18px;color:rgba(255,255,255,0.6);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Total pagado</td>
        <td style="padding:16px 18px;text-align:right;color:white;font-size:22px;font-weight:900;">$${Number(total).toLocaleString('es-CO')}</td>
      </tr></tfoot>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;margin-bottom:${shippingAddress ? '32px' : '0'};">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:800;color:#059669;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Método de pago</div>
        <div style="font-size:15px;font-weight:700;color:#065f46;">${paymentLabel}</div>
      </td></tr>
    </table>
    ${shippingAddress ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;margin-top:24px;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:800;color:#1d4ed8;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Dirección de entrega</div>
        <div style="font-weight:800;color:#1e3a8a;font-size:15px;margin-bottom:4px;">📍 ${shippingCity || ''}</div>
        <div style="color:#1d4ed8;font-size:14px;line-height:1.6;">${shippingAddress}</div>
        ${shippingNotes ? `<div style="color:#3b82f6;font-size:13px;margin-top:8px;font-style:italic;">📝 ${shippingNotes}</div>` : ''}
      </td></tr>
    </table>` : ''}
  `;

  const sendSmtpEmail = new SendSmtpEmail();
  sendSmtpEmail.subject     = `🎉 ¡Pago confirmado! Tu pedido ${orderCode} está en camino - ${b.businessName}`;
  sendSmtpEmail.to          = [{ email, name: userName }];
  sendSmtpEmail.sender      = SENDER;
  if (b.businessEmail) sendSmtpEmail.replyTo = { email: b.businessEmail, name: b.businessName };
  sendSmtpEmail.htmlContent = buildBrandedEmail({ branding: b, badge: '✅  PAGO CONFIRMADO', body: htmlBody });

  try {
    const { body } = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('[Email] Pago confirmado enviado — messageId:', body?.messageId ?? '(sin id)');
    return true;
  } catch (error) {
    console.error('[Email] Error enviando pago confirmado:', error?.message ?? error);
    return false;
  }
};

// ============================================
// 🔍 VERIFICAR CONFIGURACIÓN AL INICIAR
// ============================================
const verifyEmailConfig = () => {
  if (!process.env.BREVO_API_KEY) {
    console.warn('[Brevo] BREVO_API_KEY no configurada — emails desactivados');
    return false;
  }
  console.log('[Brevo] Configuración lista ✓');
  return true;
};

verifyEmailConfig();
// ============================================
// 📊 REPORTE DEL AGENTE IA — HTML branded
// ============================================
function markdownToHtml(md) {
  return md
    // Tablas markdown → <table>
    .replace(/^\|(.+)\|$/gm, (line) => {
      const cells = line.split("|").filter((_, i, a) => i > 0 && i < a.length - 1);
      return `<tr>${cells.map(c => `<td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#334155;">${c.trim()}</td>`).join("")}</tr>`;
    })
    .replace(/^\|[-| ]+\|$/gm, "") // eliminar fila separadora
    .replace(/(<tr>.*?<\/tr>)/gs, (match, _, offset, str) => {
      // Primera fila → thead
      const allRows = str.match(/<tr>.*?<\/tr>/gs) || [];
      if (allRows[0] === match) {
        const header = match.replace(/<td/g, '<td style="padding:10px 14px;background:#0f172a;color:white;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;"');
        return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:20px;border-collapse:collapse;"><thead>${header}</thead><tbody>`;
      }
      return match;
    })
    .replace(/(<\/tr>)(?![\s\S]*<tr>)/, "$1</tbody></table>")
    // Encabezados
    .replace(/^### (.+)$/gm, '<h3 style="font-size:14px;font-weight:800;color:#0f172a;margin:24px 0 8px;">$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2 style="font-size:17px;font-weight:800;color:#0f172a;margin:28px 0 10px;border-left:4px solid #FF9900;padding-left:12px;">$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1 style="font-size:22px;font-weight:900;color:#0f172a;margin:0 0 20px;">$1</h1>')
    // Negrita
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#0f172a;">$1</strong>')
    // Saltos de línea
    .replace(/\n\n/g, '</p><p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 12px;">')
    .replace(/\n/g, "<br>");
}

const sendAgentReportEmail = async (email, title, markdownContent) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const sendSmtpEmail = new SendSmtpEmail();

  const htmlBody = markdownToHtml(markdownContent);
  const dateStr  = new Date().toLocaleDateString("es-CO", { weekday:"long", day:"numeric", month:"long", year:"numeric" });

  sendSmtpEmail.subject     = `📊 ${title} — Delasoft ERP`;
  sendSmtpEmail.to          = [{ email, name: "Administrador" }];
  sendSmtpEmail.sender      = SENDER;
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html><html lang="es">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
        <tr><td align="center">
          <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">

            <!-- HEADER -->
            <tr>
              <td style="background:linear-gradient(135deg,#0A0A0A 0%,#1a0d00 100%);padding:40px;border-radius:20px 20px 0 0;text-align:center;">
                <div style="color:white;font-size:36px;font-weight:900;letter-spacing:-1px;text-transform:uppercase;margin:0;">DELASOFT</div>
                <div style="width:40px;height:3px;background:#FF9900;margin:12px auto 16px;border-radius:2px;"></div>
                <div style="background:rgba(255,153,0,0.15);border:1px solid rgba(255,153,0,0.4);border-radius:50px;display:inline-block;padding:8px 24px;">
                  <span style="color:#FF9900;font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;">📊 AGENTE IA — REPORTE</span>
                </div>
              </td>
            </tr>

            <!-- META -->
            <tr>
              <td style="background:#FF9900;padding:12px 40px;display:flex;justify-content:space-between;">
                <table width="100%"><tr>
                  <td style="font-size:12px;font-weight:800;color:#0A0A0A;">${title.toUpperCase()}</td>
                  <td style="font-size:12px;color:#0A0A0A;text-align:right;">${dateStr}</td>
                </tr></table>
              </td>
            </tr>

            <!-- BODY -->
            <tr>
              <td style="background:white;padding:40px;">
                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 24px;">
                  Tu agente IA completó el análisis solicitado. A continuación el reporte generado automáticamente.
                </p>
                <div style="border-left:4px solid #FF9900;padding-left:20px;margin-bottom:28px;">
                  ${htmlBody}
                </div>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8ec;border:1px solid #fde68a;border-radius:12px;margin-top:32px;">
                  <tr><td style="padding:16px 20px;font-size:12px;color:#92400e;line-height:1.6;">
                    🤖 <strong>Generado por el Agente IA de DELASOFT</strong> — Este reporte fue creado automáticamente.
                    Los datos reflejan el estado de tu ERP al momento de la ejecución.
                  </td></tr>
                </table>
              </td>
            </tr>

            <!-- FOOTER -->
            <tr>
              <td style="background:#0A0A0A;padding:24px 40px;border-radius:0 0 20px 20px;text-align:center;">
                <div style="color:#555;font-size:11px;">© 2026 Delasoft ERP · Reporte automático del sistema</div>
              </td>
            </tr>

          </table>
        </td></tr>
      </table>
    </body></html>
  `;

  try {
    const { body } = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('[Email] Reporte IA enviado — messageId:', body?.messageId ?? '(sin id)');
    return true;
  } catch (err) {
    console.error('[Email] Error enviando reporte IA:', err?.message ?? err);
    return false;
  }
};

// ============================================
// 📅 RECORDATORIO DE CUOTA DE CRÉDITO (al cliente)
// ============================================
// type: 'upcoming' | 'due' | 'overdue'
// data: { saleNumber, installmentNum, totalInstallments, amount, dueDate, daysOverdue? }
// branding: resultado de getAdminBranding() — null usa fallback Delasoft
const sendCreditReminderEmail = async (email, customerName, data, type, branding = null) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const { saleNumber, installmentNum, totalInstallments, amount, dueDate, daysOverdue = 0 } = data;
  const b = branding ?? DELASOFT_BRANDING;

  const fmtAmt  = Number(amount).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  const fmtDate = new Date(dueDate).toLocaleDateString('es-CO', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota',
  });

  // For due/overdue, semantic urgency overrides tenant primary/secondary colors
  const effectiveBranding = type === 'upcoming' ? b : {
    ...b,
    primaryColor:   type === 'due' ? '#78350f' : '#7f1d1d',
    secondaryColor: type === 'due' ? '#92400e' : '#991b1b',
  };

  const badges = {
    upcoming: '📅  RECORDATORIO DE CUOTA',
    due:      '⚠️  VENCE HOY',
    overdue:  '🔴  CUOTA VENCIDA',
  };

  const headlines = {
    upcoming: `¡Hola, ${customerName}! 👋`,
    due:      `${customerName}, hoy vence tu cuota`,
    overdue:  `${customerName}, tienes una cuota vencida`,
  };

  const bodyTexts = {
    upcoming: `Tu cuota <strong>#${installmentNum}</strong> de <strong>$${fmtAmt}</strong> vence el <strong>${fmtDate}</strong>. Te recordamos para que puedas planificar tu pago a tiempo.`,
    due:      `La cuota <strong>#${installmentNum}</strong> de <strong>$${fmtAmt}</strong> vence <strong>hoy</strong>. Realiza tu pago para evitar recargos.`,
    overdue:  `La cuota <strong>#${installmentNum}</strong> de <strong>$${fmtAmt}</strong> venció hace <strong>${daysOverdue} día${daysOverdue !== 1 ? 's' : ''}</strong>. Comunícate con nosotros lo antes posible.`,
  };

  const accentCfg = {
    upcoming: { color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe' },
    due:      { color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    overdue:  { color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
  };
  const acc = accentCfg[type] ?? accentCfg.upcoming;

  const htmlBody = `
    <p style="font-size:22px;color:#0f172a;font-weight:800;margin:0 0 16px;">${headlines[type] ?? headlines.upcoming}</p>
    <p style="font-size:15px;color:#64748b;line-height:1.75;margin:0 0 28px;">${bodyTexts[type] ?? bodyTexts.upcoming}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${acc.bg};border:1px solid ${acc.border};border-radius:14px;margin-bottom:28px;">
      <tr><td style="padding:20px 24px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-size:11px;font-weight:700;color:${acc.color};letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;">Venta</div>
            <div style="font-size:15px;font-weight:800;color:#0f172a;">${saleNumber}</div>
          </div>
          <div>
            <div style="font-size:11px;font-weight:700;color:${acc.color};letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;">Cuota</div>
            <div style="font-size:15px;font-weight:800;color:#0f172a;">${installmentNum} / ${totalInstallments}</div>
          </div>
          <div>
            <div style="font-size:11px;font-weight:700;color:${acc.color};letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;">Monto</div>
            <div style="font-size:22px;font-weight:900;color:#0f172a;">$${fmtAmt}</div>
          </div>
        </div>
      </td></tr>
    </table>
  `;

  const subjects = {
    upcoming: `📅 Recordatorio de cuota · ${saleNumber} - ${b.businessName}`,
    due:      `⚠️ Hoy vence tu cuota · ${saleNumber} - ${b.businessName}`,
    overdue:  `🔴 Cuota vencida · ${saleNumber} - ${b.businessName}`,
  };

  const sendSmtpEmail    = new SendSmtpEmail();
  sendSmtpEmail.subject  = subjects[type] ?? subjects.upcoming;
  sendSmtpEmail.to       = [{ email, name: customerName }];
  sendSmtpEmail.sender   = SENDER;
  if (b.businessEmail) sendSmtpEmail.replyTo = { email: b.businessEmail, name: b.businessName };
  sendSmtpEmail.htmlContent = buildBrandedEmail({
    branding: effectiveBranding,
    badge:    badges[type] ?? badges.upcoming,
    body:     htmlBody,
  });

  try {
    const { body } = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`[Email] Recordatorio de cuota (${type}) enviado — messageId:`, body?.messageId ?? '(sin id)');
    return true;
  } catch (err) {
    console.error(`[Email] Error enviando recordatorio (${type}):`, err?.message ?? err);
    return false;
  }
};

// ============================================
// 📄 FACTURA PDF ADJUNTA AL EMAIL DE CONFIRMACIÓN
// Pega esta función al final de config/emailConfig.js
// (antes del module.exports) y agrégala al exports
// ============================================

/**
 * Envía el email de confirmación de pedido con la factura PDF adjunta.
 *
 * @param {string} email
 * @param {string} userName
 * @param {object} orderData
 *   - orderCode       string   "AL-000001"
 *   - saleNumber      string   "VEN-000001"
 *   - total           number
 *   - subtotal        number
 *   - discountAmount  number
 *   - taxAmount       number
 *   - items           Array<{ name, sku, quantity, unit_price, subtotal }>
 *   - paymentMethod   string
 *   - paymentStatus   string
 *   - shippingAddress string|null
 *   - shippingCity    string|null
 *   - shippingNotes   string|null
 * @param {string} emailType   'confirmation' | 'payment_confirmed'
 * @param {object|null} branding
 */
const sendInvoiceEmail = async (email, userName, orderData, emailType = 'confirmation', branding = null) => {
  const { generateInvoicePdf } = require('../services/invoice.service');
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const b = branding ?? DELASOFT_BRANDING;

  const {
    orderCode, saleNumber,
    total = 0, subtotal = 0, discountAmount = 0, taxAmount = 0,
    items = [], paymentMethod, paymentStatus,
    shippingAddress, shippingCity, shippingNotes,
  } = orderData;

  // ── Generar PDF ──────────────────────────────────────────────────────────
  let pdfBase64 = null;
  try {
    const pdfBuffer = await generateInvoicePdf({
      orderCode, saleNumber,
      customer: { name: userName, email },
      items, subtotal, discountAmount, taxAmount, total,
      paymentMethod, paymentStatus,
      shippingAddress, shippingCity,
      branding: b,
    });
    pdfBase64 = pdfBuffer.toString('base64');
  } catch (pdfErr) {
    console.error('[Invoice PDF] Error generando PDF:', pdfErr.message);
    // Continúa sin adjunto si falla el PDF
  }

  // ── Cuerpo del email ─────────────────────────────────────────────────────
  const paymentLabels = {
    transfer: '🏦 Transferencia bancaria', cash: '💵 Efectivo',
    credit: '💳 Crédito', check: '📄 Cheque', wompi: '💳 Pasarela de pago',
  };
  const paymentLabel = paymentLabels[paymentMethod] || paymentMethod || 'Por confirmar';

  const itemsRows = items.map(item => `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:700;color:#0f172a;font-size:14px;">${item.name}</div>
        ${item.sku ? `<div style="font-size:11px;color:#94a3b8;margin-top:3px;">SKU: ${item.sku}</div>` : ''}
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:center;color:#64748b;font-weight:700;font-size:14px;">x${item.quantity}</td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:900;color:#0f172a;font-size:14px;">
        $${Number(item.unit_price * item.quantity).toLocaleString('es-CO')}
      </td>
    </tr>
  `).join('');

  const isConfirmed = emailType === 'payment_confirmed';

  const htmlBody = `
    <p style="font-size:24px;color:#0f172a;font-weight:800;margin:0 0 12px;">
      ${isConfirmed ? `¡Pago confirmado, ${userName}! 🎉` : `¡Gracias, ${userName}! 🎉`}
    </p>
    <p style="font-size:15px;color:#64748b;line-height:1.75;margin:0 0 24px;">
      ${isConfirmed
        ? 'Tu pago fue <strong style="color:#059669;">verificado y aprobado</strong>. Tu pedido está siendo preparado.'
        : 'Recibimos tu pedido. Adjuntamos tu factura en PDF para que la guardes.'}
    </p>

    <!-- Código de pedido -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:16px;margin-bottom:28px;">
      <tr>
        <td style="padding:22px 28px;">
          <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Código de pedido</div>
          <div style="font-size:28px;font-weight:900;color:#0f172a;letter-spacing:2px;font-family:'Courier New',monospace;">${orderCode}</div>
        </td>
        <td style="padding:22px 28px;text-align:right;border-left:1px solid #e2e8f0;">
          <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Fecha</div>
          <div style="font-size:14px;font-weight:700;color:#475569;">
            ${new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' })}
          </div>
        </td>
      </tr>
    </table>

    <!-- Tabla de ítems -->
    <div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">Resumen del pedido</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:28px;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Producto</th>
        <th style="padding:10px 16px;text-align:center;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Cant.</th>
        <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Subtotal</th>
      </tr></thead>
      <tbody>${itemsRows}</tbody>
      <tfoot>
        ${Number(discountAmount) > 0 ? `
        <tr style="background:#f8fafc;">
          <td colspan="2" style="padding:10px 18px;color:#64748b;font-size:13px;">Descuento</td>
          <td style="padding:10px 18px;text-align:right;color:#059669;font-size:14px;font-weight:700;">
            - $${Number(discountAmount).toLocaleString('es-CO')}
          </td>
        </tr>` : ''}
        <tr style="background:#0f172a;">
          <td colspan="2" style="padding:16px 18px;color:rgba(255,255,255,0.6);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Total</td>
          <td style="padding:16px 18px;text-align:right;color:white;font-size:22px;font-weight:900;">
            $${Number(total).toLocaleString('es-CO')}
          </td>
        </tr>
      </tfoot>
    </table>

    <!-- Pago -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;margin-bottom:${shippingAddress ? '24px' : '0'};">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:800;color:#059669;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Método de pago</div>
        <div style="font-size:15px;font-weight:700;color:#065f46;">${paymentLabel}</div>
      </td></tr>
    </table>

    ${shippingAddress ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:800;color:#1d4ed8;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Dirección de envío</div>
        <div style="font-weight:800;color:#1e3a8a;font-size:15px;margin-bottom:4px;">📍 ${shippingCity || ''}</div>
        <div style="color:#1d4ed8;font-size:14px;line-height:1.6;">${shippingAddress}</div>
        ${shippingNotes ? `<div style="color:#3b82f6;font-size:13px;margin-top:8px;font-style:italic;">📝 ${shippingNotes}</div>` : ''}
      </td></tr>
    </table>` : ''}

    ${pdfBase64 ? `
    <div style="margin-top:28px;padding:16px 20px;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;font-size:13px;color:#92400e;">
      📎 <strong>Tu factura en PDF está adjunta</strong> a este correo. Guárdala para tus registros.
    </div>` : ''}
  `;

  const badge   = isConfirmed ? '✅  PAGO CONFIRMADO' : '✓  PEDIDO RECIBIDO';
  const subject = isConfirmed
    ? `🎉 ¡Pago confirmado! Tu pedido ${orderCode} - ${b.businessName}`
    : `✅ Tu pedido ${orderCode} fue recibido - ${b.businessName}`;

  const sendSmtpEmail = new SendSmtpEmail();
  sendSmtpEmail.subject     = subject;
  sendSmtpEmail.to          = [{ email, name: userName }];
  sendSmtpEmail.sender      = SENDER;
  if (b.businessEmail) sendSmtpEmail.replyTo = { email: b.businessEmail, name: b.businessName };
  sendSmtpEmail.htmlContent = buildBrandedEmail({ branding: b, badge, body: htmlBody });

  // Adjuntar PDF si se generó correctamente
  if (pdfBase64) {
    sendSmtpEmail.attachment = [{
      content: pdfBase64,
      name:    `Factura-${orderCode}.pdf`,
    }];
  }

  try {
    const { body } = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`[Email] Factura enviada (${emailType}) — messageId:`, body?.messageId ?? '(sin id)');
    return true;
  } catch (error) {
    console.error('[Email] Error enviando factura:', error?.message ?? error);
    return false;
  }
};

module.exports = {
  sendInvoiceEmail,
  generateVerificationCode,
  sendVerificationEmail,
  sendOrderConfirmationEmail,
  sendPaymentConfirmedEmail,
  sendAgentReportEmail,
  sendCreditReminderEmail,
};
