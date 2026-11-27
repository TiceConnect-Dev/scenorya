import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/db';
import { Conflict } from './errors';

/**
 * Autorise, pour la seule transaction en cours, la suppression de lignes protégées par
 * déclencheur (règlements, réunions clôturées). À n'appeler qu'après confirmation explicite
 * de l'utilisateur ; la suppression est toujours inscrite au journal d'audit.
 */
export async function allowPurge(tx: DbOrTx) {
  await tx.execute(sql`select set_config('scenorya.allow_purge', 'on', true)`);
}

/** Refus tant que l'utilisateur n'a pas confirmé une suppression aux conséquences importantes. */
export function requireConfirmation(force: string | undefined, message: string, details: Record<string, unknown>) {
  if (force !== '1' && force !== 'true') throw Conflict('CONFIRM_REQUIRED', message, details);
}
