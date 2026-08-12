'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'delasoft', 'logo.jpg');
const BLUE = '#183f91';
const LIGHT_BLUE = '#eaf1ff';
const TEXT = '#303a49';
const MUTED = '#596579';

const money = (value) => `$${Number(value || 0).toLocaleString('es-CO', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})} COP`;

const shortDate = (value) => {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    ? `${value}T12:00:00-05:00`
    : value;
  return new Date(normalized).toLocaleDateString('es-CO', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota',
  });
};

const cycleLabel = (cycle) => cycle === 'yearly' ? 'Suscripción anual' : 'Suscripción mensual';
const paymentLabel = (method) => ({
  wompi: 'Wompi', manual: 'Pago manual', transfer: 'Transferencia',
  cash: 'Efectivo', card: 'Tarjeta',
})[method] || method || 'Por confirmar';

/**
 * Comprobante corporativo de DELASOFT para cobros de suscripción.
 * Es deliberadamente independiente de invoice.service.js, que pertenece a
 * las ventas multi-tienda y usa la identidad visual de cada comercio.
 */
function generateDelasoftInvoicePdf({ invoice, customer }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 58, autoFirstPage: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - 116;

    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 58, 48, { fit: [145, 145] });
    }
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(10)
      .text('Servicios digitales y desarrollo de software', 225, 91, { width: 300 });

    doc.rect(58, 202, contentWidth, 4).fill('#1671ec');
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(22)
      .text('COMPROBANTE DE PAGO', 58, 220, { width: 380 });

    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('Comprobante No.', 450, 220);
    doc.font('Helvetica').fontSize(9).text(invoice.invoice_number, 450, 233);
    doc.font('Helvetica-Bold').text('Fecha:', 450, 252);
    doc.font('Helvetica').text(shortDate(invoice.paid_at || invoice.created_at), 450, 265);

    doc.fillColor(TEXT).font('Helvetica').fontSize(10)
      .text('Cliente: ', 58, 254, { continued: true })
      .font('Helvetica-Bold').text(customer.business_name || customer.name || 'Cliente DELASOFT');

    const boxY = 292;
    doc.rect(58, boxY, contentWidth, 80).fillAndStroke('#ffffff', '#c8d8f6');
    doc.rect(58, boxY, contentWidth, 24).fill(LIGHT_BLUE);
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
      .text('DATOS DEL CLIENTE', 68, boxY + 8);
    doc.fillColor(TEXT).fontSize(9).font('Helvetica-Bold')
      .text('Nombre / negocio:', 68, boxY + 34, { continued: true })
      .font('Helvetica').text(` ${customer.business_name || customer.name || '—'}`);
    doc.font('Helvetica-Bold').text('Correo:', 68, boxY + 50, { continued: true })
      .font('Helvetica').text(` ${customer.email || '—'}`);
    doc.font('Helvetica-Bold').text('Identificación:', 340, boxY + 34, { continued: true })
      .font('Helvetica').text(` ${customer.tax_id || customer.cedula || '—'}`);
    doc.font('Helvetica-Bold').text('Teléfono:', 340, boxY + 50, { continued: true })
      .font('Helvetica').text(` ${customer.phone || '—'}`);

    const tableY = 390;
    doc.rect(58, tableY, contentWidth, 30).fill(BLUE);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(9)
      .text('ÍTEM', 68, tableY + 10)
      .text('DESCRIPCIÓN DEL SERVICIO', 112, tableY + 10)
      .text('VALOR', 470, tableY + 10, { width: 72, align: 'right' });

    doc.rect(58, tableY + 30, contentWidth, 105).fillAndStroke('#ffffff', '#c8d8f6');
    doc.moveTo(102, tableY + 30).lineTo(102, tableY + 135).stroke('#c8d8f6');
    doc.moveTo(448, tableY + 30).lineTo(448, tableY + 135).stroke('#c8d8f6');
    doc.fillColor(TEXT).font('Helvetica').fontSize(9).text('1', 68, tableY + 43);
    doc.font('Helvetica-Bold').text(`${cycleLabel(invoice.billing_cycle)} – Plan ${invoice.plan_name}`, 112, tableY + 42, { width: 320 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(`Período del servicio: ${shortDate(invoice.period_start)} al ${shortDate(invoice.period_end)}.`, 112, tableY + 61, { width: 320 })
      .text(`Método de pago: ${paymentLabel(invoice.payment_method)}.`, 112, tableY + 79, { width: 320 })
      .text(`Referencia: ${invoice.payment_reference || '—'}`, 112, tableY + 97, { width: 320 });
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(11)
      .text(money(invoice.subtotal), 458, tableY + 43, { width: 84, align: 'right' });

    let totalY = tableY + 149;
    const totalRow = (label, value, bold = false) => {
      doc.moveTo(342, totalY).lineTo(542, totalY).stroke('#c8d8f6');
      doc.fillColor(MUTED).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
        .text(label, 348, totalY + 6, { width: 82 });
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(bold ? 14 : 11)
        .text(money(value), 430, totalY + 4, { width: 112, align: 'right' });
      totalY += bold ? 27 : 23;
    };
    totalRow('SUBTOTAL', invoice.subtotal);
    if (Number(invoice.discount_amount) > 0) totalRow('DESCUENTO', -Number(invoice.discount_amount));
    totalRow('TOTAL PAGADO', invoice.total, true);

    const noteY = Math.max(totalY + 18, 620);
    doc.rect(58, noteY, contentWidth, 65).fillAndStroke('#f7f9fc', '#c8d8f6');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('INFORMACIÓN DEL COMPROBANTE', 68, noteY + 10);
    doc.fillColor(TEXT).font('Helvetica').fontSize(8)
      .text('Este documento certifica el pago del servicio de software descrito. Conserva este comprobante para tus registros administrativos.', 68, noteY + 29, { width: contentWidth - 20, lineGap: 3 });

    // El pie vive dentro del margen inferior de la hoja. Desactivar ese margen
    // al dibujarlo evita que PDFKit agregue páginas vacías automáticamente.
    doc.page.margins.bottom = 0;
    doc.moveTo(64, 735).lineTo(548, 735).stroke('#b9cef5');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('DELASOFT', 64, 749, { continued: true, lineBreak: false });
    doc.font('Helvetica').text('   |   Innovación que impulsa tu negocio', { lineBreak: false });
    doc.text('305 278 9959', 430, 747, { width: 118, align: 'right', lineBreak: false });
    doc.text('Delasoft12@gmail.com', 430, 759, { width: 118, align: 'right', lineBreak: false });

    doc.end();
  });
}

module.exports = { generateDelasoftInvoicePdf };
