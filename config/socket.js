// config/socket.js
const { Server }            = require('socket.io');
const jwt                   = require('jsonwebtoken');
const db                    = require('./db');
const { notifyUser, Payloads } = require('../services/push.service');

let io;

const initSocket = (httpServer) => {
  const allowedOrigins = (
    process.env.CLIENT_URL || process.env.ALLOWED_ORIGINS ||
    'http://localhost:5173,http://localhost:5174'
  ).split(',').map((u) => u.trim());

  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
      },
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout:  60_000,
    pingInterval: 25_000,
  });

  // Autenticación JWT obligatoria + resolución de adminId para rooms de tenant
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('AUTH_REQUIRED'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer:   'delasoft-api',
        audience: 'delasoft-client',
      });
      // owner_admin_id: null = admin raíz, valor = sub-usuario
      const { rows } = await db.query(
        'SELECT owner_admin_id FROM users WHERE id = $1 AND is_active = true',
        [decoded.id]
      );
      if (!rows.length) return next(new Error('USER_NOT_FOUND'));
      socket.user = {
        ...decoded,
        adminId: rows[0].owner_admin_id ?? decoded.id,
      };
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });

  io.on('connection', (socket) => {
    const { id, name, roles, adminId } = socket.user;

    // Sala personal (chat DM)
    socket.join(`user_${id}`);
    // Sala de tenant — recibe todos los data:update de ese admin
    socket.join(`admin_${adminId}`);
    // Superadmin ve actualizaciones de TODOS los tenants
    if (roles?.includes('superadmin')) socket.join('superadmin');

    console.log(`[Socket] ${name} (${id}) admin:${adminId} conectado: ${socket.id}`);

    // ── Mensaje directo — usa identidad del JWT, no del payload del cliente ──
    socket.on('chat:dm', async ({ recipientId, message }) => {
      if (!recipientId || !message?.trim()) return;
      try {
        const result = await db.query(
          `INSERT INTO chat_messages (user_id, user_name, recipient_id, message)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [id, name, recipientId, message.trim()]
        );
        const msg = result.rows[0];
        io.to(`user_${recipientId}`).emit('chat:dm', msg);
        socket.emit('chat:dm', msg);
        // Push para cuando el destinatario está offline o en otra pestaña
        notifyUser(recipientId, Payloads.newChat(name)).catch(() => {});
      } catch (err) {
        console.error('[Chat] Error DM:', err);
        socket.emit('chat:error', { code: 'DM_FAILED', message: 'No se pudo enviar el mensaje' });
      }
    });

    // ── Indicador de escritura ──────────────────────────────────────────────
    socket.on('chat:typing', ({ recipientId, isTyping }) => {
      if (!recipientId) return;
      socket.to(`user_${recipientId}`).emit('chat:typing', { userId: id, isTyping });
    });

    // ── Desconexión ─────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] ${name} desconectado: ${socket.id} — ${reason}`);
    });
  });

  return io;
};

const getIO = () => io;

/**
 * Emite un evento data:update al room del tenant correcto.
 * @param {string} resource  - "products" | "sales" | "providers" | etc.
 * @param {string} action    - "created" | "updated" | "deleted"
 * @param {*}      payload   - datos del registro
 * @param {number|null} adminId - owner_admin_id del tenant (req.adminId)
 */
const emitDataUpdate = (resource, action, payload = null, adminId = null) => {
  if (!io) return;
  const event = { resource, action, payload };
  if (adminId) {
    // Emite al admin dueño + superadmin (quien ve todo)
    io.to(`admin_${adminId}`).to('superadmin').emit('data:update', event);
  } else {
    // Sin tenant (ej. superadmin operando) → solo sala superadmin
    io.to('superadmin').emit('data:update', event);
  }
};

module.exports = { initSocket, getIO, emitDataUpdate };
