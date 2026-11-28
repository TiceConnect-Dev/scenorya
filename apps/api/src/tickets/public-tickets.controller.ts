import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Public } from '../common/access';
import { parse, zEmail, zOptText, zUuid } from '../common/validation';
import { AppError, BadRequest, NotFound } from '../common/errors';
import { sha256 } from '../common/crypto';
import { DB, Db } from '../db/db';
import { associations, ticketEvents, ticketOrders, ticketRates, tickets } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModulesService } from '../modules/modules.service';
import { SettingsService } from '../system/settings.service';
import { loadConfig } from '../config';
import QRCode from 'qrcode';
import { counts, effectiveEvents, issueOrder, mailTickets, money, ticketsPdf, ticketUrl } from './tickets-core';

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const HOURLY_LIMIT = 5;

/** Page publique de réservation (règlement sur place) et consultation des billets par l'acheteur. */
@ApiTags('Scenorya Tickets — public')
@Controller()
export class PublicTicketsController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService, private readonly settings: SettingsService) {}

  private async association(slug: string) {
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw NotFound('Billetterie introuvable.');
    const [a] = await this.db.select().from(associations).where(eq(associations.slug, slug));
    if (!a || a.status !== 'active') throw NotFound('Billetterie introuvable.');
    const resolved = await this.modules.resolved(a.id);
    if (!resolved.tickets?.usable || !resolved.tickets.writable) throw NotFound('Billetterie fermée.');
    return a;
  }

  /** Séances proposées en ligne : en vente, publiques, à venir, dans la période de vente. */
  private async onSale(associationId: string) {
    const now = new Date();
    const rows = (await effectiveEvents(this.db, and(eq(ticketEvents.associationId, associationId), eq(ticketEvents.status, 'on_sale'), eq(ticketEvents.publicSale, true))))
      .filter((e) => e.startAt > now && (!e.salesOpenAt || e.salesOpenAt <= now) && (!e.salesCloseAt || e.salesCloseAt > now) && e.show?.performanceStatus !== 'cancelled');
    const k = await counts(this.db, rows.map((r) => r.id));
    const rates = rows.length ? await this.db.select().from(ticketRates).where(and(inArray(ticketRates.eventId, rows.map((r) => r.id)), eq(ticketRates.publicVisible, true))).orderBy(asc(ticketRates.position), asc(ticketRates.name)) : [];
    return rows.map((e) => {
      const remaining = e.capacity == null ? null : Math.max(0, e.capacity - (k.byEvent.get(e.id) ?? 0));
      return {
        id: e.id, title: e.title, description: e.description, startAt: e.startAt, doorsAt: e.doorsAt, venue: e.venue, maxPerOrder: e.maxPerOrder, remaining,
        rates: rates.filter((r) => r.eventId === e.id).map((r) => ({ id: r.id, name: r.name, priceCents: r.priceCents, remaining: r.quota == null ? remaining : Math.max(0, Math.min(remaining ?? Infinity, r.quota - (k.byRate.get(r.id) ?? 0))) })),
      };
    });
  }

  @Public()
  @Get('public/tickets/:slug')
  async page(@Param('slug') slug: string) {
    const a = await this.association(slug);
    return { association: { name: a.name, color: a.primaryColor, city: a.city, website: a.website, email: a.email }, events: await this.onSale(a.id) };
  }

  @Public()
  @Post('public/tickets/:slug/events/:id/orders')
  async reserve(@Param('slug') slug: string, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const a = await this.association(slug);
    parse(zUuid, id);
    const input = parse(z.object({
      buyerName: z.string().trim().min(2).max(120), buyerEmail: zEmail, buyerPhone: zOptText(40),
      lines: z.array(z.object({ rateId: zUuid, quantity: z.number().int().min(0).max(100) })).min(1).max(20),
      /** Champ piège invisible : rempli seulement par les robots. */
      website: z.string().max(200).optional(),
    }), body);
    if (input.website) throw BadRequest('REJECTED', 'Demande refusée.');
    const ev = (await this.onSale(a.id)).find((e) => e.id === id);
    if (!ev) throw NotFound('Cette séance n’est pas en vente en ligne.');
    const ipHash = sha256(`${req.ip ?? ''}:${loadConfig().APP_SECRET}`);
    const [recent] = await this.db.select({ n: sql<number>`count(*)::int` }).from(ticketOrders).where(and(eq(ticketOrders.associationId, a.id), eq(ticketOrders.ipHash, ipHash), gt(ticketOrders.createdAt, new Date(Date.now() - 3600_000))));
    if (recent.n >= HOURLY_LIMIT) throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_ORDERS', 'Trop de réservations depuis cette connexion : réessayez dans une heure ou contactez l’association.');
    const [row] = await this.db.select().from(ticketEvents).where(eq(ticketEvents.id, id));
    const res = await this.db.transaction(async (tx) => {
      const r = await issueOrder(tx, { associationId: a.id, event: row, lines: input.lines, buyerName: input.buyerName, buyerEmail: input.buyerEmail, buyerPhone: input.buyerPhone ?? null, status: 'pending', channel: 'online', ipHash, publicOnly: true });
      await this.audit.log({ associationId: a.id, actorId: null, actorLabel: `${input.buyerName} (en ligne)`, ip: req.ip ?? null, action: 'tickets.order.online', resourceType: 'ticket_order', resourceId: r.order.id, summary: `Réservation en ligne ${r.order.number} : ${r.tickets.length} billet(s) pour « ${row.title} », ${money(r.order.totalCents)}${r.order.status === 'pending' ? ' à régler sur place' : ''}` }, tx);
      return r;
    });
    const [e] = await effectiveEvents(this.db, eq(ticketEvents.id, id));
    const emailStatus = await mailTickets(this.settings, a, e, res.order, res.tickets);
    await this.db.update(ticketOrders).set({ emailStatus }).where(eq(ticketOrders.id, res.order.id));
    return { token: res.order.publicToken, number: res.order.number, emailStatus };
  }

  private async byToken(token: string) {
    if (!TOKEN.test(token)) throw NotFound('Commande introuvable.');
    const [o] = await this.db.select().from(ticketOrders).where(eq(ticketOrders.publicToken, token));
    if (!o) throw NotFound('Commande introuvable.');
    const [a] = await this.db.select().from(associations).where(eq(associations.id, o.associationId));
    const [e] = await effectiveEvents(this.db, eq(ticketEvents.id, o.eventId));
    return { o, a, e };
  }

  @Public()
  @Get('public/orders/:token')
  async order(@Param('token') token: string) {
    const { o, a, e } = await this.byToken(token);
    const list = await this.db.select().from(tickets).where(eq(tickets.orderId, o.id)).orderBy(asc(tickets.createdAt));
    const base = loadConfig().PUBLIC_URL.replace(/\/$/, '');
    return {
      association: { name: a.name, color: a.primaryColor, email: a.email, slug: a.slug },
      event: { title: e.title, startAt: e.startAt, doorsAt: e.doorsAt, venue: e.venue, status: e.status },
      order: { number: o.number, buyerName: o.buyerName, status: o.status, totalCents: o.totalCents, channel: o.channel, createdAt: o.createdAt },
      tickets: list.map((t) => ({ code: t.code, url: `${base}/billet/${t.code}`, rateName: t.rateName, priceCents: t.priceCents, holderName: t.holderName, status: t.status, scanned: !!t.scannedAt })),
      canCancel: o.status === 'pending' && o.channel === 'online' && e.startAt > new Date(),
    };
  }

  @Public()
  @Get('public/orders/:token/tickets.pdf')
  async pdf(@Param('token') token: string, @Res() res: Response) {
    const { o, a, e } = await this.byToken(token);
    const list = await this.db.select().from(tickets).where(eq(tickets.orderId, o.id)).orderBy(asc(tickets.createdAt));
    const pdf = await ticketsPdf(a, e, o, list);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="billets-${o.number}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }

  /** L'acheteur libère une réservation en ligne non réglée. */
  @Public()
  @Post('public/orders/:token/cancel')
  @HttpCode(200)
  async cancel(@Param('token') token: string, @Req() req: Request) {
    const { o, e } = await this.byToken(token);
    if (!(o.status === 'pending' && o.channel === 'online' && e.startAt > new Date())) throw BadRequest('NOT_CANCELLABLE', 'Cette réservation ne peut plus être annulée en ligne : contactez l’association.');
    await this.db.transaction(async (tx) => {
      await tx.update(tickets).set({ status: 'cancelled' }).where(eq(tickets.orderId, o.id));
      await tx.update(ticketOrders).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(ticketOrders.id, o.id));
      await this.audit.log({ associationId: o.associationId, actorId: null, actorLabel: `${o.buyerName} (en ligne)`, ip: req.ip ?? null, action: 'tickets.order.cancel', resourceType: 'ticket_order', resourceId: o.id, summary: `Réservation ${o.number} annulée par l’acheteur` }, tx);
    });
    return { ok: true };
  }

  /** Image du QR code d'un billet (page de l'acheteur). */
  @Public()
  @Get('public/ticket/:code/qr.png')
  async qr(@Param('code') code: string, @Res() res: Response) {
    if (!TOKEN.test(code)) throw NotFound('Billet inconnu.');
    const [t] = await this.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.code, code));
    if (!t) throw NotFound('Billet inconnu.');
    const png = await QRCode.toBuffer(ticketUrl(code), { errorCorrectionLevel: 'M', margin: 1, width: 360 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(png);
  }

  /** Lecture d'un QR code avec un appareil photo ordinaire : séance et validité, sans donnée personnelle. */
  @Public()
  @Get('public/ticket/:code')
  async ticket(@Param('code') code: string) {
    if (!TOKEN.test(code)) throw NotFound('Billet inconnu.');
    const [t] = await this.db.select({ t: tickets, o: ticketOrders, a: associations.name }).from(tickets).innerJoin(ticketOrders, eq(ticketOrders.id, tickets.orderId)).innerJoin(associations, eq(associations.id, ticketOrders.associationId)).where(eq(tickets.code, code));
    if (!t) throw NotFound('Billet inconnu.');
    const [e] = await effectiveEvents(this.db, eq(ticketEvents.id, t.t.eventId));
    return { association: t.a, title: e.title, startAt: e.startAt, venue: e.venue, rateName: t.t.rateName, valid: t.t.status === 'valid' && t.o.status !== 'cancelled' && e.status !== 'cancelled', used: !!t.t.scannedAt, pending: t.o.status === 'pending' };
  }
}
