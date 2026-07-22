---
name: project-delasoft-back
description: Stack, arquitectura multi-tenant, y mejoras de seguridad/producción del backend delasoft_back
metadata:
  type: project
---

## Stack
- Node.js + Express 5 + PostgreSQL (Neon)
- JWT access (15m) + refresh tokens (7d) en tabla `refresh_tokens`
- Socket.io para chat DM en tiempo real
- Cloudinary para imágenes
- web-push (VAPID) para notificaciones push
- Groq SDK (LLM) + @google/generative-ai para agente AI
- Wompi para pagos (Colombia)
- Brevo (@getbrevo/brevo) para emails transaccionales
- node-cron para tareas: vencimientos de suscripción, push notifications, sync de usage

## Arquitectura multi-tenant
- `owner_admin_id` en products/categories/providers/expenses/sales/etc. → identifica al admin dueño
- `created_by` en muchas tablas → quién creó el registro
- `adminScope` middleware inyecta `req.isSuperAdmin` y `req.adminId` en todas las rutas
- Sub-usuarios heredan el scope de su admin (via `owner_admin_id` en users)
- Superadmin ve y gestiona TODO sin filtros de tenant

## Sistema de suscripciones
- Plans en `subscription_plans`, estado en `subscriptions`
- `subscription.middleware.js` → `requireFeature()`, `requireLimit()`, `requireActiveSubscription()`
- Cache en memoria con TTL 5min por adminId (invalidar con `invalidateCache(adminId)`)
- Cron diario procesa vencimientos y envía notificaciones

## Seguridad aplicada (branch: security/production-hardening)
- SSL `rejectUnauthorized: true` en producción (antes era siempre false)
- Validación JWT_SECRET mínimo 32 chars en env.js
- JWT_SECRET !== JWT_REFRESH_SECRET en producción (validado en env.js)
- FRONTEND_URL requerido en producción
- Fix: setupAdmin incluye ahora el campo `cedula` (era bug NOT NULL en DB)
- Socket.io: eliminados `io.emit('chat:user_joined')` y `chat:user_left` (fuga cross-tenant)
- `assertOwnership` whitelist de tablas y columnas para evitar SQL injection via interpolación
- Rate limiting en memoria (in-process) — limitación: no comparte estado entre instancias

## Performance
- `compression` middleware (gzip) en todas las respuestas
- Request timeout de 30s configurable via `REQUEST_TIMEOUT`
- DB pool max configurable via `DB_POOL_MAX` (default 10)
- Subscription middleware tiene cache en memoria 5min
- Schema cache en agent.service.js (1 hora TTL)
- Pool `allowExitOnIdle: true` — apropiado para Neon serverless

## Paquetes limpiados (eran unused/frontend)
- Removidos: `@supabase/supabase-js`, `sqlite3`, `recharts`, `@reduxjs/toolkit`, `postgres`, `@neondatabase/serverless`
- Agregado: `compression`

## Pagos multi-tienda (implementado 2026-05-25)
- `store_payment_accounts` → credenciales Wompi por tienda (AES-256-GCM en reposo vía `utils/crypto.js`)
- `sale_payment_transactions` → log de cada intento de cobro (reference UNIQUE)
- `payment_webhook_events` → idempotencia del webhook (provider, event_id UNIQUE)
- `services/payment.service.js` → toda la lógica de Wompi (agnóstico de proveedor)
- `controllers/paymentAccounts.controller.js` + `routes/paymentAccounts.routes.js` → `/api/payment-accounts`
- Webhook: `POST /api/wompi/webhook` registrado ANTES de `express.json()` con `express.raw()` en app.js
- Feature flag `has_wompi_payments` en `subscription_plans` controla acceso al CRUD de cuentas
- `PAYMENTS_ENCRYPTION_KEY` requerida en entorno (32 bytes hex/base64)
- `routes/payments.controller.js` eliminado (era duplicado de `controllers/payments.controller.js`)
- `exports.wompiWebhook` eliminado de `sales.controller.js` (nunca estuvo ruteado; reemplazado por el nuevo webhook)

**Why:** Reducir superficie de ataque, mejorar rendimiento y garantizar correcto funcionamiento en producción.
**How to apply:** Al hacer cambios de seguridad o agregar features, respetar la arquitectura multi-tenant (siempre filtrar por owner_admin_id o created_by según la tabla).
