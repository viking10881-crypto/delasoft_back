// services/notification.worker.js
'use strict';

const cron                        = require('node-cron');
const notificationService         = require('./notification.service');
const db                          = require('../config/db');
const { sendCreditReminderEmail } = require('../config/emailConfig');
const { getAdminBranding }        = require('./branding.service');

// ── Recordatorios de cuotas de crédito ───────────────────────────────────────

async function checkCreditInstallments() {
  const today    = new Date().toISOString().slice(0, 10);
  const cutoff   = new Date(); cutoff.setDate(cutoff.getDate() + 2);
  const upcoming = cutoff.toISOString().slice(0, 10);

  // Fase 1: reclamar filas con FOR UPDATE SKIP LOCKED + marcar ANTES de enviar.
  // Garantiza que dos instancias concurrentes (deploy, restart) no procesen
  // la misma cuota, y que un crash post-envío no reenvíe al día siguiente.
  const client = await db.connect();
  let rows = [];

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT
         cps.id, cps.sale_id, cps.owner_admin_id, cps.installment_num,
         cps.due_date, cps.expected_amount,
         s.sale_number,
         u.name  AS customer_name,
         u.email AS customer_email,
         (SELECT COUNT(*) FROM credit_payment_schedule WHERE sale_id = cps.sale_id) AS total_installments
       FROM credit_payment_schedule cps
       JOIN sales s ON s.id = cps.sale_id
       JOIN users u ON u.id = s.customer_id
       WHERE cps.status = 'pending'
         AND (
           (cps.due_date <= $1 AND cps.overdue_notified_at  IS NULL)
           OR (cps.due_date = $2  AND cps.due_notified_at   IS NULL)
           OR (cps.due_date BETWEEN $2 AND $3 AND cps.upcoming_notified_at IS NULL)
         )
       FOR UPDATE OF cps SKIP LOCKED`,
      [today, today, upcoming]
    );

    rows = result.rows;

    for (const inst of rows) {
      const due    = String(inst.due_date).slice(0, 10);
      const column = due < today    ? 'overdue_notified_at'
                   : due === today  ? 'due_notified_at'
                   :                  'upcoming_notified_at';

      await client.query(
        `UPDATE credit_payment_schedule SET ${column} = NOW() WHERE id = $1`,
        [inst.id]
      );

      // Anotar en el objeto para usarlo en la fase de envío
      inst._due    = due;
      inst._column = column;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (!rows.length) return;

  console.log(`[CreditReminderWorker] Procesando ${rows.length} cuota(s)...`);

  // Fase 2: enviar notificaciones FUERA de la transacción — las filas ya están
  // reclamadas. Un fallo de email no genera reenvío porque la marca ya se hizo.
  for (const inst of rows) {
    const due         = inst._due;
    const isOverdue   = due < today;
    const isDue       = due === today;
    const type        = isOverdue ? 'overdue' : isDue ? 'due' : 'upcoming';
    const templateKey = `credit_${type}`;
    const daysOverdue = isOverdue
      ? Math.round((new Date(today) - new Date(due)) / 86400000)
      : 0;

    const fmtAmt  = Number(inst.expected_amount).toLocaleString('es-CO', { maximumFractionDigits: 0 });
    const fmtDate = new Date(inst.due_date).toLocaleDateString('es-CO', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota',
    });

    const payload = {
      customer_name:      inst.customer_name,
      amount:             fmtAmt,
      due_date:           fmtDate,
      installment_num:    inst.installment_num,
      total_installments: inst.total_installments,
      sale_number:        inst.sale_number,
      days_overdue:       daysOverdue,
    };

    let branding = null;
    try { branding = await getAdminBranding(inst.owner_admin_id); } catch {}

    if (inst.customer_email) {
      try {
        await sendCreditReminderEmail(
          inst.customer_email,
          inst.customer_name,
          {
            saleNumber:        inst.sale_number,
            installmentNum:    inst.installment_num,
            totalInstallments: Number(inst.total_installments),
            amount:            inst.expected_amount,
            dueDate:           inst.due_date,
            daysOverdue,
          },
          type,
          branding
        );
      } catch (err) {
        console.error(`[CreditReminderWorker] Email falló para cuota ${inst.id}:`, err.message);
      }
    }

    try {
      await notificationService.enqueueNotification({
        ownerAdminId:    inst.owner_admin_id,
        recipientUserId: null,
        event:           'credit_reminder',
        channel:         'whatsapp',
        payload,
        templateKey,
        referenceType:   'credit_payment_schedule',
        referenceId:     inst.id,
        jobId:           `credit-reminder-${inst.id}-${type}-${today}`,
      });
    } catch (err) {
      console.error(`[CreditReminderWorker] WhatsApp falló para cuota ${inst.id}:`, err.message);
    }
  }

  console.log(`[CreditReminderWorker] ✅ ${rows.length} cuota(s) notificada(s)`);
}

// ── Inicio del worker ─────────────────────────────────────────────────────────

function startNotificationWorker() {
  // Cola de notificaciones salientes — cada 30 segundos
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { processed } = await notificationService.processQueueBatch(20);
      if (processed > 0) {
        console.log(`[NotificationWorker] ${processed} notificación(es) procesada(s)`);
      }
    } catch (err) {
      console.error('[NotificationWorker] Error:', err.message);
    }
  });

  // Recordatorios diarios de cuotas de crédito — 8am hora Colombia
  cron.schedule('0 8 * * *', async () => {
    try {
      await checkCreditInstallments();
    } catch (err) {
      console.error('[CreditReminderWorker] Error:', err.message);
    }
  }, { timezone: 'America/Bogota' });

  console.log('[NotificationWorker] ✅ Worker de notificaciones registrado (cada 30s)');
  console.log('[CreditReminderWorker] ✅ Recordatorios de cuotas registrado (08:00 Bogotá)');
}

module.exports = { startNotificationWorker };