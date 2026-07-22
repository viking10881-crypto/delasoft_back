-- Migration: Collapse fulfillment_mode to hybrid-only
-- All products become hybrid: stock when available, procurement when not.
-- Never blocks a sale for lack of physical stock.

BEGIN;

UPDATE products
SET fulfillment_mode = 'hybrid'
WHERE fulfillment_mode IN ('stock', 'on_demand');

ALTER TABLE products
  ALTER COLUMN fulfillment_mode SET DEFAULT 'hybrid';

COMMIT;
