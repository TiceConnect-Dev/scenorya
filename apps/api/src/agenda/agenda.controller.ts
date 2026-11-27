import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_TIMEZONE, EVENT_CATEGORIES, EventCategory, expandOccurrences, grantsCover, isFeatureEnabled, localDate, RecurrenceRule, zonedParts, zonedToUtc,
} from '@scenorya/shared';
import { Access, AssocContext, AssocCtx, Public } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Forbidden, NotFound } from '../common/errors';
import { randomToken, sha256 } from '../common/crypto';
import { DB, Db } from '../db/db';
import { associationUsers, associations, calendarFeeds, eventParticipants, events, memberGroupLinks, members } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModulesService } from '../modules/modules.service';
import { PermissionService } from '../admin/permission.service';
import { loadConfig } from '../config';
import { buildIcs } from './ics';

const TZ = DEFAULT_TIMEZONE;
const DAY = 86_400_000;
const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });

const zRule = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(52).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  count: z.number().int().min(1).max(500).nullable().optional(),
}).refine((r) => r.until || r.count, 'Une récurrence doit avoir une date de fin ou un nombre d’occurrences');

const zEvent = z.object({
  title: z.string().trim().min(2).max(160),
  description: zOptText(4000),
  location: zOptText(200),
  category: z.enum(Object.keys(EVENT_CATEGORIES) as [EventCategory, ...EventCategory[]]).default('other'),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  allDay: z.boolean().default(false),
  rule: zRule.nullable().optional(),
  visibility: z.enum(['internal', 'public']).default('internal'),
  memberIds: z.array(zUuid).max(500).optional(),
  groupIds: z.array(zUuid).max(50).optional(),
});

type EventRow = typeof events.$inferSelect;

/** Normalise les bornes : journée entière = minuit local → minuit local du lendemain de la date de fin. */
function bounds(input: { start: string; end: string; allDay: boolean }) {
  let start = new Date(input.start);
  let end = new Date(input.end);
  if (input.allDay) {
    const s = zonedParts(start, TZ);
    const e = zonedParts(end, TZ);
    start = zonedToUtc(s.year, s.month, s.day, 0, 0, TZ);
    end = zonedToUtc(e.year, e.month, e.day + 1, 0, 0, TZ);
  }
  if (end <= start) throw BadRequest('INVALID_DATES', 'La fin doit être postérieure au début.');
  if (end.getTime() - start.getTime() > 60 * DAY) throw BadRequest('TOO_LONG', 'Un événement ne peut pas durer plus de 60 jours.');
  return { start, end };
}

export const occurrencesOf = (e: Pick<EventRow, 'startAt' | 'endAt' | 'rule' | 'exdates'>, from: Date, to: Date) =>
  expandOccurrences({ start: e.startAt, end: e.endAt, rule: (e.rule as RecurrenceRule | null) ?? null, exdates: e.exdates }, from, to, TZ);

