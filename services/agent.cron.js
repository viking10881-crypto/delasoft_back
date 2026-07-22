// services/agent.cron.js
const cron  = require("node-cron");
const { TOOLS } = require("./agent.tools");
const db    = require("../config/db");
const Groq  = require("groq-sdk");
const { recordUsage } = require("./token-budget");
const { sendAgentReportEmail } = require("../config/emailConfig");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function synthesize(prompt, data) {
  const res = await groq.chat.completions.create({
    model: "llama3-8b-8192",
    messages: [{
      role: "user",
      content: `${prompt}\n\nDatos: ${JSON.stringify(data).slice(0, 4000)}\n\nResponde en español. Puntos de miles. Máximo 2 párrafos.`,
    }],
    temperature: 0.2,
    max_tokens: 400,
  });

  const used = res.usage?.total_tokens || 400;
  recordUsage(used);

  return res.choices[0].message.content.trim();
}

// ── 1. Alerta de stock bajo — cada hora ──────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  try {
    const { alerts, count } = await TOOLS.check_stock_alerts({ threshold_factor: 1.2 });
    if (count === 0) return;

    const critical = alerts.filter(a => a.status === "out");
    const low      = alerts.filter(a => a.status === "low");

    const summary = await synthesize(
      "Resume las alertas de inventario de forma ejecutiva para el dueño del negocio.",
      { critical_out_of_stock: critical.length, low_stock: low.length, products: alerts.slice(0, 10) }
    );

    await TOOLS.notify({
      channel: "websocket",
      event: "stock_alert",
      payload: {
        type: "stock_alert",
        critical: critical.length,
        low: low.length,
        summary,
        products: alerts.slice(0, 10),
        timestamp: new Date().toISOString(),
      },
    });

    if (critical.length > 0 && process.env.ADMIN_EMAIL) {
      const productList = critical.map(p => `- ${p.name} (SKU: ${p.sku || "N/A"}): AGOTADO`).join("\n");
      await TOOLS.notify({
        channel: "email",
        event: "stock_critical",
        payload: {},
        email_to: process.env.ADMIN_EMAIL,
        email_subject: `⚠️ Delasoft ERP — ${critical.length} producto(s) AGOTADO(S)`,
        email_body: `<h2>Alerta de stock crítico</h2><p>${summary}</p><pre>${productList}</pre>`,
      });
    }

    console.log(`[Cron stock] ${count} alertas enviadas (${critical.length} críticas)`);
  } catch (e) {
    console.error("[Cron stock error]", e.message);
  }
});

// ── 2. Reporte diario — lunes a sábado a las 8 AM ────────────────────────────
cron.schedule("0 8 * * 1-6", async () => {
  try {
    const context = await TOOLS.get_erp_context();

    const { rows: yesterday } = await db.query(`
      SELECT COUNT(*) as orders, SUM(total) as revenue, SUM(CASE WHEN payment_status='paid' THEN total END) as collected
      FROM sales WHERE DATE(sale_date) = CURRENT_DATE - 1
    `);

    const { rows: topProds } = await db.query(`
      SELECT p.name, SUM(si.quantity) as units, SUM(si.subtotal) as revenue
      FROM sale_items si JOIN products p ON p.id = si.product_id
      JOIN sales s ON s.id = si.sale_id WHERE DATE(s.sale_date) = CURRENT_DATE - 1
      GROUP BY p.name ORDER BY revenue DESC LIMIT 5
    `);

    const title = `Reporte diario — ${new Date().toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })}`;

    const { report } = await TOOLS.generate_report({
      title,
      data: { yesterday: yesterday[0], top_products: topProds, erp_context: context },
      format: "markdown",
    });

    // WebSocket
    await TOOLS.notify({
      channel: "websocket",
      event: "daily_report",
      payload: { title: "Reporte diario listo", summary: report.slice(0, 200) },
    });

    // Email con plantilla branded
    if (process.env.ADMIN_EMAIL) {
      await sendAgentReportEmail(process.env.ADMIN_EMAIL, title, report);
    }

    console.log("[Cron daily] Reporte diario enviado");
  } catch (e) {
    console.error("[Cron daily error]", e.message);
  }
});

// ── 3. Monitoreo de facturas vencidas — cada día a las 9 AM ─────────────────
cron.schedule("0 9 * * *", async () => {
  try {
    const { rows } = await db.query(`
      SELECT provider_name, invoice_number, total_amount, pending_amount, days_overdue
      FROM v_invoices_summary
      WHERE days_overdue > 0 AND payment_status != 'paid'
      ORDER BY days_overdue DESC LIMIT 20
    `);
    if (rows.length === 0) return;

    const summary = await synthesize(
      "Genera un resumen ejecutivo de las facturas vencidas para tomar acción urgente.",
      rows
    );

    await TOOLS.notify({
      channel: "websocket",
      event: "invoices_overdue",
      payload: {
        type: "invoices_overdue",
        count: rows.length,
        summary,
        invoices: rows.slice(0, 5),
        timestamp: new Date().toISOString(),
      },
    });

    if (process.env.ADMIN_EMAIL) {
      await TOOLS.notify({
        channel: "email",
        event: "invoices_overdue",
        payload: {},
        email_to: process.env.ADMIN_EMAIL,
        email_subject: `🔴 Delasoft — ${rows.length} factura(s) vencida(s)`,
        email_body: `<h2>Facturas vencidas</h2><p>${summary}</p>`,
      });
    }

    console.log(`[Cron invoices] ${rows.length} facturas vencidas notificadas`);
  } catch (e) {
    console.error("[Cron invoices error]", e.message);
  }
});

// ── 4. Reporte semanal — domingo a las 9 AM ──────────────────────────────────
cron.schedule("0 9 * * 0", async () => {
  try {
    const { rows: weekSales } = await db.query(`
      SELECT DATE_TRUNC('day', sale_date) as day,
             COUNT(*) as orders, SUM(total) as revenue, SUM(total_profit) as profit
      FROM v_sales_full
      WHERE sale_date >= NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY 1
    `);

    const { rows: topProfit } = await db.query(`
      SELECT name, units_sold, total_revenue, realized_profit, margin_pct
      FROM v_profit_analysis ORDER BY realized_profit DESC LIMIT 10
    `);

    const title = "Reporte semanal de rendimiento";

    const { report } = await TOOLS.generate_report({
      title,
      data: { sales_by_day: weekSales, top_profit_products: topProfit },
      format: "markdown",
    });

    // WebSocket
    await TOOLS.notify({
      channel: "websocket",
      event: "weekly_report",
      payload: { title: "Reporte semanal listo" },
    });

    // Email con plantilla branded
    if (process.env.ADMIN_EMAIL) {
      await sendAgentReportEmail(process.env.ADMIN_EMAIL, title, report);
    }

    console.log("[Cron weekly] Reporte semanal enviado");
  } catch (e) {
    console.error("[Cron weekly error]", e.message);
  }
});

console.log("[Agent Cron] Tareas programadas activas: stock(1h), diario(8AM L-S), facturas(9AM), semanal(Dom 9AM)");