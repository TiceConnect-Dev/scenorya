import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Conflict, NotFound } from '../common/errors';
import { toCsv } from '../common/csv';
import { requireConfirmation } from '../common/purge';
import { DB, Db } from '../db/db';
import { bookingItems, bookings, maintenanceTickets, stockItems, stockLocations, stockMovements, users } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';
import { loadConfig } from '../config';
import { availability } from './availability';
import { labelsPdf } from './labels-pdf';

const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zDate = z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional());
const zItem = z.object({
  name: z.string().trim().min(1).max(160),
  reference: zOptText(40), category: zOptText(60),
  kind: z.enum(['equipment', 'consumable']).default('equipment'),
  quantity: z.number().int().min(0).max(1_000_000).default(1),
  unit: zOptText(20), minQuantity: z.number().int().min(0).max(1_000_000).nullable().optional(),
  locationId: zUuid.nullable().optional(),
  brand: zOptText(80), model: zOptText(80), serialNumber: zOptText(80),
  valueCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(), purchasedOn: zDate,
  condition: z.enum(['good', 'worn', 'broken']).default('good'),
  loanable: z.boolean().default(true),
  notes: zOptText(2000),
});
const MOVE: Record<string, string> = { in: 'Entrée', out: 'Sortie', adjust: 'Inventaire', lost: 'Perte' };

