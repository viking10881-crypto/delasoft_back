// controllers/contact.controller.js
const db   = require("../config/db");
const { getBrevoClient } = require("../config/emailConfig");   // reusa tu helper existente

// ── POST /api/contact  (público — sin auth) ──────────────────────────────────
exports.submit = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: "Nombre, email y mensaje son requeridos." });
    }

    const { rows } = await db.query(
      `INSERT INTO contact_messages (name, email, subject, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [name.trim(), email.trim().toLowerCase(), subject?.trim() || null, message.trim()]
    );

    // Notificar al admin por email (opcional — no bloquea la respuesta)
    notifyAdmin({ name, email, subject, message, id: rows[0].id }).catch(e =>
      console.warn("[Contact] Error notificando admin:", e.message)
    );

    return res.status(201).json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error("[contact.controller] submit:", err.message);
    return res.status(500).json({ success: false, message: "Error al enviar el mensaje." });
  }
};

// ── GET /api/contact  (admin) ────────────────────────────────────────────────
exports.list = async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const values     = [];

    if (status && ["unread", "read", "replied"].includes(status)) {
      conditions.push(`cm.status = $${values.length + 1}`);
      values.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await db.query(
      `SELECT cm.id, cm.name, cm.email, cm.subject, cm.message,
              cm.status, cm.reply, cm.replied_at, cm.created_at,
              u.name AS replied_by_name
       FROM contact_messages cm
       LEFT JOIN users u ON u.id = cm.replied_by
       ${where}
       ORDER BY cm.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, parseInt(limit), offset]
    );

    const { rows: total } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'unread')  AS unread,
         COUNT(*) FILTER (WHERE status = 'read')    AS read,
         COUNT(*) FILTER (WHERE status = 'replied') AS replied,
         COUNT(*)                                   AS total
       FROM contact_messages`
    );

    return res.json({ messages: rows, counts: total[0] });
  } catch (err) {
    console.error("[contact.controller] list:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/contact/:id/read  (admin) ─────────────────────────────────────
exports.markRead = async (req, res) => {
  try {
    await db.query(
      `UPDATE contact_messages
       SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END
       WHERE id = $1`,
      [req.params.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("[contact.controller] markRead:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/contact/:id/reply  (admin) ─────────────────────────────────────
exports.reply = async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply?.trim()) {
      return res.status(400).json({ success: false, message: "La respuesta no puede estar vacía." });
    }

    // Obtener el mensaje original
    const { rows } = await db.query(
      `SELECT * FROM contact_messages WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: "Mensaje no encontrado." });

    const msg = rows[0];

    // Enviar email de respuesta
    await sendReplyEmail({ to: msg.email, name: msg.name, subject: msg.subject, originalMessage: msg.message, reply });

    // Actualizar en BD
    await db.query(
      `UPDATE contact_messages
       SET status = 'replied', reply = $1, replied_at = NOW(), replied_by = $2
       WHERE id = $3`,
      [reply.trim(), req.user.id, req.params.id]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[contact.controller] reply:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/contact/:id  (admin) ─────────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    await db.query(`DELETE FROM contact_messages WHERE id = $1`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error("[contact.controller] remove:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── Helpers de email ──────────────────────────────────────────────────────────
async function sendReplyEmail({ to, name, subject, originalMessage, reply }) {
  if (!process.env.BREVO_API_KEY) {
    console.warn("[Contact] BREVO_API_KEY no configurada — email de respuesta omitido");
    return;
  }

  const brevo         = require("@getbrevo/brevo");
  const apiInstance   = new brevo.TransactionalEmailsApi();
  const SendSmtpEmail = brevo.SendSmtpEmail;

  apiInstance.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  const mail          = new SendSmtpEmail();
  mail.sender         = { name: "Delasoft", email: process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM };
  mail.to             = [{ email: to, name }];
  mail.subject        = `Re: ${subject || "Tu mensaje a Delasoft"}`;
  mail.htmlContent    = `
    <div style="font-family:sans-serif;max-width:600px;color:#0f172a">
      <h2 style="font-size:20px;margin-bottom:4px">Hola ${name} 👋</h2>
      <p style="color:#64748b;margin-top:0">Hemos respondido a tu mensaje.</p>
      <div style="background:#f8fafc;border-left:3px solid #3b82f6;padding:16px;border-radius:8px;margin:20px 0">
        <p style="margin:0;font-size:14px;color:#475569"><strong>Tu mensaje:</strong></p>
        <p style="margin:8px 0 0;font-size:14px;color:#64748b;font-style:italic">${originalMessage}</p>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;padding:20px;border-radius:12px">
        <p style="margin:0;font-size:14px;color:#475569"><strong>Nuestra respuesta:</strong></p>
        <p style="margin:12px 0 0;font-size:15px;color:#0f172a;line-height:1.7">${reply.replace(/\n/g, "<br>")}</p>
      </div>
      <p style="margin-top:24px;font-size:13px;color:#94a3b8">
        Este correo fue enviado desde Delasoft${process.env.PUBLIC_SITE_URL ? ` · <a href="${process.env.PUBLIC_SITE_URL}" style="color:#3b82f6">Sitio web</a>` : ''}
      </p>
    </div>`;

  await apiInstance.sendTransacEmail(mail);
}

async function notifyAdmin({ id, name, email, subject, message }) {
  if (!process.env.ADMIN_EMAIL || !process.env.BREVO_API_KEY) return;

  const brevo         = require("@getbrevo/brevo");
  const apiInstance   = new brevo.TransactionalEmailsApi();
  const SendSmtpEmail = brevo.SendSmtpEmail;

  apiInstance.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  const mail       = new SendSmtpEmail();
  mail.sender      = { name: "Delasoft ERP", email: process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM };
  mail.to          = [{ email: process.env.ADMIN_EMAIL }];
  mail.subject     = `📬 Nuevo mensaje de contacto — ${name}`;
  mail.htmlContent = `
    <div style="font-family:sans-serif;max-width:600px">
      <h2>Nuevo mensaje de contacto #${id}</h2>
      <p><strong>De:</strong> ${name} &lt;${email}&gt;</p>
      <p><strong>Asunto:</strong> ${subject || "Sin asunto"}</p>
      <div style="background:#f8fafc;padding:16px;border-radius:8px;margin-top:16px">
        <p style="margin:0;white-space:pre-wrap;font-size:14px">${message}</p>
      </div>
      <p style="margin-top:20px">
        <a href="${process.env.ADMIN_URL || process.env.FRONTEND_URL || "http://localhost:5173"}/tools/contact-messages"
           style="background:#0f172a;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px">
          Responder en el panel →
        </a>
      </p>
    </div>`;

  await apiInstance.sendTransacEmail(mail);
}
