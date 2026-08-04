BEGIN;

ALTER TABLE subscription_checkout_orders
  ADD COLUMN activated_admin_id BIGINT,
  ADD COLUMN activation_started_at TIMESTAMPTZ,
  ADD COLUMN activated_at TIMESTAMPTZ,
  ADD COLUMN activated_by BIGINT;

CREATE INDEX idx_subscription_checkout_orders_activation
  ON subscription_checkout_orders (activated_at, created_at DESC);

COMMENT ON COLUMN subscription_checkout_orders.activated_admin_id IS
'Administrador al que el superadmin vinculó la compra. Sin llave foránea para conservar historial.';

COMMIT;
