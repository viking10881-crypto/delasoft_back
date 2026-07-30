-- Planes comerciales DELASOFT en pesos colombianos.
-- El precio anual equivale a 10 mensualidades (2 meses de ahorro).

INSERT INTO subscription_plans (
  name, slug, description, tagline,
  price_monthly, price_yearly, currency, trial_days,
  max_products, max_users, max_admins, max_monthly_sales,
  max_api_keys, max_categories, max_banners, max_providers, storage_mb,
  has_analytics, has_ai_agent, has_api_access, has_multi_admin,
  has_custom_branding, has_wompi_payments, has_export,
  has_priority_support, has_push_notifications, has_financial_reports,
  has_purchase_orders, has_discount_system, has_inventory,
  color, badge_label, icon, sort_order, is_active, is_public
) VALUES
  (
    'Básico', 'basic',
    'Para tiendas que están organizando sus ventas e inventario.',
    'Todo lo esencial para comenzar',
    49900, 499000, 'COP', 14,
    100, -1, 1, 500,
    0, 20, 3, 20, 1024,
    false, false, false, false,
    false, true, false,
    false, false, false,
    false, true, true,
    '#2563EB', NULL, 'package', 1, true, true
  ),
  (
    'Estándar', 'standard',
    'Para negocios en crecimiento que necesitan automatización y control financiero.',
    'La mejor relación entre precio y herramientas',
    89900, 899000, 'COP', 14,
    1000, -1, 3, 3000,
    1, 50, 10, 50, 5120,
    true, false, true, true,
    true, true, true,
    false, true, true,
    true, true, true,
    '#0EA5E9', 'Recomendado', 'zap', 2, true, true
  ),
  (
    'Pro', 'pro',
    'Para operaciones consolidadas, equipos amplios e integraciones avanzadas.',
    'Máxima capacidad para escalar',
    149900, 1499000, 'COP', 14,
    -1, -1, 10, -1,
    10, -1, 20, -1, 20480,
    true, true, true, true,
    true, true, true,
    true, true, true,
    true, true, true,
    '#1D4ED8', 'Más completo', 'crown', 3, true, true
  )
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  tagline = EXCLUDED.tagline,
  price_monthly = EXCLUDED.price_monthly,
  price_yearly = EXCLUDED.price_yearly,
  currency = EXCLUDED.currency,
  trial_days = EXCLUDED.trial_days,
  max_products = EXCLUDED.max_products,
  max_users = EXCLUDED.max_users,
  max_admins = EXCLUDED.max_admins,
  max_monthly_sales = EXCLUDED.max_monthly_sales,
  max_api_keys = EXCLUDED.max_api_keys,
  max_categories = EXCLUDED.max_categories,
  max_banners = EXCLUDED.max_banners,
  max_providers = EXCLUDED.max_providers,
  storage_mb = EXCLUDED.storage_mb,
  has_analytics = EXCLUDED.has_analytics,
  has_ai_agent = EXCLUDED.has_ai_agent,
  has_api_access = EXCLUDED.has_api_access,
  has_multi_admin = EXCLUDED.has_multi_admin,
  has_custom_branding = EXCLUDED.has_custom_branding,
  has_wompi_payments = EXCLUDED.has_wompi_payments,
  has_export = EXCLUDED.has_export,
  has_priority_support = EXCLUDED.has_priority_support,
  has_push_notifications = EXCLUDED.has_push_notifications,
  has_financial_reports = EXCLUDED.has_financial_reports,
  has_purchase_orders = EXCLUDED.has_purchase_orders,
  has_discount_system = EXCLUDED.has_discount_system,
  has_inventory = EXCLUDED.has_inventory,
  color = EXCLUDED.color,
  badge_label = EXCLUDED.badge_label,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  is_public = EXCLUDED.is_public,
  updated_at = now();

-- Cualquier plan heredado que no forme parte de la oferta queda fuera del catálogo.
UPDATE subscription_plans
SET is_public = false, is_active = false, updated_at = now()
WHERE slug NOT IN ('basic', 'standard', 'pro');
