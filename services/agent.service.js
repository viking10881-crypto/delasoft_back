// services/agent.service.js
const Groq  = require("groq-sdk");
const db    = require("../config/db");
const { TOOLS, TOOL_DESCRIPTIONS } = require("./agent.tools");
const { checkBudget, recordUsage }  = require("./token-budget");

const groq      = new Groq({ apiKey: process.env.GROQ_API_KEY });
// Línea 13 — cambiar MAX_STEPS
const MAX_STEPS = 10;  // era 6

// ── Cache del esquema ─────────────────────────────────────────────────────────
// El esquema de la BD casi nunca cambia; reconstruirlo en cada llamada
// es el mayor desperdicio de tokens. Se cachea 1 hora en memoria.
let _schemaCache     = null;
let _schemaCachedAt  = 0;
const SCHEMA_TTL_MS  = 60 * 60 * 1000; // 1 hora

async function getFilteredSchema() {
  const now = Date.now();
  if (_schemaCache && now - _schemaCachedAt < SCHEMA_TTL_MS) {
    return _schemaCache;
  }

  const ALLOWED_TABLES = [
    "sales","sale_items","coupon_usage","products","product_variants",
    "product_images","product_price_history","categories",
    "attribute_types","attribute_values","variant_attribute_values",
    "bundle_items","variant_images","expenses","invoices","invoice_items",
    "invoice_payments","financial_budgets","provider_payments",
    "providers","purchase_orders","purchase_order_items",
    "discounts","discount_coupons","discount_targets","banners",
    "agent_conversations",
    "v_sales_full","v_products_full","v_profit_analysis",
    "v_cashflow_detailed","v_expenses_summary",
    "v_invoices_summary","v_provider_balance",
  ];
  const HIDE = [
    "password","token","secret","cedula","documento",
    "customer_phone","shipping_address","shipping_lat","shipping_lng",
    "payment_proof_url","tax_id","contact_person","device_info","token_hash",
  ];

  const { rows } = await db.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY($1)
    ORDER BY table_name, ordinal_position
  `, [ALLOWED_TABLES]);

  const schema = {};
  for (const r of rows) {
    if (HIDE.some(h => r.column_name.toLowerCase().includes(h))) continue;
    if (!schema[r.table_name]) schema[r.table_name] = [];
    schema[r.table_name].push(r.column_name);
  }

  // Formato comprimido: tabla(col1,col2,...) — sin tipos, ~40% menos tokens
  _schemaCache    = Object.entries(schema)
    .map(([t, cols]) => `${t}(${cols.join(",")})`)
    .join("\n");
  _schemaCachedAt = now;

  console.log("[Agent] Esquema DB cacheado —", Object.keys(schema).length, "tablas/vistas");
  return _schemaCache;
}

function buildSystemPrompt(schema) {
  return `Eres el agente inteligente del ERP "Delasoft". Operas el sistema con herramientas reales.

MODO DE OPERACIÓN — loop ReAct:
En cada turno debes responder ÚNICAMENTE con un objeto JSON válido. Ningún texto fuera del JSON.

FORMATOS PERMITIDOS (elige solo uno por turno):

Usar herramienta:
{"thought":"razonamiento corto","action":"nombre_tool","args":{}}

Responder al usuario (OBLIGATORIO como último paso):
{"thought":"...","action":"answer","text":"respuesta completa en español"}

Pedir confirmación antes de mutar:
{"thought":"...","action":"confirm","text":"descripción de la acción","pending_sql":"..."}

REGLA CRÍTICA: Cuando ya tienes toda la información necesaria, SIEMPRE termina con action=answer.
Nunca termines el loop en una herramienta. El usuario solo ve el campo "text" de action=answer.
Si usaste notify o generate_report, confirma al usuario qué hiciste en el text final.

AUTONOMÍA:
- query_erp, check_stock_alerts, get_erp_context, generate_report, notify → ejecuta sin pedir permiso
- mutate_erp → primero confirmed=false para mostrar plan, luego espera "sí confirmo"
- Si el usuario escribió "sí confirmo", usa mutate_erp con confirmed=true directamente

REGLA DE EMAIL — MUY IMPORTANTE:
Si el usuario pidió "notifícame por email", "envíame un correo" o similar:
1. DEBES llamar notify con channel="email" o channel="both" ANTES de responder
2. Solo DESPUÉS de que notify devuelva un resultado, usa action=answer
3. NUNCA digas que enviaste un email sin haber llamado la herramienta notify
4. En el action=answer confirma el resultado real de notify (éxito o error)

REGLA DE REPORTE + EMAIL:
Cuando el usuario pide reporte por email, el flujo OBLIGATORIO es:
  paso 1 → query_erp (obtener datos)
  paso 2 → generate_report (format: "markdown")  
  paso 3 → notify (channel: "email", email_body: <el reporte markdown>)
  paso 4 → answer (confirmar lo que hiciste)

${TOOL_DESCRIPTIONS}

ESQUEMA (formato tabla(columnas)):
${schema}

VISTAS DISPONIBLES: v_sales_full, v_products_full, v_profit_analysis,
v_cashflow_detailed, v_expenses_summary, v_invoices_summary, v_provider_balance`;
}

async function callLLM(systemPrompt, conversation) {
  // Verificar presupuesto antes de cada llamada al LLM
  // Estimación conservadora: system prompt + historial + respuesta esperada
  checkBudget(1500);

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      ...conversation.map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ],
    temperature: 0.1,
    // Pasos del loop ReAct solo emiten un JSON de acción — 500 tokens es suficiente.
    // Para síntesis final usamos synthesizeFinalAnswer con su propio límite.
    max_tokens: 500,
  });

  // Registrar tokens reales consumidos
  const used = res.usage?.total_tokens || 500;
  recordUsage(used);

  return res.choices[0].message.content.trim();
}

function parseStep(raw) {
  const clean = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch { return null; }
}

// Llamada final para sintetizar todo lo que el agente hizo en lenguaje natural
async function synthesizeFinalAnswer(systemPrompt, loopConv) {
  checkBudget(800);

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      ...loopConv,
      {
        role: "user",
        content: `Basándote en todo lo que hiciste arriba, responde ahora al usuario con un resumen claro en español.
Responde SOLO con este JSON: {"thought":"síntesis","action":"answer","text":"tu respuesta aquí"}
No incluyas ningún texto fuera del JSON.`,
      },
    ],
    temperature: 0.2,
    max_tokens: 800,
  });

  const used = res.usage?.total_tokens || 800;
  recordUsage(used);

  const raw    = res.choices[0].message.content.trim();
  const parsed = parseStep(raw);
  return parsed?.text || raw;
}

async function runAgent(messages) {
  if (!process.env.GROQ_API_KEY)
    throw new Error("GROQ_API_KEY no configurada");

  const schema       = await getFilteredSchema();
  const systemPrompt = buildSystemPrompt(schema);
  const loopConv     = [...messages];

  let needsConfirm  = false;
  let pendingAction = null;
  let finalReply    = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const raw    = await callLLM(systemPrompt, loopConv);
    const parsed = parseStep(raw);

    // Si el LLM devolvió algo que no es JSON válido, sintetizar con lo que tenemos
    if (!parsed) {
      console.warn(`[Agent step ${step + 1}] respuesta no-JSON, sintetizando...`);
      finalReply = await synthesizeFinalAnswer(systemPrompt, loopConv);
      break;
    }

    console.log(`[Agent step ${step + 1}]`, parsed.action, "-", parsed.thought || "");

    // ── Respuesta final ───────────────────────────────────────────────
    if (parsed.action === "answer") {
      finalReply = parsed.text;
      break;
    }

    // ── Confirmación requerida ────────────────────────────────────────
    if (parsed.action === "confirm") {
      needsConfirm  = true;
      pendingAction = parsed.pending_sql;
      finalReply    = parsed.text;
      break;
    }

    // ── Ejecutar tool ─────────────────────────────────────────────────
    if (parsed.action && TOOLS[parsed.action]) {
      let observation;
      try {
        observation = await TOOLS[parsed.action](parsed.args || {});
      } catch (err) {
        observation = { error: err.message };
        console.error(`[Tool ${parsed.action} error]`, err.message);
      }

      if (observation?.status === "needs_confirm") {
        needsConfirm  = true;
        pendingAction = observation.sql;
        finalReply    = `Quiero ejecutar la siguiente acción:\n\n\`\`\`sql\n${observation.sql}\n\`\`\`\n\n${observation.reason || ""}\n\n¿Confirmas? Escribe **"sí confirmo"** para proceder.`;
        break;
      }

      loopConv.push({
        role: "assistant",
        content: JSON.stringify({ thought: parsed.thought, action: parsed.action, args: parsed.args }),
      });
      loopConv.push({
        role: "user",
        // Truncar observaciones largas para no desperdiciar tokens de contexto
        content: `Observación de ${parsed.action}: ${JSON.stringify(observation).slice(0, 2000)}`,
      });

    } else {
      // Acción desconocida — sintetizar con lo acumulado
      console.warn(`[Agent] acción desconocida: ${parsed.action}`);
      finalReply = await synthesizeFinalAnswer(systemPrompt, loopConv);
      break;
    }

    // Último paso del loop — forzar síntesis
    if (step === MAX_STEPS - 1) {
      console.log("[Agent] MAX_STEPS alcanzado, sintetizando respuesta final...");
      finalReply = await synthesizeFinalAnswer(systemPrompt, loopConv);
    }
  }

  if (!finalReply) {
    finalReply = await synthesizeFinalAnswer(systemPrompt, loopConv);
  }

  return {
    reply:   finalReply,
    history: [...messages, { role: "assistant", content: finalReply }],
    needsConfirm,
    pendingAction,
  };
}

module.exports = { runAgent };