@ApiTags('Scenorya Agenda')
@Controller()
export class AgendaController implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly modules: ModulesService,
    private readonly permissions: PermissionService,
  ) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'agenda',
      check: async (db, associationId) => {
        const [r] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(events)
          .where(and(eq(events.associationId, associationId), isNull(events.cancelledAt), or(gt(events.endAt, new Date()), sql`${events.rule} is not null`)));
        return r.n > 0 ? [{ module: 'agenda', level: 'warning', message: `${r.n} événement(s) à venir ou récurrent(s) disparaîtront des plannings et des abonnements iCal jusqu’à la réactivation.` }] : [];
      },
    });
  }

  private async find(associationId: string, id: string) {
    parse(zUuid, id);
    const [e] = await this.db.select().from(events).where(and(eq(events.id, id), eq(events.associationId, associationId)));
    if (!e) throw NotFound('Événement introuvable.');
    return e;
  }

  /** Événements susceptibles d'avoir une occurrence dans la fenêtre. */
  private candidates(associationId: string, from: Date, to: Date) {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.associationId, associationId), isNull(events.cancelledAt), lt(events.startAt, to), or(gt(events.endAt, from), sql`${events.rule} is not null`)))
      .orderBy(asc(events.startAt));
  }

  private canSeeNames(c: AssocCtx) {
    return grantsCover(c.grants, 'asso.members.read') || grantsCover(c.grants, 'agenda.events.update');
  }

  /** Adhérents concernés (individuels + membres des groupes), contrôlés dans l'association. */
  private async resolveMembers(c: AssocCtx, memberIds: string[] = [], groupIds: string[] = []) {
    if (memberIds.length + groupIds.length === 0) return [];
    if (!isFeatureEnabled(c.modules, 'agenda.memberInvitations')) throw Forbidden('FEATURE_UNAVAILABLE', 'Les invitations nécessitent le module Scenorya Asso.');
    const ids = new Set<string>();
    if (memberIds.length) {
      const found = await this.db.select({ id: members.id }).from(members).where(and(eq(members.associationId, c.association.id), inArray(members.id, memberIds), sql`${members.status} <> 'archived'`));
      if (found.length !== new Set(memberIds).size) throw NotFound('Adhérent introuvable dans cette association.');
      found.forEach((m) => ids.add(m.id));
    }
    if (groupIds.length) {
      const rows = await this.db
        .select({ id: members.id })
        .from(memberGroupLinks)
        .innerJoin(members, eq(members.id, memberGroupLinks.memberId))
        .where(and(inArray(memberGroupLinks.groupId, groupIds), eq(members.associationId, c.association.id), sql`${members.status} <> 'archived'`));
      rows.forEach((m) => ids.add(m.id));
    }
    return [...ids];
  }

  /** Conflits : mêmes participants ou même lieu sur des créneaux qui se chevauchent (12 mois max). */
  private async conflicts(associationId: string, ev: { startAt: Date; endAt: Date; rule: RecurrenceRule | null; exdates: string[]; location: string | null }, memberIds: string[], excludeId?: string) {
    const from = new Date(Math.max(ev.startAt.getTime(), Date.now() - DAY));
    const to = new Date(from.getTime() + 366 * DAY);
    const mine = occurrencesOf({ ...ev, rule: ev.rule }, from, to).slice(0, 200);
    if (mine.length === 0) return [];
    const windowFrom = mine[0].start;
    const windowTo = mine[mine.length - 1].end;
    const others = (await this.candidates(associationId, windowFrom, windowTo)).filter((o) => o.id !== excludeId);
    if (others.length === 0) return [];
    const parts = memberIds.length
      ? await this.db
          .select({ eventId: eventParticipants.eventId, memberId: eventParticipants.memberId, firstName: members.firstName, lastName: members.lastName })
          .from(eventParticipants)
          .innerJoin(members, eq(members.id, eventParticipants.memberId))
          .where(and(inArray(eventParticipants.eventId, others.map((o) => o.id)), inArray(eventParticipants.memberId, memberIds), sql`${eventParticipants.status} <> 'no'`))
      : [];
    const loc = ev.location?.trim().toLowerCase();
    const out: { eventId: string; title: string; start: Date; end: Date; reasons: string[] }[] = [];
    for (const o of others) {
      const shared = parts.filter((p) => p.eventId === o.id);
      const sameLoc = Boolean(loc && o.location && o.location.trim().toLowerCase() === loc);
      if (!shared.length && !sameLoc) continue;
      const theirs = occurrencesOf(o, windowFrom, windowTo);
      for (const a of mine) {
        const hit = theirs.find((b) => b.start < a.end && a.start < b.end);
        if (hit) {
          const reasons = [];
          if (sameLoc) reasons.push(`même lieu (${o.location})`);
          if (shared.length) reasons.push(`participants : ${shared.map((p) => `${p.firstName} ${p.lastName}`).join(', ')}`);
          out.push({ eventId: o.id, title: o.title, start: hit.start, end: hit.end, reasons });
          break;
        }
      }
      if (out.length >= 20) break;
    }
    return out;
  }

  /* --------------------------------------------------------- Lecture */

  @Access('agenda', 'agenda.events.read')
  @Get('agenda/events')
  async list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date(), category: z.string().optional(), memberId: zUuid.optional() }), query);
    if (q.to <= q.from || q.to.getTime() - q.from.getTime() > 400 * DAY) throw BadRequest('INVALID_RANGE', 'Période invalide (400 jours maximum).');
    let rows = await this.candidates(c.association.id, q.from, q.to);
    if (q.category) rows = rows.filter((r) => r.category === q.category);
    if (q.memberId) {
      const mine = new Set((await this.db.select({ e: eventParticipants.eventId }).from(eventParticipants).where(eq(eventParticipants.memberId, q.memberId))).map((r) => r.e));
      rows = rows.filter((r) => mine.has(r.id));
    }
    const counts = rows.length
      ? await this.db
          .select({ eventId: eventParticipants.eventId, status: eventParticipants.status, n: sql<number>`count(*)::int` })
          .from(eventParticipants)
          .where(inArray(eventParticipants.eventId, rows.map((r) => r.id)))
          .groupBy(eventParticipants.eventId, eventParticipants.status)
      : [];
    const items = rows.flatMap((e) =>
      occurrencesOf(e, q.from, q.to).map((o) => {
        const cnt = Object.fromEntries(counts.filter((x) => x.eventId === e.id).map((x) => [x.status, x.n]));
        return {
          id: e.id, occurrence: o.key, title: e.title, category: e.category, location: e.location, allDay: e.allDay,
          start: o.start, end: o.end, recurring: Boolean(e.rule), visibility: e.visibility,
          participants: { invited: cnt.invited ?? 0, yes: cnt.yes ?? 0, no: cnt.no ?? 0, maybe: cnt.maybe ?? 0 },
        };
      }),
    );
    items.sort((a, b) => a.start.getTime() - b.start.getTime());
    return { items, timezone: TZ };
  }

  @Access('agenda', 'agenda.events.read')
  @Get('agenda/events/:id')
  async get(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const e = await this.find(c.association.id, id);
    const showNames = this.canSeeNames(c);
    const parts = await this.db
      .select({ memberId: eventParticipants.memberId, status: eventParticipants.status, comment: eventParticipants.comment, respondedAt: eventParticipants.respondedAt, firstName: members.firstName, lastName: members.lastName, number: members.number })
      .from(eventParticipants)
      .innerJoin(members, eq(members.id, eventParticipants.memberId))
      .where(eq(eventParticipants.eventId, id))
      .orderBy(asc(members.lastName), asc(members.firstName));
    const next = occurrencesOf(e, new Date(Date.now() - DAY), new Date(Date.now() + 366 * DAY)).slice(0, 10);
    return {
      ...e,
      nextOccurrences: next,
      participants: showNames ? parts : [],
      participantCounts: parts.reduce((acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }), {} as Record<string, number>),
      canSeeParticipants: showNames,
    };
  }

  @Access('agenda', 'agenda.events.read', { write: false })
  @Post('agenda/conflicts')
  @HttpCode(200)
  async preview(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zEvent.extend({ excludeId: zUuid.optional() }), body);
    const b = bounds(input);
    const memberIds = await this.resolveMembers(c, input.memberIds, input.groupIds);
    return { conflicts: await this.conflicts(c.association.id, { startAt: b.start, endAt: b.end, rule: input.rule ?? null, exdates: [], location: input.location }, memberIds, input.excludeId) };
  }

  /* ------------------------------------------------------- Écriture */

  @Access('agenda', 'agenda.events.create')
  @Post('agenda/events')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zEvent, body);
    const b = bounds(input);
    const memberIds = await this.resolveMembers(c, input.memberIds, input.groupIds);
    const e = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(events)
        .values({ associationId: c.association.id, title: input.title, description: input.description, location: input.location, category: input.category, startAt: b.start, endAt: b.end, allDay: input.allDay, rule: input.rule ?? null, visibility: input.visibility, createdBy: c.user.id })
        .returning();
      if (memberIds.length) await tx.insert(eventParticipants).values(memberIds.map((memberId) => ({ eventId: row.id, memberId })));
      await this.audit.log({ ...log(c), action: 'event.create', resourceType: 'event', resourceId: row.id, summary: `Création de l’événement « ${row.title} » (${EVENT_CATEGORIES[input.category].label})${input.rule ? ', récurrent' : ''}`, data: { participants: memberIds.length } }, tx);
      return row;
    });
    const conflicts = await this.conflicts(c.association.id, e, memberIds, e.id);
    return { event: e, conflicts };
  }

  @Access('agenda', 'agenda.events.update')
  @Patch('agenda/events/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.find(c.association.id, id);
    if (before.cancelledAt) throw BadRequest('CANCELLED', 'Événement annulé.');
    const input = parse(patchOf(zEvent.omit({ memberIds: true, groupIds: true })), body);
    const patch: Partial<EventRow> = { updatedAt: new Date() };
    for (const k of ['title', 'description', 'location', 'category', 'visibility'] as const) if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];
    if (input.rule !== undefined) patch.rule = input.rule;
    if (input.start || input.end || input.allDay !== undefined) {
      const allDay = input.allDay ?? before.allDay;
      const b = bounds({ start: input.start ?? before.startAt.toISOString(), end: input.end ?? (allDay && before.allDay ? new Date(before.endAt.getTime() - DAY).toISOString() : before.endAt.toISOString()), allDay });
      Object.assign(patch, { startAt: b.start, endAt: b.end, allDay });
    }
    const [e] = await this.db.update(events).set(patch).where(eq(events.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'event.update', resourceType: 'event', resourceId: id, summary: `Modification de l’événement « ${e.title} »`, data: { fields: Object.keys(input) } });
    const memberIds = (await this.db.select({ m: eventParticipants.memberId }).from(eventParticipants).where(eq(eventParticipants.eventId, id))).map((r) => r.m);
    return { event: e, conflicts: await this.conflicts(c.association.id, e, memberIds, id) };
  }

  /** Annule une seule occurrence d'un événement récurrent. */
  @Access('agenda', 'agenda.events.update')
  @Post('agenda/events/:id/cancel-occurrence')
  @HttpCode(200)
  async cancelOccurrence(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const e = await this.find(c.association.id, id);
    const { occurrence } = parse(z.object({ occurrence: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), body);
    if (!e.rule) throw BadRequest('NOT_RECURRING', 'Pour un événement simple, annulez l’événement.');
    const day = new Date(`${occurrence}T12:00:00Z`).getTime();
    const exists = occurrencesOf(e, new Date(day - 2 * DAY), new Date(day + 2 * DAY)).some((o) => o.key === occurrence);
    if (!exists) throw NotFound('Occurrence introuvable.');
    await this.db.update(events).set({ exdates: sql`array_append(${events.exdates}, ${occurrence})`, updatedAt: new Date() }).where(eq(events.id, id));
    await this.audit.log({ ...log(c), action: 'event.occurrence.cancel', resourceType: 'event', resourceId: id, summary: `Annulation de l’occurrence du ${occurrence} de « ${e.title} »` });
    return { ok: true };
  }

  /** Annulation de l'événement (conservé dans l'historique, retiré des plannings). */
  @Access('agenda', 'agenda.events.delete')
  @Delete('agenda/events/:id')
  async cancel(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const e = await this.find(c.association.id, id);
    await this.db.update(events).set({ cancelledAt: new Date(), updatedAt: new Date() }).where(eq(events.id, id));
    await this.audit.log({ ...log(c), action: 'event.cancel', resourceType: 'event', resourceId: id, summary: `Annulation de l’événement « ${e.title} »` });
    return { ok: true };
  }

  @Access('agenda', 'agenda.events.update')
  @Put('agenda/events/:id/participants')
  async addParticipants(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const e = await this.find(c.association.id, id);
    const input = parse(z.object({ memberIds: z.array(zUuid).max(500).default([]), groupIds: z.array(zUuid).max(50).default([]) }), body);
    const ids = await this.resolveMembers(c, input.memberIds, input.groupIds);
    if (ids.length) await this.db.insert(eventParticipants).values(ids.map((memberId) => ({ eventId: id, memberId }))).onConflictDoNothing();
    await this.audit.log({ ...log(c), action: 'event.participants.add', resourceType: 'event', resourceId: id, summary: `${ids.length} participant(s) invité(s) à « ${e.title} »` });
    return { invited: ids.length, conflicts: await this.conflicts(c.association.id, e, ids, id) };
  }

  @Access('agenda', 'agenda.events.update')
  @Delete('agenda/events/:id/participants/:memberId')
  async removeParticipant(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('memberId') memberId: string) {
    await this.find(c.association.id, id);
    parse(zUuid, memberId);
    await this.db.delete(eventParticipants).where(and(eq(eventParticipants.eventId, id), eq(eventParticipants.memberId, memberId)));
    return { ok: true };
  }

  /** Enregistre la réponse d'un participant (présence confirmée, excusé…). */
  @Access('agenda', 'agenda.events.update')
  @Patch('agenda/events/:id/participants/:memberId')
  async respond(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('memberId') memberId: string, @Body() body: unknown) {
    const e = await this.find(c.association.id, id);
    parse(zUuid, memberId);
    const input = parse(z.object({ status: z.enum(['invited', 'yes', 'no', 'maybe']), comment: zOptText(300) }), body);
    const [p] = await this.db
      .update(eventParticipants)
      .set({ status: input.status, comment: input.comment, respondedAt: input.status === 'invited' ? null : new Date() })
      .where(and(eq(eventParticipants.eventId, id), eq(eventParticipants.memberId, memberId)))
      .returning();
    if (!p) throw NotFound('Participant introuvable.');
    await this.audit.log({ ...log(c), action: 'event.participant.respond', resourceType: 'member', resourceId: memberId, summary: `Réponse « ${input.status} » enregistrée pour « ${e.title} »` });
    return p;
  }

  /* ------------------------------------------------------ iCalendar */

  private async ics(associationId: string, name: string, from: Date, to: Date) {
    const rows = await this.candidates(associationId, from, to);
    const items = rows.flatMap((e) =>
      occurrencesOf(e, from, to).map((o) => ({
        uid: `${e.id}-${o.key}@scenorya`,
        title: e.title, description: e.description, location: e.location, allDay: e.allDay,
        start: o.start, end: o.end, startKey: o.key, endKey: localDate(o.end, TZ),
        category: EVENT_CATEGORIES[e.category as EventCategory]?.label, updatedAt: e.updatedAt,
      })),
    );
    return buildIcs(name, items);
  }

  @Access('agenda', 'agenda.events.export')
  @Get('agenda/events.ics')
  async export(@AssocContext() c: AssocCtx, @Query() query: unknown, @Res() res: Response) {
    const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), query);
    const from = q.from ?? new Date(Date.now() - 30 * DAY);
    const to = q.to ?? new Date(Date.now() + 365 * DAY);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="agenda.ics"');
    res.send(await this.ics(c.association.id, c.association.name, from, to));
  }

  @Access('agenda', 'agenda.events.read')
  @Get('agenda/feed')
  async feedStatus(@AssocContext() c: AssocCtx) {
    const [f] = await this.db.select().from(calendarFeeds).where(and(eq(calendarFeeds.associationUserId, c.membershipId), isNull(calendarFeeds.revokedAt)));
    return { active: Boolean(f), createdAt: f?.createdAt ?? null, lastUsedAt: f?.lastUsedAt ?? null };
  }

  /** Crée (ou remplace) le lien d'abonnement personnel. Le jeton n'est affiché qu'une fois. */
  @Access('agenda', 'agenda.events.read', { write: true })
  @Post('agenda/feed')
  async createFeed(@AssocContext() c: AssocCtx) {
    const token = randomToken(24);
    await this.db.transaction(async (tx) => {
      await tx.update(calendarFeeds).set({ revokedAt: new Date() }).where(and(eq(calendarFeeds.associationUserId, c.membershipId), isNull(calendarFeeds.revokedAt)));
      await tx.insert(calendarFeeds).values({ associationUserId: c.membershipId, tokenHash: sha256(token) });
    });
    await this.audit.log({ ...log(c), action: 'agenda.feed.create', resourceType: 'feed', summary: 'Création d’un lien d’abonnement iCal' });
    const base = loadConfig().PUBLIC_URL.replace(/\/$/, '');
    return { url: `${base}/api/public/agenda/${token}.ics`, webcal: `${base.replace(/^https?:/, 'webcal:')}/api/public/agenda/${token}.ics` };
  }

  @Access('agenda', 'agenda.events.read', { write: true })
  @Delete('agenda/feed')
  async revokeFeed(@AssocContext() c: AssocCtx) {
    await this.db.update(calendarFeeds).set({ revokedAt: new Date() }).where(and(eq(calendarFeeds.associationUserId, c.membershipId), isNull(calendarFeeds.revokedAt)));
    await this.audit.log({ ...log(c), action: 'agenda.feed.revoke', resourceType: 'feed', summary: 'Révocation du lien d’abonnement iCal' });
    return { ok: true };
  }

  /**
   * Flux iCal personnel (applications d'agenda). Les droits sont réévalués à
   * chaque lecture : appartenance, module actif et permission de consultation.
   */
  @Public()
  @Get('public/agenda/:file')
  async feed(@Param('file') file: string, @Res() res: Response) {
    const token = /^([A-Za-z0-9_-]{24,64})\.ics$/.exec(file)?.[1];
    if (!token) throw NotFound('Abonnement inconnu.');
    const [row] = await this.db
      .select({ f: calendarFeeds, au: associationUsers, a: { id: associations.id, name: associations.name } })
      .from(calendarFeeds)
      .innerJoin(associationUsers, eq(associationUsers.id, calendarFeeds.associationUserId))
      .innerJoin(associations, eq(associations.id, associationUsers.associationId))
      .where(and(eq(calendarFeeds.tokenHash, sha256(token)), isNull(calendarFeeds.revokedAt)));
    if (!row) throw NotFound('Abonnement inconnu ou révoqué.');
    const membership = await this.permissions.membership(row.au.userId, row.a.id);
    const resolved = await this.modules.resolved(row.a.id);
    if (!membership || !resolved.agenda.usable || !(await this.permissions.can(membership.id, 'agenda.events.read'))) {
      throw NotFound('Abonnement inactif.');
    }
    await this.db.update(calendarFeeds).set({ lastUsedAt: new Date() }).where(eq(calendarFeeds.id, row.f.id));
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(await this.ics(row.a.id, row.a.name, new Date(Date.now() - 60 * DAY), new Date(Date.now() + 365 * DAY)));
  }
}
