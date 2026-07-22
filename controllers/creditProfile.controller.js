'use strict';
// controllers/creditProfile.controller.js

const db = require('../config/db');

// GET /users/:id/credit-profile
exports.getCreditProfile = async (req, res) => {
  const { id: customerId } = req.params;
  const ownerAdminId       = req.adminId;

  try {
    // Aggregate credit stats in one query
    const { rows: [p] } = await db.query(
      `SELECT
         COUNT(DISTINCT s.id)::int                                                        AS total_credit_sales,
         COUNT(CASE WHEN cps.status = 'paid' AND cps.paid_at::date <= cps.due_date THEN 1 END)::int AS paid_on_time,
         COUNT(CASE WHEN cps.status = 'paid' AND cps.paid_at::date >  cps.due_date THEN 1 END)::int AS paid_late,
         ROUND(COALESCE(AVG(
           CASE WHEN cps.status = 'paid' AND cps.paid_at::date > cps.due_date
                THEN EXTRACT(EPOCH FROM (cps.paid_at::date - cps.due_date::date)) / 86400
           END
         ), 0), 1)::float                                                                AS avg_days_late,
         COALESCE(SUM(CASE WHEN cps.status = 'pending' THEN cps.expected_amount ELSE 0 END), 0)::numeric AS pending_debt,
         COUNT(CASE WHEN cps.status = 'pending' AND cps.due_date < CURRENT_DATE THEN 1 END)::int          AS overdue_installments
       FROM sales s
       LEFT JOIN credit_payment_schedule cps ON cps.sale_id = s.id
       WHERE s.customer_id    = $1
         AND s.owner_admin_id = $2
         AND s.payment_method = 'credit'
         AND s.credit_due_date IS NOT NULL`,
      [customerId, ownerAdminId]
    );

    const { rows: [lastSale] } = await db.query(
      `SELECT sale_number, total, payment_status, created_at
       FROM sales
       WHERE customer_id = $1 AND owner_admin_id = $2
         AND payment_method = 'credit' AND credit_due_date IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [customerId, ownerAdminId]
    );

    const totalPaid    = p.paid_on_time + p.paid_late;
    const onTimePct    = totalPaid > 0 ? (p.paid_on_time / totalPaid) * 100 : null;

    let reliability_label, reliability_color;
    if (p.total_credit_sales === 0) {
      reliability_label = 'new';     reliability_color = 'gray';
    } else if (p.overdue_installments >= 2 || (onTimePct !== null && onTimePct < 60)) {
      reliability_label = 'defaulter'; reliability_color = 'red';
    } else if (p.overdue_installments === 1 || (onTimePct !== null && onTimePct < 90)) {
      reliability_label = 'risky';   reliability_color = 'yellow';
    } else if (p.total_credit_sales >= 3 && onTimePct !== null && onTimePct >= 90) {
      reliability_label = 'reliable'; reliability_color = 'green';
    } else {
      reliability_label = 'new';     reliability_color = 'gray';
    }

    res.json({
      data: {
        total_credit_sales:   p.total_credit_sales,
        paid_on_time:         p.paid_on_time,
        paid_late:            p.paid_late,
        avg_days_late:        p.avg_days_late,
        pending_debt:         Number(p.pending_debt),
        overdue_installments: p.overdue_installments,
        on_time_percentage:   onTimePct !== null ? Math.round(onTimePct) : null,
        reliability_label,
        reliability_color,
        last_sale:            lastSale ?? null,
      },
    });
  } catch (err) {
    console.error('[CreditProfile] Error:', err.message);
    res.status(500).json({ message: 'Error al obtener perfil crediticio' });
  }
};