@ApiTags('Scenorya Stock')
@Controller()
export class StockController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'stock',
      check: async (db, associationId) => {
        const out: ModuleImpact[] = [];
        const [i] = await db.select({ n: sql<number>`count(*)::int` }).from(stockItems).where(and(eq(stockItems.associationId, associationId), isNull(stockItems.archivedAt)));
        if (i.n > 0) out.push({ module: 'stock', level: 'info', message: `${i.n} article(s) conservé(s).` });
        return out;
      },
    });
  }

  private async item(associationId: string, id: string) {
    parse(zUuid, id);
    const [i] = await this.db.select().from(stockItems).where(and(eq(stockItems.id, id), eq(stockItems.associationId, associationId)));
    if (!i) throw NotFound('Article introuvable.');
    return i;
  }

  private async assertLocation(associationId: string, id: string | null | undefined) {
    if (!id) return;
    const [l] = await this.db.select({ id: stockLocations.id }).from(stockLocations).where(and(eq(stockLocations.id, id), eq(stockLocations.associationId, associationId)));
    if (!l) throw BadRequest('UNKNOWN_LOCATION', 'Emplacement inconnu.');
  }

  private dupe(e: unknown): never {
    const x = e as { code?: string; cause?: { code?: string } };
    if (x.code === '23505' || x.cause?.code === '23505') throw Conflict('REFERENCE_TAKEN', 'Cette référence est déjà utilisée par un autre article.');
    throw e;
  }

  /* ============================================================ Emplacements */

  @Access('stock', 'stock.locations.read')
  @Get('stock/locations')
  async locations(@AssocContext() c: AssocCtx) {
    return this.db.select({ id: stockLocations.id, name: stockLocations.name, description: stockLocations.description, items: sql<number>`(select count(*)::int from stock_items i where i.location_id = "stock_locations"."id" and i.archived_at is null)` })
      .from(stockLocations).where(eq(stockLocations.associationId, c.association.id)).orderBy(asc(stockLocations.name));
  }

  @Access('stock', 'stock.locations.update')
  @Post('stock/locations')
  async addLocation(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(1).max(120), description: zOptText(500) }), body);
    const [l] = await this.db.insert(stockLocations).values({ ...input, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'stock.location.create', resourceType: 'stock_location', resourceId: l.id, summary: `Emplacement « ${l.name} » créé` });
    return l;
  }

  @Access('stock', 'stock.locations.update')
  @Patch('stock/locations/:id')
  async updateLocation(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const input = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), description: zOptText(500) }), body);
    const [l] = await this.db.update(stockLocations).set(input).where(and(eq(stockLocations.id, id), eq(stockLocations.associationId, c.association.id))).returning();
    if (!l) throw NotFound('Emplacement introuvable.');
    return l;
  }

  @Access('stock', 'stock.locations.update')
  @Delete('stock/locations/:id')
  async removeLocation(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [l] = await this.db.delete(stockLocations).where(and(eq(stockLocations.id, id), eq(stockLocations.associationId, c.association.id))).returning();
    if (!l) throw NotFound('Emplacement introuvable.');
    await this.audit.log({ ...log(c), action: 'stock.location.delete', resourceType: 'stock_location', resourceId: id, summary: `Emplacement « ${l.name} » supprimé (ses articles n’ont plus d’emplacement)` });
    return { ok: true };
  }

  /* ============================================================ Articles */

  @Access('stock', 'stock.items.read')
  @Get('stock/items')
  async list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ q: z.string().max(100).optional(), category: z.string().max(60).optional(), locationId: zUuid.optional(), archived: z.enum(['true', 'false']).default('false'), low: z.enum(['true', 'false']).optional(), kind: z.enum(['equipment', 'consumable']).optional() }), query);
    const term = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await this.db.select({ i: stockItems, location: stockLocations.name, out: sql<number>`coalesce((select sum(t.units_out) from maintenance_tickets t where t.item_id = "stock_items"."id" and t.status not in ('done', 'cancelled')), 0)::int` })
      .from(stockItems).leftJoin(stockLocations, eq(stockLocations.id, stockItems.locationId))
      .where(and(
        eq(stockItems.associationId, c.association.id),
        q.archived === 'true' ? isNotNull(stockItems.archivedAt) : isNull(stockItems.archivedAt),
        term ? or(ilike(stockItems.name, term), ilike(stockItems.reference, term), ilike(stockItems.serialNumber, term), ilike(stockItems.brand, term), ilike(stockItems.model, term)) : undefined,
        q.category ? eq(stockItems.category, q.category) : undefined,
        q.locationId ? eq(stockItems.locationId, q.locationId) : undefined,
        q.kind ? eq(stockItems.kind, q.kind) : undefined,
        q.low === 'true' ? sql`${stockItems.minQuantity} is not null and ${stockItems.quantity} <= ${stockItems.minQuantity}` : undefined,
      )).orderBy(asc(stockItems.category), asc(stockItems.name)).limit(2000);
    return rows.map(({ i, location, out }) => ({ ...i, location, outOfService: out, low: i.minQuantity != null && i.quantity <= i.minQuantity }));
  }

  @Access('stock', 'stock.items.read')
  @Get('stock/categories')
  async categories(@AssocContext() c: AssocCtx) {
    const rows = await this.db.selectDistinct({ c: stockItems.category }).from(stockItems).where(and(eq(stockItems.associationId, c.association.id), isNotNull(stockItems.category))).orderBy(asc(stockItems.category));
    return rows.map((r) => r.c);
  }

  @Access('stock', 'stock.items.create')
  @Post('stock/items')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zItem, body);
    await this.assertLocation(c.association.id, input.locationId);
    const i = await this.db.transaction(async (tx) => {
      const [i] = await tx.insert(stockItems).values({ ...input, purchasedOn: input.purchasedOn ?? null, associationId: c.association.id, createdBy: c.user.id }).returning().catch((e) => this.dupe(e));
      if (i.quantity > 0) await tx.insert(stockMovements).values({ itemId: i.id, kind: 'in', delta: i.quantity, quantityAfter: i.quantity, reason: 'Création de l’article', userId: c.user.id });
      await this.audit.log({ ...log(c), action: 'stock.item.create', resourceType: 'stock_item', resourceId: i.id, summary: `Article « ${i.name} » créé (${i.quantity}${i.unit ? ` ${i.unit}` : ''})` }, tx);
      return i;
    });
    return i;
  }

  @Access('stock', 'stock.items.read')
  @Get('stock/items/:id')
  async detail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const i = await this.item(c.association.id, id);
    const [loc] = i.locationId ? await this.db.select().from(stockLocations).where(eq(stockLocations.id, i.locationId)) : [];
    const moves = await this.db.select({ m: stockMovements, user: users.displayName }).from(stockMovements).leftJoin(users, eq(users.id, stockMovements.userId))
      .where(eq(stockMovements.itemId, id)).orderBy(desc(stockMovements.id)).limit(100);
    const now = new Date();
    const av = (await availability(this.db, c.association.id, [id], now, new Date(now.getTime() + 60_000))).get(id);
    const tickets = c.modules.maintenance?.usable
      ? await this.db.select({ id: maintenanceTickets.id, title: maintenanceTickets.title, status: maintenanceTickets.status, priority: maintenanceTickets.priority, unitsOut: maintenanceTickets.unitsOut, createdAt: maintenanceTickets.createdAt })
        .from(maintenanceTickets).where(eq(maintenanceTickets.itemId, id)).orderBy(desc(maintenanceTickets.createdAt)).limit(20)
      : [];
    const loans = c.modules.booking?.usable
      ? await this.db.select({ id: bookings.id, title: bookings.title, startAt: bookings.startAt, endAt: bookings.endAt, status: bookings.status, checkedOutAt: bookings.checkedOutAt, returnedAt: bookings.returnedAt, quantity: bookingItems.quantity })
        .from(bookingItems).innerJoin(bookings, eq(bookings.id, bookingItems.bookingId))
        .where(and(eq(bookingItems.itemId, id), inArray(bookings.status, ['pending', 'confirmed']), or(gte(bookings.endAt, now), and(isNotNull(bookings.checkedOutAt), isNull(bookings.returnedAt)))))
        .orderBy(asc(bookings.startAt)).limit(20)
      : [];
    return {
      ...i, location: loc ? { id: loc.id, name: loc.name } : null, availableNow: av?.available ?? i.quantity, outOfService: av?.outOfService ?? 0,
      movements: moves.map((r) => ({ ...r.m, user: r.user })), tickets, loans,
    };
  }

  @Access('stock', 'stock.items.update')
  @Patch('stock/items/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.item(c.association.id, id);
    // La quantité ne change que par un mouvement (traçabilité).
    const input = parse(patchOf(zItem.omit({ quantity: true })), body);
    await this.assertLocation(c.association.id, input.locationId);
    const [i] = await this.db.update(stockItems).set({ ...input, updatedAt: new Date() }).where(eq(stockItems.id, id)).returning().catch((e) => this.dupe(e));
    await this.audit.log({ ...log(c), action: 'stock.item.update', resourceType: 'stock_item', resourceId: id, summary: `Article « ${before.name} » modifié${input.condition && input.condition !== before.condition ? ` (état : ${input.condition})` : ''}` });
    return i;
  }

  /** Entrée, sortie, perte ou comptage d'inventaire (quantité constatée). */
  @Access('stock', 'stock.items.update')
  @Post('stock/items/:id/movements')
  async move(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.item(c.association.id, id);
    const input = parse(z.object({ kind: z.enum(['in', 'out', 'adjust', 'lost']), quantity: z.number().int().min(0).max(1_000_000), reason: zOptText(300) }), body);
    if (input.kind !== 'adjust' && input.quantity === 0) throw BadRequest('INVALID_QUANTITY', 'Quantité nulle.');
    return this.db.transaction(async (tx) => {
      const [i] = await tx.select().from(stockItems).where(eq(stockItems.id, id)).for('update');
      const after = input.kind === 'adjust' ? input.quantity : input.kind === 'in' ? i.quantity + input.quantity : i.quantity - input.quantity;
      if (after < 0) throw BadRequest('INSUFFICIENT_STOCK', `Stock insuffisant : ${i.quantity} disponible(s).`);
      const delta = after - i.quantity;
      await tx.update(stockItems).set({ quantity: after, updatedAt: new Date() }).where(eq(stockItems.id, id));
      const [m] = await tx.insert(stockMovements).values({ itemId: id, kind: input.kind, delta, quantityAfter: after, reason: input.reason ?? null, userId: c.user.id }).returning();
      await this.audit.log({ ...log(c), action: 'stock.movement', resourceType: 'stock_item', resourceId: id, summary: `${MOVE[input.kind]} sur « ${i.name} » : ${delta >= 0 ? '+' : ''}${delta} (stock : ${after})${input.reason ? ` — ${input.reason}` : ''}` }, tx);
      return m;
    });
  }

  @Access('stock', 'stock.items.update')
  @Post('stock/items/:id/archive')
  @HttpCode(200)
  async archive(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const i = await this.item(c.association.id, id);
    const { restore } = parse(z.object({ restore: z.boolean().default(false) }), body ?? {});
    await this.db.update(stockItems).set({ archivedAt: restore ? null : new Date(), updatedAt: new Date() }).where(eq(stockItems.id, id));
    await this.audit.log({ ...log(c), action: restore ? 'stock.item.restore' : 'stock.item.archive', resourceType: 'stock_item', resourceId: id, summary: `Article « ${i.name} » ${restore ? 'restauré' : 'archivé (réformé)'}` });
    return { ok: true };
  }

  /** Suppression définitive : historique, interventions et entretiens compris ; confirmation si des prêts sont en cours ou à venir. */
  @Access('stock', 'stock.items.delete')
  @Delete('stock/items/:id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query('force') force?: string) {
    const i = await this.item(c.association.id, id);
    const [loans] = await this.db.select({ n: sql<number>`count(*)::int` }).from(bookingItems).innerJoin(bookings, eq(bookings.id, bookingItems.bookingId))
      .where(and(eq(bookingItems.itemId, id), inArray(bookings.status, ['pending', 'confirmed']), isNull(bookings.returnedAt), or(gte(bookings.endAt, new Date()), isNotNull(bookings.checkedOutAt))));
    const [tk] = await this.db.select({ n: sql<number>`count(*)::int` }).from(maintenanceTickets).where(and(eq(maintenanceTickets.itemId, id), ne(maintenanceTickets.status, 'done'), ne(maintenanceTickets.status, 'cancelled')));
    if (loans.n || tk.n) requireConfirmation(force, `« ${i.name} » figure dans ${loans.n} prêt(s) en cours ou à venir et ${tk.n} intervention(s) ouverte(s). Il en sera retiré. Pour un matériel réformé, préférez « Archiver ».`, { loans: loans.n, tickets: tk.n });
    await this.db.transaction(async (tx) => {
      await tx.delete(stockItems).where(eq(stockItems.id, id));
      await this.audit.log({ ...log(c), action: 'stock.item.delete', resourceType: 'stock_item', resourceId: id, summary: `Suppression définitive de l’article « ${i.name} »${i.reference ? ` (${i.reference})` : ''}` }, tx);
    });
    return { ok: true };
  }

  @Access('stock', 'stock.items.export')
  @Get('stock/items.csv')
  async exportCsv(@AssocContext() c: AssocCtx, @Res() res: Response) {
    const rows = await this.list(c, {});
    const csv = toCsv(['Référence', 'Nom', 'Catégorie', 'Type', 'Quantité', 'Unité', 'Seuil', 'Emplacement', 'Marque', 'Modèle', 'N° de série', 'État', 'Valeur (€)', 'Achat', 'Prêtable', 'Hors service'],
      rows.map((r) => [r.reference ?? '', r.name, r.category ?? '', r.kind === 'equipment' ? 'Matériel' : 'Consommable', String(r.quantity), r.unit ?? '', r.minQuantity != null ? String(r.minQuantity) : '', r.location ?? '', r.brand ?? '', r.model ?? '', r.serialNumber ?? '',
        { good: 'Bon', worn: 'Usé', broken: 'Hors d’usage' }[r.condition] ?? r.condition, r.valueCents != null ? (r.valueCents / 100).toFixed(2).replace('.', ',') : '', r.purchasedOn ?? '', r.loanable ? 'Oui' : 'Non', String(r.outOfService)]));
    await this.audit.log({ ...log(c), action: 'stock.export', resourceType: 'stock_item', summary: `Export de l’inventaire (${rows.length} article(s))` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventaire.csv"');
    res.send(csv);
  }

  /** Étiquettes QR : le code renvoie vers la fiche de l'article (connexion requise). */
  @Access('stock', 'stock.items.download')
  @Get('stock/labels.pdf')
  async labels(@AssocContext() c: AssocCtx, @Query('ids') ids: string | undefined, @Res() res: Response) {
    const list = (ids ?? '').split(',').filter(Boolean);
    list.forEach((x) => parse(zUuid, x));
    if (!list.length || list.length > 500) throw BadRequest('INVALID_SELECTION', 'Sélectionnez de 1 à 500 articles.');
    const rows = await this.db.select({ i: stockItems, location: stockLocations.name }).from(stockItems).leftJoin(stockLocations, eq(stockLocations.id, stockItems.locationId))
      .where(and(eq(stockItems.associationId, c.association.id), inArray(stockItems.id, list))).orderBy(asc(stockItems.reference), asc(stockItems.name));
    const base = loadConfig().PUBLIC_URL.replace(/\/$/, '');
    const pdf = await labelsPdf(c.association.name, rows.map((r) => ({ name: r.i.name, reference: r.i.reference, location: r.location, url: `${base}/stock/articles/${r.i.id}` })));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="etiquettes.pdf"');
    res.send(pdf);
  }

  /** Disponibilité sur un créneau (prêts et hors-service déduits). */
  @Access('stock', 'stock.items.read')
  @Get('stock/availability')
  async avail(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date(), excludeBookingId: zUuid.optional() }), query);
    if (q.to <= q.from) throw BadRequest('INVALID_DATES', 'La fin doit suivre le début.');
    return [...(await availability(this.db, c.association.id, null, q.from, q.to, q.excludeBookingId)).values()];
  }
}
