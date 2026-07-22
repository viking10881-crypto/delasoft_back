// Script de uso único para crear el primer admin.
// Uso: ADMIN_EMAIL=tu@email.com ADMIN_PASSWORD='TuClave123!' node createAdmin.js
require('dotenv/config');
const bcrypt = require('bcryptjs');
const pool   = require('./config/db');

const email    = process.env.SEED_ADMIN_EMAIL    || process.env.ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
const name     = process.env.SEED_ADMIN_NAME     || 'Admin';

if (!email || !password) {
  console.error('Uso: SEED_ADMIN_EMAIL=x SEED_ADMIN_PASSWORD=y node createAdmin.js');
  process.exit(1);
}

async function createAdmin() {
  try {
    const hash = await bcrypt.hash(password, 12);

    const userRes = await pool.query(
      `INSERT INTO users (email, password, cedula, name, is_verified, is_active)
       VALUES ($1, $2, $3, $4, true, true)
       ON CONFLICT (email) DO UPDATE
         SET password = EXCLUDED.password, is_verified = true, is_active = true
       RETURNING id, email`,
      [email.toLowerCase().trim(), hash, '00000000', name.trim()]
    );

    const user = userRes.rows[0];
    console.log('Usuario listo:', user);

    const roleRes = await pool.query("SELECT id FROM roles WHERE name = 'admin' LIMIT 1");
    if (roleRes.rowCount === 0) {
      console.error("El rol 'admin' no existe. Ejecuta las migraciones primero.");
      process.exit(1);
    }

    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user.id, roleRes.rows[0].id]
    );

    console.log(`Admin creado: ${user.email}`);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

createAdmin();
