# BACKEND_AUDIT.md — delasoft_back

> Informe de auditoría completo. Cubre arquitectura, mapa de módulos con endpoints, capa de datos, ciclo de vida de una request, análisis de la integración Wompi, hallazgos priorizados, convenciones detectadas y recomendaciones.
> Fecha: 2026-05-26 · Sin cambios de código.

---

## 1. Resumen general

`delasoft_back` es una API REST multi-tenant para la gestión de boutiques (tiendas de moda colombianas). Cada tienda es un "admin" independiente; sus operadores (gerente, cajero…) son sub-usuarios que heredan el scope del admin dueño. Un superadmin especial tiene visibilidad total sobre todos los tenants.

**Stack principal:**

| Capa | Tecnología |
|---|---|
| Runtime | Node.js + Express 5.2.1 |
| Base de datos | PostgreSQL (NeonDB serverless) vía `pg` pool |
| Auth | JWT (access 15 min / refresh 7 días) + API Key SHA-256 |
| Pagos | Wompi (Colombia) — credenciales por tienda, AES-256-GCM |
| Tiempo real | Socket.IO (chat DM + actualizaciones de datos) |
| Email | Brevo (`@getbrevo/brevo`) |
| Imágenes | Cloudinary |
| Push | Web Push VAPID |
| IA | Groq SDK + `@google/generative-ai` (agente ReAct) |
| Tareas programadas | `node-cron` (3 crons) |
| Compresión | `compression` (gzip/brotli) |
| Seguridad HTTP | `helmet` + CORS explícito |

El servidor arranca en `server.js` → valida env → crea `http.Server` → llama `initSocket` → `listen`. El graceful shutdown cierra el socket HTTP y el pool de DB con un `setTimeout` de 10 s como salida forzada.

---

## 2. Mapa de módulos y endpoints

### 2.1 Panel de administración (`/api/*`)

El webhook de Wompi se registra **directamente en `app.js`** antes de `express.json()`. El resto de rutas se montan con `safeRequire` (ver §4).

#### Auth — `/api/auth`
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/register` | Registro + email de verificación |
| POST | `/verify` | Verifica código OTP (6 dígitos, 10 min) |
| POST | `/login` | Login → access token + refresh token |
| POST | `/refresh` | Renueva access token con refresh token |
| POST | `/logout` | Revoca refresh token en DB |
| GET | `/profile` | Perfil del usuario autenticado |
| POST | `/setup` | Crea superadmin inicial (requiere `SETUP_SECRET_KEY`) |

#### Superadmin — `/api/superadmin`
CRUD de admins, planes de suscripción, gestión de tenants, estadísticas globales. Solo accesible con rol `superadmin`.

#### Usuarios — `/api/users`
CRUD de sub-usuarios dentro del tenant del admin autenticado.

#### Roles — `/api/roles`
Listado de roles disponibles en el sistema.

#### API Keys — `/api/api-keys`
CRUD de claves para el acceso externo (`X-API-Key`). Cada clave se almacena como SHA-256 del raw.

#### Perfil admin — `/api/admin-profile`
Lectura y actualización del perfil del admin autenticado. Incluye imagen de perfil vía Cloudinary.

#### Suscripciones — `/api/subscriptions`
Consulta y gestión del plan activo. Integrado con `subscription.cron` para vencimientos.

#### Estadísticas — `/api/stats`
KPIs del dashboard: ventas, ingresos, productos más vendidos, etc.

#### Proveedores — `/api/providers`
CRUD de proveedores filtrado por tenant.

#### Finanzas — `/api/finance`
Gastos, presupuestos, órdenes de compra, facturas.

#### Productos — `/api/products`
CRUD de productos con variantes y bundles. Incluye upload a Cloudinary y control de límites de plan.

#### Categorías — `/api/categories`
CRUD de categorías.

#### Ventas — `/api/sales`
CRUD de ventas + abonos + historial de pagos. Columna `payment_status` puede ser: `pending`, `partial`, `paid`, `cancelled`.

#### Descuentos — `/api/discounts`
Descuentos por porcentaje/monto fijo + cupones.

#### Banners — `/api/banners`
CRUD de banners para la vitrina pública.

#### Notificaciones — `/api/notifications`
Suscripciones Web Push y envío de notificaciones por admin.

#### Variantes y bundles — `/api` (montado en raíz `/api`)
Rutas de atributos de producto, variantes y bundles.

#### Reseñas — `/api` (montado en raíz `/api`)
Reseñas de productos por clientes.

#### Chat — `/api/chat`
Mensajes directos en tiempo real. Historial persistido en DB; entrega vía Socket.IO.

#### Agente IA — `/api/agent`
Loop ReAct con Groq/Gemini. Genera reportes que se envían por email. Schema cache de 1 h.

#### Wompi (panel) — `/api/wompi`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/session/:sale_id` | Construye sesión de checkout |
| GET | `/verify/:reference` | Consulta estado del pago por referencia |
| POST | `/webhook` *(directo en app.js)* | Recibe eventos de Wompi |

