'use strict';

const https = require('https');
const http  = require('http');

/**
 * Descarga una imagen remota (logo en Cloudinary, etc.) y la retorna como Buffer.
 * No usa libs externas — solo https/http nativos de Node.
 */
function fetchImageBuffer(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    const client = url.startsWith('http://') ? http : https;

    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Sigue una redirección simple (Cloudinary a veces redirige)
        res.resume();
        return fetchImageBuffer(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Logo fetch falló: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('timeout', () => req.destroy(new Error('Logo fetch: timeout')));
    req.on('error', reject);
  });
}

/**
 * Genera una factura PDF en memoria usando PDFKit.
 * Retorna un Buffer listo para adjuntar al email de Brevo.
 *
 * @param {object} params
 * @param {string} params.orderCode       - Código legible  (AL-000001)
 * @param {string} params.saleNumber      - Número interno  (VEN-000001)
 * @param {object} params.customer        - { name, email }
 * @param {Array}  params.items           - [ { name, sku, quantity, unit_price, subtotal } ]
 * @param {number} params.subtotal
 * @param {number} params.discountAmount
 * @param {number} params.taxAmount
 * @param {number} params.total
 * @param {string} params.paymentMethod
 * @param {string} params.paymentStatus
 * @param {string} [params.shippingAddress]
 * @param {string} [params.shippingCity]
 * @param {object} [params.branding]      - resultado de getAdminBranding()
 * @returns {Promise<Buffer>}
 */
