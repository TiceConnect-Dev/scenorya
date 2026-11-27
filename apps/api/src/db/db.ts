import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** Transaction ou base : les services acceptent les deux. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

export function createPool(url: string) {
  return new Pool({ connectionString: url, max: 10 });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'drizzle');

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