#### Cuentas de pago — `/api/payment-accounts`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Lee la cuenta activa (secretos enmascarados) |
| POST | `/` | Crea o actualiza credenciales (cifrado AES-256-GCM) |
| POST | `/verify` | Verifica credenciales contra Wompi |
| DELETE | `/` | Desactiva la cuenta (soft delete) |

#### Analytics — `/api/analytics`
Métricas avanzadas de ventas. Protegido por feature flag `has_analytics`.

#### Contacto — `/api/contact`
Formulario de contacto público.

#### Health — `/api/health`
Estado del servidor + estado de carga de cada módulo de rutas (solo detalles en non-prod).

---

### 2.2 API pública (storefront) — `/public-api/v1/*`

Autenticación exclusiva por `X-API-Key`. El tenant se resuelve siempre desde la API Key — nunca del cliente.

Incluye: catálogo de productos, categorías, banners, carrito, checkout (crea `sales`), auth de clientes (`/auth/register`, `/auth/login`), perfil, historial de pedidos, reseñas.

---

### 2.3 Tareas programadas (crons)

| Módulo | Frecuencia | Función |
|---|---|---|
| `services/agent.cron.js` | Configurable | Ejecuta agente IA autónomo y envía reporte por email |
| `services/notificationScheduler.js` | Configurable | Push notifications programadas |
| `services/subscription.cron.js` | Diario | Procesa vencimientos, envía avisos, sincroniza contadores de uso |

---

## 3. Capa de datos y multi-tenancia

### 3.1 Pool de conexión

`config/db.js` — `pg.Pool` con:
- SSL `rejectUnauthorized: true` en producción, `false` en development.
- `allowExitOnIdle: true` — compatible con Neon serverless (libera conexiones inactivas).
- `max` configurable vía `DB_POOL_MAX` (default 10).

### 3.2 Modelo de multi-tenancia

Cada tabla de negocio lleva **dos columnas de scope**:

| Columna | Tablas principales | Uso |
|---|---|---|
| `owner_admin_id` | `products`, `categories`, `providers`, `sales`, `expenses`, `discounts`, `purchase_orders`, `invoices`, `users` | El admin dueño del recurso |
| `created_by` | `sales`, `expenses`, `banners`, `discounts`, `purchase_orders`, `invoices`, `financial_budgets` | Quién creó el registro |
| `admin_id` | `api_keys`, `subscriptions`, `subscription_invoices`, `store_payment_accounts` | Asociación directa al admin |
| `user_id` | `agent_conversations`, `push_subscriptions` | Asociación al usuario |

El middleware `adminScope.js` inyecta:
- `req.isSuperAdmin` — boolean, true si el rol es `superadmin`.
- `req.adminId` — `req.user.owner_admin_id ?? req.user.id` (resuelve sub-usuarios al admin dueño).

Los helpers `scopeByCreator`, `scopeByOwner`, `scopeByAdminId`, `scopeByUserId` construyen fragmentos `AND col = $N` parametrizados. El superadmin recibe siempre `{ where: "", params: [] }`.

`assertOwnership` verifica antes de UPDATE/DELETE con una **whitelist** de tablas y columnas (ver `adminScope.js:119-128`), eliminando el riesgo de inyección por interpolación de nombre de tabla.

### 3.3 Tablas de pagos (nuevas)

| Tabla | Propósito |
|---|---|
| `store_payment_accounts` | Credenciales Wompi por tienda (cifradas AES-256-GCM). UNIQUE `(admin_id, provider)`. |
| `sale_payment_transactions` | Log de intentos de cobro. UNIQUE `(reference)` = `sale_number`. |
| `payment_webhook_events` | Registro idempotente de eventos. UNIQUE `(provider, event_id)`. |

### 3.4 Suscripciones

