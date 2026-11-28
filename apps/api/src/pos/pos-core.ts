import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/db';
import { posCashMoves, posPayments, posSaleLines, posSales, posSessions } from '../db/schema';

export const METHOD: Record<string, string> = { cash: 'Espèces', card: 'Carte bancaire', cheque: 'Chèque', other: 'Autre' };
/** Coupures acceptées au comptage (en centimes). */
export const DENOMINATIONS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
export const euros = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

/** Récapitulatif d'une session : ventes, règlements, produits, espèces attendues. */
export async function sessionSummary(db: DbOrTx, session: typeof posSessions.$inferSelect) {
  const sales = await db.select({ status: posSales.status, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${posSales.totalCents}), 0)::int` })
    .from(posSales).where(eq(posSales.sessionId, session.id)).groupBy(posSales.status);
  const pay = await db.select({ method: posPayments.method, cents: sql<number>`coalesce(sum(${posPayments.amountCents}), 0)::int`, n: sql<number>`count(*)::int` })
    .from(posPayments).innerJoin(posSales, eq(posSales.id, posPayments.saleId))
    .where(and(eq(posSales.sessionId, session.id), eq(posSales.status, 'completed'))).groupBy(posPayments.method);
  const lines = await db.select({ name: posSaleLines.name, category: posSaleLines.category, kind: posSaleLines.kind, qty: sql<number>`sum(${posSaleLines.quantity})::int`, cents: sql<number>`sum(${posSaleLines.quantity} * ${posSaleLines.unitPriceCents})::int` })
    .from(posSaleLines).innerJoin(posSales, eq(posSales.id, posSaleLines.saleId))
    .where(and(eq(posSales.sessionId, session.id), eq(posSales.status, 'completed'))).groupBy(posSaleLines.name, posSaleLines.category, posSaleLines.kind)
    .orderBy(sql`sum(${posSaleLines.quantity} * ${posSaleLines.unitPriceCents}) desc`);
  const moves = await db.select().from(posCashMoves).where(eq(posCashMoves.sessionId, session.id)).orderBy(posCashMoves.id);
  const completed = sales.find((s) => s.status === 'completed') ?? { n: 0, cents: 0 };
  const voided = sales.find((s) => s.status === 'voided') ?? { n: 0, cents: 0 };
  const byMethod = Object.fromEntries(pay.map((p) => [p.method, p.cents])) as Record<string, number>;
  const cashIn = moves.filter((m) => m.kind === 'in').reduce((a, m) => a + m.amountCents, 0);
  const cashOut = moves.filter((m) => m.kind === 'out').reduce((a, m) => a + m.amountCents, 0);
  const expectedCash = session.openingFloatCents + (byMethod.cash ?? 0) + cashIn - cashOut;
  return {
    salesCount: completed.n, totalCents: completed.cents, voidedCount: voided.n, voidedCents: voided.cents,
    byMethod, products: lines, moves, cashIn, cashOut, expectedCashCents: expectedCash,
    averageCents: completed.n ? Math.round(completed.cents / completed.n) : 0,
  };
}
export type SessionSummary = Awaited<ReturnType<typeof sessionSummary>>;

export async function sessionTotals(db: DbOrTx, ids: string[]) {
  if (!ids.length) return new Map<string, { n: number; cents: number }>();
  const rows = await db.select({ id: posSales.sessionId, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${posSales.totalCents}), 0)::int` })
    .from(posSales).where(and(inArray(posSales.sessionId, ids), eq(posSales.status, 'completed'))).groupBy(posSales.sessionId);
  return new Map(rows.map((r) => [r.id, { n: r.n, cents: r.cents }]));
}
