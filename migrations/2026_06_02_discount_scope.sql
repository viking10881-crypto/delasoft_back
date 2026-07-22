-- =============================================================================
-- Discount scope enforcement (2026-06-02)
-- 1. sales.discount_id — traza qué descuento se aplicó (para revertir times_used al cancelar)
-- 2. discount_coupons.scope — mismo contrato de canal que discounts.scope
-- Idempotent: safe to re-run.
-- Usage: psql $NEON_DB_URL -f migrations/2026_06_02_discount_scope.sql
-- =============================================================================

-- ── 1. Descuento aplicado a la venta ──────────────────────────────────────────
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS discount_id integer
    REFERENCES discounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_discount_id
  ON sales(discount_id)
  WHERE discount_id IS NOT NULL;

-- ── 2. Scope en cupones (si la tabla existe) ──────────────────────────────────
ALTER TABLE discount_coupons
  ADD COLUMN IF NOT EXISTS scope varchar(10) NOT NULL DEFAULT 'all',
  ADD CONSTRAINT IF NOT EXISTS discount_coupons_scope_check
    CHECK (scope IN ('web', 'pos', 'all'));
