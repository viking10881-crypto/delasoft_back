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

  const DELASOFT_BLUE = '#183f91';
  const DELASOFT_LINE = '#1671ec';
  const LIGHT_BLUE = '#eaf1ff';

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
    const doc  = new PDFDocument({ margin: 58, size: 'LETTER' });
    const chunks = [];
    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;   // 595
    const M = 58;               // margin
    const CW = W - M * 2;       // content width = 495

    // ══════════════════════════════════════════════════════
    // HEADER corporativo DELASOFT — identidad propia de cada tienda
    // ══════════════════════════════════════════════════════
    let textX = M;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, M, 38, { fit: [130, 120], align: 'left', valign: 'center' });
        textX = M + 150;
      } catch (e) {
        console.error('[Invoice PDF] Logo en formato no soportado, se omite:', e.message);
        textX = M;
      }
    }
    const textW = CW - (textX - M);

    doc.fillColor('#303a49').fontSize(19).font('Helvetica-Bold')
       .text(bizName.toUpperCase(), textX, logoBuffer ? 70 : 55, { width: textW, align: 'left' });

    doc.fillColor('#596579').fontSize(9).font('Helvetica')
       .text(branding?.tagline || 'Comprobante comercial', textX, logoBuffer ? 96 : 81, { width: textW });

    doc.rect(M, 175, CW, 4).fill(DELASOFT_LINE);
    doc.fillColor(DELASOFT_BLUE).fontSize(22).font('Helvetica-Bold')
       .text('FACTURA / RECIBO DE COMPRA', M, 194, { width: 355 });

    // Badge estado de pago
    const badgeLabel = statusLabels[paymentStatus] || paymentStatus?.toUpperCase() || 'EMITIDA';
    // Mantiene la paleta visual DELASOFT en todos los comprobantes. El texto
    // comunica el estado sin introducir una identidad cromática diferente.
    const badgeColor = DELASOFT_BLUE;
    doc.roundedRect(W - M - 100, 192, 100, 25, 5).fill(badgeColor);
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
       .text(badgeLabel, W - M - 100, 200, { width: 100, align: 'center' });

    // ── Datos del documento (derecha del header) ──
    doc.fillColor('#596579').fontSize(8).font('Helvetica')
       .text(`Pedido: ${orderCode}`, W - M - 130, 224, { width: 130, align: 'right' })
       .text(dateStr, W - M - 130, 237, { width: 130, align: 'right' });

    // ══════════════════════════════════════════════════════
    // SECCIÓN: DATOS DEL NEGOCIO  |  DATOS DEL CLIENTE
    // ══════════════════════════════════════════════════════
    let y = 264;
    const colW = CW / 2 - 10;

    // Fondo gris claro para la sección
    doc.rect(M, y, CW, 88).fillAndStroke('#ffffff', '#c8d8f6');
    doc.rect(M, y, CW, 23).fill(LIGHT_BLUE);

    // Negocio (izquierda)
    doc.fillColor('#94a3b8').fontSize(7).font('Helvetica-Bold')
       .text('EMISOR', M + 12, y + 8);
    doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold')
       .text(bizName, M + 12, y + 32);
    doc.fontSize(8).font('Helvetica').fillColor('#475569');
    if (bizEmail)   doc.text(bizEmail,   M + 12, y + 47);
    if (bizPhone)   doc.text(bizPhone,   M + 12, y + 59);
    if (bizAddress) doc.text(bizAddress, M + 12, y + 71, { width: colW - 10 });

    // Cliente (derecha)
    const col2X = M + colW + 20;
    doc.fillColor('#94a3b8').fontSize(7).font('Helvetica-Bold')
       .text('CLIENTE', col2X, y + 8);
    doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold')
       .text(customer?.name || 'Cliente', col2X, y + 32, { width: colW });
    doc.fontSize(8).font('Helvetica').fillColor('#475569')
       .text(customer?.email || '', col2X, y + 47, { width: colW });
    if (shippingCity || shippingAddress) {
      doc.text(`${shippingCity || ''} — ${shippingAddress || ''}`, col2X, y + 61, { width: colW });
    }

    // ══════════════════════════════════════════════════════
    // TABLA DE ÍTEMS
    // ══════════════════════════════════════════════════════
    y += 106;

    // Encabezado tabla
    doc.rect(M, y, CW, 25).fill(DELASOFT_BLUE);
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
    doc.text('PRODUCTO',        M + 8,       y + 7, { width: 200 });
    doc.text('SKU',             M + 212,     y + 7, { width: 70 });
    doc.text('CANT.',           M + 285,     y + 7, { width: 50, align: 'right' });
    doc.text('P. UNIT.',        M + 338,     y + 7, { width: 70, align: 'right' });
    doc.text('SUBTOTAL',        M + 412,     y + 7, { width: 75, align: 'right' });

    y += 25;

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
        doc.rect(totalsX - 8, y - 4, totalsW + 8, 24).fill(DELASOFT_BLUE);
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
    doc.rect(M, y, CW, 42).fillAndStroke(LIGHT_BLUE, '#c8d8f6');
    doc.fillColor(DELASOFT_BLUE).fontSize(8).font('Helvetica-Bold')
       .text('MÉTODO DE PAGO', M + 12, y + 8);
    doc.fillColor(DELASOFT_BLUE).fontSize(10).font('Helvetica-Bold')
       .text(payLabels[paymentMethod] || paymentMethod || 'Por confirmar', M + 12, y + 20);

    doc.fillColor(DELASOFT_BLUE).fontSize(8).font('Helvetica-Bold')
       .text('ESTADO', M + CW - 130, y + 8, { width: 118, align: 'right' });
    doc.fillColor(DELASOFT_BLUE).fontSize(10).font('Helvetica-Bold')
       .text(statusLabels[paymentStatus] || paymentStatus || '—', M + CW - 130, y + 20, { width: 118, align: 'right' });

    // ══════════════════════════════════════════════════════
    // FOOTER
    // ══════════════════════════════════════════════════════
    const footerY = doc.page.height - 60;
    // El pie se dibuja dentro del margen inferior. `lineBreak: false` evita que
    // PDFKit cree páginas extra al actualizar internamente la posición Y.
    doc.page.margins.bottom = 0;
    doc.moveTo(M, footerY).lineTo(W - M, footerY).stroke('#b9cef5');
    doc.fillColor('#596579').fontSize(8).font('Helvetica')
       .text(
         `© ${now.getFullYear()} ${bizName} · Gestionado con Delasoft ERP · ${bizEmail}`,
         M, footerY + 18, { width: CW, align: 'center', lineBreak: false }
       )
       .text(
         `Documento generado el ${dateStr} · Ref: ${saleNumber}`,
         M, footerY + 34, { width: CW, align: 'center', lineBreak: false }
       );

    doc.end();
  });
}

module.exports = { generateInvoicePdf };
