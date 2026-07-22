// services/token-budget.js
// ── Presupuesto diario de tokens para Groq ────────────────────────────────
// Evita alcanzar el límite duro de 100k TPD con un límite suave configurable.
// Funciona en memoria (se resetea al reiniciar el servidor).
// Si tienes Redis disponible, reemplaza las variables por claves Redis
// para persistir entre reinicios.

const DAILY_LIMIT  = parseInt(process.env.GROQ_DAILY_TOKEN_LIMIT || "80000", 10);
const WARN_AT      = 0.75; // avisa al llegar al 75 % del presupuesto

let dailyTokensUsed = 0;
let budgetResetAt   = Date.now();

function resetIfNewDay() {
  const now = Date.now();
  // 86_400_000 ms = 24 horas
  if (now - budgetResetAt >= 86_400_000) {
    console.log(`[TokenBudget] Nuevo día — reseteando contador. Tokens usados ayer: ${dailyTokensUsed}`);
    dailyTokensUsed = 0;
    budgetResetAt   = now;
  }
}

/**
 * Lanza un error 429 si el presupuesto diario se agotaría con esta llamada.
 * @param {number} estimatedTokens  Estimación conservadora del costo de la llamada.
 */
function checkBudget(estimatedTokens = 2000) {
  resetIfNewDay();

  const afterCall = dailyTokensUsed + estimatedTokens;

  if (afterCall > DAILY_LIMIT) {
    const err = new Error(
      `rate_limit_exceeded — presupuesto diario interno agotado ` +
      `(${dailyTokensUsed}/${DAILY_LIMIT} tokens usados). ` +
      `Intenta mañana o aumenta GROQ_DAILY_TOKEN_LIMIT.`
    );
    err.status = 429;
    throw err;
  }

  // Advertencia suave
  if (afterCall > DAILY_LIMIT * WARN_AT && dailyTokensUsed <= DAILY_LIMIT * WARN_AT) {
    console.warn(
      `[TokenBudget] ⚠️  ${Math.round((afterCall / DAILY_LIMIT) * 100)}% ` +
      `del presupuesto diario utilizado (${afterCall}/${DAILY_LIMIT} tokens)`
    );
  }
}

/**
 * Registra los tokens realmente consumidos tras una llamada exitosa.
 * @param {number} tokens
 */
function recordUsage(tokens) {
  resetIfNewDay();
  dailyTokensUsed += tokens;
  console.log(`[TokenBudget] +${tokens} tokens → total hoy: ${dailyTokensUsed}/${DAILY_LIMIT}`);
}

/** Devuelve el estado actual del presupuesto (útil para endpoints de salud). */
function getStatus() {
  resetIfNewDay();
  return {
    used:       dailyTokensUsed,
    limit:      DAILY_LIMIT,
    remaining:  DAILY_LIMIT - dailyTokensUsed,
    pct:        Math.round((dailyTokensUsed / DAILY_LIMIT) * 100),
    resetAt:    new Date(budgetResetAt + 86_400_000).toISOString(),
  };
}

module.exports = { checkBudget, recordUsage, getStatus };