`subscriptions` → vincula admin a un plan. `subscription_plans` define feature flags (`has_wompi_payments`, `has_analytics`, etc.) y límites numéricos (`max_products`, `max_users`, etc.). `subscription_usage` lleva contadores actuales; el cron los sincroniza diariamente.

---

## 4. Ciclo de vida de una request

```
Incoming request
  │
  ├─ X-Request-Id (UUID) — trazabilidad
  ├─ compression (gzip/brotli)
  ├─ helmet (CSP, HSTS, XFO, etc.)
  ├─ CORS — /public-api/* = any origin; /api/* = ALLOWED_ORIGINS
  │
  ├─ [Ruta especial] POST /api/wompi/webhook
  │     └─ express.raw({ type: "application/json" }) — buffer crudo
  │
  ├─ express.json({ limit: REQUEST_LIMIT || "10mb" })
  ├─ express.urlencoded(...)
  ├─ morgan (logs HTTP)
  ├─ Request timeout (REQUEST_TIMEOUT || 30 s) → 503 si se supera
  │
  ├─ Rutas del panel (/api/*)
  │     ├─ auth middleware → JWT verify + DB is_active + owner_admin_id
  │     ├─ adminScope → inyecta req.isSuperAdmin, req.adminId
  │     ├─ requireRole / requireAdmin / requireManager / requireSuperAdmin
  │     ├─ requireFeature("has_...") — feature flag via suscripción
  │     ├─ requireLimit("resource") — límites numéricos del plan
  │     └─ controller → db queries → response
  │
  ├─ Rutas storefront (/public-api/v1/*)
  │     ├─ apiKeyAuth → SHA-256(key) + DB lookup + origin check
  │     └─ controller → db queries (filtrado por req.tenant.admin_id) → response
  │
  ├─ 404 handler — { success: false, message: "Ruta no encontrada..." }
  └─ Error handler global — 500 con stack en dev, mensaje genérico en prod
```

**Carga de rutas con `safeRequire`:** Cada módulo de rutas se carga dentro de un `try/catch`. Si un módulo falla al cargar (ej. error de sintaxis o dependencia faltante), el servidor **arranca igualmente** y esas rutas retornan 404 en lugar de bloquear el arranque. Los errores de carga se logean en consola.

---

## 5. Análisis de la integración Wompi

### 5.1 Checkout session (`GET /api/wompi/session/:sale_id`)

- El monto **siempre viene de la DB** (`sales.total`), nunca del cliente. ✅
- Se verifica ownership antes de construir la sesión (superadmin / manager / customer). ✅
- Se bloquea con 400 si `payment_status` es `paid` o `cancelled`. ✅
- `buildCheckoutSession` lanza error 402 si la tienda no tiene cuenta de pago conectada. ✅
- La firma de integridad se calcula correctamente: `SHA-256(reference + amount_in_cents + currency + integrity_secret)`. ✅
- El intent de pago se registra en `sale_payment_transactions` con `ON CONFLICT DO NOTHING` (idempotente). ✅

### 5.2 Webhook (`POST /api/wompi/webhook`)

**Recepción:**
- `express.raw()` registrado antes que `express.json()` en `app.js:57-60` — el body llega como `Buffer`. ✅
- El controller verifica `Buffer.isBuffer(rawBody)` antes de procesarlo. ✅
- El controller siempre responde `200` a Wompi, incluso en errores internos. ✅

**Validación de firma:**
- `wompiValidateWebhookSignature` reconstruye `SHA-256(values[signature.properties] + timestamp + events_secret)` y lo compara con `signature.checksum`. ✅
- `crypto.timingSafeEqual` con verificación previa de longitud de buffers (evita crash por buffers desiguales). ✅
- El `events_secret` se obtiene de la cuenta del tenant, no de variables de entorno globales. ✅
- Si la referencia no existe en DB, `sig_valid = null` (no puede validarse); el evento se guarda pero no se procesa. ✅

**Idempotencia:**
- `ON CONFLICT (provider, event_id) DO UPDATE SET updated_at = now() RETURNING id, processed` — permite reintentar eventos que fallaron a mitad (crash recovery). ✅
- Si `processed = true`, retorna sin processar. ✅
- Dentro de la transacción: `SELECT ... FOR UPDATE` sobre el evento — serializa re-entregas concurrentes (solo una gana el lock, las demás ven `processed = true`). ✅
- Check adicional `sale.payment_status === 'paid'` en caso de evento duplicado con referencia diferente. ✅

