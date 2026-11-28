import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { grantsCover, isFeatureEnabled } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Conflict, Forbidden, NotFound } from '../common/errors';
import { requireConfirmation } from '../common/purge';
import { DB, Db, DbOrTx } from '../db/db';
import { bookingItems, bookingResources, bookings, events, stockItems, stockMovements, users } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';
import { availability } from '../stock/availability';

const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zResource = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['room', 'vehicle', 'equipment', 'other']).default('room'),
  capacity: z.number().int().min(0).max(100_000).nullable().optional(),
  location: zOptText(200), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  requiresApproval: z.boolean().default(false), notes: zOptText(2000),
});
const zLine = z.object({ itemId: zUuid, quantity: z.number().int().min(1).max(100_000) });
const zBooking = z.object({
  resourceId: zUuid.nullable().optional(),
  title: z.string().trim().min(1).max(160),
  startAt: z.coerce.date(), endAt: z.coerce.date(),
  contact: zOptText(200), notes: zOptText(2000),
  items: z.array(zLine).max(200).default([]),
});
const fmt = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d);
type Row = typeof bookings.$inferSelect;

@ApiTags('Scenorya Booking')
@Controller()
export class BookingController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'booking',
      check: async (db, associationId) => {
        const out: ModuleImpact[] = [];
        const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(eq(bookings.associationId, associationId), inArray(bookings.status, ['pending', 'confirmed']), gt(bookings.endAt, new Date())));
        if (b.n > 0) out.push({ module: 'booking', level: 'warning', message: `${b.n} réservation(s) à venir ne seront plus visibles (conservées).` });
        const [o] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(eq(bookings.associationId, associationId), isNotNull(bookings.checkedOutAt), isNull(bookings.returnedAt)));
        if (o.n > 0) out.push({ module: 'booking', level: 'warning', message: `${o.n} prêt(s) de matériel non rendu(s).` });
        return out;
      },
    });
    this.modules.registerImpactProvider({
      module: 'stock',
      check: async (db, associationId) => {
        const [o] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings).innerJoin(bookingItems, eq(bookingItems.bookingId, bookings.id))
          .where(and(eq(bookings.associationId, associationId), inArray(bookings.status, ['pending', 'confirmed']), isNull(bookings.returnedAt)));
        return o.n > 0 ? [{ module: 'booking', level: 'warning', message: `Les prêts de matériel de Booking seront masqués (${o.n} ligne(s) en cours).` } as ModuleImpact] : [];
      },
    });
  }

  private canValidate(c: AssocCtx) { return grantsCover(c.grants, 'booking.bookings.validate'); }
  private loans(c: AssocCtx) { return !!c.modules.stock?.usable && isFeatureEnabled(c.modules, 'booking.equipmentLoans'); }

  private async booking(associationId: string, id: string) {
    parse(zUuid, id);
    const [b] = await this.db.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.associationId, associationId)));
    if (!b) throw NotFound('Réservation introuvable.');
    return b;
  }

  private async resource(associationId: string, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select().from(bookingResources).where(and(eq(bookingResources.id, id), eq(bookingResources.associationId, associationId)));
    if (!r) throw NotFound('Ressource introuvable.');
    return r;
  }

  /** Le demandeur garde la main sur sa demande ; sinon il faut le droit de modifier les réservations. */
  private assertOwner(c: AssocCtx, b: Row) {
    if (b.requestedBy !== c.user.id && !grantsCover(c.grants, 'booking.bookings.update')) throw Forbidden('NOT_OWNER', 'Vous ne pouvez modifier que vos propres réservations.');
  }

  /** Contrôles sous verrou : chevauchement sur la salle, disponibilité du matériel. */
  private async check(tx: DbOrTx, c: AssocCtx, input: { resourceId?: string | null; startAt: Date; endAt: Date; items: { itemId: string; quantity: number }[] }, excludeId?: string) {
    if (input.endAt <= input.startAt) throw BadRequest('INVALID_DATES', 'La fin doit suivre le début.');
    if (input.endAt.getTime() - input.startAt.getTime() > 366 * 86_400_000) throw BadRequest('INVALID_DATES', 'Une réservation ne peut dépasser un an.');
    if (!input.resourceId && !input.items.length) throw BadRequest('EMPTY_BOOKING', 'Choisissez une ressource ou du matériel.');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${c.association.id}`}))`);
    if (input.resourceId) {
      await this.resource(c.association.id, input.resourceId);
      const clash = await tx.select({ id: bookings.id, title: bookings.title, startAt: bookings.startAt, endAt: bookings.endAt }).from(bookings)
        .where(and(eq(bookings.resourceId, input.resourceId), inArray(bookings.status, ['pending', 'confirmed']), lt(bookings.startAt, input.endAt), gt(bookings.endAt, input.startAt), excludeId ? ne(bookings.id, excludeId) : undefined)).limit(1);
      if (clash.length) throw Conflict('RESOURCE_BUSY', `Ressource déjà réservée : « ${clash[0].title} » (${fmt(clash[0].startAt)} – ${fmt(clash[0].endAt)}).`, { bookingId: clash[0].id });
    }
    if (input.items.length) {
      if (!this.loans(c)) throw BadRequest('LOANS_DISABLED', 'Le prêt de matériel n’est pas activé.');
      const ids = [...new Set(input.items.map((i) => i.itemId))];
      if (ids.length !== input.items.length) throw BadRequest('DUPLICATE_ITEM', 'Un article figure deux fois.');
      const found = await tx.select({ id: stockItems.id, name: stockItems.name, loanable: stockItems.loanable }).from(stockItems)
        .where(and(eq(stockItems.associationId, c.association.id), inArray(stockItems.id, ids), isNull(stockItems.archivedAt)));
      if (found.length !== ids.length) throw BadRequest('UNKNOWN_ITEM', 'Article inconnu ou archivé.');
      const notLoanable = found.find((f) => !f.loanable);
      if (notLoanable) throw BadRequest('NOT_LOANABLE', `« ${notLoanable.name} » n’est pas prêtable.`);
      const av = await availability(tx, c.association.id, ids, input.startAt, input.endAt, excludeId);
      const short = input.items.map((l) => ({ l, a: av.get(l.itemId)!, name: found.find((f) => f.id === l.itemId)!.name })).filter((x) => x.a.available < x.l.quantity);
      if (short.length) throw Conflict('NOT_AVAILABLE', `Matériel insuffisant sur ce créneau : ${short.map((s) => `« ${s.name} » (${s.a.available} disponible(s) sur ${s.l.quantity} demandé(s))`).join(', ')}.`, { items: short.map((s) => ({ itemId: s.l.itemId, available: s.a.available })) });
    }
  }

  /** Événement d'agenda (fonctionnalité booking.agenda) pour les réservations confirmées. */
  private async syncEvent(tx: DbOrTx, c: AssocCtx, b: Row) {
    if (!c.modules.agenda?.usable || !isFeatureEnabled(c.modules, 'booking.agenda')) return;
    if (b.status !== 'confirmed') {
      if (b.eventId) { await tx.delete(events).where(eq(events.id, b.eventId)); await tx.update(bookings).set({ eventId: null }).where(eq(bookings.id, b.id)); }
      return;
    }
    const [r] = b.resourceId ? await tx.select().from(bookingResources).where(eq(bookingResources.id, b.resourceId)) : [];
    const values = { title: r ? `${r.name} — ${b.title}` : `Prêt — ${b.title}`, category: 'other', startAt: b.startAt, endAt: b.endAt, location: r?.location ?? r?.name ?? null, description: b.notes, visibility: 'internal', updatedAt: new Date() };
    if (b.eventId) {
      const [still] = await tx.update(events).set(values).where(eq(events.id, b.eventId)).returning({ id: events.id });
      if (still) return;
    }
    const [e] = await tx.insert(events).values({ ...values, associationId: c.association.id, createdBy: c.user.id }).returning({ id: events.id });
    await tx.update(bookings).set({ eventId: e.id }).where(eq(bookings.id, b.id));
  }

  /* ============================================================ Ressources */

  @Access('booking', 'booking.resources.read')
  @Get('booking/resources')
  async resources(@AssocContext() c: AssocCtx) {
    return this.db.select().from(bookingResources).where(eq(bookingResources.associationId, c.association.id)).orderBy(asc(bookingResources.name));
  }

  @Access('booking', 'booking.resources.update')
  @Post('booking/resources')
  async addResource(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zResource, body);
    const [r] = await this.db.insert(bookingResources).values({ ...input, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'booking.resource.create', resourceType: 'booking_resource', resourceId: r.id, summary: `Ressource « ${r.name} » créée` });
    return r;
  }

  @Access('booking', 'booking.resources.update')
  @Patch('booking/resources/:id')
  async updateResource(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.resource(c.association.id, id);
    const input = parse(patchOf(zResource), body);
    const [r] = await this.db.update(bookingResources).set({ ...input, updatedAt: new Date() }).where(eq(bookingResources.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'booking.resource.update', resourceType: 'booking_resource', resourceId: id, summary: `Ressource « ${r.name} » modifiée` });
    return r;
  }

  @Access('booking', 'booking.resources.update')
  @Delete('booking/resources/:id')
  async removeResource(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query('force') force?: string) {
    const r = await this.resource(c.association.id, id);
    const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(eq(bookings.resourceId, id), inArray(bookings.status, ['pending', 'confirmed']), gt(bookings.endAt, new Date())));
    if (n.n) requireConfirmation(force, `${n.n} réservation(s) à venir de « ${r.name} » seront supprimées.`, { bookings: n.n });
    await this.db.transaction(async (tx) => {
      const evs = await tx.select({ e: bookings.eventId }).from(bookings).where(and(eq(bookings.resourceId, id), isNotNull(bookings.eventId)));
      if (evs.length) await tx.delete(events).where(inArray(events.id, evs.map((x) => x.e!)));
      await tx.delete(bookingResources).where(eq(bookingResources.id, id));
      await this.audit.log({ ...log(c), action: 'booking.resource.delete', resourceType: 'booking_resource', resourceId: id, summary: `Ressource « ${r.name} » supprimée avec ses réservations` }, tx);
    });
    return { ok: true };
  }

  /* ============================================================ Réservations */

  @Access('booking', 'booking.bookings.read')
  @Get('booking/bookings')
  async list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), resourceId: zUuid.optional(), status: z.enum(['pending', 'confirmed', 'rejected', 'cancelled', 'active']).optional(), mine: z.enum(['true', 'false']).optional(), loans: z.enum(['out', 'true']).optional() }), query);
    const rows = await this.db.select({ b: bookings, resource: bookingResources.name, color: bookingResources.color, requester: users.displayName }).from(bookings)
      .leftJoin(bookingResources, eq(bookingResources.id, bookings.resourceId)).leftJoin(users, eq(users.id, bookings.requestedBy))
      .where(and(
        eq(bookings.associationId, c.association.id),
        q.from ? gt(bookings.endAt, q.from) : undefined, q.to ? lt(bookings.startAt, q.to) : undefined,
        q.resourceId ? eq(bookings.resourceId, q.resourceId) : undefined,
        q.status === 'active' ? inArray(bookings.status, ['pending', 'confirmed']) : q.status ? eq(bookings.status, q.status) : undefined,
        q.mine === 'true' ? eq(bookings.requestedBy, c.user.id) : undefined,
        q.loans === 'out' ? and(isNotNull(bookings.checkedOutAt), isNull(bookings.returnedAt)) : undefined,
        q.loans === 'true' ? sql`exists (select 1 from booking_items bi where bi.booking_id = "bookings"."id")` : undefined,
      )).orderBy(asc(bookings.startAt)).limit(1000);
    const ids = rows.map((r) => r.b.id);
    const lines = ids.length && this.loans(c) ? await this.db.select({ bookingId: bookingItems.bookingId, itemId: bookingItems.itemId, quantity: bookingItems.quantity, returnedQuantity: bookingItems.returnedQuantity, name: stockItems.name, reference: stockItems.reference })
      .from(bookingItems).innerJoin(stockItems, eq(stockItems.id, bookingItems.itemId)).where(inArray(bookingItems.bookingId, ids)) : [];
    return rows.map((r) => ({ ...r.b, resource: r.resource, color: r.color, requester: r.requester, mine: r.b.requestedBy === c.user.id, items: lines.filter((l) => l.bookingId === r.b.id).map(({ bookingId: _b, ...l }) => l) }));
  }

  @Access('booking', 'booking.bookings.read')
  @Get('booking/bookings/:id')
  async detail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    await this.booking(c.association.id, id);
    const [b] = (await this.list(c, {})).filter((x) => x.id === id);
    if (b) return { ...b, canValidate: this.canValidate(c) };
    const row = await this.booking(c.association.id, id);
    return { ...row, items: [], canValidate: this.canValidate(c) };
  }

  @Access('booking', 'booking.bookings.create')
  @Post('booking/bookings')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zBooking, body);
    return this.db.transaction(async (tx) => {
      await this.check(tx, c, input);
      const [r] = input.resourceId ? await tx.select().from(bookingResources).where(eq(bookingResources.id, input.resourceId)) : [];
      // Validation requise pour les ressources qui l'exigent et pour les prêts de matériel seuls, sauf droit de validation.
      const status = this.canValidate(c) || (r && !r.requiresApproval) ? 'confirmed' : 'pending';
      const [b] = await tx.insert(bookings).values({ associationId: c.association.id, resourceId: input.resourceId ?? null, title: input.title, startAt: input.startAt, endAt: input.endAt, contact: input.contact ?? null, notes: input.notes ?? null, status, requestedBy: c.user.id }).returning();
      if (input.items.length) await tx.insert(bookingItems).values(input.items.map((l) => ({ bookingId: b.id, itemId: l.itemId, quantity: l.quantity })));
      await this.syncEvent(tx, c, b);
      await this.audit.log({ ...log(c), action: 'booking.create', resourceType: 'booking', resourceId: b.id, summary: `Réservation « ${b.title} »${r ? ` (${r.name})` : ''} du ${fmt(b.startAt)} au ${fmt(b.endAt)}${status === 'pending' ? ' — en attente de validation' : ''}` }, tx);
      return b;
    });
  }

  @Access('booking', 'booking.bookings.create')
  @Patch('booking/bookings/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.booking(c.association.id, id);
    this.assertOwner(c, before);
    if (before.status === 'rejected' || before.status === 'cancelled') throw BadRequest('BOOKING_CLOSED', 'Réservation refusée ou annulée.');
    if (before.returnedAt) throw BadRequest('BOOKING_CLOSED', 'Le matériel a déjà été rendu.');
    const input = parse(patchOf(zBooking), body);
    return this.db.transaction(async (tx) => {
      const lines = input.items ?? (await tx.select({ itemId: bookingItems.itemId, quantity: bookingItems.quantity }).from(bookingItems).where(eq(bookingItems.bookingId, id)));
      if (before.checkedOutAt && input.items) throw BadRequest('ALREADY_OUT', 'Le matériel est sorti : sa liste ne peut plus changer.');
      const next = { resourceId: input.resourceId !== undefined ? input.resourceId : before.resourceId, startAt: input.startAt ?? before.startAt, endAt: input.endAt ?? before.endAt, items: lines };
      await this.check(tx, c, next, id);
      // Un demandeur sans droit de validation qui modifie une demande confirmée la repasse en attente (si la ressource l'exige).
      const [r] = next.resourceId ? await tx.select().from(bookingResources).where(eq(bookingResources.id, next.resourceId)) : [];
      const moved = +next.startAt !== +before.startAt || +next.endAt !== +before.endAt || next.resourceId !== before.resourceId || !!input.items;
      const status = before.status === 'confirmed' && moved && !this.canValidate(c) && r?.requiresApproval ? 'pending' : before.status;
      const [b] = await tx.update(bookings).set({ resourceId: next.resourceId ?? null, startAt: next.startAt, endAt: next.endAt, title: input.title ?? before.title, contact: input.contact !== undefined ? input.contact : before.contact, notes: input.notes !== undefined ? input.notes : before.notes, status, updatedAt: new Date() }).where(eq(bookings.id, id)).returning();
      if (input.items) {
        await tx.delete(bookingItems).where(eq(bookingItems.bookingId, id));
        if (input.items.length) await tx.insert(bookingItems).values(input.items.map((l) => ({ bookingId: id, itemId: l.itemId, quantity: l.quantity })));
      }
      await this.syncEvent(tx, c, b);
      await this.audit.log({ ...log(c), action: 'booking.update', resourceType: 'booking', resourceId: id, summary: `Réservation « ${b.title} » modifiée${status !== before.status ? ' (de nouveau en attente)' : ''}` }, tx);
      return b;
    });
  }

  @Access('booking', 'booking.bookings.validate')
  @Post('booking/bookings/:id/decision')
  @HttpCode(200)
  async decide(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.booking(c.association.id, id);
    const input = parse(z.object({ accept: z.boolean(), note: zOptText(500) }), body);
    if (before.status !== 'pending') throw BadRequest('NOT_PENDING', 'Cette demande a déjà été traitée.');
    return this.db.transaction(async (tx) => {
      if (input.accept) {
        const lines = await tx.select({ itemId: bookingItems.itemId, quantity: bookingItems.quantity }).from(bookingItems).where(eq(bookingItems.bookingId, id));
        await this.check(tx, c, { resourceId: before.resourceId, startAt: before.startAt, endAt: before.endAt, items: lines }, id);
      }
      const [b] = await tx.update(bookings).set({ status: input.accept ? 'confirmed' : 'rejected', decisionNote: input.note ?? null, updatedAt: new Date() }).where(eq(bookings.id, id)).returning();
      await this.syncEvent(tx, c, b);
      await this.audit.log({ ...log(c), action: input.accept ? 'booking.accept' : 'booking.reject', resourceType: 'booking', resourceId: id, summary: `Réservation « ${b.title} » ${input.accept ? 'acceptée' : 'refusée'}${input.note ? ` — ${input.note}` : ''}` }, tx);
      return b;
    });
  }

  @Access('booking', 'booking.bookings.create')
  @Post('booking/bookings/:id/cancel')
  @HttpCode(200)
  async cancel(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const before = await this.booking(c.association.id, id);
    if (before.requestedBy !== c.user.id && !this.canValidate(c) && !grantsCover(c.grants, 'booking.bookings.update')) throw Forbidden('NOT_OWNER', 'Vous ne pouvez annuler que vos propres réservations.');
    if (before.checkedOutAt && !before.returnedAt) throw BadRequest('ALREADY_OUT', 'Le matériel est sorti : enregistrez d’abord son retour.');
    if (!['pending', 'confirmed'].includes(before.status)) throw BadRequest('BOOKING_CLOSED', 'Réservation déjà close.');
    return this.db.transaction(async (tx) => {
      const [b] = await tx.update(bookings).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(bookings.id, id)).returning();
      await this.syncEvent(tx, c, b);
      await this.audit.log({ ...log(c), action: 'booking.cancel', resourceType: 'booking', resourceId: id, summary: `Réservation « ${b.title} » annulée` }, tx);
      return b;
    });
  }

  /** Sortie du matériel (remise à l'emprunteur). */
  @Access('booking', 'booking.bookings.update')
  @Post('booking/bookings/:id/checkout')
  @HttpCode(200)
  async checkout(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const b = await this.booking(c.association.id, id);
    if (b.status !== 'confirmed') throw BadRequest('NOT_CONFIRMED', 'Seule une réservation confirmée peut sortir.');
    if (b.checkedOutAt) throw BadRequest('ALREADY_OUT', 'Matériel déjà sorti.');
    const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(bookingItems).where(eq(bookingItems.bookingId, id));
    if (!n.n) throw BadRequest('NO_ITEMS', 'Aucun matériel dans cette réservation.');
    await this.db.update(bookings).set({ checkedOutAt: new Date(), updatedAt: new Date() }).where(eq(bookings.id, id));
    await this.audit.log({ ...log(c), action: 'booking.checkout', resourceType: 'booking', resourceId: id, summary: `Sortie du matériel « ${b.title} »` });
    return { ok: true };
  }

  /** Retour : quantités rendues par article ; le manque est sorti du stock comme perte. */
  @Access('booking', 'booking.bookings.update')
  @Post('booking/bookings/:id/return')
  @HttpCode(200)
  async giveBack(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const b = await this.booking(c.association.id, id);
    if (!b.checkedOutAt || b.returnedAt) throw BadRequest('NOT_OUT', 'Ce matériel n’est pas sorti.');
    const input = parse(z.object({ items: z.array(z.object({ itemId: zUuid, returned: z.number().int().min(0) })).max(200).default([]), note: zOptText(500) }), body ?? {});
    return this.db.transaction(async (tx) => {
      const lines = await tx.select({ itemId: bookingItems.itemId, quantity: bookingItems.quantity, name: stockItems.name }).from(bookingItems).innerJoin(stockItems, eq(stockItems.id, bookingItems.itemId)).where(eq(bookingItems.bookingId, id));
      const losses: string[] = [];
      for (const l of lines) {
        const given = input.items.find((x) => x.itemId === l.itemId);
        const returned = Math.min(l.quantity, given ? given.returned : l.quantity);
        await tx.update(bookingItems).set({ returnedQuantity: returned }).where(and(eq(bookingItems.bookingId, id), eq(bookingItems.itemId, l.itemId)));
        const missing = l.quantity - returned;
        if (missing > 0) {
          const [i] = await tx.select().from(stockItems).where(eq(stockItems.id, l.itemId)).for('update');
          const after = Math.max(0, i.quantity - missing);
          await tx.update(stockItems).set({ quantity: after, updatedAt: new Date() }).where(eq(stockItems.id, l.itemId));
          await tx.insert(stockMovements).values({ itemId: l.itemId, kind: 'lost', delta: after - i.quantity, quantityAfter: after, reason: `Non rendu — ${b.title}${input.note ? ` (${input.note})` : ''}`, userId: c.user.id });
          losses.push(`${missing} × ${l.name}`);
        }
      }
      await tx.update(bookings).set({ returnedAt: new Date(), updatedAt: new Date() }).where(eq(bookings.id, id));
      await this.audit.log({ ...log(c), action: 'booking.return', resourceType: 'booking', resourceId: id, summary: `Retour du matériel « ${b.title} »${losses.length ? ` — manquant : ${losses.join(', ')}` : ' — complet'}` }, tx);
      return { ok: true, losses };
    });
  }

  @Access('booking', 'booking.bookings.delete')
  @Delete('booking/bookings/:id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const b = await this.booking(c.association.id, id);
    if (b.checkedOutAt && !b.returnedAt) throw BadRequest('ALREADY_OUT', 'Le matériel est sorti : enregistrez d’abord son retour.');
    await this.db.transaction(async (tx) => {
      if (b.eventId) await tx.delete(events).where(eq(events.id, b.eventId));
      await tx.delete(bookings).where(eq(bookings.id, id));
      await this.audit.log({ ...log(c), action: 'booking.delete', resourceType: 'booking', resourceId: id, summary: `Suppression de la réservation « ${b.title} »` }, tx);
    });
    return { ok: true };
  }

  /** Disponibilité d'une ressource et du matériel prêtable sur un créneau (formulaire de réservation). */
  @Access('booking', 'booking.bookings.read')
  @Get('booking/availability')
  async avail(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date(), excludeBookingId: zUuid.optional() }), query);
    if (q.to <= q.from) throw BadRequest('INVALID_DATES', 'La fin doit suivre le début.');
    const busy = await this.db.select({ resourceId: bookings.resourceId, title: bookings.title, startAt: bookings.startAt, endAt: bookings.endAt }).from(bookings)
      .where(and(eq(bookings.associationId, c.association.id), isNotNull(bookings.resourceId), inArray(bookings.status, ['pending', 'confirmed']), lt(bookings.startAt, q.to), gt(bookings.endAt, q.from), q.excludeBookingId ? ne(bookings.id, q.excludeBookingId) : undefined));
    let items: unknown[] = [];
    if (this.loans(c)) {
      const av = await availability(this.db, c.association.id, null, q.from, q.to, q.excludeBookingId);
      const meta = await this.db.select({ id: stockItems.id, name: stockItems.name, reference: stockItems.reference, category: stockItems.category, unit: stockItems.unit }).from(stockItems)
        .where(and(eq(stockItems.associationId, c.association.id), eq(stockItems.loanable, true), isNull(stockItems.archivedAt))).orderBy(asc(stockItems.category), asc(stockItems.name));
      items = meta.map((m) => ({ ...m, ...av.get(m.id) }));
    }
    return { busy, items, loans: this.loans(c) };
  }
}
