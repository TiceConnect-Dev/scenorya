import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql, asc, gte, lte, ilike, or } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../db/db';
import { auditLogs } from '../db/schema';
import { canonicalJson, sha256 } from '../common/crypto';

export interface AuditEntry {
  associationId: string | null;
  actorId: string | null;
  actorLabel?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
  ip?: string | null;
}

const SECRET_KEYS = /pass(word)?|secret|token|iban|apikey|api_key/i;

/** Retire récursivement toute valeur dont la clé évoque un secret. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[masqué]' : redact(v)]),
    );
  }
  return value;
}

function computeHash(prevHash: string | null, e: Omit<typeof auditLogs.$inferInsert, 'hash' | 'prevHash' | 'id'>) {
  return sha256(
    canonicalJson({
      prev: prevHash,
      associationId: e.associationId ?? null,
      actorId: e.actorId ?? null,
      actorLabel: e.actorLabel ?? null,
      action: e.action,
      resourceType: e.resourceType ?? null,
      resourceId: e.resourceId ?? null,
      summary: e.summary,
      data: e.data ?? {},
      ip: e.ip ?? null,
      createdAt: (e.createdAt as Date).toISOString(),
    }),
  );
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Ajoute une entrée chaînée (hash du précédent) au journal de l'association
   * (ou de l'instance si associationId est nul). Un verrou consultatif
   * transactionnel sérialise les écritures concurrentes d'une même chaîne.
   */
  async log(entry: AuditEntry, tx?: DbOrTx) {
    const run = async (t: DbOrTx) => {
      const chain = entry.associationId ?? 'instance';
      await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'audit:' + chain}))`);
      const [last] = await t
        .select({ hash: auditLogs.hash })
        .from(auditLogs)
        .where(entry.associationId ? eq(auditLogs.associationId, entry.associationId) : isNull(auditLogs.associationId))
        .orderBy(desc(auditLogs.id))
        .limit(1);
      const prevHash = last?.hash ?? null;
      const createdAt = new Date();
      const row = {
        associationId: entry.associationId,
        actorId: entry.actorId,
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        summary: entry.summary,
        data: redact(entry.data ?? {}) as Record<string, unknown>,
        ip: entry.ip ?? null,
        createdAt,
      };
      await t.insert(auditLogs).values({ ...row, prevHash, hash: computeHash(prevHash, row) });
    };
    if (tx) return run(tx);
    return this.db.transaction(run);
  }

  async list(associationId: string | null, opts: { page: number; pageSize: number; q?: string; action?: string; from?: Date; to?: Date }) {
    const conds = [associationId ? eq(auditLogs.associationId, associationId) : isNull(auditLogs.associationId)];
    if (opts.action) conds.push(ilike(auditLogs.action, `${opts.action}%`));
    if (opts.q) conds.push(or(ilike(auditLogs.summary, `%${opts.q}%`), ilike(auditLogs.actorLabel, `%${opts.q}%`))!);
    if (opts.from) conds.push(gte(auditLogs.createdAt, opts.from));
    if (opts.to) conds.push(lte(auditLogs.createdAt, opts.to));
    const where = and(...conds);
    const [{ count }] = await this.db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(where);
    const items = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize);
    return { items, total: count, page: opts.page, pageSize: opts.pageSize };
  }

  /** Recalcule toute la chaîne et signale la première rupture éventuelle. */
  async verify(associationId: string | null) {
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(associationId ? eq(auditLogs.associationId, associationId) : isNull(auditLogs.associationId))
      .orderBy(asc(auditLogs.id));
    let prev: string | null = null;
    for (const r of rows) {
      const { id, hash, prevHash, ...rest } = r;
      const expected = computeHash(prev, rest);
      if (prevHash !== prev || hash !== expected) {
        return { valid: false, checked: rows.length, brokenAt: id };
      }
      prev = hash;
    }
    return { valid: true, checked: rows.length, brokenAt: null };
  }
}
