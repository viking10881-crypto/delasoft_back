// controllers/superadmin.controller.js
// Solo accesible por el rol "superadmin"
const db     = require("../config/db");
const bcrypt = require("bcryptjs");
const subscriptionService = require("../services/subscription.service");

const SALT_ROUNDS = 12;

const isValidEmail    = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isStrongPassword = (pw) =>
  pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw);

// ============================================
// 📋 LISTAR TODOS LOS ADMINS
// Incluye datos de suscripción para que AdminCard los pueda mostrar.
// ============================================
exports.getAdmins = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id,
        u.email,
        u.name,
        u.phone,
        u.cedula,
        u.city,
        u.is_active,
        u.is_verified,
        u.created_at,
        u.last_login,
        -- Roles
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
          FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS roles,
        -- API Keys
        COUNT(DISTINCT ak.id) AS api_keys_count,
        -- Suscripción (usados en AdminCard)
        s.status        AS subscription_status,
        s.trial_end     AS subscription_trial_end,
        s.billing_cycle AS subscription_billing_cycle,
        sp.name         AS plan_name,
        sp.slug         AS plan_slug,
        sp.color        AS plan_color
      FROM users u
      -- Roles
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r       ON r.id       = ur.role_id
      -- API Keys
      LEFT JOIN api_keys ak   ON ak.admin_id = u.id AND ak.is_active = true
      -- Suscripción
      LEFT JOIN subscriptions s        ON s.admin_id = u.id
      LEFT JOIN subscription_plans sp  ON sp.id      = s.plan_id
      WHERE r.name = 'admin'
      GROUP BY u.id, s.status, s.trial_end, s.billing_cycle, sp.name, sp.slug, sp.color
      ORDER BY u.created_at DESC
    `);

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[GET ADMINS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener administradores" });
  }
};

// ============================================
// ➕ CREAR ADMIN — con asignación de plan
// ============================================
exports.createAdmin = async (req, res) => {
  const client = await db.connect();
  try {
    const {
      email, password, name, cedula,
      phone, city, address,
      plan_slug     = "basic",
      trial_days,
      start_active  = false,
      billing_cycle = "monthly",
    } = req.body;

    // ── Validaciones ──────────────────────────────────────────────
    if (!email || !password || !name || !cedula) {
      return res.status(400).json({
        success: false,
        message: "Campos requeridos: email, password, name, cedula",
        code: "MISSING_FIELDS",
      });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Email inválido", code: "INVALID_EMAIL" });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        success: false,
        message: "La contraseña debe tener mínimo 8 caracteres, mayúsculas, minúsculas y números",
        code: "WEAK_PASSWORD",
      });
    }

    await client.query("BEGIN");

    // Unicidad
    const emailCheck = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    if (emailCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "El email ya está registrado", code: "EMAIL_TAKEN" });
    }

    const cedulaCheck = await client.query(
      "SELECT id FROM users WHERE cedula = $1",
      [cedula.trim()]
    );
    if (cedulaCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "La cédula ya está registrada", code: "CEDULA_TAKEN" });
    }

    // Verificar plan
    const planCheck = await client.query(
      "SELECT id, name, trial_days, price_monthly FROM subscription_plans WHERE slug = $1 AND is_active = true",
      [plan_slug]
    );
    if (planCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: `Plan '${plan_slug}' no encontrado`, code: "PLAN_NOT_FOUND" });
    }
    const plan = planCheck.rows[0];

    // Rol admin
    const roleRes = await client.query("SELECT id FROM roles WHERE name = 'admin' LIMIT 1");
    if (roleRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, message: "Rol 'admin' no encontrado", code: "ROLE_NOT_FOUND" });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Crear usuario
    const userRes = await client.query(
      `INSERT INTO users (email, password, name, cedula, phone, city, address, is_active, is_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,true)
       RETURNING id, email, name, cedula, created_at`,
      [
        email.toLowerCase().trim(), hashedPassword, name.trim(), cedula.trim(),
        phone?.trim() || null, city?.trim() || null, address?.trim() || null,
      ]
    );
    const newAdmin = userRes.rows[0];

    // Asignar rol
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [newAdmin.id, roleRes.rows[0].id]
    );

    await client.query("COMMIT");
    // COMMIT antes de subscriptionService (usa su propio pool)

    // ── Crear suscripción ─────────────────────────────────────────
    let subscriptionResult = null;
    try {
      if (start_active) {
        subscriptionResult = await subscriptionService.activateSubscription(newAdmin.id, {
          planSlug:         plan_slug,
          billingCycle:     billing_cycle,
          paymentMethod:    "manual",
          paymentReference: `SUPERADMIN-${req.user.id}`,
          changedBy:        req.user.id,
        });
      } else {
        subscriptionResult = await subscriptionService.createTrialSubscription(
          newAdmin.id,
          plan_slug,
          req.user.id
        );

        // Override días de trial si se especificó un valor custom
        const customDays = parseInt(trial_days);
        if (!isNaN(customDays) && customDays > 0 && customDays !== plan.trial_days) {
          const trialEnd = new Date();
          trialEnd.setDate(trialEnd.getDate() + customDays);
          const trialEndStr = trialEnd.toISOString().split("T")[0];
          await db.query(
            `UPDATE subscriptions
             SET trial_end = $1, current_period_end = $1, next_billing_date = $1, updated_at = now()
             WHERE admin_id = $2`,
            [trialEndStr, newAdmin.id]
          );
        }
      }
    } catch (subErr) {
      // Admin creado OK; la suscripción puede asignarse manualmente después
      console.error("[CREATE ADMIN] Subscription error (admin created OK):", subErr.message);
    }

    console.log(
      `[SUPERADMIN] Admin creado: ${newAdmin.email} (ID: ${newAdmin.id}) | ` +
      `Plan: ${plan.name} | ${start_active ? "Activo" : `Trial ${trial_days ?? plan.trial_days}d`} | ` +
      `por superadmin ID: ${req.user.id}`
    );

    return res.status(201).json({
      success: true,
      message: "Administrador creado correctamente",
      data: {
        ...newAdmin,
        plan_slug,
        plan_name:    plan.name,
        subscription: subscriptionResult,
      },
    });

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[CREATE ADMIN ERROR]", error);
    res.status(500).json({ success: false, message: "Error al crear administrador" });
  } finally {
    client.release();
  }
};

// ============================================
// GET /superadmin/admins/:id/subscription
// ============================================
exports.getAdminSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const sub    = await subscriptionService.getSubscriptionByAdmin(id);
    const limits = sub ? await subscriptionService.checkLimits(id) : null;
    res.json({ success: true, data: { subscription: sub, limits } });
  } catch (err) {
    console.error("[GET ADMIN SUBSCRIPTION]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================
// POST /superadmin/admins/:id/subscription
// ============================================
exports.setAdminSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const { plan_slug, trial_days, start_active = false, billing_cycle = "monthly" } = req.body;

    if (!plan_slug) {
      return res.status(400).json({ success: false, message: "plan_slug requerido" });
    }

    let result;
    if (start_active) {
      result = await subscriptionService.activateSubscription(parseInt(id), {
        planSlug:         plan_slug,
        billingCycle:     billing_cycle,
        paymentMethod:    "manual",
        paymentReference: `SA-${req.user.id}`,
        changedBy:        req.user.id,
      });
    } else {
      result = await subscriptionService.createTrialSubscription(parseInt(id), plan_slug, req.user.id);

      const customDays = parseInt(trial_days);
      if (!isNaN(customDays) && customDays > 0) {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + customDays);
        await db.query(
          `UPDATE subscriptions
           SET trial_end = $1, current_period_end = $1, next_billing_date = $1, updated_at = now()
           WHERE admin_id = $2`,
          [trialEnd.toISOString().split("T")[0], id]
        );
      }
    }

    res.json({ success: true, message: "Suscripción actualizada", data: result });
  } catch (err) {
    console.error("[SET ADMIN SUBSCRIPTION]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================
// ✏️ ACTUALIZAR ADMIN
// ============================================
exports.updateAdmin = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { name, email, phone, cedula, city, address, is_active, password } = req.body;

    if (parseInt(id) === req.user.id) {
      return res.status(400).json({
        success: false,
        message: "Usa /api/auth/profile para modificar tu propio perfil",
        code: "SELF_UPDATE_FORBIDDEN",
      });
    }

    await client.query("BEGIN");

    const userCheck = await client.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1 AND r.name = 'admin'`,
      [id]
    );
    if (userCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Admin no encontrado", code: "ADMIN_NOT_FOUND" });
    }

    await client.query(
      `UPDATE users
       SET name=$1, email=$2, phone=$3, cedula=$4, city=$5, address=$6, is_active=$7, updated_at=NOW()
       WHERE id=$8`,
      [name, email?.toLowerCase().trim(), phone || null, cedula, city || null, address || null, is_active ?? true, id]
    );

    if (password && password.trim() !== "") {
      if (!isStrongPassword(password)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Contraseña débil", code: "WEAK_PASSWORD" });
      }
      const hashed = await bcrypt.hash(password, SALT_ROUNDS);
      await client.query("UPDATE users SET password=$1 WHERE id=$2", [hashed, id]);
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Administrador actualizado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE ADMIN ERROR]", error);
    res.status(500).json({ success: false, message: "Error al actualizar administrador" });
  } finally {
    client.release();
  }
};

