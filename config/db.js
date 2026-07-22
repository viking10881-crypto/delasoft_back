const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString:        process.env.NEON_DB_URL,
  ssl:                     { rejectUnauthorized: isProduction },
  max:                     parseInt(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle:         true,
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado en cliente idle:', err.message);
});

pool.query('SELECT 1')
  .then(() => console.log('[DB] Conectada'))
  .catch((err) => {
    console.error('[DB] Error al conectar:', err.message);
    process.exit(1);
  });

module.exports = pool;
