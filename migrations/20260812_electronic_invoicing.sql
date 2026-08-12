BEGIN;

CREATE TABLE store_fiscal_integrations (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  provider VARCHAR(30) NOT NULL DEFAULT 'factus',
  environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  client_id VARCHAR(255) NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  username_encrypted TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  tax_id VARCHAR(30) NOT NULL,
  verification_digit VARCHAR(2),
  document_type_id INTEGER,
  numbering_range_id INTEGER,
  municipality_id INTEGER,
  tribute_id INTEGER,
  legal_organization_id INTEGER,
  fiscal_regime_id INTEGER,
  fiscal_responsibility_code VARCHAR(20),
  request_mode VARCHAR(20) NOT NULL DEFAULT 'customer_request',
  is_active BOOLEAN NOT NULL DEFAULT false,
  last_verified_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_id, provider),
  CHECK (provider IN ('factus')),
  CHECK (environment IN ('sandbox', 'production')),
  CHECK (status IN ('pending', 'connected', 'error')),
  CHECK (request_mode IN ('customer_request', 'always', 'manual'))
);

CREATE TABLE sale_electronic_invoices (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT NOT NULL UNIQUE,
  owner_admin_id BIGINT NOT NULL,
  integration_id BIGINT NOT NULL REFERENCES store_fiscal_integrations(id),
  provider VARCHAR(30) NOT NULL,
  environment VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'requested',
  requested_by BIGINT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_document_id VARCHAR(255),
  invoice_number VARCHAR(100),
  cufe TEXT,
  qr_data TEXT,
  pdf_url TEXT,
  xml_url TEXT,
  provider_response JSONB,
  error_message TEXT,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('requested', 'processing', 'approved', 'rejected', 'error'))
);

ALTER TABLE sales ADD COLUMN electronic_invoice_requested BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_store_fiscal_integrations_admin ON store_fiscal_integrations(admin_id);
CREATE INDEX idx_sale_electronic_invoices_tenant ON sale_electronic_invoices(owner_admin_id, created_at DESC);

COMMIT;
