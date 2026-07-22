// server.js
require('dotenv/config');
require('./config/env')(); // Valida variables de entorno al arrancar

const http            = require('http');
const app             = require('./app');
const { initSocket }  = require('./config/socket');
const db              = require('./config/db');

const PORT   = process.env.PORT || 4000;
const server = http.createServer(app);

initSocket(server);

server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
  console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`[${signal}] Cerrando servidor...`);
  server.close(async () => {
    await db.end().catch(() => {});
    console.log('Servidor cerrado.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;