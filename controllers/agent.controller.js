// controllers/agent.controller.js
const db = require("../config/db");
const { runAgent } = require("../services/agent.service");

// ── POST /agent/chat ─────────────────────────────────────────────────────────
exports.chat = async (req, res) => {
  try {
    const { messages, conversationId } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: "messages array requerido" });
    }

    const result = await runAgent(messages);

    const convId = await upsertConversation({
      userId:         req.user.id,
      conversationId,
      history:        result.history,
      firstUserMsg:   messages.find(m => m.role === "user")?.content,
    });

    return res.json({
      history:        result.history,
      needsConfirm:   result.needsConfirm   || false,
      pendingAction:  result.pendingAction   || null,
      conversationId: convId,
    });

  // controllers/agent.controller.js — exports.chat
    } catch (err) {
      console.error("[agent.controller] chat:", err.message);

      // Groq rate limit → devolver 429 para que el frontend lo distinga
      if (err.message?.includes("rate_limit_exceeded") || err.status === 429) {
        return res.status(429).json({
          success: false,
          message: "Límite de consultas de IA alcanzado. Intenta en unos minutos.",
        });
      }

      return res.status(500).json({ success: false, message: err.message });
    }
};

// ── POST /agent/confirm ──────────────────────────────────────────────────────
exports.confirmAction = async (req, res) => {
  try {
    const { messages, conversationId, pendingAction } = req.body;

    // Inyectamos el "sí confirmo" + sql pendiente en el historial
    const updated = [
      ...messages,
      { role: "user", content: "sí confirmo" },
    ];

    const result = await runAgent(updated);

    const convId = await upsertConversation({
      userId:         req.user.id,
      conversationId,
      history:        result.history,
      firstUserMsg:   messages.find(m => m.role === "user")?.content,
    });

    return res.json({
      history:        result.history,
      needsConfirm:   false,
      pendingAction:  null,
      conversationId: convId,
    });

  } catch (err) {
    console.error("[agent.controller] confirmAction:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /agent/conversations ─────────────────────────────────────────────────
exports.listConversations = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, preview, updated_at
       FROM agent_conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("[agent.controller] listConversations:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /agent/conversations/:id ─────────────────────────────────────────────
exports.getConversation = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT messages FROM agent_conversations
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: "Conversación no encontrada" });

    // messages se guarda como JSONB o TEXT — parseamos si viene como string
    const messages = typeof rows[0].messages === "string"
      ? JSON.parse(rows[0].messages)
      : rows[0].messages;

    return res.json({ messages });
  } catch (err) {
    console.error("[agent.controller] getConversation:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /agent/conversations/:id ──────────────────────────────────────────
exports.deleteConversation = async (req, res) => {
  try {
    await db.query(
      `DELETE FROM agent_conversations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("[agent.controller] deleteConversation:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function upsertConversation({ userId, conversationId, history, firstUserMsg }) {
  const preview = (firstUserMsg || "Consulta").slice(0, 80);
  const json    = JSON.stringify(history);

  if (conversationId) {
    await db.query(
      `UPDATE agent_conversations
       SET messages = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [json, conversationId, userId]
    );
    return conversationId;
  }

  const { rows } = await db.query(
    `INSERT INTO agent_conversations (user_id, messages, preview, updated_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id`,
    [userId, json, preview]
  );
  return rows[0].id;
}