// ============================================
// 🔒 ACTIVAR / DESACTIVAR
// ============================================
exports.toggleAdminStatus = async (req, res) => {
  try {
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
      return res.status(400).json({
        success: false,
        message: "No puedes desactivarte a ti mismo",
        code: "SELF_DEACTIVATION",
      });
    }

    const result = await db.query(
      `UPDATE users SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1 RETURNING id, email, name, is_active`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Admin no encontrado" });
    }

    const admin  = result.rows[0];
    const action = admin.is_active ? "activado" : "desactivado";

    console.log(`[SUPERADMIN] Admin ${admin.email} ${action} por superadmin ID: ${req.user.id}`);

    return res.json({
      success: true,
      message: `Administrador ${action} correctamente`,
      data: { id: admin.id, email: admin.email, is_active: admin.is_active },
    });
  } catch (error) {
    console.error("[TOGGLE ADMIN ERROR]", error);
    res.status(500).json({ success: false, message: "Error al cambiar estado del administrador" });
  }
};

// ============================================
// 🗑️ ELIMINAR ADMIN
// ============================================
exports.deleteAdmin = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ success: false, message: "No puedes eliminarte a ti mismo" });
    }

    await client.query("BEGIN");

    await client.query("UPDATE api_keys       SET is_active = false WHERE admin_id = $1", [id]);
    await client.query("UPDATE refresh_tokens SET revoked = true    WHERE user_id  = $1", [id]);
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);

    const result = await client.query("DELETE FROM users WHERE id = $1 RETURNING email", [id]);

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Admin no encontrado" });
    }

    await client.query("COMMIT");
    console.log(`[SUPERADMIN] Admin ${result.rows[0].email} eliminado por superadmin ID: ${req.user.id}`);

    return res.json({ success: true, message: "Administrador eliminado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE ADMIN ERROR]", error);
    const msg = error.code === "23503"
      ? "No se puede eliminar: tiene registros vinculados. Desactívalo en su lugar."
      : "Error al eliminar administrador";
    res.status(500).json({ success: false, message: msg });
  } finally {
    client.release();
  }
};

// ============================================
// 📊 STATS DEL SISTEMA
// ============================================
exports.getSystemStats = async (req, res) => {
  try {
    const [admins, users, apiKeys, sales] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id WHERE r.name = 'admin'`
      ),
      db.query(
        `SELECT COUNT(*) FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id WHERE r.name = 'user'`
      ),
      db.query("SELECT COUNT(*) FROM api_keys WHERE is_active = true"),
      db.query(
        `SELECT COUNT(*), COALESCE(SUM(total), 0) AS revenue
         FROM sales WHERE sale_date >= NOW() - INTERVAL '30 days'`
      ),
    ]);

    res.json({
      success: true,
      data: {
        admins:        parseInt(admins.rows[0].count),
        users:         parseInt(users.rows[0].count),
        activeApiKeys: parseInt(apiKeys.rows[0].count),
        last30Days: {
          sales:   parseInt(sales.rows[0].count),
          revenue: parseFloat(sales.rows[0].revenue),
        },
      },
    });
  } catch (error) {
    console.error("[SYSTEM STATS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener estadísticas" });
  }
};