**Actualización de estado:**
- `sale_payments` INSERT (método `gateway`). ✅
- Recalcula `amount_paid` desde la suma real de `sale_payments` — soporta pagos parciales combinados con gateway. ✅
- Actualiza `sales.payment_status` a `pending` / `partial` / `paid` según la suma. ✅
- Side effects (email, push, socket) corren fuera de la transacción DB, envueltos en try/catch. ✅

**Punto de atención — ruta de verificación de credenciales (`verifyWompiCredentials`):**
```js
// services/payment.service.js:152
await wompiGet(`/merchants/${encodeURIComponent(privateKey)}`, environment, privateKey);
```
La private key aparece tanto en la URL path como en el header `Authorization: Bearer`. La API de Wompi para verificar credenciales usa el endpoint `/merchants` (no lleva la key en el path). Si Wompi cambia la ruta de validación, esta llamada retornaría 404 pero el servicio retornaría `false` (no crash). **Sin impacto funcional en el flujo de pagos** — solo afecta la validación manual de credenciales.

### 5.3 Verificación de estado (`GET /api/wompi/verify/:reference`)

- Ownership check idéntico al de `getSession`. ✅
- `customer_id` y `owner_admin_id` se eliminan de la respuesta antes de enviarla. ✅

---

## 6. Hallazgos priorizados

### F-1 · MEDIUM — `PAYMENTS_ENCRYPTION_KEY` no validada al arrancar

| | |
|---|---|
| **Archivo** | `config/env.js:1-8` |
| **Riesgo** | El proceso arranca sin la clave. El primer intento de pago lanza una excepción en `utils/crypto.js:13`, retorna 500 al usuario y queda sin log estructurado (el error aparece solo en el try/catch del controller). |
| **Fix** | Agregar `'PAYMENTS_ENCRYPTION_KEY'` al array `REQUIRED` en `env.js`. Opcionalmente validar que el buffer resultante sea de 32 bytes en el propio `env.js`. |

### F-2 · MEDIUM — `BREVO_API_KEY` no validada al arrancar

| | |
|---|---|
| **Archivo** | `config/env.js:1-8`, `config/emailConfig.js:380-389` |
| **Riesgo** | El servidor arranca aunque Brevo no esté configurado. Los emails simplemente no se envían y los errores quedan en consola. No hay falla explicita al cliente ni alerta de operaciones. |
| **Fix** | Agregar `'BREVO_API_KEY'` a la sección de advertencias de producción en `env.js`, o al array `REQUIRED` si el email es obligatorio para el flujo (verificación de cuenta requiere email). |

### F-3 · MEDIUM — `requireFeature` usa `req.user.id` en lugar del adminId resuelto

| | |
|---|---|
| **Archivo** | `middleware/subscription.middleware.js:66` |
| **Descripción** | `requireFeature` y `requireLimit` derivan el adminId con `req.user?.id`. Para un sub-usuario (gerente, cajero), `req.user.id` es el ID del sub-usuario — no el del admin dueño. La suscripción está vinculada al admin, no al sub-usuario. Por tanto `getSubscriptionData(subUserId)` retorna `null` → 403 "Sin suscripción activa" para cualquier sub-usuario que intente acceder a rutas con feature flag. |
| **Riesgo** | Funcionalidad bloqueada para sub-usuarios en rutas con `requireFeature`. En la práctica, muchas rutas de features también exigen `requireAdmin` (bloquea sub-usuarios antes), pero rutas con `requireManager` + `requireFeature` son afectadas. |
| **Fix** | Cambiar la resolución del adminId: `const adminId = req.user?.owner_admin_id ?? req.user?.id;` |

### F-4 · LOW — Código de depuración en producción (`emailConfig.js`)

| | |
|---|---|
| **Archivo** | `config/emailConfig.js:20`, `config/emailConfig.js:37-40`, `config/emailConfig.js:385` |
| **Descripción** | Tres `console.log` con datos sensibles o de debug: (1) volcado de todas las keys de exports del módulo Brevo en cada init; (2) los primeros 8 caracteres del `BREVO_API_KEY` impreso en cada init de cliente; (3) el mismo prefijo de key en `verifyEmailConfig()` al arrancar. |
| **Riesgo** | En un entorno con log aggregation (Datadog, CloudWatch, etc.) los primeros caracteres de la API key aparecen en los logs. No es explotable directamente, pero viola la política de no loguear secretos. El volcado de keys del módulo agrega ruido en logs de producción. |
| **Fix** | Eliminar las líneas 20 y 37-40. Cambiar la línea 385 a solo `console.log('✅ Brevo configurada')` sin exponer ningún fragmento de key. |

