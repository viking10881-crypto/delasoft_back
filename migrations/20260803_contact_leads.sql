BEGIN;

CREATE TABLE contact_leads (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  business_name VARCHAR(160),
  email VARCHAR(160) NOT NULL,
  phone VARCHAR(40),
  business_type VARCHAR(100),
  product_count VARCHAR(50),
  interested_plan VARCHAR(30),
  message TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'new',
  source VARCHAR(50) NOT NULL DEFAULT 'landing',
  notes TEXT,
  assigned_admin_id BIGINT,
  converted_user_id BIGINT,
  converted_business_id BIGINT,
  consent_accepted BOOLEAN NOT NULL DEFAULT false,
  contacted_at TIMESTAMPTZ,
  demo_scheduled_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  utm_source VARCHAR(120),
  utm_medium VARCHAR(120),
  utm_campaign VARCHAR(160),
  landing_page VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_leads_status_check CHECK (
    status IN ('new', 'contacted', 'demo_scheduled', 'negotiating', 'converted', 'discarded')
  ),
  CONSTRAINT contact_leads_plan_check CHECK (
    interested_plan IS NULL OR interested_plan IN ('basic', 'standard', 'pro', 'not_sure')
  ),
  CONSTRAINT contact_leads_consent_check CHECK (consent_accepted = true)
);

CREATE INDEX idx_contact_leads_status ON contact_leads(status);
CREATE INDEX idx_contact_leads_created_at ON contact_leads(created_at DESC);
CREATE INDEX idx_contact_leads_email ON contact_leads(LOWER(email));
CREATE INDEX idx_contact_leads_phone ON contact_leads(phone);
CREATE INDEX idx_contact_leads_interested_plan ON contact_leads(interested_plan);
CREATE INDEX idx_contact_leads_assigned_admin ON contact_leads(assigned_admin_id);

CREATE OR REPLACE FUNCTION update_contact_leads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_contact_leads_updated_at
BEFORE UPDATE ON contact_leads
FOR EACH ROW
EXECUTE FUNCTION update_contact_leads_updated_at();

COMMENT ON TABLE contact_leads IS
'Posibles clientes captados desde la landing de DELASOFT. No son usuarios del panel ni compradores de las tiendas.';

COMMENT ON COLUMN contact_leads.status IS
'Estado comercial: new, contacted, demo_scheduled, negotiating, converted o discarded.';

COMMENT ON COLUMN contact_leads.source IS
'Origen de la solicitud, por ejemplo landing, whatsapp, email, referral o social_media.';

COMMENT ON COLUMN contact_leads.assigned_admin_id IS
'Administrador encargado del prospecto. Se conserva sin llave foránea por ahora.';

COMMENT ON COLUMN contact_leads.converted_user_id IS
'Usuario creado cuando el prospecto se convierte. Se conserva sin llave foránea por ahora.';

COMMENT ON COLUMN contact_leads.converted_business_id IS
'Negocio creado cuando el prospecto se convierte. Se conserva sin llave foránea por ahora.';

COMMENT ON COLUMN contact_leads.consent_accepted IS
'Indica que la persona autorizó el tratamiento de sus datos para ser contactada.';

COMMIT;
