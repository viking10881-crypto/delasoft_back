'use strict';

const { decrypt } = require('../utils/crypto');

const BASE_URLS = {
  sandbox: process.env.FACTUS_SANDBOX_URL || 'https://api-sandbox.factus.com.co',
  production: process.env.FACTUS_PRODUCTION_URL || 'https://api.factus.com.co',
};

async function getFactusToken(row) {
  const response = await fetch(`${BASE_URLS[row.environment]}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: row.client_id,
      client_secret: decrypt(row.client_secret_encrypted),
      username: decrypt(row.username_encrypted),
      password: decrypt(row.password_encrypted),
    }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error(data.message || data.error_description || 'Factus rechazó las credenciales');
    error.status = response.status;
    throw error;
  }
  return data.access_token;
}

async function verifyIntegration(row) {
  if (row.provider !== 'factus') throw new Error('Proveedor fiscal no soportado');
  await getFactusToken(row);
  return true;
}

module.exports = { verifyIntegration, getFactusToken };