### F-5 · LOW — Número de WhatsApp hardcodeado en templates de email

| | |
|---|---|
| **Archivos** | `config/emailConfig.js:226`, `config/emailConfig.js:348` |
| **Descripción** | El número `573145055073` aparece en dos templates HTML (`sendOrderConfirmationEmail` y `sendPaymentConfirmedEmail`). Cada tienda envía emails con el WhatsApp del operador de la plataforma, no el de la propia tienda. |
| **Riesgo** | Operativo — al escalar a múltiples tenants, todos los clientes son dirigidos al mismo número. No es un riesgo de seguridad pero impacta la multi-tenancia. |
| **Fix** | Mover el número a una variable de entorno (`WHATSAPP_CONTACT`) o mejor aún, tomarlo del perfil del admin cuando se genera el email. |

### F-6 · LOW — Rate limiting en memoria (no escala horizontalmente)

| | |
|---|---|
| **Archivo** | `middleware/auth.middleware.js:237-274` |
| **Descripción** | `_rateLimitStore` es un objeto JavaScript en el heap del proceso. Se pierde en cada reinicio y no se comparte entre instancias (si el app corre en múltiples pods/procesos). |
| **Riesgo** | En despliegue con más de una instancia (PM2 cluster, Kubernetes, etc.), un atacante puede distribuir intentos entre instancias y eludir el límite. |
| **Fix** | En instancia única, el comportamiento es correcto. Si se escala horizontalmente, migrar a Redis o un middleware de rate limiting distribuido (p.ej. `express-rate-limit` con `ioredis`). |

### F-7 · LOW — `safeRequire` oculta errores de carga de rutas

| | |
|---|---|
| **Archivo** | `app.js:80-90` |
| **Descripción** | Si un módulo de rutas lanza excepción al cargar (error de sintaxis, dependencia faltante, etc.), `safeRequire` imprime el error en consola pero el servidor arranca y esas rutas quedan inactivas (404). En producción, los errores de consola pueden perderse. |
| **Riesgo** | Una ruta rota puede pasar desapercibida en producción hasta que un usuario reporta 404. |
| **Fix** | En producción, convertir las cargas fallidas en errores fatales: `if (isProd && !criticalRoute) { console.error(...); process.exit(1); }`. O instrumentar con métricas/alertas sobre el endpoint `/api/health`. |

### F-8 · INFO — Graceful shutdown no drena conexiones en vuelo

| | |
|---|---|
| **Archivo** | `server.js:21-29` |
| **Descripción** | `server.close()` deja de aceptar nuevas conexiones pero el callback se ejecuta solo cuando **todas** las conexiones keep-alive cierran, lo cual en Express 5 con keep-alive puede no ocurrir nunca si hay clientes idle. El `setTimeout(process.exit(1), 10000)` fuerza la salida después de 10 s, potencialmente cortando transacciones en vuelo. |
| **Riesgo** | Pérdida de datos bajo despliegue con tráfico activo (poco probable, pero posible). |
| **Fix** | Usar `server.closeAllConnections()` (disponible en Node.js 18.2+) antes de `server.close()`, o el paquete `http-graceful-shutdown`. |

### F-9 · INFO — Sender de email hardcodeado al dueño de la plataforma

| | |
|---|---|
| **Archivo** | `config/emailConfig.js:3-6` |
| **Descripción** | El remitente se configura mediante `BREVO_SENDER_EMAIL` o `EMAIL_FROM`; ya no existe un correo personal hardcodeado como respaldo. |
| **Riesgo** | Operativo y de marca — los clientes de diferentes tiendas ven el mismo remitente. No es un riesgo de seguridad. |

---

## 7. Convenciones detectadas

### Respuestas HTTP
Todas las respuestas siguen el patrón `{ success: boolean, message?: string, data?: any }`. **Excepción:** `controllers/payments.controller.js` usa `{ message: "..." }` sin el campo `success` — inconsistencia con el resto del sistema.

### Autenticación y alcance
- `auth` → decodifica JWT y valida usuario activo en DB.
- `adminScope` → resuelve `req.isSuperAdmin` y `req.adminId`.
- `requireAdmin` / `requireManager` → verifican rol.
- `requireFeature(flag)` → verifica feature flag del plan.
- `requireLimit(resource)` → verifica límites numéricos del plan.
- Orden estándar de guard en rutas del panel: `[auth, adminScope, requireAdmin/Manager, requireFeature?, requireLimit?]`.

