// services/agent.tools.js
const db     = require("../config/db");
const { io } = require("../config/socket");
const Groq   = require("groq-sdk");
const { sendAgentReportEmail } = require("../config/emailConfig");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Brevo lazy ────────────────────────────────────────────────────────────────
function getBrevoClient() {
  const brevo         = require("@getbrevo/brevo");
  const apiInstance   = new brevo.TransactionalEmailsApi();
  const SendSmtpEmail = brevo.SendSmtpEmail;

  apiInstance.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  return { apiInstance, SendSmtpEmail };
}

async function sendBrevoEmail({ to, subject, body }) {
  if (!process.env.BREVO_API_KEY) {
    console.warn("[Agent notify] BREVO_API_KEY no configurada — email omitido");
    return { email: "skipped: no api key" };
  }

  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const mail = new SendSmtpEmail();

  mail.sender      = { name: "Delasoft ERP", email: process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM };
  mail.to          = [{ email: to }];
  mail.subject     = subject || "Delasoft ERP — Notificación del agente";
  mail.htmlContent = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7;max-width:600px">${body}</div>`;
  mail.textContent = body.replace(/<[^>]+>/g, "");

  const data = await apiInstance.sendTransacEmail(mail);
  console.log("[Agent notify] Email enviado:", data.messageId);
  return { email: "sent", messageId: data.messageId };
}

// ── Detectar si el contenido es markdown con tablas/encabezados ──────────────
function isMarkdownReport(text) {
  if (!text) return false;
  return /^#{1,3}\s/m.test(text) || /^\|.+\|$/m.test(text);
}

// ── Tablas y campos permitidos ───────────────────────────────────────────────
const ALLOWED_TABLES = [
  "sales", "sale_items", "coupon_usage",
  "products", "product_variants", "product_images",
  "product_price_history", "categories",
  "attribute_types", "attribute_values", "variant_attribute_values",
  "bundle_items", "variant_images",
  "expenses", "invoices", "invoice_items", "invoice_payments",
  "financial_budgets", "provider_payments",
  "providers", "purchase_orders", "purchase_order_items",
  "discounts", "discount_coupons", "discount_targets",
  "banners", "agent_conversations",
  "v_sales_full", "v_products_full", "v_profit_analysis",
  "v_cashflow_detailed", "v_expenses_summary",
  "v_invoices_summary", "v_provider_balance",
];

const MASK_FIELDS = [
  "customer_phone","shipping_address","shipping_city",
  "shipping_lat","shipping_lng","shipping_notes","payment_proof_url",
  "phone","email","address","contact_person","tax_id","customer_email",
];

const DANGEROUS = /\b(DROP|TRUNCATE|ALTER|CREATE\s+TABLE|DELETE\s+FROM|GRANT|REVOKE|COPY\s+.*\s+TO|pg_read_file|pg_write_file|INTO\s+OUTFILE)\b/i;

function validateSQL(sql, mode) {
  if (DANGEROUS.test(sql)) throw new Error("Operación peligrosa bloqueada.");
  if (mode === "query"  && !/^\s*SELECT\s+/i.test(sql))
    throw new Error("Solo SELECT permitido en query_erp.");
  if (mode === "mutate" && !/^\s*(INSERT|UPDATE)\s+/i.test(sql))
    throw new Error("Solo INSERT/UPDATE permitido en mutate_erp.");
  if (mode === "mutate" && /^\s*UPDATE\s+/i.test(sql) && !/WHERE\s+/i.test(sql))
    throw new Error("Los UPDATE deben incluir WHERE.");

  const tableRx = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let m;
  while ((m = tableRx.exec(sql)) !== null) {
    if (!ALLOWED_TABLES.includes(m[1].toLowerCase()))
      throw new Error(`Tabla '${m[1]}' no permitida.`);
  }
}

