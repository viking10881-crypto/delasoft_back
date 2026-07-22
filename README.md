# Delasoft Backend

## Variables de entorno

Copia `.env.example` (o crea un archivo `.env`) con las variables siguientes.

### Base de datos
```
NEON_DB_URL=postgresql://user:password@host/dbname?sslmode=require
DB_POOL_MAX=10
NODE_ENV=production
```

### Autenticación / JWT
```
JWT_SECRET=
JWT_REFRESH_SECRET=
```

### Cloudinary (imágenes)
```
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

### Email (Brevo)
```
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
EMAIL_FROM=
ADMIN_EMAIL=
```

### Wompi (pagos en línea)
```
WOMPI_PUBLIC_KEY=
WOMPI_PRIVATE_KEY=
WOMPI_EVENTS_SECRET=
WOMPI_INTEGRITY_SECRET=
PAYMENTS_ENCRYPTION_KEY=
```

### CORS
```
ALLOWED_ORIGINS=http://localhost:5173,https://tudominio.com
FRONTEND_URL=https://tudominio.com
CLIENT_URL=https://tudominio.com
ADMIN_URL=https://tudominio.com
```

### Push Notifications (Web Push / VAPID)
```
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@tudominio.com
```

### WhatsApp — elige UN proveedor

#### Opción A: Meta Cloud API (sin dependencias extra)
```
WHATSAPP_PROVIDER=meta_cloud
META_WA_PHONE_NUMBER_ID=
META_WA_ACCESS_TOKEN=
META_WA_BUSINESS_ACCOUNT_ID=
META_WA_APP_SECRET=
META_WA_VERIFY_TOKEN=
```

#### Opción B: Twilio (requiere `npm install twilio`)
```
WHATSAPP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=+14155238886
```

> `WHATSAPP_PROVIDER` por defecto es `meta_cloud` si no se define.
> El webhook de Meta debe apuntar a `POST /api/notifications/webhook/whatsapp`.
> El `META_WA_VERIFY_TOKEN` se usa para la verificación GET del webhook en Meta.

## Base de datos nueva

El repositorio no incluye una migración base completa del PostgreSQL actual. Consulta
[`NEON_SETUP.md`](NEON_SETUP.md) antes de conectar una cuenta nueva. Las migraciones de
`migrations/` son incrementales y no crean por sí solas todas las tablas.
# delasoft_back
