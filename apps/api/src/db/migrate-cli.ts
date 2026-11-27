import { loadConfig } from '../config';
import { createDb, createPool, runMigrations } from './db';

/** Applique les migrations versionnées (non destructives) : `npm run db:migrate`. */
async function main() {
  const pool = createPool(loadConfig().DATABASE_URL);
  try {
    await runMigrations(createDb(pool));
    // eslint-disable-next-line no-console
    console.log('Migrations appliquées.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