async function generateInvoicePdf(params) {
  const PDFDocument = require('pdfkit');

  const {
    orderCode, saleNumber, customer, items = [],
    subtotal = 0, discountAmount = 0, taxAmount = 0, total = 0,
    paymentMethod, paymentStatus,
    shippingAddress, shippingCity,
    branding,
  } = params;

  // ── Branding defaults ──────────────────────────────────────────────────────
  const bizName    = branding?.businessName  || 'Delasoft Boutique';
  const bizEmail   = branding?.businessEmail || process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM || '';
  const bizPhone   = branding?.businessPhone || '';
  const bizAddress = branding?.address       || '';
  const primaryHex = branding?.primaryColor  || '#0f172a';
  const logoUrl    = branding?.logoUrl       || null;

  // Descarga el logo ANTES de empezar a dibujar (PDFKit dibuja de forma síncrona)
  let logoBuffer = null;
  if (logoUrl) {
    try {
      logoBuffer = await fetchImageBuffer(logoUrl);
    } catch (e) {
      console.error('[Invoice PDF] No se pudo descargar el logo, se omite:', e.message);
      logoBuffer = null;
    }
  }

  // Convierte hex → RGB (0-1) para PDFKit
  const hexToRgb = (hex) => {
    const h = (hex || '#0f172a').replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  };
  const [pr, pg, pb] = hexToRgb(primaryHex);

  const fmt = (n) => `$${Number(n ?? 0).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-CO', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota',
  });

  const payLabels = {
    cash: 'Efectivo', transfer: 'Transferencia', credit: 'Crédito / Tarjeta',
    check: 'Cheque', fiado: 'Crédito / Fiado', wompi: 'Pasarela de pago',
  };
  const statusLabels = {
    paid: 'PAGADO', pending: 'PENDIENTE', partial: 'ABONO PARCIAL',
  };

  return new Promise((resolve, reject) => {
    const doc  = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;   // 595
    const M = 50;               // margin
    const CW = W - M * 2;       // content width = 495

    // ══════════════════════════════════════════════════════
    // HEADER — barra de color + logo (si existe) + nombre del negocio
    // ══════════════════════════════════════════════════════
    doc.rect(0, 0, W, 90).fill([pr, pg, pb]);

    let textX = M;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, M, 18, { fit: [54, 54] });
        textX = M + 68; // desplaza el texto a la derecha del logo
      } catch (e) {
        console.error('[Invoice PDF] Logo en formato no soportado, se omite:', e.message);
        textX = M;
      }
    }
    const textW = CW - 120 - (textX - M);

    doc.fillColor('white')
       .fontSize(20).font('Helvetica-Bold')
       .text(bizName.toUpperCase(), textX, 22, { width: textW, align: 'left' });

    doc.fontSize(9).font('Helvetica')
       .text('FACTURA / RECIBO DE COMPRA', textX, 50, { width: textW });

    // Badge estado de pago
    const badgeLabel = statusLabels[paymentStatus] || paymentStatus?.toUpperCase() || 'EMITIDA';
    const badgeColor = paymentStatus === 'paid' ? '#16a34a'
                     : paymentStatus === 'pending' ? '#dc2626'
                     : '#d97706';
    const [br2, bg2, bb2] = hexToRgb(badgeColor);
    doc.roundedRect(W - M - 110, 20, 110, 30, 6).fill([br2, bg2, bb2]);
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
       .text(badgeLabel, W - M - 110, 30, { width: 110, align: 'center' });

    // ── Datos del documento (derecha del header) ──
    doc.fillColor('white').fontSize(8).font('Helvetica')
       .text(`Pedido: ${orderCode}`, W - M - 110, 58, { width: 110, align: 'center' })
       .text(dateStr, W - M - 110, 70, { width: 110, align: 'center' });

    // ══════════════════════════════════════════════════════
    // SECCIÓN: DATOS DEL NEGOCIO  |  DATOS DEL CLIENTE
    // ══════════════════════════════════════════════════════
    let y = 110;
    const colW = CW / 2 - 10;

    // Fondo gris claro para la sección
    doc.rect(M, y, CW, 80).fill('#f8fafc');
    doc.rect(M, y, CW, 80).stroke('#e2e8f0');

    // Negocio (izquierda)
    doc.fillColor('#94a3b8').fontSize(7).font('Helvetica-Bold')
       .text('EMISOR', M + 12, y + 10);
    doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold')
       .text(bizName, M + 12, y + 22);
    doc.fontSize(8).font('Helvetica').fillColor('#475569');
    if (bizEmail)   doc.text(bizEmail,   M + 12, y + 36);
    if (bizPhone)   doc.text(bizPhone,   M + 12, y + 48);
    if (bizAddress) doc.text(bizAddress, M + 12, y + 60, { width: colW - 10 });

    // Cliente (derecha)
    const col2X = M + colW + 20;
    doc.fillColor('#94a3b8').fontSize(7).font('Helvetica-Bold')
       .text('CLIENTE', col2X, y + 10);
    doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold')
       .text(customer?.name || 'Cliente', col2X, y + 22, { width: colW });
    doc.fontSize(8).font('Helvetica').fillColor('#475569')
       .text(customer?.email || '', col2X, y + 36, { width: colW });
    if (shippingCity || shippingAddress) {
      doc.text(`${shippingCity || ''} — ${shippingAddress || ''}`, col2X, y + 48, { width: colW });
    }

    // ══════════════════════════════════════════════════════
    // TABLA DE ÍTEMS
    // ══════════════════════════════════════════════════════
    y += 96;

    // Encabezado tabla
    doc.rect(M, y, CW, 22).fill([pr, pg, pb]);
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
    doc.text('PRODUCTO',        M + 8,       y + 7, { width: 200 });
    doc.text('SKU',             M + 212,     y + 7, { width: 70 });
    doc.text('CANT.',           M + 285,     y + 7, { width: 50, align: 'right' });
    doc.text('P. UNIT.',        M + 338,     y + 7, { width: 70, align: 'right' });
    doc.text('SUBTOTAL',        M + 412,     y + 7, { width: 75, align: 'right' });

    y += 22;

    // Filas
    items.forEach((item, i) => {
      const rowH = 28;
      const bgColor = i % 2 === 0 ? '#ffffff' : '#f8fafc';
      doc.rect(M, y, CW, rowH).fill(bgColor);

      doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold')
         .text(item.name || '', M + 8, y + 5, { width: 200, ellipsis: true });
      doc.fillColor('#64748b').fontSize(7).font('Helvetica')
         .text(item.sku || '—', M + 212, y + 10, { width: 70 });
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica')
         .text(String(item.quantity), M + 285, y + 10, { width: 50, align: 'right' });
      doc.text(fmt(item.unit_price), M + 338, y + 10, { width: 70, align: 'right' });
      doc.font('Helvetica-Bold')
         .text(fmt(item.subtotal ?? item.unit_price * item.quantity), M + 412, y + 10, { width: 75, align: 'right' });

      // línea separadora
      doc.moveTo(M, y + rowH).lineTo(M + CW, y + rowH).stroke('#e2e8f0');
      y += rowH;
    });

    // ══════════════════════════════════════════════════════
    // TOTALES
    // ══════════════════════════════════════════════════════
    y += 12;
    const totalsX = M + CW - 230;
    const totalsW = 230;

    const drawTotalRow = (label, value, bold = false, highlight = false) => {
      if (highlight) {
        doc.rect(totalsX - 8, y - 4, totalsW + 8, 24).fill([pr, pg, pb]);
        doc.fillColor('white');
      } else {
        doc.fillColor(bold ? '#0f172a' : '#64748b');
      }
      doc.fontSize(bold ? 10 : 9)
         .font(bold ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, totalsX, y, { width: 140 });
      doc.text(value, totalsX + 140, y, { width: 90, align: 'right' });
      y += bold ? 26 : 20;
    };

    drawTotalRow('Subtotal',   fmt(subtotal));
    if (Number(discountAmount) > 0) drawTotalRow('Descuento', `- ${fmt(discountAmount)}`);
    if (Number(taxAmount) > 0)      drawTotalRow('Impuestos', fmt(taxAmount));
    drawTotalRow('TOTAL', fmt(total), true, true);

    // ══════════════════════════════════════════════════════
    // PAGO
    // ══════════════════════════════════════════════════════
    y += 16;
    doc.rect(M, y, CW, 36).fill('#f0fdf4').stroke('#bbf7d0');
    doc.fillColor('#059669').fontSize(8).font('Helvetica-Bold')
       .text('MÉTODO DE PAGO', M + 12, y + 8);
    doc.fillColor('#065f46').fontSize(10).font('Helvetica-Bold')
       .text(payLabels[paymentMethod] || paymentMethod || 'Por confirmar', M + 12, y + 20);

    doc.fillColor('#059669').fontSize(8).font('Helvetica-Bold')
       .text('ESTADO', M + CW - 130, y + 8, { width: 118, align: 'right' });
    doc.fillColor('#065f46').fontSize(10).font('Helvetica-Bold')
       .text(statusLabels[paymentStatus] || paymentStatus || '—', M + CW - 130, y + 20, { width: 118, align: 'right' });

    // ══════════════════════════════════════════════════════
    // FOOTER
    // ══════════════════════════════════════════════════════
    const footerY = doc.page.height - 60;
    doc.rect(0, footerY, W, 60).fill('#0f172a');
    doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
       .text(
         `© ${now.getFullYear()} ${bizName} · Gestionado con Delasoft ERP · ${bizEmail}`,
         M, footerY + 18, { width: CW, align: 'center' }
       )
       .text(
         `Documento generado el ${dateStr} · Ref: ${saleNumber}`,
         M, footerY + 34, { width: CW, align: 'center' }
       );

    doc.end();
  });
}

module.exports = { generateInvoicePdf };
