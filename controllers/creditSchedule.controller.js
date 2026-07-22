'use strict';
// controllers/creditSchedule.controller.js

const db = require('../config/db');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function syncPaymentStatus(client, saleId) {
  const { rows: [{ paid }] } = await client.query(
    'SELECT COALESCE(SUM(amount), 0) AS paid FROM sale_payments WHERE sale_id = $1',
    [saleId]
  );
  const { rows: [sale] } = await client.query(
    'SELECT total FROM sales WHERE id = $1 FOR UPDATE', [saleId]
  );
  if (!sale) throw new Error(`Venta ${saleId} no encontrada al sincronizar`);
  const total  = Number(sale.total);
  const paidN  = Number(paid);
  const status = paidN <= 0 ? 'pending' : paidN < total ? 'partial' : 'paid';
  await client.query(
    'UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3',
    [paidN, status, saleId]
  );
  return { paid: paidN, status };
}

// Verify sale belongs to tenant + is a fiado sale
async function checkSaleAccess(saleId, ownerAdminId) {
  const { rows: [sale] } = await db.query(
    `SELECT id, payment_method, total, amount_paid FROM sales WHERE id = $1 AND owner_admin_id = $2`,
    [saleId, ownerAdminId]
  );
  return sale ?? null;
}

// ── GET /sales/:id/payment-schedule ──────────────────────────────────────────
exports.getSchedule = async (req, res) => {
  const { id: saleId } = req.params;
  const ownerAdminId   = req.adminId;
  try {
    const { rows } = await db.query(
      `SELECT cps.*
       FROM credit_payment_schedule cps
       WHERE cps.sale_id = $1 AND cps.owner_admin_id = $2
       ORDER BY cps.installment_num`,
      [saleId, ownerAdminId]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[CreditSchedule] getSchedule error:', err.message);
    res.status(500).json({ message: 'Error al obtener cronograma' });
  }
};

// ── POST /sales/:id/payment-schedule ─────────────────────────────────────────
// Body: { installments: [{due_date, expected_amount}] }
// Idempotent: deletes pending installments then recreates
exports.setSchedule = async (req, res) => {
  const { id: saleId }   = req.params;
  const ownerAdminId     = req.adminId;
  const { installments } = req.body;

  if (!Array.isArray(installments) || installments.length === 0)
    return res.status(400).json({ message: 'installments es requerido y debe tener al menos 1 elemento' });

  for (const [i, inst] of installments.entries()) {
    if (!inst.due_date || !inst.expected_amount)
      return res.status(400).json({ message: `Cuota ${i + 1}: falta due_date o expected_amount` });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const sale = await checkSaleAccess(saleId, ownerAdminId);
    if (!sale) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Venta no encontrada' });
    }

    // Validate sum of new installments matches remaining balance
    const remaining = Number(sale.total) - Number(sale.amount_paid || 0);
    const newSum    = installments.reduce((s, i) => s + Number(i.expected_amount), 0);
    if (Math.abs(newSum - remaining) > 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `La suma de cuotas ($${newSum.toLocaleString('es-CO')}) no coincide con el saldo pendiente ($${remaining.toLocaleString('es-CO')})`,
      });
    }

    // Delete only pending installments (preserve paid ones)
    await client.query(
      `DELETE FROM credit_payment_schedule WHERE sale_id = $1 AND status = 'pending'`,
      [saleId]
    );

    // Re-number keeping paid ones: start installment_num after last paid
    const { rows: paidRows } = await client.query(
      `SELECT MAX(installment_num) AS max_num FROM credit_payment_schedule WHERE sale_id = $1 AND status = 'paid'`,
      [saleId]
    );
    const startNum = (Number(paidRows[0].max_num) || 0) + 1;

    for (let i = 0; i < installments.length; i++) {
      const inst = installments[i];
      await client.query(
        `INSERT INTO credit_payment_schedule
           (sale_id, owner_admin_id, installment_num, due_date, expected_amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [saleId, ownerAdminId, startNum + i, inst.due_date, Number(inst.expected_amount)]
      );
    }

    // Keep credit_due_date = last installment date
    const lastDate = installments[installments.length - 1].due_date;
    await client.query(
      `UPDATE sales SET credit_due_date = $1 WHERE id = $2`,
      [lastDate, saleId]
    );

    await client.query('COMMIT');

    const { rows } = await db.query(
      `SELECT * FROM credit_payment_schedule WHERE sale_id = $1 ORDER BY installment_num`,
      [saleId]
    );
    res.status(201).json({ data: rows, message: 'Cronograma guardado ✓' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CreditSchedule] setSchedule error:', err.message);
    res.status(500).json({ message: 'Error al guardar cronograma' });
  } finally {
    client.release();
  }
};

// ── PATCH /sales/:id/payment-schedule/:installmentId/pay ─────────────────────
// Marks one pending installment as paid, creates a sale_payment record
exports.payInstallment = async (req, res) => {
  const { id: saleId, installmentId } = req.params;
  const ownerAdminId  = req.adminId;
  const { payment_method = 'cash', notes, payment_date } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [inst] } = await client.query(
      `SELECT * FROM credit_payment_schedule
       WHERE id = $1 AND sale_id = $2 AND owner_admin_id = $3`,
      [installmentId, saleId, ownerAdminId]
    );
    if (!inst) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cuota no encontrada' });
    }
    if (inst.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'La cuota ya fue pagada o está cancelada' });
    }

    const payDate = payment_date || new Date().toISOString().slice(0, 10);
    const method  = ['cash', 'transfer', 'credit', 'check'].includes(payment_method)
      ? payment_method : 'cash';

    const { rows: [payment] } = await client.query(
      `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, payment_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [saleId, inst.expected_amount, method,
       notes || `Cuota ${inst.installment_num} del cronograma`,
       payDate, req.user.id]
    );

    await client.query(
      `UPDATE credit_payment_schedule
       SET status = 'paid', paid_at = NOW(), sale_payment_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [payment.id, installmentId]
    );

    const { paid, status } = await syncPaymentStatus(client, saleId);

    await client.query('COMMIT');

    res.json({
      message:        'Cuota pagada ✓',
      payment_status: status,
      amount_paid:    paid,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CreditSchedule] payInstallment error:', err.message);
    res.status(500).json({ message: 'Error al pagar cuota' });
  } finally {
    client.release();
  }
};

// ── PATCH /sales/:id/payment-schedule/:installmentId/reschedule ──────────────
// Changes the due_date of a pending installment, resets notification flags
exports.rescheduleInstallment = async (req, res) => {
  const { id: saleId, installmentId } = req.params;
  const ownerAdminId  = req.adminId;
  const { new_due_date } = req.body;

  if (!new_due_date)
    return res.status(400).json({ message: 'new_due_date es requerido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [inst] } = await client.query(
      `SELECT * FROM credit_payment_schedule
       WHERE id = $1 AND sale_id = $2 AND owner_admin_id = $3 AND status = 'pending'
       FOR UPDATE`,
      [installmentId, saleId, ownerAdminId]
    );
    if (!inst) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cuota pendiente no encontrada' });
    }

    await client.query(
      `UPDATE credit_payment_schedule
       SET due_date             = $1,
           upcoming_notified_at = NULL,
           due_notified_at      = NULL,
           overdue_notified_at  = NULL,
           updated_at           = NOW()
       WHERE id = $2`,
      [new_due_date, installmentId]
    );

    await client.query(
      `UPDATE sales
       SET credit_due_date = (
         SELECT MAX(due_date) FROM credit_payment_schedule WHERE sale_id = $1
       )
       WHERE id = $1`,
      [saleId]
    );

    await client.query('COMMIT');
    res.json({ message: 'Cuota reagendada ✓' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CreditSchedule] rescheduleInstallment error:', err.message);
    res.status(500).json({ message: 'Error al reagendar cuota' });
  } finally {
    client.release();
  }
};
