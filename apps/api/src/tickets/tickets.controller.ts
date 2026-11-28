import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isFeatureEnabled } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zEmail, zOptText, zUuid } from '../common/validation';
import { BadRequest, Forbidden, NotFound } from '../common/errors';
import { toCsv } from '../common/csv';
import { requireConfirmation } from '../common/purge';
import { grantsCover } from '@scenorya/shared';
import { DB, Db } from '../db/db';
import { associations, showPerformances, shows, showVenues, ticketEvents, ticketOrders, ticketRates, tickets } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';
import { SettingsService } from '../system/settings.service';
import { loadConfig } from '../config';
import { counts, effectiveEvents, issueOrder, mailTickets, money, orderUrl, PAYMENT, ticketsPdf } from './tickets-core';

const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zRate = z.object({
  name: z.string().trim().min(1).max(80), priceCents: z.number().int().min(0).max(10_000_000),
  quota: z.number().int().min(0).max(1_000_000).nullable().optional(), publicVisible: z.boolean().default(true), position: z.number().int().min(0).max(1000).optional(),
});
const zEvent = z.object({
  performanceId: zUuid.nullable().optional(),
  title: z.string().trim().min(1).max(200), description: zOptText(4000),
  startAt: z.coerce.date(), venue: zOptText(200),
  capacity: z.number().int().min(0).max(1_000_000).nullable().optional(),
  status: z.enum(['draft', 'on_sale', 'closed', 'cancelled']).default('draft'),
  publicSale: z.boolean().default(false),
  salesOpenAt: z.coerce.date().nullable().optional(), salesCloseAt: z.coerce.date().nullable().optional(),
  maxPerOrder: z.number().int().min(1).max(100).default(10),
});
const zLines = z.array(z.object({ rateId: zUuid, quantity: z.number().int().min(0).max(500), holderNames: z.array(z.string().max(120)).max(500).optional() })).min(1).max(50);
const zPayment = z.enum(['cash', 'card', 'cheque', 'transfer', 'free', 'other']);
const fmt = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d);