function sanitize(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => {
    const c = { ...r };
    for (const k of Object.keys(c)) {
      if (MASK_FIELDS.some(f => k.toLowerCase() === f.toLowerCase())) c[k] = "***";
      if (/\b(cedula|documento|password|token|secret)\b/i.test(k)) c[k] = "***";
    }
    return c;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 1 · query_erp
// ═══════════════════════════════════════════════════════════════════════════
async function query_erp({ sql }) {
  validateSQL(sql, "query");
  const { rows } = await db.query(sql);
  return { rows: sanitize(rows), count: rows.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 2 · mutate_erp
// ═══════════════════════════════════════════════════════════════════════════
async function mutate_erp({ sql, confirmed = false, reason }) {
  validateSQL(sql, "mutate");
  if (!confirmed) {
    return { status: "needs_confirm", sql, reason, message: "Acción pendiente de confirmación humana." };
  }
  const result = await db.query(sql);
  return { status: "executed", rowCount: result.rowCount, sql };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 3 · notify — WebSocket + Brevo email
// ═══════════════════════════════════════════════════════════════════════════
async function notify({ channel, event, payload, email_to, email_subject, email_body }) {
  const results = {};

  // ── WebSocket ────────────────────────────────────────────────────────────
  if (channel === "websocket" || channel === "both") {
    try {
      io.emit(event || "agent_notification", payload);
      results.websocket = "sent";
    } catch (e) {
      results.websocket = `error: ${e.message}`;
    }
  }

  // ── Email via Brevo ──────────────────────────────────────────────────────
  if ((channel === "email" || channel === "both") && email_to) {
    try {
      // Si el body es markdown (reporte), usar plantilla branded completa
      if (isMarkdownReport(email_body)) {
        await sendAgentReportEmail(
          email_to,
          email_subject || "Reporte del Agente IA",
          email_body
        );
        results.email = "sent";

      } else {
        // Alerta corta — plantilla simple pero con marca DELASOFT
        const htmlBody = email_body || `
          <pre style="background:#f8fafc;padding:16px;border-radius:8px;font-size:13px">
            ${JSON.stringify(payload, null, 2)}
          </pre>
        `;
        const branded = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#0A0A0A;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
              <div style="color:white;font-size:26px;font-weight:900;letter-spacing:-1px;">DELASOFT</div>
              <div style="width:30px;height:3px;background:#FF9900;margin:8px auto 0;border-radius:2px;"></div>
            </div>
            <div style="background:white;padding:32px;border:1px solid #e2e8f0;">
              <h2 style="color:#0f172a;font-size:17px;margin:0 0 16px;border-left:4px solid #FF9900;padding-left:12px;">
                ${email_subject || "Notificación del Agente IA"}
              </h2>
              <div style="font-size:14px;color:#475569;line-height:1.7;">${htmlBody}</div>
            </div>
            <div style="background:#0A0A0A;padding:16px;border-radius:0 0 12px 12px;text-align:center;">
              <div style="color:#555;font-size:11px;">© 2026 Delasoft ERP · Alerta automática del sistema</div>
            </div>
          </div>
        `;
        const emailResult = await sendBrevoEmail({
          to:      email_to,
          subject: email_subject || "Delasoft ERP — Notificación del agente",
          body:    branded,
        });
        results.email = emailResult.email;
        if (emailResult.messageId) results.messageId = emailResult.messageId;
      }
    } catch (e) {
      console.error("[Agent notify email error]", e.message);
      results.email = `error: ${e.message}`;
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 4 · generate_report
// ═══════════════════════════════════════════════════════════════════════════
async function generate_report({ title, data, format = "text" }) {
  const rows   = Array.isArray(data) ? data : [data];
  const prompt = `Genera un reporte ejecutivo en español titulado "${title}".
Datos: ${JSON.stringify(rows).slice(0, 8000)}
Formato: ${format === "markdown" ? "Markdown con tablas" : "Texto plano con secciones claras"}.
Usa puntos de miles. No inventes datos. Sé conciso pero completo.`;

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 2048,
  });
  return { report: res.choices[0].message.content.trim() };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 5 · check_stock_alerts
// ═══════════════════════════════════════════════════════════════════════════
async function check_stock_alerts({ threshold_factor = 1.0 }) {
  const { rows } = await db.query(`
    SELECT id, name, sku, stock, min_stock, sale_price,
           CASE WHEN stock = 0 THEN 'out' WHEN stock <= min_stock THEN 'low' ELSE 'ok' END AS status
    FROM products
    WHERE is_active = true AND stock <= min_stock * $1
    ORDER BY stock ASC
    LIMIT 50
  `, [threshold_factor]);
  return { alerts: rows, count: rows.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 6 · get_erp_context
// ═══════════════════════════════════════════════════════════════════════════
async function get_erp_context() {
  const [sales, stock, invoices, cashflow] = await Promise.all([
    db.query(`SELECT COUNT(*) as total, SUM(total) as revenue,
                     SUM(CASE WHEN payment_status='pending' THEN 1 ELSE 0 END) as pending
              FROM sales WHERE sale_date >= NOW() - INTERVAL '30 days'`),
    db.query(`SELECT COUNT(*) as low FROM products WHERE is_active=true AND stock <= min_stock`),
    db.query(`SELECT COUNT(*) as overdue, SUM(pending_amount) as total_pending
              FROM v_invoices_summary WHERE days_overdue > 0`),
    db.query(`SELECT SUM(daily_income) as income, SUM(daily_expenses) as expenses
              FROM v_cashflow_detailed WHERE date >= NOW() - INTERVAL '7 days'`),
  ]);
  return {
    last_30_days:         sales.rows[0],
    low_stock_products:   stock.rows[0].low,
    overdue_invoices:     invoices.rows[0],
    last_7_days_cashflow: cashflow.rows[0],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════════════
const TOOLS = {
  query_erp,
  mutate_erp,
  notify,
  generate_report,
  check_stock_alerts,
  get_erp_context,
};

const TOOL_DESCRIPTIONS = `
HERRAMIENTAS DISPONIBLES (úsalas en tu loop Thought→Act→Observation):

1. query_erp(sql)
   → SELECT en el ERP. Usa las vistas. Siempre LIMIT 100. Devuelve { rows[], count }.

2. mutate_erp(sql, confirmed, reason)
   → INSERT/UPDATE. confirmed=false → plan; confirmed=true → ejecuta. Siempre WHERE.

3. notify(channel, event, payload, email_to?, email_subject?, email_body?)
   → channel: "websocket" | "email" | "both"
   → email_to: usa process.env.ADMIN_EMAIL si el usuario no especificó otra dirección
   → email_body: si viene de generate_report, pasa el markdown directamente — se renderiza automáticamente
   → IMPORTANTE: esta herramienta SÍ envía el email. Debes llamarla para que el email llegue.
   → Devuelve { email: "sent" } si fue exitoso.
   
4. generate_report(title, data, format?)
   → Sintetiza datos en reporte. format: "text" | "markdown"
   → Para enviar por email, usa format:"markdown" y luego notify con ese contenido.

5. check_stock_alerts(threshold_factor?)
   → Productos con stock bajo o agotado. threshold_factor=1.0 → exactamente en min_stock.

6. get_erp_context()
   → Snapshot: ventas 30d, stock bajo, facturas vencidas, cashflow 7d.
   → Usar SIEMPRE al inicio de consultas complejas.
`;

module.exports = { TOOLS, TOOL_DESCRIPTIONS };
