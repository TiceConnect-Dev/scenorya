import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { aliasedTable, and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isFeatureEnabled } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Conflict, NotFound } from '../common/errors';
import { toCsv } from '../common/csv';
import { requireConfirmation } from '../common/purge';
import { DB, Db, DbOrTx } from '../db/db';
import {
  associations, counters, posCashMoves, posCategories, posPayments, posProducts, posRegisters, posSaleLines, posSales, posSessions,
  stockItems, stockMovements, ticketEvents, ticketOrders, ticketRates, tickets, users,
} from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';
import { counts, effectiveEvents, issueOrder, orderUrl } from '../tickets/tickets-core';
import { DENOMINATIONS, euros, METHOD, sessionSummary, sessionTotals } from './pos-core';
import { receiptPdf, zReport } from './pos-pdf';

const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const zProduct = z.object({
  name: z.string().trim().min(1).max(60), priceCents: z.number().int().min(0).max(1_000_000),
  categoryId: zUuid.nullable().optional(), color: zColor, stockItemId: zUuid.nullable().optional(),
  stockUnits: z.number().int().min(0).max(10_000).default(1), active: z.boolean().default(true), position: z.number().int().min(0).max(10_000).default(0),
});
const zSale = z.object({
  lines: z.array(z.union([
    z.object({ productId: zUuid, quantity: z.number().int().min(1).max(999) }),
    z.object({ ticketRateId: zUuid, quantity: z.number().int().min(1).max(100) }),
    z.object({ custom: z.string().trim().min(1).max(60), priceCents: z.number().int().min(0).max(1_000_000), quantity: z.number().int().min(1).max(999) }),
  ])).min(1).max(100),
  payments: z.array(z.object({ method: z.enum(['cash', 'card', 'cheque', 'other']), amountCents: z.number().int().min(0).max(10_000_000), tenderedCents: z.number().int().min(0).max(10_000_000).nullable().optional() })).max(5).default([]),
  buyerName: zOptText(120),
});
const dt = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d);

async function next(tx: DbOrTx, associationId: string, key: string) {
  const [r] = await tx.insert(counters).values({ associationId, key, value: 1 })
    .onConflictDoUpdate({ target: [counters.associationId, counters.key], set: { value: sql`${counters.value} + 1` } }).returning({ value: counters.value });
  return r.value;
}