### Queries SQL
- Siempre parametrizadas (`$1, $2, ...`), nunca concatenadas.
- Transacciones explícitas (`BEGIN / COMMIT / ROLLBACK`) para operaciones que tocan múltiples tablas.
- `scopeByOwner` / `scopeByCreator` para inyectar el filtro de tenant de forma consistente.
- `assertOwnership` antes de UPDATE/DELETE de recursos ajenos.
- `buildUpdate` para SET dinámico con whitelist de campos.

### Manejo de errores
- `try/catch` con `console.error("[module] operation:", err.message)` y `res.status(500).json(...)`.
- Side effects (email, push, socket) en bloques `try/catch` propios para no contaminar la respuesta principal.
- `processWompiWebhook` **nunca lanza** — siempre retorna `{ processed, reason }`.

### Soft delete
Recursos desactivables usan `is_active = false` en lugar de DELETE físico.

### Cloudinary
Los `public_id` se extraen del URL para poder eliminar imágenes al actualizar recursos.

### Cifrado
- Contraseñas: `bcryptjs` con `SALT_ROUNDS = 12`.
- API Keys: `SHA-256` del raw key (one-way, `utils/hash.js`).
- Secretos de pasarela: AES-256-GCM, `utils/crypto.js` (reversible, layout `[12 IV][16 tag][ciphertext]` base64).

---

## 8. Recomendaciones

### R-1 · Completar validación de entorno (aborda F-1 y F-2)
Agregar `PAYMENTS_ENCRYPTION_KEY` y `BREVO_API_KEY` al array `REQUIRED` de `config/env.js`. El proceso debe fallar al arrancar si estas variables no están presentes, antes de aceptar cualquier request.

### R-2 · Corregir resolución de adminId en subscription middleware (aborda F-3)
En `subscription.middleware.js:66`, cambiar:
```js
// Antes
const adminId = req.user?.id;
// Después
const adminId = req.user?.owner_admin_id ?? req.user?.id;
```
Esto alinea el middleware con la convención ya establecida en `adminScope.js` y en los propios controllers.

### R-3 · Eliminar logs de depuración (aborda F-4)
Remover las líneas 20 y 37-40 de `emailConfig.js`. Simplificar la línea 385 para no exponer fragmentos de key.

### R-4 · Externalizar número de WhatsApp (aborda F-5)
Mover `573145055073` a `process.env.WHATSAPP_CONTACT`. A largo plazo, considerar un campo de contacto en el perfil del admin para multi-tenancia real del remitente.

### R-5 · Estrategia de rotación de `PAYMENTS_ENCRYPTION_KEY`
`utils/crypto.js` no soporta rotación de clave. Si la clave se compromete, no hay forma de re-cifrar las credenciales existentes sin bajarlas a texto plano. Considerar un esquema con `key_version` en la columna cifrada para soportar rotación gradual.

### R-6 · Verificar endpoint de Wompi para validación de credenciales (aborda §5.2)
Confirmar con la documentación oficial de Wompi si el endpoint correcto para verificar una clave privada es `GET /merchants/{privateKey}` o simplemente `GET /merchants` con auth Bearer. Si el segundo, corregir la llamada en `services/payment.service.js:152`.

### R-7 · Alertas sobre firmas de webhook inválidas
Actualmente `wompiValidateWebhookSignature` retorna `false` en silencio. Considerar emitir un log estructurado (o métrica) cuando `sigValid === false` y la referencia sí existe, ya que podría indicar intentos de spoofing o una rotación de `events_secret` sin actualizar la cuenta.

### R-8 · Considerar Redis para rate limiting si se escala (aborda F-6)
No es urgente mientras el servidor corre en una sola instancia, pero documentarlo como prerequisito antes de escalar horizontalmente.

### R-9 · Normalizar formato de respuesta en `payments.controller.js`
`controllers/payments.controller.js` retorna `{ message: "..." }` sin `success`. Alinearlo con el patrón `{ success: true/false, message, data }` del resto del sistema para que el frontend pueda tratarlo de forma uniforme.

### R-10 · Drenado de conexiones en shutdown (aborda F-8)
En Node.js 18.2+:
```js
server.close(() => { ... });
server.closeAllConnections(); // cierra keep-alive antes del timeout
```
Esto garantiza que el callback de `server.close()` se ejecuta en tiempo razonable durante deploys.

---

*Fin del informe.*
