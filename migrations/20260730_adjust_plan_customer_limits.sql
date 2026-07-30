-- Los clientes finales de una tienda no deben consumir cupos internos del panel.
-- max_users queda ilimitado y max_admins representa los usuarios internos incluidos.

UPDATE subscription_plans
SET
  max_users = -1,
  max_admins = CASE slug
    WHEN 'basic' THEN 1
    WHEN 'standard' THEN 3
    WHEN 'pro' THEN 10
    ELSE max_admins
  END,
  updated_at = now()
WHERE slug IN ('basic', 'standard', 'pro');

