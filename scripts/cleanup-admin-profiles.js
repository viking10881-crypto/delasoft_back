'use strict';
// scripts/cleanup-admin-profiles.js
// Uso: NEON_DB_URL=... node scripts/cleanup-admin-profiles.js
//
// Diagnóstico + limpieza de filas duplicadas en admin_profiles.
// Solo elimina filas sin business_name que no sean el registro más antiguo por user_id.
// Siempre muestra un preview antes de borrar. Pasar --execute para aplicar.

const db  = require('../config/db');
const DRY = !process.argv.includes('--execute');

async function main() {
  console.log(DRY ? '\n[DRY RUN] — pasar --execute para aplicar cambios\n' : '\n[EXECUTE]\n');

  // 1. Duplicados por user_id
  const { rows: dupes } = await db.query(`
    SELECT user_id, COUNT(*) AS cnt, array_agg(id ORDER BY id) AS ids
    FROM admin_profiles
    GROUP BY user_id
    HAVING COUNT(*) > 1
    ORDER BY user_id
  `);

  if (!dupes.length) {
    console.log('✅ Sin filas duplicadas en admin_profiles. Nada que limpiar.');
    await db.end?.();
    process.exit(0);
  }

  console.log(`Encontrados ${dupes.length} user_id con duplicados:\n`);
  for (const d of dupes) {
    console.log(`  user_id=${d.user_id}  ids=[${d.ids.join(', ')}]  total=${d.cnt}`);
  }

  // 2. Identificar IDs a borrar: todos salvo el más antiguo (MIN id) por user_id,
  //    pero SOLO si no tienen business_name (huérfanos de un INSERT fallido)
  const { rows: toDelete } = await db.query(`
    SELECT ap.id, ap.user_id, ap.business_name
    FROM admin_profiles ap
    WHERE ap.id NOT IN (
      SELECT MIN(id) FROM admin_profiles GROUP BY user_id
    )
    AND (ap.business_name IS NULL OR ap.business_name = '')
    ORDER BY ap.user_id, ap.id
  `);

  if (!toDelete.length) {
    console.log('\nℹ️  Los duplicados tienen business_name — no son huérfanos seguros de borrar automáticamente.');
    console.log('   Revisar manualmente cuál conservar.');
    await db.end?.();
    process.exit(0);
  }

  console.log(`\nFilas a eliminar (${toDelete.length}):\n`);
  for (const r of toDelete) {
    console.log(`  id=${r.id}  user_id=${r.user_id}  business_name=${r.business_name ?? 'NULL'}`);
  }

  if (DRY) {
    console.log('\n🔍 DRY RUN — ningún cambio aplicado. Ejecutar con --execute para borrar.');
    await db.end?.();
    process.exit(0);
  }

  const ids = toDelete.map(r => r.id);
  const { rowCount } = await db.query(
    `DELETE FROM admin_profiles WHERE id = ANY($1::int[])`,
    [ids]
  );

  console.log(`\n✅ Eliminadas ${rowCount} fila(s) huérfana(s).`);
  await db.end?.();
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});