@ApiTags('Scenorya POS')
@Controller()
export class PosController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'pos',
      check: async (db, associationId) => {
        const [o] = await db.select({ n: sql<number>`count(*)::int` }).from(posSessions).where(and(eq(posSessions.associationId, associationId), eq(posSessions.status, 'open')));
        return o.n > 0 ? [{ module: 'pos', level: 'warning', message: `${o.n} caisse(s) ouverte(s) : clôturez-les avant de désactiver le module.` } as ModuleImpact] : [];
      },
    });
  }

  private stockSync(c: AssocCtx) { return !!c.modules.stock?.usable && isFeatureEnabled(c.modules, 'pos.stockSync'); }
  private ticketSales(c: AssocCtx) { return !!c.modules.tickets?.usable && isFeatureEnabled(c.modules, 'pos.ticketSales'); }

  private async register(c: AssocCtx, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select().from(posRegisters).where(and(eq(posRegisters.id, id), eq(posRegisters.associationId, c.association.id)));
    if (!r) throw NotFound('Caisse introuvable.');
    return r;
  }

  private async session(c: AssocCtx, id: string) {
    parse(zUuid, id);
    const [s] = await this.db.select({ s: posSessions, register: posRegisters.name, ticketSales: posRegisters.ticketSales }).from(posSessions).innerJoin(posRegisters, eq(posRegisters.id, posSessions.registerId))
      .where(and(eq(posSessions.id, id), eq(posSessions.associationId, c.association.id)));
    if (!s) throw NotFound('Session de caisse introuvable.');
    return { ...s.s, register: s.register, registerTicketSales: s.ticketSales };
  }

  private async sale(c: AssocCtx, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ sale: posSales, session: posSessions, register: posRegisters.name }).from(posSales)
      .innerJoin(posSessions, eq(posSessions.id, posSales.sessionId)).innerJoin(posRegisters, eq(posRegisters.id, posSessions.registerId))
      .where(and(eq(posSales.id, id), eq(posSessions.associationId, c.association.id)));
    if (!r) throw NotFound('Vente introuvable.');
    return r;
  }

  private async checkRefs(c: AssocCtx, input: { categoryId?: string | null; stockItemId?: string | null }) {
    if (input.categoryId) {
      const [x] = await this.db.select({ id: posCategories.id }).from(posCategories).where(and(eq(posCategories.id, input.categoryId), eq(posCategories.associationId, c.association.id)));
      if (!x) throw BadRequest('UNKNOWN_CATEGORY', 'Catégorie inconnue.');
    }
    if (input.stockItemId) {
      const [x] = await this.db.select({ id: stockItems.id }).from(stockItems).where(and(eq(stockItems.id, input.stockItemId), eq(stockItems.associationId, c.association.id)));
      if (!x) throw BadRequest('UNKNOWN_ITEM', 'Article de stock inconnu.');
    }
  }

  /* ============================================================ Caisses */

  @Access('pos', 'pos.catalog.read')
  @Get('pos/registers')
  async registers(@AssocContext() c: AssocCtx, @Query('archived') archived?: string) {
    const opener = aliasedTable(users, 'opener');
    const rows = await this.db.select({ r: posRegisters, s: posSessions, openedBy: opener.displayName }).from(posRegisters)
      .leftJoin(posSessions, and(eq(posSessions.registerId, posRegisters.id), eq(posSessions.status, 'open')))
      .leftJoin(opener, eq(opener.id, posSessions.openedBy))
      .where(and(eq(posRegisters.associationId, c.association.id), archived === '1' ? undefined : isNull(posRegisters.archivedAt))).orderBy(asc(posRegisters.name));
    const totals = await sessionTotals(this.db, rows.filter((r) => r.s).map((r) => r.s!.id));
    return rows.map((r) => ({ ...r.r, session: r.s ? { id: r.s.id, number: r.s.number, openedAt: r.s.openedAt, openedBy: r.openedBy, sales: totals.get(r.s.id)?.n ?? 0, totalCents: totals.get(r.s.id)?.cents ?? 0 } : null }));
  }

  @Access('pos', 'pos.catalog.update')
  @Post('pos/registers')
  async addRegister(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(1).max(60), color: zColor, ticketSales: z.boolean().default(false) }), body);
    const [r] = await this.db.insert(posRegisters).values({ ...input, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'pos.register.create', resourceType: 'pos_register', resourceId: r.id, summary: `Caisse « ${r.name} » créée` });
    return r;
  }

  @Access('pos', 'pos.catalog.update')
  @Patch('pos/registers/:id')
  async updateRegister(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.register(c, id);
    const input = parse(z.object({ name: z.string().trim().min(1).max(60).optional(), color: zColor, ticketSales: z.boolean().optional(), archived: z.boolean().optional() }), body);
    const { archived, ...rest } = input;
    const [r] = await this.db.update(posRegisters).set({ ...rest, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) }).where(eq(posRegisters.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'pos.register.update', resourceType: 'pos_register', resourceId: id, summary: `Caisse « ${r.name} » modifiée` });
    return r;
  }

  @Access('pos', 'pos.catalog.update')
  @Delete('pos/registers/:id')
  async removeRegister(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query('force') force?: string) {
    const r = await this.register(c, id);
    const [s] = await this.db.select({ n: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${posSessions.status} = 'open')::int` }).from(posSessions).where(eq(posSessions.registerId, id));
    if (s.open) throw Conflict('SESSION_OPEN', 'Clôturez d’abord la session ouverte de cette caisse.');
    if (s.n) requireConfirmation(force, `« ${r.name} » a ${s.n} session(s) clôturée(s) : leurs ventes et rapports seront supprimés définitivement. Pour garder l’historique, préférez « Archiver ».`, { sessions: s.n });
    await this.db.transaction(async (tx) => {
      await tx.delete(posRegisters).where(eq(posRegisters.id, id));
      await this.audit.log({ ...log(c), action: 'pos.register.delete', resourceType: 'pos_register', resourceId: id, summary: `Caisse « ${r.name} » supprimée (${s.n} session(s))` }, tx);
    });
    return { ok: true };
  }

  /* ============================================================ Catalogue */

  @Access('pos', 'pos.catalog.read')
  @Get('pos/catalog')
  async catalog(@AssocContext() c: AssocCtx) {
    const categories = await this.db.select().from(posCategories).where(eq(posCategories.associationId, c.association.id)).orderBy(asc(posCategories.position), asc(posCategories.name));
    const products = await this.db.select({ p: posProducts, stockName: stockItems.name, stockQuantity: stockItems.quantity, stockUnit: stockItems.unit }).from(posProducts)
      .leftJoin(stockItems, eq(stockItems.id, posProducts.stockItemId))
      .where(eq(posProducts.associationId, c.association.id)).orderBy(asc(posProducts.position), asc(posProducts.name));
    return {
      categories, stockSync: this.stockSync(c), ticketSales: this.ticketSales(c),
      products: products.map((r) => ({ ...r.p, stock: r.p.stockItemId && this.stockSync(c) ? { name: r.stockName, quantity: r.stockQuantity, unit: r.stockUnit } : null })),
    };
  }

  @Access('pos', 'pos.catalog.update')
  @Post('pos/categories')
  async addCategory(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(1).max(40), color: zColor, position: z.number().int().min(0).max(1000).default(0) }), body);
    const [r] = await this.db.insert(posCategories).values({ ...input, associationId: c.association.id }).returning();
    return r;
  }

  @Access('pos', 'pos.catalog.update')
  @Patch('pos/categories/:id')
  async updateCategory(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const input = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), color: zColor, position: z.number().int().min(0).max(1000).optional() }), body);
    const [r] = await this.db.update(posCategories).set(input).where(and(eq(posCategories.id, id), eq(posCategories.associationId, c.association.id))).returning();
    if (!r) throw NotFound('Catégorie introuvable.');
    return r;
  }

  @Access('pos', 'pos.catalog.update')
  @Delete('pos/categories/:id')
  async removeCategory(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [r] = await this.db.delete(posCategories).where(and(eq(posCategories.id, id), eq(posCategories.associationId, c.association.id))).returning();
    if (!r) throw NotFound('Catégorie introuvable.');
    await this.audit.log({ ...log(c), action: 'pos.category.delete', resourceType: 'pos_category', resourceId: id, summary: `Catégorie de caisse « ${r.name} » supprimée (ses produits restent, sans catégorie)` });
    return { ok: true };
  }

  @Access('pos', 'pos.catalog.update')
  @Post('pos/products')
  async addProduct(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zProduct, body);
    await this.checkRefs(c, input);
    const [p] = await this.db.insert(posProducts).values({ ...input, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'pos.product.create', resourceType: 'pos_product', resourceId: p.id, summary: `Produit « ${p.name} » (${euros(p.priceCents)}) ajouté` });
    return p;
  }

  @Access('pos', 'pos.catalog.update')
  @Patch('pos/products/:id')
  async updateProduct(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const [before] = await this.db.select().from(posProducts).where(and(eq(posProducts.id, id), eq(posProducts.associationId, c.association.id)));
    if (!before) throw NotFound('Produit introuvable.');
    const input = parse(patchOf(zProduct), body);
    await this.checkRefs(c, input);
    const [p] = await this.db.update(posProducts).set({ ...input, updatedAt: new Date() }).where(eq(posProducts.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'pos.product.update', resourceType: 'pos_product', resourceId: id, summary: `Produit « ${p.name} » modifié${input.priceCents !== undefined && input.priceCents !== before.priceCents ? ` (${euros(before.priceCents)} → ${euros(p.priceCents)})` : ''}` });
    return p;
  }

  @Access('pos', 'pos.catalog.update')
  @Delete('pos/products/:id')
  async removeProduct(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [p] = await this.db.delete(posProducts).where(and(eq(posProducts.id, id), eq(posProducts.associationId, c.association.id))).returning();
    if (!p) throw NotFound('Produit introuvable.');
    await this.audit.log({ ...log(c), action: 'pos.product.delete', resourceType: 'pos_product', resourceId: id, summary: `Produit « ${p.name} » supprimé (les ventes passées gardent son nom et son prix)` });
    return { ok: true };
  }

  /* ============================================================ Sessions */

  @Access('pos', 'pos.sessions.create')
  @Post('pos/registers/:id/open')
  async open(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const r = await this.register(c, id);
    if (r.archivedAt) throw BadRequest('ARCHIVED', 'Caisse archivée.');
    const input = parse(z.object({ openingFloatCents: z.number().int().min(0).max(10_000_000).default(0), eventId: zUuid.nullable().optional() }), body ?? {});
    return this.db.transaction(async (tx) => {
      const [s] = await tx.insert(posSessions).values({ associationId: c.association.id, registerId: id, number: await next(tx, c.association.id, 'pos-session'), openingFloatCents: input.openingFloatCents, eventId: input.eventId ?? null, openedBy: c.user.id })
        .returning().catch((e: { code?: string; cause?: { code?: string } }) => { if (e.code === '23505' || e.cause?.code === '23505') throw Conflict('ALREADY_OPEN', 'Cette caisse est déjà ouverte.'); throw e; });
      await this.audit.log({ ...log(c), action: 'pos.session.open', resourceType: 'pos_session', resourceId: s.id, summary: `Ouverture de « ${r.name} » (session n° ${s.number}, fond de caisse ${euros(s.openingFloatCents)})` }, tx);
      return s;
    });
  }

  @Access('pos', 'pos.sessions.read')
  @Get('pos/sessions')
  async sessions(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ registerId: zUuid.optional(), status: z.enum(['open', 'closed']).optional() }), query);
    const opener = aliasedTable(users, 'opener'), closer = aliasedTable(users, 'closer');
    const rows = await this.db.select({ s: posSessions, register: posRegisters.name, openedBy: opener.displayName, closedBy: closer.displayName }).from(posSessions)
      .innerJoin(posRegisters, eq(posRegisters.id, posSessions.registerId)).leftJoin(opener, eq(opener.id, posSessions.openedBy)).leftJoin(closer, eq(closer.id, posSessions.closedBy))
      .where(and(eq(posSessions.associationId, c.association.id), q.registerId ? eq(posSessions.registerId, q.registerId) : undefined, q.status ? eq(posSessions.status, q.status) : undefined))
      .orderBy(desc(posSessions.openedAt)).limit(500);
    const totals = await sessionTotals(this.db, rows.map((r) => r.s.id));
    return rows.map((r) => ({ ...r.s, register: r.register, openedByName: r.openedBy, closedByName: r.closedBy, sales: totals.get(r.s.id)?.n ?? 0, totalCents: totals.get(r.s.id)?.cents ?? 0, differenceCents: r.s.countedCashCents != null && r.s.expectedCashCents != null ? r.s.countedCashCents - r.s.expectedCashCents : null }));
  }

  @Access('pos', 'pos.sessions.read')
  @Get('pos/sessions/:id')
  async sessionDetail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.session(c, id);
    const summary = await sessionSummary(this.db, s);
    const seller = aliasedTable(users, 'seller');
    const sales = await this.db.select({ sale: posSales, seller: seller.displayName, methods: sql<string>`(select string_agg(distinct p.method, ',') from pos_payments p where p.sale_id = "pos_sales"."id")` })
      .from(posSales).leftJoin(seller, eq(seller.id, posSales.createdBy)).where(eq(posSales.sessionId, id)).orderBy(desc(posSales.createdAt)).limit(1000);
    const [o] = await this.db.select({ opened: users.displayName }).from(users).where(eq(users.id, s.openedBy ?? '00000000-0000-0000-0000-000000000000'));
    return { ...s, openedByName: o?.opened ?? null, summary, sales: sales.map((r) => ({ ...r.sale, seller: r.seller, methods: r.methods?.split(',') ?? [] })), denominations: DENOMINATIONS };
  }

  @Access('pos', 'pos.sessions.update')
  @Post('pos/sessions/:id/moves')
  async move(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const s = await this.session(c, id);
    if (s.status !== 'open') throw BadRequest('SESSION_CLOSED', 'Session close.');
    const input = parse(z.object({ kind: z.enum(['in', 'out']), amountCents: z.number().int().min(1).max(10_000_000), reason: zOptText(200) }), body);
    const [m] = await this.db.insert(posCashMoves).values({ ...input, sessionId: id, userId: c.user.id }).returning();
    await this.audit.log({ ...log(c), action: 'pos.cash.move', resourceType: 'pos_session', resourceId: id, summary: `${input.kind === 'in' ? 'Apport' : 'Retrait'} d’espèces de ${euros(input.amountCents)} sur « ${s.register} »${input.reason ? ` — ${input.reason}` : ''}` });
    return m;
  }

  @Access('pos', 'pos.sessions.update')
  @Delete('pos/sessions/:id/moves/:moveId')
  async removeMove(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('moveId') moveId: string) {
    const s = await this.session(c, id);
    if (s.status !== 'open') throw BadRequest('SESSION_CLOSED', 'Session close.');
    const n = parse(z.coerce.number().int().positive(), moveId);
    const [m] = await this.db.delete(posCashMoves).where(and(eq(posCashMoves.id, n), eq(posCashMoves.sessionId, id))).returning();
    if (!m) throw NotFound('Mouvement introuvable.');
    await this.audit.log({ ...log(c), action: 'pos.cash.move.delete', resourceType: 'pos_session', resourceId: id, summary: `Mouvement d’espèces de ${euros(m.amountCents)} supprimé sur « ${s.register} »` });
    return { ok: true };
  }

  /** Clôture : comptage des espèces (par coupure ou total), écart calculé et figé. */
  @Access('pos', 'pos.sessions.update')
  @Post('pos/sessions/:id/close')
  @HttpCode(200)
  async close(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const s = await this.session(c, id);
    if (s.status !== 'open') throw BadRequest('SESSION_CLOSED', 'Session déjà close.');
    const input = parse(z.object({
      cashCount: z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(100_000)).optional(),
      countedCashCents: z.number().int().min(0).max(100_000_000).optional(), notes: zOptText(2000),
    }), body ?? {});
    if (input.cashCount && Object.keys(input.cashCount).some((k) => !DENOMINATIONS.includes(Number(k)))) throw BadRequest('INVALID_DENOMINATION', 'Coupure inconnue.');
    const counted = input.cashCount ? Object.entries(input.cashCount).reduce((a, [v, n]) => a + Number(v) * n, 0) : input.countedCashCents ?? null;
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(posSessions).where(eq(posSessions.id, id)).for('update');
      if (locked.status !== 'open') throw BadRequest('SESSION_CLOSED', 'Session déjà close.');
      const sum = await sessionSummary(tx, locked);
      const [n] = await tx.update(posSessions).set({ status: 'closed', closedAt: new Date(), closedBy: c.user.id, expectedCashCents: sum.expectedCashCents, countedCashCents: counted, cashCount: input.cashCount ?? null, notes: input.notes ?? null }).where(eq(posSessions.id, id)).returning();
      const diff = counted == null ? null : counted - sum.expectedCashCents;
      await this.audit.log({ ...log(c), action: 'pos.session.close', resourceType: 'pos_session', resourceId: id, summary: `Clôture de « ${s.register} » (session n° ${s.number}) : ${sum.salesCount} vente(s), ${euros(sum.totalCents)}${diff != null ? `, écart de caisse ${diff === 0 ? 'nul' : `${diff > 0 ? '+' : '−'}${euros(Math.abs(diff))}`}` : ''}` }, tx);
      return { ...n, summary: sum, differenceCents: diff };
    });
  }

  @Access('pos', 'pos.sessions.download')
  @Get('pos/sessions/:id/report.pdf')
  async report(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const s = await this.session(c, id);
    const sum = await sessionSummary(this.db, s);
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const names = await this.db.select({ id: users.id, n: users.displayName }).from(users).where(inArray(users.id, [s.openedBy, s.closedBy].filter((x): x is string => !!x).concat('00000000-0000-0000-0000-000000000000')));
    const pdf = await zReport(a, { ...s, openedBy: names.find((x) => x.id === s.openedBy)?.n ?? null, closedBy: names.find((x) => x.id === s.closedBy)?.n ?? null, cashCount: s.cashCount as Record<string, number> | null }, sum);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cloture-caisse-${s.number}.pdf"`);
    res.send(pdf);
  }

  @Access('pos', 'pos.sessions.export')
  @Get('pos/sessions/:id/sales.csv')
  async exportSales(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const s = await this.session(c, id);
    const rows = await this.db.select({ sale: posSales, line: posSaleLines }).from(posSaleLines).innerJoin(posSales, eq(posSales.id, posSaleLines.saleId)).where(eq(posSales.sessionId, id)).orderBy(asc(posSales.createdAt), asc(posSaleLines.id));
    const pays = await this.db.select({ saleId: posPayments.saleId, method: posPayments.method }).from(posPayments).innerJoin(posSales, eq(posSales.id, posPayments.saleId)).where(eq(posSales.sessionId, id));
    const csv = toCsv(['Ticket', 'Date', 'État', 'Produit', 'Catégorie', 'Quantité', 'Prix unitaire (€)', 'Montant (€)', 'Règlement'],
      rows.map(({ sale, line }) => [sale.number, dt(sale.createdAt), sale.status === 'completed' ? 'Validée' : 'Annulée', line.name, line.category ?? '', String(line.quantity), (line.unitPriceCents / 100).toFixed(2).replace('.', ','), ((line.quantity * line.unitPriceCents) / 100).toFixed(2).replace('.', ','),
        [...new Set(pays.filter((p) => p.saleId === sale.id).map((p) => METHOD[p.method]))].join(' + ')]));
    await this.audit.log({ ...log(c), action: 'pos.export', resourceType: 'pos_session', resourceId: id, summary: `Export des ventes de la session n° ${s.number}` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ventes-caisse-${s.number}.csv"`);
    res.send(csv);
  }

  @Access('pos', 'pos.sessions.delete')
  @Delete('pos/sessions/:id')
  async removeSession(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query('force') force?: string) {
    const s = await this.session(c, id);
    if (s.status === 'open') throw Conflict('SESSION_OPEN', 'Clôturez d’abord la session.');
    const sum = await sessionSummary(this.db, s);
    if (sum.salesCount || sum.voidedCount) requireConfirmation(force, `La session n° ${s.number} compte ${sum.salesCount} vente(s) (${euros(sum.totalCents)}). Elles seront supprimées définitivement, ainsi que le rapport de clôture. Les billets et mouvements de stock déjà faits ne sont pas modifiés.`, { sales: sum.salesCount });
    await this.db.transaction(async (tx) => {
      await tx.delete(posSessions).where(eq(posSessions.id, id));
      await this.audit.log({ ...log(c), action: 'pos.session.delete', resourceType: 'pos_session', resourceId: id, summary: `Suppression de la session de caisse n° ${s.number} (« ${s.register} », ${sum.salesCount} vente(s), ${euros(sum.totalCents)})` }, tx);
    });
    return { ok: true };
  }

  /* ============================================================ Écran de caisse */

  /** Tout ce qu'il faut à l'écran de caisse : session, catalogue actif, billets en vente, dernières ventes. */
  @Access('pos', 'pos.sales.create')
  @Get('pos/sessions/:id/screen')
  async screen(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.session(c, id);
    const cat = await this.catalog(c);
    let events: unknown[] = [];
    if (s.registerTicketSales && this.ticketSales(c)) {
      const from = new Date(Date.now() - 12 * 3600_000);
      const evs = (await effectiveEvents(this.db, and(eq(ticketEvents.associationId, c.association.id), eq(ticketEvents.status, 'on_sale')))).filter((e) => e.startAt >= from).slice(0, 10);
      const k = await counts(this.db, evs.map((e) => e.id));
      const rates = evs.length ? await this.db.select().from(ticketRates).where(inArray(ticketRates.eventId, evs.map((e) => e.id))).orderBy(asc(ticketRates.position)) : [];
      events = evs.map((e) => ({ id: e.id, title: e.title, startAt: e.startAt, remaining: e.capacity == null ? null : Math.max(0, e.capacity - (k.byEvent.get(e.id) ?? 0)), rates: rates.filter((r) => r.eventId === e.id).map((r) => ({ id: r.id, name: r.name, priceCents: r.priceCents })) }));
    }
    const recent = await this.db.select().from(posSales).where(eq(posSales.sessionId, id)).orderBy(desc(posSales.createdAt)).limit(15);
    const totals = (await sessionTotals(this.db, [id])).get(id) ?? { n: 0, cents: 0 };
    return { session: { id: s.id, number: s.number, status: s.status, register: s.register, openedAt: s.openedAt, sales: totals.n, totalCents: totals.cents }, categories: cat.categories, products: cat.products.filter((p) => p.active), events, recent };
  }

  @Access('pos', 'pos.sales.create')
  @Post('pos/sessions/:id/sales')
  async sell(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const s = await this.session(c, id);
    if (s.status !== 'open') throw BadRequest('SESSION_CLOSED', 'Cette caisse est fermée.');
    const input = parse(zSale, body);
    const productIds = input.lines.flatMap((l) => ('productId' in l ? [l.productId] : []));
    const rateIds = input.lines.flatMap((l) => ('ticketRateId' in l ? [l.ticketRateId] : []));
    const products = productIds.length ? await this.db.select({ p: posProducts, category: posCategories.name }).from(posProducts).leftJoin(posCategories, eq(posCategories.id, posProducts.categoryId))
      .where(and(eq(posProducts.associationId, c.association.id), inArray(posProducts.id, productIds), eq(posProducts.active, true))) : [];
    if (new Set(productIds).size !== products.length) throw BadRequest('UNKNOWN_PRODUCT', 'Produit inconnu ou retiré de la vente.');
    let event: typeof ticketEvents.$inferSelect | null = null;
    let rates: (typeof ticketRates.$inferSelect)[] = [];
    if (rateIds.length) {
      if (!s.registerTicketSales || !this.ticketSales(c)) throw BadRequest('TICKETS_DISABLED', 'Cette caisse ne vend pas de billets.');
      rates = await this.db.select().from(ticketRates).where(inArray(ticketRates.id, rateIds));
      const evIds = [...new Set(rates.map((r) => r.eventId))];
      if (rates.length !== new Set(rateIds).size || evIds.length !== 1) throw BadRequest('INVALID_TICKETS', 'Une vente ne porte que sur les billets d’une seule séance.');
      [event] = await this.db.select().from(ticketEvents).where(and(eq(ticketEvents.id, evIds[0]), eq(ticketEvents.associationId, c.association.id)));
      if (!event || event.status !== 'on_sale') throw BadRequest('NOT_ON_SALE', 'Cette séance n’est pas en vente.');
    }
    const lines = input.lines.map((l) => {
      if ('productId' in l) { const p = products.find((x) => x.p.id === l.productId)!; return { kind: 'product', productId: p.p.id, ticketRateId: null, name: p.p.name, category: p.category, unitPriceCents: p.p.priceCents, quantity: l.quantity, stockItemId: this.stockSync(c) ? p.p.stockItemId : null, stockUnits: p.p.stockUnits }; }
      if ('ticketRateId' in l) { const r = rates.find((x) => x.id === l.ticketRateId)!; return { kind: 'ticket', productId: null, ticketRateId: r.id, name: `Billet ${r.name} — ${event!.title}`, category: 'Billetterie', unitPriceCents: r.priceCents, quantity: l.quantity, stockItemId: null, stockUnits: 0 }; }
      return { kind: 'custom', productId: null, ticketRateId: null, name: l.custom, category: null, unitPriceCents: l.priceCents, quantity: l.quantity, stockItemId: null, stockUnits: 0 };
    });
    const total = lines.reduce((a, l) => a + l.unitPriceCents * l.quantity, 0);
    const paid = input.payments.reduce((a, p) => a + p.amountCents, 0);
    if (paid !== total) throw BadRequest('PAYMENT_MISMATCH', `Le règlement (${euros(paid)}) ne correspond pas au total (${euros(total)}).`);
    for (const p of input.payments) if (p.tenderedCents != null && (p.method !== 'cash' || p.tenderedCents < p.amountCents)) throw BadRequest('INVALID_TENDER', 'Montant remis insuffisant.');
    const change = input.payments.reduce((a, p) => a + (p.method === 'cash' && p.tenderedCents != null ? p.tenderedCents - p.amountCents : 0), 0);
    const year = new Date().getFullYear();
    return this.db.transaction(async (tx) => {
      const number = `C${year}-${String(await next(tx, c.association.id, `pos-sale-${year}`)).padStart(5, '0')}`;
      let ticketOrder: { id: string; publicToken: string; number: string } | null = null;
      if (event) {
        const methods = [...new Set(input.payments.map((p) => p.method))];
        const r = await issueOrder(tx, { associationId: c.association.id, event, lines: input.lines.flatMap((l) => ('ticketRateId' in l ? [{ rateId: l.ticketRateId, quantity: l.quantity }] : [])), buyerName: input.buyerName ?? 'Vente en caisse', status: 'paid', channel: 'box_office', paymentMethod: methods.length === 1 ? methods[0] : 'other', createdBy: c.user.id, notes: `Caisse « ${s.register} », ticket ${number}` });
        ticketOrder = r.order;
      }
      const [sale] = await tx.insert(posSales).values({ sessionId: id, number, totalCents: total, createdBy: c.user.id, ticketOrderId: ticketOrder?.id ?? null }).returning();
      await tx.insert(posSaleLines).values(lines.map((l) => ({ ...l, saleId: sale.id, stockUnits: l.stockItemId ? l.stockUnits * l.quantity : 0 })));
      if (input.payments.length) await tx.insert(posPayments).values(input.payments.map((p) => ({ ...p, saleId: sale.id, tenderedCents: p.tenderedCents ?? null })));
      // Stock : décrément sans bloquer la vente (le stock ne descend pas sous zéro, l'écart est signalé).
      const shortages: string[] = [];
      for (const l of lines) {
        if (!l.stockItemId || !l.stockUnits) continue;
        const need = l.stockUnits * l.quantity;
        const [it] = await tx.select().from(stockItems).where(eq(stockItems.id, l.stockItemId)).for('update');
        if (!it) continue;
        const after = Math.max(0, it.quantity - need);
        if (it.quantity < need) shortages.push(it.name);
        if (after !== it.quantity) {
          await tx.update(stockItems).set({ quantity: after, updatedAt: new Date() }).where(eq(stockItems.id, it.id));
          await tx.insert(stockMovements).values({ itemId: it.id, kind: 'out', delta: after - it.quantity, quantityAfter: after, reason: `Vente en caisse ${number}${it.quantity < need ? ' (stock insuffisant)' : ''}`, userId: c.user.id });
        }
      }
      await this.audit.log({ ...log(c), action: 'pos.sale', resourceType: 'pos_sale', resourceId: sale.id, summary: `Vente ${number} sur « ${s.register} » : ${euros(total)} (${input.payments.map((p) => METHOD[p.method]).join(' + ') || 'gratuit'})` }, tx);
      return { ...sale, changeCents: change, shortages, ticketOrder: ticketOrder ? { id: ticketOrder.id, number: ticketOrder.number, url: orderUrl(ticketOrder.publicToken) } : null };
    });
  }

  @Access('pos', 'pos.sales.read')
  @Get('pos/sales/:id')
  async saleDetail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const r = await this.sale(c, id);
    const lines = await this.db.select().from(posSaleLines).where(eq(posSaleLines.saleId, id)).orderBy(asc(posSaleLines.id));
    const payments = await this.db.select().from(posPayments).where(eq(posPayments.saleId, id)).orderBy(asc(posPayments.id));
    return { ...r.sale, register: r.register, sessionStatus: r.session.status, lines, payments };
  }

  /** Annulation (session ouverte) : stock restitué, billets annulés ; la vente reste au journal. */
  @Access('pos', 'pos.sales.cancel')
  @Post('pos/sales/:id/void')
  @HttpCode(200)
  async void(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const r = await this.sale(c, id);
    if (r.sale.status === 'voided') throw BadRequest('ALREADY_VOIDED', 'Vente déjà annulée.');
    if (r.session.status !== 'open') throw BadRequest('SESSION_CLOSED', 'La session est close : la vente ne peut plus être annulée (faites un remboursement dans la session en cours).');
    const { reason } = parse(z.object({ reason: z.string().trim().min(2).max(300) }), body);
    if (r.sale.ticketOrderId) {
      const [used] = await this.db.select({ n: sql<number>`count(*)::int` }).from(tickets).where(and(eq(tickets.orderId, r.sale.ticketOrderId), ne(tickets.status, 'cancelled'), gt(tickets.scannedAt, new Date(0))));
      if (used.n) throw BadRequest('TICKETS_USED', 'Des billets de cette vente ont déjà servi à l’entrée.');
    }
    return this.db.transaction(async (tx) => {
      const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.saleId, id));
      for (const l of lines) {
        if (!l.stockItemId || !l.stockUnits) continue;
        const [it] = await tx.select().from(stockItems).where(eq(stockItems.id, l.stockItemId)).for('update');
        if (!it) continue;
        await tx.update(stockItems).set({ quantity: it.quantity + l.stockUnits, updatedAt: new Date() }).where(eq(stockItems.id, it.id));
        await tx.insert(stockMovements).values({ itemId: it.id, kind: 'in', delta: l.stockUnits, quantityAfter: it.quantity + l.stockUnits, reason: `Annulation de la vente ${r.sale.number}`, userId: c.user.id });
      }
      if (r.sale.ticketOrderId) {
        await tx.update(tickets).set({ status: 'cancelled' }).where(eq(tickets.orderId, r.sale.ticketOrderId));
        await tx.update(ticketOrders).set({ status: 'cancelled', refundedAt: new Date(), updatedAt: new Date() }).where(eq(ticketOrders.id, r.sale.ticketOrderId));
      }
      const [n] = await tx.update(posSales).set({ status: 'voided', voidedAt: new Date(), voidedBy: c.user.id, voidReason: reason }).where(eq(posSales.id, id)).returning();
      await this.audit.log({ ...log(c), action: 'pos.sale.void', resourceType: 'pos_sale', resourceId: id, summary: `Vente ${r.sale.number} annulée (${euros(r.sale.totalCents)}) — ${reason}` }, tx);
      return n;
    });
  }

  @Access('pos', 'pos.sales.read')
  @Get('pos/sales/:id/receipt.pdf')
  async receipt(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const d = await this.saleDetail(c, id);
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const [seller] = d.createdBy ? await this.db.select({ n: users.displayName }).from(users).where(eq(users.id, d.createdBy)) : [];
    const pdf = await receiptPdf({ name: a.name, address: a.addressLine, city: [a.postalCode, a.city].filter(Boolean).join(' ') || null }, { ...d, seller: seller?.n ?? null }, d.lines, d.payments);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ticket-${d.number}.pdf"`);
    res.send(pdf);
  }
}
