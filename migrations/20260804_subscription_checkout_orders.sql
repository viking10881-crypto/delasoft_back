BEGIN;

CREATE TABLE subscription_checkout_orders (
  id BIGSERIAL PRIMARY KEY,
  reference VARCHAR(100) NOT NULL UNIQUE,
  plan_id BIGINT NOT NULL,
  plan_slug VARCHAR(30) NOT NULL,
  plan_name VARCHAR(100) NOT NULL,
  billing_cycle VARCHAR(10) NOT NULL,
  buyer_name VARCHAR(120) NOT NULL,
  business_name VARCHAR(160),
  email VARCHAR(160) NOT NULL,
  phone VARCHAR(40),
  currency CHAR(3) NOT NULL DEFAULT 'COP',
  amount_cents BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  wompi_transaction_id VARCHAR(100) UNIQUE,
  wompi_status VARCHAR(30),
  wompi_payment_method VARCHAR(50),
  wompi_event_id VARCHAR(100),
  consent_accepted BOOLEAN NOT NULL DEFAULT false,
  paid_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscription_checkout_cycle_check CHECK (billing_cycle IN ('monthly', 'yearly')),
  CONSTRAINT subscription_checkout_status_check CHECK (
    status IN ('pending', 'approved', 'declined', 'voided', 'error', 'expired')
  ),
  CONSTRAINT subscription_checkout_amount_check CHECK (amount_cents > 0),
  CONSTRAINT subscription_checkout_consent_check CHECK (consent_accepted = true)
);

CREATE INDEX idx_subscription_checkout_orders_email
  ON subscription_checkout_orders (LOWER(email));
CREATE INDEX idx_subscription_checkout_orders_status
  ON subscription_checkout_orders (status, created_at DESC);
CREATE INDEX idx_subscription_checkout_orders_plan
  ON subscription_checkout_orders (plan_slug, billing_cycle);

CREATE OR REPLACE FUNCTION update_subscription_checkout_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_subscription_checkout_orders_updated_at
BEFORE UPDATE ON subscription_checkout_orders
FOR EACH ROW
EXECUTE FUNCTION update_subscription_checkout_orders_updated_at();

COMMENT ON TABLE subscription_checkout_orders IS
'Órdenes de pago creadas desde la landing para contratar planes DELASOFT.';

COMMIT;
