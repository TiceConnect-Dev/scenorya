import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, zOptText, zUuid } from '../common/validation';
import { BadRequest, NotFound } from '../common/errors';
import { sha256 } from '../common/crypto';
import { DB, Db, DbOrTx } from '../db/db';
import { ticketEvents, ticketOrders, tickets, ticketScans } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { codeOf, counts, effectiveEvents, EffectiveEvent } from '../tickets/tickets-core';

type Result = 'ok' | 'already' | 'unknown' | 'wrong_event' | 'cancelled' | 'event_cancelled';
const MESSAGES: Record<Result, string> = {
  ok: 'Entrée validée', already: 'Billet déjà utilisé', unknown: 'Billet inconnu', wrong_event: 'Billet d’une autre séance', cancelled: 'Billet annulé', event_cancelled: 'Séance annulée',
};
const hm = (d: Date) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Paris' }).format(d);

@ApiTags('Scenorya Scan')
@Controller()
export class ScanController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  private async event(c: AssocCtx, id: string) {
    parse(zUuid, id);
    const [e] = await effectiveEvents(this.db, and(eq(ticketEvents.id, id), eq(ticketEvents.associationId, c.association.id)));
    if (!e) throw NotFound('Séance introuvable.');
    return e;
  }

  /** Séances à contrôler : de la veille aux deux mois à venir. */
  @Access('scan', 'scan.entries.read')
  @Get('scan/events')
  async events(@AssocContext() c: AssocCtx) {
    const from = new Date(Date.now() - 24 * 3600_000), to = new Date(Date.now() + 60 * 86_400_000);
    const rows = (await effectiveEvents(this.db, and(eq(ticketEvents.associationId, c.association.id), ne(ticketEvents.status, 'draft')))).filter((e) => e.startAt >= from && e.startAt <= to);
    const k = await counts(this.db, rows.map((r) => r.id));
    return rows.map((e) => ({ id: e.id, title: e.title, startAt: e.startAt, venue: e.venue, status: e.status, sold: k.byEvent.get(e.id) ?? 0, scanned: k.scanned.get(e.id) ?? 0, capacity: e.capacity }));
  }

  @Access('scan', 'scan.entries.read')
  @Get('scan/events/:id')
  async state(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const e = await this.event(c, id);
    const k = await counts(this.db, [id]);
    const recent = await this.db.select({ s: ticketScans, rateName: tickets.rateName, holderName: tickets.holderName, buyerName: ticketOrders.buyerName, number: ticketOrders.number })
      .from(ticketScans).leftJoin(tickets, eq(tickets.id, ticketScans.ticketId)).leftJoin(ticketOrders, eq(ticketOrders.id, tickets.orderId))
      .where(eq(ticketScans.eventId, id)).orderBy(desc(ticketScans.id)).limit(30);
    return {
      id: e.id, title: e.title, startAt: e.startAt, venue: e.venue, status: e.status, capacity: e.capacity,
      sold: k.byEvent.get(id) ?? 0, scanned: k.scanned.get(id) ?? 0,
      recent: recent.map((r) => ({ id: r.s.id, ticketId: r.s.ticketId, result: r.s.result, at: r.s.at, offline: r.s.offline, rateName: r.rateName, holder: r.holderName ?? r.buyerName, number: r.number })),
    };
  }

  /** Validation atomique : un billet ne passe qu'une fois, même lu par deux postes en même temps. */
  private async check(tx: DbOrTx, c: AssocCtx, e: EffectiveEvent, raw: string, at: Date, offline: boolean, device: string | null) {
    const code = codeOf(raw);
    const [row] = code ? await tx.select({ t: tickets, o: ticketOrders, assoc: ticketOrders.associationId }).from(tickets).innerJoin(ticketOrders, eq(ticketOrders.id, tickets.orderId)).where(eq(tickets.code, code)) : [];
    let result: Result;
    const ticket = row && row.assoc === c.association.id ? row : undefined;
    let scannedAt: Date | null = null;
    if (!ticket) result = 'unknown';
    else if (ticket.t.eventId !== e.id) result = 'wrong_event';
    else if (e.status === 'cancelled') result = 'event_cancelled';
    else if (ticket.t.status !== 'valid' || ticket.o.status === 'cancelled') result = 'cancelled';
    else {
      const [u] = await tx.update(tickets).set({ scannedAt: at, scannedBy: c.user.id }).where(and(eq(tickets.id, ticket.t.id), eq(tickets.status, 'valid'), isNull(tickets.scannedAt))).returning();
      if (u) { result = 'ok'; scannedAt = at; } else {
        const [again] = await tx.select({ s: tickets.scannedAt }).from(tickets).where(eq(tickets.id, ticket.t.id));
        result = 'already'; scannedAt = again?.s ?? null;
      }
    }
    await tx.insert(ticketScans).values({ eventId: e.id, ticketId: ticket?.t.id ?? null, result, at, offline, device, userId: c.user.id });
    let other: string | null = null;
    if (result === 'wrong_event' && ticket) other = (await effectiveEvents(tx, eq(ticketEvents.id, ticket.t.eventId)))[0]?.title ?? null;
    return {
      result, ok: result === 'ok',
      message: result === 'already' && scannedAt ? `${MESSAGES.already} à ${hm(scannedAt)}` : result === 'wrong_event' && other ? `${MESSAGES.wrong_event} : « ${other} »` : MESSAGES[result],
      ticket: ticket ? { id: ticket.t.id, rateName: ticket.t.rateName, holder: ticket.t.holderName ?? ticket.o.buyerName, number: ticket.o.number, pending: ticket.o.status === 'pending', totalCents: ticket.o.totalCents, scannedAt } : null,
    };
  }

  @Access('scan', 'scan.entries.create')
  @Post('scan/events/:id/check')
  @HttpCode(200)
  async validate(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const e = await this.event(c, id);
    const input = parse(z.object({ code: z.string().min(1).max(300), device: zOptText(60) }), body);
    return this.db.transaction((tx) => this.check(tx, c, e, input.code, new Date(), false, input.device ?? null));
  }

  /** Rejeu des lectures faites hors connexion, avec leur heure d'origine (bornée aux dernières 24 h). */
  @Access('scan', 'scan.entries.create')
  @Post('scan/events/:id/sync')
  @HttpCode(200)
  async sync(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const e = await this.event(c, id);
    const input = parse(z.object({ device: zOptText(60), entries: z.array(z.object({ code: z.string().min(1).max(300), at: z.coerce.date() })).max(5000) }), body);
    const now = Date.now();
    const out = [];
    for (const x of input.entries.sort((a, b) => +a.at - +b.at)) {
      const at = new Date(Math.min(now, Math.max(now - 24 * 3600_000, +x.at)));
      out.push({ code: x.code, ...(await this.db.transaction((tx) => this.check(tx, c, e, x.code, at, true, input.device ?? null))) });
    }
    if (out.length) await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip, action: 'scan.sync', resourceType: 'ticket_event', resourceId: id, summary: `Contrôle hors connexion transmis pour « ${e.title} » : ${out.filter((o) => o.ok).length} entrée(s), ${out.filter((o) => !o.ok).length} refus` });
    return { results: out };
  }

  /**
   * Liste pour le contrôle hors connexion : empreintes SHA-256 des codes (jamais les codes eux-mêmes),
   * tarif, porteur et état. Le poste compare l'empreinte du QR lu.
   */
  @Access('scan', 'scan.entries.read')
  @Get('scan/events/:id/manifest')
  async manifest(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const e = await this.event(c, id);
    const rows = await this.db.select({ t: tickets, o: ticketOrders }).from(tickets).innerJoin(ticketOrders, eq(ticketOrders.id, tickets.orderId)).where(eq(tickets.eventId, id));
    return {
      event: { id: e.id, title: e.title, startAt: e.startAt, status: e.status }, generatedAt: new Date(),
      tickets: rows.map(({ t, o }) => ({ h: sha256(t.code), id: t.id, rateName: t.rateName, holder: t.holderName ?? o.buyerName, number: o.number, valid: t.status === 'valid' && o.status !== 'cancelled', pending: o.status === 'pending', scannedAt: t.scannedAt })),
    };
  }

  /** Annule une entrée (erreur de lecture, sortie définitive) : le billet peut de nouveau passer. */
  @Access('scan', 'scan.entries.update')
  @Post('scan/tickets/:id/undo')
  @HttpCode(200)
  async undo(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [row] = await this.db.select({ t: tickets, o: ticketOrders }).from(tickets).innerJoin(ticketOrders, eq(ticketOrders.id, tickets.orderId)).where(and(eq(tickets.id, id), eq(ticketOrders.associationId, c.association.id)));
    if (!row) throw NotFound('Billet introuvable.');
    if (!row.t.scannedAt) throw BadRequest('NOT_SCANNED', 'Ce billet n’est pas entré.');
    await this.db.transaction(async (tx) => {
      await tx.update(tickets).set({ scannedAt: null, scannedBy: null }).where(eq(tickets.id, id));
      await tx.insert(ticketScans).values({ eventId: row.t.eventId, ticketId: id, result: 'undo', at: new Date(), userId: c.user.id });
      await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip, action: 'scan.undo', resourceType: 'ticket_order', resourceId: row.o.id, summary: `Entrée annulée pour un billet « ${row.t.rateName} » de la commande ${row.o.number}` }, tx);
    });
    return { ok: true };
  }
}

