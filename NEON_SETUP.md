# Preparación de la nueva base de datos Neon

## Estado encontrado

El backend usa PostgreSQL mediante `pg` y `NEON_DB_URL`. El repositorio contiene cuatro
migraciones incrementales, pero no contiene la migración inicial que creó el esquema.
Por eso **no se deben ejecutar directamente sobre una base vacía**: dependen de tablas
que todavía no existirían.

El código referencia, entre otras, estas tablas:

- Identidad: `users`, `roles`, `user_roles`, `refresh_tokens`, `admin_profiles`.
- Catálogo: `products`, `product_images`, `categories`, `product_variants`,
  `variant_images`, `attribute_types`, `attribute_values`,
  `variant_attribute_values`, `bundle_items`, `banners`, `reviews`,
  `review_images`, `review_votes`, `review_reports`.
- Ventas y pagos: `sales`, `sale_items`, `sale_payments`,
  `sale_payment_transactions`, `store_payment_accounts`,
  `payment_webhook_events`, `discounts`, `discount_targets`,
  `discount_coupons`.
- Finanzas y compras: `providers`, `provider_payments`, `invoices`,
  `invoice_items`, `invoice_payments`, `expenses`, `procurement_orders`,
  `purchase_orders`, `purchase_order_items`, `product_price_history`.
- Inventario: `stock_ledger`, `stock_alerts`, `stock_reservations`,
  `credit_payment_schedule`.
- Plataforma: `api_keys`, `api_key_logs`, `subscriptions`,
  `subscription_plans`, `subscription_usage`, `subscription_invoices`,
  `subscription_coupons`, `subscription_plan_changes`.
- Comunicación: `notification_settings`, `notification_templates`,
  `notification_queue`, `push_subscriptions`, `chat_messages`,
  `contact_messages`, `agent_conversations`, `page_views`.

También se consultan las vistas `v_cashflow_detailed`, `v_inventory_valuation`,
`v_invoices_summary`, `v_profit_analysis`, `v_purchase_orders_summary`,
`v_sales_full` y `v_stock_disponible`.

Esta lista sirve como inventario, no como definición exacta: los tipos, constraints,
índices, secuencias, funciones y vistas deben conservarse desde el esquema real.

## Procedimiento seguro recomendado

1. Crear un proyecto y una base vacía en la cuenta nueva de Neon.
2. Exportar **solo el esquema** de la base anterior. `pg_dump --schema-only` realiza
   lecturas de catálogo y no exporta filas ni modifica la base origen:

   ```bash
   pg_dump "$OLD_NEON_DB_URL" \
     --schema-only --no-owner --no-privileges \
     --file=migrations/000_baseline.sql
   ```

3. Revisar `000_baseline.sql` para confirmar que no incluya propietarios o permisos
   propios de la cuenta anterior.
4. Aplicarlo únicamente a la URL de la base nueva:

   ```bash
   psql "$NEW_NEON_DB_URL" -v ON_ERROR_STOP=1 \
     -f migrations/000_baseline.sql
   ```

5. Aplicar, en orden, solo las migraciones incrementales que no estén ya reflejadas
   en el baseline.
6. Verificar tablas y vistas en la base nueva y luego configurar `NEON_DB_URL` en
   Render. Nunca versionar las URLs reales.

## Datos

El proceso anterior copia únicamente estructura. No copia usuarios, ventas, productos,
credenciales de pago ni ninguna otra fila. El primer administrador debe crearse después
en la base nueva mediante el flujo de setup o `createAdmin.js`.

## Integraciones que deben crearse de nuevo

- Render y su URL pública.
- Neon (`NEON_DB_URL`).
- Cloudinary.
- Brevo.
- Google OAuth.
- Groq.
- VAPID web push.
- Meta WhatsApp o Twilio.
- Wompi y la clave local de cifrado de credenciales.

La plantilla completa está en `.env.example`.