@ApiTags('Scenorya Tickets')
@Controller()
export class TicketsController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService, private readonly settings: SettingsService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'tickets',
      check: async (db, associationId) => {
        const out: ModuleImpact[] = [];
        const [e] = await db.select({ n: sql<number>`count(*)::int` }).from(ticketEvents).where(and(eq(ticketEvents.associationId, associationId), eq(ticketEvents.status, 'on_sale'), gt(ticketEvents.startAt, new Date())));
        if (e.n > 0) out.push({ module: 'tickets', level: 'warning', message: `${e.n} séance(s) en vente : la vente et la page publique s’arrêteront (commandes conservées).` });
        return out;
      },
    });
    this.modules.registerImpactProvider({
      module: 'show',
      check: async (db, associationId) => {
        const [e] = await db.select({ n: sql<number>`count(*)::int` }).from(ticketEvents).where(and(eq(ticketEvents.associationId, associationId), sql`${ticketEvents.performanceId} is not null`, gt(ticketEvents.startAt, new Date())));
        return e.n > 0 ? [{ module: 'tickets', level: 'info', message: `${e.n} séance(s) de billetterie liées à des représentations garderont leur dernière date connue.` } as ModuleImpact] : [];
      },
    });
  }

  private async event(c: AssocCtx, id: string) {
    parse(zUuid, id);
    const [e] = await effectiveEvents(this.db, and(eq(ticketEvents.id, id), eq(ticketEvents.associationId, c.association.id)));
    if (!e) throw NotFound('Séance introuvable.');
    return e;
  }

  private async order(c: AssocCtx, id: string) {
    parse(zUuid, id);
    const [o] = await this.db.select().from(ticketOrders).where(and(eq(ticketOrders.id, id), eq(ticketOrders.associationId, c.association.id)));
    if (!o) throw NotFound('Commande introuvable.');
    return o;
  }

  private async rate(c: AssocCtx, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ r: ticketRates }).from(ticketRates).innerJoin(ticketEvents, eq(ticketEvents.id, ticketRates.eventId)).where(and(eq(ticketRates.id, id), eq(ticketEvents.associationId, c.association.id)));
    if (!r) throw NotFound('Tarif introuvable.');
    return r.r;
  }

  private async assoc(c: AssocCtx) {
    const [a] = await this.db.select({ name: associations.name, slug: associations.slug, primaryColor: associations.primaryColor }).from(associations).where(eq(associations.id, c.association.id));
    return a;
  }

  /* ============================================================ Séances */

  @Access('tickets', 'tickets.events.read')
  @Get('tickets/events')
  async list(@AssocContext() c: AssocCtx, @Query('past') past?: string) {
    const since = new Date(Date.now() - 6 * 3600_000);
    const rows = (await effectiveEvents(this.db, eq(ticketEvents.associationId, c.association.id))).filter((e) => (past === '1' ? e.startAt < since : e.startAt >= since));
    if (past === '1') rows.reverse();
    const k = await counts(this.db, rows.map((r) => r.id));
    const revenue = rows.length ? await this.db.select({ eventId: ticketOrders.eventId, paid: sql<number>`coalesce(sum(${ticketOrders.totalCents}) filter (where ${ticketOrders.status} = 'paid' and ${ticketOrders.refundedAt} is null), 0)::int`, pending: sql<number>`count(*) filter (where ${ticketOrders.status} = 'pending')::int` })
      .from(ticketOrders).where(inArray(ticketOrders.eventId, rows.map((r) => r.id))).groupBy(ticketOrders.eventId) : [];
    return rows.map((e) => ({ ...e, sold: k.byEvent.get(e.id) ?? 0, scanned: k.scanned.get(e.id) ?? 0, revenueCents: revenue.find((r) => r.eventId === e.id)?.paid ?? 0, pendingOrders: revenue.find((r) => r.eventId === e.id)?.pending ?? 0 }));
  }

  /** Représentations de Show pouvant être mises en vente (fonctionnalité tickets.showEvents). */
  @Access('tickets', 'tickets.events.create')
  @Get('tickets/performances')
  async performances(@AssocContext() c: AssocCtx) {
    if (!isFeatureEnabled(c.modules, 'tickets.showEvents')) return [];
    return this.db.select({ id: showPerformances.id, startAt: showPerformances.startAt, capacity: showPerformances.capacity, show: shows.title, venue: showVenues.name, venueCapacity: showVenues.capacity })
      .from(showPerformances).innerJoin(shows, eq(shows.id, showPerformances.showId)).leftJoin(showVenues, eq(showVenues.id, showPerformances.venueId))
      .leftJoin(ticketEvents, eq(ticketEvents.performanceId, showPerformances.id))
      .where(and(eq(shows.associationId, c.association.id), gt(showPerformances.startAt, new Date()), ne(showPerformances.status, 'cancelled'), isNull(ticketEvents.id)))
      .orderBy(asc(showPerformances.startAt));
  }

  @Access('tickets', 'tickets.events.create')
  @Post('tickets/events')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const raw = (body ?? {}) as Record<string, unknown>;
    let prefill: Record<string, unknown> = {};
    if (raw.performanceId) {
      if (!isFeatureEnabled(c.modules, 'tickets.showEvents')) throw BadRequest('FEATURE_DISABLED', 'La vente des représentations nécessite Scenorya Show.');
      const p = (await this.performances(c)).find((x) => x.id === raw.performanceId);
      if (!p) throw BadRequest('UNKNOWN_PERFORMANCE', 'Représentation inconnue, passée ou déjà en vente.');
      prefill = { title: p.show, startAt: p.startAt.toISOString(), capacity: p.capacity ?? p.venueCapacity ?? null };
    }
    const input = parse(zEvent.extend({ rates: z.array(zRate).max(30).optional() }), { ...prefill, ...raw });
    if (input.salesOpenAt && input.salesCloseAt && input.salesCloseAt <= input.salesOpenAt) throw BadRequest('INVALID_DATES', 'La fin des ventes doit suivre leur ouverture.');
    const { rates, ...ev } = input;
    return this.db.transaction(async (tx) => {
      const [e] = await tx.insert(ticketEvents).values({ ...ev, associationId: c.association.id, createdBy: c.user.id }).returning();
      const list = rates?.length ? rates : [{ name: 'Plein tarif', priceCents: 1000, publicVisible: true }, { name: 'Tarif réduit', priceCents: 700, publicVisible: true }, { name: 'Invitation', priceCents: 0, publicVisible: false }];
      await tx.insert(ticketRates).values(list.map((r, i) => ({ ...r, eventId: e.id, position: r.position ?? i })));
      await this.audit.log({ ...log(c), action: 'tickets.event.create', resourceType: 'ticket_event', resourceId: e.id, summary: `Séance « ${e.title} » du ${fmt(e.startAt)} créée` }, tx);
      return e;
    });
  }

  @Access('tickets', 'tickets.events.read')
  @Get('tickets/events/:id')
  async detail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const e = await this.event(c, id);
    const rates = await this.db.select().from(ticketRates).where(eq(ticketRates.eventId, id)).orderBy(asc(ticketRates.position), asc(ticketRates.name));
    const k = await counts(this.db, [id]);
    const pay = await this.db.select({ method: ticketOrders.paymentMethod, channel: ticketOrders.channel, status: ticketOrders.status, refunded: sql<boolean>`${ticketOrders.refundedAt} is not null`, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${ticketOrders.totalCents}), 0)::int` })
      .from(ticketOrders).where(eq(ticketOrders.eventId, id)).groupBy(ticketOrders.paymentMethod, ticketOrders.channel, ticketOrders.status, sql`${ticketOrders.refundedAt} is not null`);
    const byMethod: Record<string, number> = {};
    for (const p of pay) if (p.status === 'paid' && !p.refunded && p.method) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.cents;
    const byChannel: Record<string, number> = {};
    for (const p of pay) if (p.status !== 'cancelled') byChannel[p.channel] = (byChannel[p.channel] ?? 0) + p.n;
    return {
      ...e, rates: rates.map((r) => ({ ...r, sold: k.byRate.get(r.id) ?? 0 })),
      sold: k.byEvent.get(id) ?? 0, scanned: k.scanned.get(id) ?? 0,
      revenueCents: Object.values(byMethod).reduce((a, b) => a + b, 0), byMethod, byChannel,
      pendingCents: pay.filter((p) => p.status === 'pending').reduce((a, p) => a + p.cents, 0),
      publicUrl: `${loadConfig().PUBLIC_URL.replace(/\/$/, '')}/billetterie/${(await this.assoc(c)).slug}`,
      features: { show: isFeatureEnabled(c.modules, 'tickets.showEvents'), scan: !!c.modules.scan?.usable },
    };
  }

  @Access('tickets', 'tickets.events.update')
  @Patch('tickets/events/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.event(c, id);
    const input = parse(patchOf(zEvent.omit({ performanceId: true })), body);
    if (before.performanceId) { delete input.startAt; delete input.venue; }
    const open = input.salesOpenAt !== undefined ? input.salesOpenAt : before.salesOpenAt, close = input.salesCloseAt !== undefined ? input.salesCloseAt : before.salesCloseAt;
    if (open && close && close <= open) throw BadRequest('INVALID_DATES', 'La fin des ventes doit suivre leur ouverture.');
    if (input.capacity != null && input.capacity < (await counts(this.db, [id])).byEvent.get(id)!) throw BadRequest('CAPACITY_TOO_LOW', 'La jauge ne peut être inférieure au nombre de billets déjà vendus.');
    const [e] = await this.db.update(ticketEvents).set({ ...input, updatedAt: new Date() }).where(eq(ticketEvents.id, id)).returning();
    const STATUS: Record<string, string> = { draft: 'en préparation', on_sale: 'mise en vente', closed: 'ventes closes', cancelled: 'annulée' };
    await this.audit.log({ ...log(c), action: 'tickets.event.update', resourceType: 'ticket_event', resourceId: id, summary: `Séance « ${e.title} » modifiée${input.status && input.status !== before.status ? ` (${STATUS[input.status]})` : ''}` });
    return e;
  }

  @Access('tickets', 'tickets.events.delete')
  @Delete('tickets/events/:id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query('force') force?: string) {
    const e = await this.event(c, id);
    const [o] = await this.db.select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${ticketOrders.totalCents}) filter (where ${ticketOrders.status} = 'paid'), 0)::int` }).from(ticketOrders).where(eq(ticketOrders.eventId, id));
    if (o.n) requireConfirmation(force, `${o.n} commande(s) (${money(o.cents)} encaissés) et leurs billets seront supprimés définitivement. Pour garder une trace, préférez l’état « Annulée ».`, { orders: o.n });
    await this.db.transaction(async (tx) => {
      await tx.delete(ticketEvents).where(eq(ticketEvents.id, id));
      await this.audit.log({ ...log(c), action: 'tickets.event.delete', resourceType: 'ticket_event', resourceId: id, summary: `Suppression de la séance « ${e.title} » du ${fmt(e.startAt)} (${o.n} commande(s))` }, tx);
    });
    return { ok: true };
  }

  /* ============================================================ Tarifs */

  @Access('tickets', 'tickets.events.update')
  @Post('tickets/events/:id/rates')
  async addRate(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const e = await this.event(c, id);
    const input = parse(zRate, body);
    const [r] = await this.db.insert(ticketRates).values({ ...input, eventId: id, position: input.position ?? 100 }).returning();
    await this.audit.log({ ...log(c), action: 'tickets.rate.create', resourceType: 'ticket_event', resourceId: id, summary: `Tarif « ${r.name} » (${money(r.priceCents)}) ajouté à « ${e.title} »` });
    return r;
  }

  @Access('tickets', 'tickets.events.update')
  @Patch('tickets/rates/:id')
  async updateRate(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.rate(c, id);
    const input = parse(patchOf(zRate), body);
    const [r] = await this.db.update(ticketRates).set(input).where(eq(ticketRates.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'tickets.rate.update', resourceType: 'ticket_event', resourceId: before.eventId, summary: `Tarif « ${r.name} » modifié${input.priceCents !== undefined && input.priceCents !== before.priceCents ? ` (${money(before.priceCents)} → ${money(r.priceCents)}, billets déjà vendus inchangés)` : ''}` });
    return r;
  }

  @Access('tickets', 'tickets.events.update')
  @Delete('tickets/rates/:id')
  async removeRate(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query('force') force?: string) {
    const r = await this.rate(c, id);
    const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(tickets).where(eq(tickets.rateId, id));
    if (n.n) requireConfirmation(force, `${n.n} billet(s) vendus à ce tarif resteront valides (le nom du tarif est conservé sur le billet).`, { tickets: n.n });
    await this.db.delete(ticketRates).where(eq(ticketRates.id, id));
    await this.audit.log({ ...log(c), action: 'tickets.rate.delete', resourceType: 'ticket_event', resourceId: r.eventId, summary: `Tarif « ${r.name} » supprimé` });
    return { ok: true };
  }

  /* ============================================================ Commandes */

  @Access('tickets', 'tickets.orders.read')
  @Get('tickets/events/:id/orders')
  async orders(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query() query: unknown) {
    await this.event(c, id);
    const q = parse(z.object({ q: z.string().max(100).optional(), status: z.enum(['pending', 'paid', 'cancelled']).optional() }), query);
    const term = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await this.db.select({ o: ticketOrders, n: sql<number>`(select count(*)::int from tickets t where t.order_id = "ticket_orders"."id" and t.status = 'valid')`, s: sql<number>`(select count(*)::int from tickets t where t.order_id = "ticket_orders"."id" and t.scanned_at is not null)` })
      .from(ticketOrders).where(and(eq(ticketOrders.eventId, id), q.status ? eq(ticketOrders.status, q.status) : undefined,
        term ? or(ilike(ticketOrders.buyerName, term), ilike(ticketOrders.buyerEmail, term), ilike(ticketOrders.number, term), sql`exists (select 1 from tickets t where t.order_id = "ticket_orders"."id" and (t.holder_name ilike ${term} or t.code = ${q.q!.trim()}))`) : undefined))
      .orderBy(desc(ticketOrders.createdAt)).limit(2000);
    return rows.map((r) => ({ ...r.o, tickets: r.n, scanned: r.s }));
  }

  @Access('tickets', 'tickets.orders.create')
  @Post('tickets/events/:id/orders')
  async sell(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const e = await this.event(c, id);
    const input = parse(z.object({
      lines: zLines, buyerName: z.string().trim().min(1).max(120), buyerEmail: zEmail.nullable().optional().or(z.literal('').transform(() => null)), buyerPhone: zOptText(40), notes: zOptText(1000),
      status: z.enum(['paid', 'pending']).default('paid'), channel: z.enum(['box_office', 'invitation']).default('box_office'), paymentMethod: zPayment.nullable().optional(), send: z.boolean().default(false),
    }), body);
    if (e.status === 'cancelled') throw BadRequest('EVENT_CANCELLED', 'Cette séance est annulée.');
    const [ev] = await this.db.select().from(ticketEvents).where(eq(ticketEvents.id, id));
    const res = await this.db.transaction(async (tx) => {
      const r = await issueOrder(tx, { associationId: c.association.id, event: ev, ...input, buyerEmail: input.buyerEmail ?? null, status: input.channel === 'invitation' ? 'paid' : input.status, paymentMethod: input.channel === 'invitation' ? 'free' : input.paymentMethod, createdBy: c.user.id });
      await this.audit.log({ ...log(c), action: 'tickets.order.create', resourceType: 'ticket_order', resourceId: r.order.id, summary: `${input.channel === 'invitation' ? 'Invitation' : 'Vente'} ${r.order.number} : ${r.tickets.length} billet(s) pour « ${e.title} », ${money(r.order.totalCents)}${r.order.status === 'pending' ? ' (à régler)' : r.order.paymentMethod ? ` (${PAYMENT[r.order.paymentMethod]})` : ''}` }, tx);
      return r;
    });
    let emailStatus: string | null = null;
    if (input.send && res.order.buyerEmail) {
      emailStatus = await mailTickets(this.settings, await this.assoc(c), e, res.order, res.tickets);
      await this.db.update(ticketOrders).set({ emailStatus }).where(eq(ticketOrders.id, res.order.id));
    }
    return { ...res.order, emailStatus, url: orderUrl(res.order.publicToken), tickets: res.tickets.map((t) => ({ id: t.id, rateName: t.rateName, priceCents: t.priceCents })) };
  }

  @Access('tickets', 'tickets.orders.read')
  @Get('tickets/orders/:id')
  async orderDetail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const o = await this.order(c, id);
    const list = await this.db.select().from(tickets).where(eq(tickets.orderId, id)).orderBy(asc(tickets.createdAt), asc(tickets.rateName));
    return { ...o, url: orderUrl(o.publicToken), tickets: list };
  }

  @Access('tickets', 'tickets.orders.update')
  @Patch('tickets/orders/:id')
  async updateOrder(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.order(c, id);
    const input = parse(z.object({ buyerName: z.string().trim().min(1).max(120).optional(), buyerEmail: zEmail.nullable().optional().or(z.literal('').transform(() => null)), buyerPhone: zOptText(40), notes: zOptText(1000), holders: z.array(z.object({ ticketId: zUuid, holderName: zOptText(120) })).max(500).optional() }), body);
    const { holders, ...rest } = input;
    return this.db.transaction(async (tx) => {
      const [o] = await tx.update(ticketOrders).set({ ...rest, updatedAt: new Date() }).where(eq(ticketOrders.id, id)).returning();
      for (const h of holders ?? []) await tx.update(tickets).set({ holderName: h.holderName ?? null }).where(and(eq(tickets.id, h.ticketId), eq(tickets.orderId, id)));
      await this.audit.log({ ...log(c), action: 'tickets.order.update', resourceType: 'ticket_order', resourceId: id, summary: `Commande ${o.number} modifiée` }, tx);
      return o;
    });
  }

  /** Encaissement d'une réservation à régler. */
  @Access('tickets', 'tickets.orders.update')
  @Post('tickets/orders/:id/pay')
  @HttpCode(200)
  async pay(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const o = await this.order(c, id);
    if (o.status !== 'pending') throw BadRequest('NOT_PENDING', 'Cette commande n’est pas à régler.');
    const { paymentMethod } = parse(z.object({ paymentMethod: zPayment }), body);
    const [n] = await this.db.update(ticketOrders).set({ status: 'paid', paymentMethod, paidAt: new Date(), updatedAt: new Date() }).where(and(eq(ticketOrders.id, id), eq(ticketOrders.status, 'pending'))).returning();
    await this.audit.log({ ...log(c), action: 'tickets.order.pay', resourceType: 'ticket_order', resourceId: id, summary: `Commande ${o.number} réglée : ${money(o.totalCents)} (${PAYMENT[paymentMethod]})` });
    return n;
  }

  /** Annulation : billets invalidés, places libérées ; remboursement noté si demandé. */
  @Access('tickets', 'tickets.orders.cancel')
  @Post('tickets/orders/:id/cancel')
  @HttpCode(200)
  async cancel(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const o = await this.order(c, id);
    const { refund } = parse(z.object({ refund: z.boolean().default(false) }), body ?? {});
    if (o.status === 'cancelled') throw BadRequest('ALREADY_CANCELLED', 'Commande déjà annulée.');
    if (refund && o.status === 'paid' && o.totalCents > 0 && !grantsCover(c.grants, 'tickets.orders.refund')) throw Forbidden('REFUND_FORBIDDEN', 'Vous n’avez pas le droit de rembourser.');
    const refunded = refund && o.status === 'paid' && o.totalCents > 0;
    return this.db.transaction(async (tx) => {
      await tx.update(tickets).set({ status: 'cancelled' }).where(eq(tickets.orderId, id));
      const [n] = await tx.update(ticketOrders).set({ status: 'cancelled', refundedAt: refunded ? new Date() : null, updatedAt: new Date() }).where(eq(ticketOrders.id, id)).returning();
      await this.audit.log({ ...log(c), action: refunded ? 'tickets.order.refund' : 'tickets.order.cancel', resourceType: 'ticket_order', resourceId: id, summary: `Commande ${o.number} annulée${refunded ? `, remboursement de ${money(o.totalCents)}` : ''}` }, tx);
      return n;
    });
  }

  /** Annulation d'un seul billet : place libérée, montant de la commande recalculé. */
  @Access('tickets', 'tickets.orders.cancel')
  @Post('tickets/tickets/:id/cancel')
  @HttpCode(200)
  async cancelTicket(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [row] = await this.db.select({ t: tickets, o: ticketOrders }).from(tickets).innerJoin(ticketOrders, eq(ticketOrders.id, tickets.orderId)).where(and(eq(tickets.id, id), eq(ticketOrders.associationId, c.association.id)));
    if (!row) throw NotFound('Billet introuvable.');
    if (row.t.status === 'cancelled') throw BadRequest('ALREADY_CANCELLED', 'Billet déjà annulé.');
    return this.db.transaction(async (tx) => {
      await tx.update(tickets).set({ status: 'cancelled' }).where(eq(tickets.id, id));
      const [{ n, cents }] = await tx.select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${tickets.priceCents}), 0)::int` }).from(tickets).where(and(eq(tickets.orderId, row.o.id), eq(tickets.status, 'valid')));
      await tx.update(ticketOrders).set({ totalCents: cents, status: n === 0 ? 'cancelled' : row.o.status, updatedAt: new Date() }).where(eq(ticketOrders.id, row.o.id));
      await this.audit.log({ ...log(c), action: 'tickets.ticket.cancel', resourceType: 'ticket_order', resourceId: row.o.id, summary: `Billet « ${row.t.rateName} » de la commande ${row.o.number} annulé (${money(row.t.priceCents)})` }, tx);
      return { ok: true, totalCents: cents };
    });
  }

  @Access('tickets', 'tickets.orders.update')
  @Post('tickets/orders/:id/send')
  @HttpCode(200)
  async send(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const o = await this.order(c, id);
    if (!o.buyerEmail) throw BadRequest('NO_EMAIL', 'Aucune adresse e-mail pour cette commande.');
    const e = await this.event(c, o.eventId);
    const list = await this.db.select().from(tickets).where(and(eq(tickets.orderId, id), eq(tickets.status, 'valid')));
    if (!list.length) throw BadRequest('NO_TICKETS', 'Aucun billet valide.');
    const emailStatus = await mailTickets(this.settings, await this.assoc(c), e, o, list);
    await this.db.update(ticketOrders).set({ emailStatus }).where(eq(ticketOrders.id, id));
    await this.audit.log({ ...log(c), action: 'tickets.order.send', resourceType: 'ticket_order', resourceId: id, summary: `Billets ${o.number} ${emailStatus === 'sent' ? 'envoyés' : 'non envoyés'} à ${o.buyerEmail}` });
    if (emailStatus !== 'sent') throw BadRequest('EMAIL_FAILED', emailStatus.startsWith('failed') ? `Échec de l’envoi : ${emailStatus.slice(8)}` : 'Envoi impossible.');
    return { emailStatus };
  }

  @Access('tickets', 'tickets.orders.download')
  @Get('tickets/orders/:id/tickets.pdf')
  async pdf(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const o = await this.order(c, id);
    const e = await this.event(c, o.eventId);
    const list = await this.db.select().from(tickets).where(eq(tickets.orderId, id)).orderBy(asc(tickets.createdAt));
    const pdf = await ticketsPdf(await this.assoc(c), e, o, list);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="billets-${o.number}.pdf"`);
    res.send(pdf);
  }

  @Access('tickets', 'tickets.orders.delete')
  @Delete('tickets/orders/:id')
  async removeOrder(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const o = await this.order(c, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(ticketOrders).where(eq(ticketOrders.id, id));
      await this.audit.log({ ...log(c), action: 'tickets.order.delete', resourceType: 'ticket_order', resourceId: id, summary: `Suppression définitive de la commande ${o.number} (${o.buyerName}, ${money(o.totalCents)})` }, tx);
    });
    return { ok: true };
  }

  /* ============================================================ Exports */

  @Access('tickets', 'tickets.orders.export')
  @Get('tickets/events/:id/attendees.csv')
  async attendees(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const e = await this.event(c, id);
    const rows = await this.db.select({ t: tickets, o: ticketOrders }).from(tickets).innerJoin(ticketOrders, eq(ticketOrders.id, tickets.orderId))
      .where(eq(tickets.eventId, id)).orderBy(asc(ticketOrders.buyerName), asc(tickets.createdAt));
    const csv = toCsv(['Commande', 'Acheteur', 'E-mail', 'Téléphone', 'Porteur', 'Tarif', 'Prix (€)', 'Billet', 'Commande : état', 'Règlement', 'Canal', 'Entrée'],
      rows.map(({ t, o }) => [o.number, o.buyerName, o.buyerEmail ?? '', o.buyerPhone ?? '', t.holderName ?? '', t.rateName, (t.priceCents / 100).toFixed(2).replace('.', ','),
        t.status === 'valid' ? 'Valide' : 'Annulé', { pending: 'À régler', paid: 'Réglée', cancelled: 'Annulée' }[o.status] ?? o.status, o.paymentMethod ? PAYMENT[o.paymentMethod] : '',
        { box_office: 'Guichet', online: 'En ligne', invitation: 'Invitation' }[o.channel] ?? o.channel, t.scannedAt ? fmt(t.scannedAt) : '']));
    await this.audit.log({ ...log(c), action: 'tickets.export', resourceType: 'ticket_event', resourceId: id, summary: `Export des spectateurs de « ${e.title} » (${rows.length} billet(s))` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="spectateurs.csv"');
    res.send(csv);
  }
}
