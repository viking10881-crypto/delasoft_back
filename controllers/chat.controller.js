// controllers/chat.controller.js
const db = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const { getIO } = require('../config/socket');

// ── Multer / Cloudinary ───────────────────────────────────────────────────────
const chatStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'chat_images',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    public_id: `chat-${Date.now()}-${file.originalname.split('.')[0]}`,
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  }),
});

const uploadChatImage = multer({
  storage: chatStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype);
    cb(ok ? null : new Error('Tipo de archivo no permitido'), ok);
  },
});

// ── GET /api/chat/users ───────────────────────────────────────────────────────
const getChatUsers = async (req, res) => {
  try {
    // FIX: reemplazamos INNER JOIN con EXISTS para evitar el fallo si el
    // nombre exacto del rol no coincide. Acepta 'admin', 'administrator',
    // 'administrador' (case-insensitive).
    // Si quieres ver todos los roles disponibles, descomenta la query de debug
    // que está abajo y revisa los logs del servidor.

    // ── DEBUG: descomenta esto UNA VEZ para ver los roles en tu DB ──
    // const rolesDebug = await db.query('SELECT id, name FROM roles');
    // console.log('[Chat] Roles en DB:', rolesDebug.rows);
    // ────────────────────────────────────────────────────────────────

    const result = await db.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        (
          SELECT cm.message FROM chat_messages cm
          WHERE (cm.user_id = u.id AND cm.recipient_id = $1)
             OR (cm.user_id = $1 AND cm.recipient_id = u.id)
          ORDER BY cm.created_at DESC LIMIT 1
        ) AS last_message,
        (
          SELECT cm.image_url FROM chat_messages cm
          WHERE (cm.user_id = u.id AND cm.recipient_id = $1)
             OR (cm.user_id = $1 AND cm.recipient_id = u.id)
          ORDER BY cm.created_at DESC LIMIT 1
        ) AS last_message_image,
        (
          SELECT cm.created_at FROM chat_messages cm
          WHERE (cm.user_id = u.id AND cm.recipient_id = $1)
             OR (cm.user_id = $1 AND cm.recipient_id = u.id)
          ORDER BY cm.created_at DESC LIMIT 1
        ) AS last_message_at,
        (
          SELECT COUNT(*) FROM chat_messages cm
          WHERE cm.user_id = u.id
            AND cm.recipient_id = $1
            AND cm.read_at IS NULL
        ) AS unread_count
      FROM users u
      WHERE u.id != $1
        AND u.is_active = true
        AND EXISTS (
          SELECT 1 FROM user_roles ur
          INNER JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = u.id
            AND LOWER(r.name) IN ('admin', 'administrator', 'administrador')
        )
      ORDER BY last_message_at DESC NULLS LAST, u.name
    `, [req.user.id]);

    res.json({ users: result.rows });
  } catch (err) {
    // Log detallado para identificar la causa exacta del 500
    console.error('[Chat] getChatUsers ERROR:', {
      message: err.message,
      code:    err.code,
      detail:  err.detail,
      hint:    err.hint,
    });
    res.status(500).json({ error: 'Error obteniendo usuarios', detail: err.message });
  }
};

// ── GET /api/chat/conversation/:userId ────────────────────────────────────────
const getConversation = async (req, res) => {
  const { userId } = req.params;
  const myId = req.user.id;

  if (!/^\d+$/.test(userId))
    return res.status(400).json({ error: 'userId inválido' });

  try {
    const result = await db.query(`
      SELECT * FROM chat_messages
      WHERE (user_id = $1 AND recipient_id = $2)
         OR (user_id = $2 AND recipient_id = $1)
      ORDER BY created_at ASC
      LIMIT 200
    `, [myId, userId]);

    await db.query(`
      UPDATE chat_messages
      SET read_at = NOW()
      WHERE recipient_id = $1
        AND user_id = $2
        AND read_at IS NULL
    `, [myId, userId]);

    res.json({ messages: result.rows });
  } catch (err) {
    console.error('[Chat] getConversation:', err);
    res.status(500).json({ error: 'Error obteniendo conversación' });
  }
};

// ── PUT /api/chat/message/:id ─────────────────────────────────────────────────
const editMessage = async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const myId = req.user.id;

  if (!message?.trim())
    return res.status(400).json({ error: 'El mensaje no puede estar vacío' });

  try {
    const result = await db.query(`
      UPDATE chat_messages
      SET message = $1, edited_at = NOW()
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `, [message.trim(), id, myId]);

    if (result.rowCount === 0)
      return res.status(403).json({ error: 'No autorizado o mensaje no encontrado' });

    const updatedMsg = result.rows[0];

    const io = getIO();
    if (io) {
      io.to(`user_${updatedMsg.recipient_id}`).emit('chat:message_edited', updatedMsg);
      io.to(`user_${updatedMsg.user_id}`).emit('chat:message_edited', updatedMsg);
    }

    res.json({ message: updatedMsg });
  } catch (err) {
    console.error('[Chat] editMessage:', err);
    res.status(500).json({ error: 'Error editando mensaje' });
  }
};

// ── DELETE /api/chat/message/:id ──────────────────────────────────────────────
const deleteMessage = async (req, res) => {
  const { id } = req.params;
  const myId = req.user.id;

  try {
    const found = await db.query(
      'SELECT * FROM chat_messages WHERE id = $1 AND user_id = $2',
      [id, myId]
    );

    if (found.rowCount === 0)
      return res.status(403).json({ error: 'No autorizado o mensaje no encontrado' });

    const msg = found.rows[0];

    if (msg.image_url) {
      try {
        const publicId = msg.image_url.split('/').slice(-1)[0].split('.')[0];
        await cloudinary.uploader.destroy(`chat_images/${publicId}`);
      } catch (_) { /* no bloquear si falla */ }
    }

    await db.query('DELETE FROM chat_messages WHERE id = $1', [id]);

    const io = getIO();
    if (io) {
      const payload = { id: Number(id), user_id: myId, recipient_id: msg.recipient_id };
      io.to(`user_${msg.recipient_id}`).emit('chat:message_deleted', payload);
      io.to(`user_${myId}`).emit('chat:message_deleted', payload);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Chat] deleteMessage:', err);
    res.status(500).json({ error: 'Error eliminando mensaje' });
  }
};

// ── POST /api/chat/upload-image ───────────────────────────────────────────────
const uploadImage = async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: 'No se recibió imagen' });

    const recipientId = req.body.recipientId || req.body.recipient_id;
    if (!recipientId)
      return res.status(400).json({ error: 'Falta recipientId' });

    const result = await db.query(
      `INSERT INTO chat_messages (user_id, recipient_id, message, image_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, recipientId, '', req.file.path]
    );

    const newMsg = result.rows[0];

    const io = getIO();
    if (io) {
      io.to(`user_${recipientId}`).emit('chat:dm', newMsg);
      io.to(`user_${req.user.id}`).emit('chat:dm', newMsg);
    }

    res.json({ message: newMsg });
  } catch (err) {
    console.error('[Chat] uploadImage:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── DELETE /api/chat/history ──────────────────────────────────────────────────
const clearHistory = async (req, res) => {
  try {
    await db.query('DELETE FROM chat_messages');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error limpiando historial' });
  }
};

module.exports = {
  getChatUsers, getConversation, editMessage, deleteMessage,
  uploadImage, uploadChatImage, clearHistory,
};