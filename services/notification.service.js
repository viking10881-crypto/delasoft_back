// services/notification.service.js
'use strict';

const db = require('../config/db');

function _render(template, payload) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(payload[key] ?? ''));
}

function _isQuietHours(settings) {
  if (!settings.quiet_hours_start || !settings.quiet_hours_end) return false;
  const tz = settings.timezone || 'America/Bogota';
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const [hh, mm] = timeStr.split(':').map(Number);
  const cur = hh * 60 + mm;
  const [sh, sm] = String(settings.quiet_hours_start).split(':').map(Number);
  const [eh, em] = String(settings.quiet_hours_end).split(':').map(Number);
  const start = sh * 60 + sm;
  const end   = eh * 60 + em;
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

function _nextRunAfterQuiet(settings) {
  const tz = settings.timezone || 'America/Bogota';
  const [eh, em] = String(settings.quiet_hours_end).split(':').map(Number);
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const next = new Date(localNow);
  next.setHours(eh, em, 0, 0);
  if (next <= localNow) next.setDate(next.getDate() + 1);
  return next;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getOrCreateSettings(adminId) {
  const { rows: [existing] } = await db.query(
    `SELECT * FROM notification_settings WHERE admin_id = $1`,
    [adminId]
  );
  if (existing) return existing;

  const { rows: [created] } = await db.query(
    `INSERT INTO notification_settings
       (admin_id, whatsapp_enabled, email_enabled, push_enabled,
        whatsapp_country_code, events_enabled, created_at, updated_at)
     VALUES ($1, false, false, false, '+57', '[]', NOW(), NOW())
     ON CONFLICT (admin_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [adminId]
  );
  return created;
}

/**
 * Enqueues one outbound notification.
 * Respects channel-enabled flags and events_enabled list.
 * Returns the queued row id, or null if skipped.
 */
async function enqueueNotification({
  ownerAdminId, recipientUserId, event, channel,
  payload, templateKey, referenceType, referenceId,
}) {
  const settings = await getOrCreateSettings(ownerAdminId);

  // Check event filter
  const eventsEnabled = Array.isArray(settings.events_enabled)
    ? settings.events_enabled
    : [];
  if (eventsEnabled.length && !eventsEnabled.includes(event)) return null;

  // Check channel enabled
  if (channel === 'whatsapp' && !settings.whatsapp_enabled) return null;
  if (channel === 'email'    && !settings.email_enabled)    return null;
  if (channel === 'push'     && !settings.push_enabled)     return null;

  // Resolve recipient contact
  let recipientPhone = null;
  let recipientEmail = null;

  if (channel === 'whatsapp') {
    if (!settings.whatsapp_phone) return null;
    const code  = String(settings.whatsapp_country_code || '+57').replace(/\D/g, '');
    const local = String(settings.whatsapp_phone).replace(/\D/g, '');
    recipientPhone = local.startsWith(code) ? local : code + local;
  }

  if (channel === 'email' && recipientUserId) {
    const { rows: [u] } = await db.query(
      `SELECT email FROM users WHERE id = $1`, [recipientUserId]
    );
    recipientEmail = u?.email ?? null;
  }

  // Load and render template
  const { rows: [tpl] } = await db.query(
    `SELECT subject_template, body_template
     FROM notification_templates
     WHERE template_key = $1 AND channel = $2 AND is_active = true
     LIMIT 1`,
    [templateKey, channel]
  );

  if (!tpl) {
    console.error(
      `[Notification] Template faltante: key=${templateKey} channel=${channel} ownerAdmin=${ownerAdminId} — notificación cancelada`
    );
    await db.query(
      `INSERT INTO notification_queue
         (owner_admin_id, recipient_user_id, recipient_phone, recipient_email,
          channel, event, template_key, rendered_subject, rendered_message,
          payload, status, attempts, max_attempts, last_error, scheduled_for,
          reference_type, reference_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'failed',0,3,$11,NOW(),$12,$13,NOW(),NOW())`,
      [
        ownerAdminId, recipientUserId ?? null,
        recipientPhone, recipientEmail,
        channel, event, templateKey,
        null, 'NO_TEMPLATE',
        JSON.stringify(payload),
        'Template no encontrado — revisar notification_templates',
        referenceType ?? null, referenceId ?? null,
      ]
    );
    return null;
  }

  const renderedSubject = _render(tpl.subject_template, payload);
  const renderedMessage = _render(tpl.body_template, payload);

  const { rows: [queued] } = await db.query(
    `INSERT INTO notification_queue
       (owner_admin_id, recipient_user_id, recipient_phone, recipient_email,
        channel, event, template_key, rendered_subject, rendered_message,
        payload, status, attempts, max_attempts, scheduled_for,
        reference_type, reference_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',0,3,NOW(),$11,$12,NOW(),NOW())
     RETURNING id`,
    [
      ownerAdminId, recipientUserId ?? null,
      recipientPhone, recipientEmail,
      channel, event, templateKey,
      renderedSubject, renderedMessage,
      JSON.stringify(payload),
      referenceType ?? null, referenceId ?? null,
    ]
  );

  return queued?.id ?? null;
}

/**
 * Picks up to `limit` pending notifications from the queue (SKIP LOCKED),
 * sends them via the appropriate provider, and updates their status.
 * Respects quiet_hours and exponential backoff on failure.
 */
async function processQueueBatch(limit = 20) {
  // Recover jobs stuck in 'sending' after a process crash (reset after 5 min)

  // ✅ Check rápido antes de abrir conexión costosa
  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*) FROM notification_queue 
     WHERE status = 'pending' AND scheduled_for <= NOW()`
  );
  if (Number(count) === 0) return { processed: 0 };

  
  await db.query(
    `UPDATE notification_queue SET status = 'pending', updated_at = NOW()
     WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '5 minutes'`
  );

  const client = await db.connect();
  let jobs;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, channel, owner_admin_id,
              recipient_phone, recipient_email,
              rendered_message, rendered_subject,
              attempts, max_attempts
       FROM notification_queue
       WHERE status = 'pending' AND scheduled_for <= NOW()
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    jobs = rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (!jobs.length) return { processed: 0 };

  const whatsappProvider = require('./providers/whatsapp.provider');
  let processed = 0;

  for (const job of jobs) {
    // Re-check quiet hours per job
    const settings = await getOrCreateSettings(job.owner_admin_id);
    if (_isQuietHours(settings)) {
      const nextRun = _nextRunAfterQuiet(settings);
      await db.query(
        `UPDATE notification_queue
         SET scheduled_for = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'pending'`,
        [nextRun, job.id]
      );
      continue;
    }

    await db.query(
      `UPDATE notification_queue SET status = 'sending', updated_at = NOW() WHERE id = $1`,
      [job.id]
    );

    let success         = false;
    let providerMsgId   = null;
    let lastError       = null;

    try {
      if (job.channel === 'whatsapp' && job.recipient_phone) {
        const result = await whatsappProvider.send(job.recipient_phone, job.rendered_message);
        success       = result.success;
        providerMsgId = result.providerMessageId ?? null;
        lastError     = result.error ?? null;
      }
    } catch (err) {
      lastError = err.message;
    }

    if (success) {
      await db.query(
        `UPDATE notification_queue
         SET status = 'sent', provider_message_id = $1, sent_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [providerMsgId, job.id]
      );
    } else {
      const newAttempts = job.attempts + 1;
      const failed      = newAttempts >= job.max_attempts;
      const newStatus   = failed ? 'failed' : 'pending';
      const backoffMs   = Math.pow(2, newAttempts) * 60_000;
      const nextRun     = failed ? null : new Date(Date.now() + backoffMs);

      await db.query(
        `UPDATE notification_queue
         SET status = $1, attempts = $2, last_error = $3,
             scheduled_for = COALESCE($4, scheduled_for), updated_at = NOW()
         WHERE id = $5`,
        [newStatus, newAttempts, lastError, nextRun, job.id]
      );
    }

    processed++;
  }

  return { processed };
}

module.exports = { enqueueNotification, processQueueBatch, getOrCreateSettings };
