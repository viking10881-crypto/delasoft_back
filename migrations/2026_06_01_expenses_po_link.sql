-- =============================================================================
-- Expenses — purchase_order_id link (2026-06-01)
-- Allows creating expenses linked to POs without duplicates.
-- Idempotent: safe to re-run.
-- Usage: psql $NEON_DB_URL -f migrations/2026_06_01_expenses_po_link.sql
-- =============================================================================

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS purchase_order_id integer REFERENCES purchase_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_purchase_order
  ON expenses(purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;
