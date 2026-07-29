-- Separa la visibilidad en tienda del ciclo de vida operativo del producto.
-- Los productos existentes permanecen publicados para evitar cambios inesperados.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_published boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_products_public_listing
  ON products (owner_admin_id, is_published, created_at DESC)
  WHERE is_active = true;

COMMENT ON COLUMN products.is_published IS
  'Controla la visibilidad en la tienda. No afecta inventario, historial ni actividad operativa.';
