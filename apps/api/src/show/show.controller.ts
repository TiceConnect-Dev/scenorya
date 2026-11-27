import { Body, Controller, Delete, Get, Inject, OnModuleInit, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isFeatureEnabled } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Forbidden, NotFound } from '../common/errors';
import { DB, Db } from '../db/db';
import { associations, driveLinks, castAssignments, castProductions, castRoles, eventParticipants, events, members, showCrew, showPerformances, shows, showVenues } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';
import { resyncShow, syncPerformanceEvent } from './show-sync';
import { showSheetPdf } from './show-pdf';

const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const sctx = (c: AssocCtx) => ({ associationId: c.association.id, userId: c.user.id, modules: c.modules });
const fr = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d);
const zInt = (max: number) => z.number().int().min(0).max(max).nullable().optional();

const zShow = z.object({
  title: z.string().trim().min(1).max(200),
  subtitle: zOptText(200), author: zOptText(200), director: zOptText(200), genre: zOptText(80),
  durationMin: zInt(1000), intermissionMin: zInt(120), ageMin: zInt(99),
  synopsis: zOptText(8000),
  status: z.enum(['draft', 'announced', 'running', 'archived']).default('draft'),
});
const zVenue = z.object({
  name: z.string().trim().min(1).max(160),
  addressLine: zOptText(200), postalCode: zOptText(12), city: zOptText(100),
  capacity: zInt(100_000), accessibility: zOptText(1000), notes: zOptText(2000),
});
const zPerformance = z.object({
  startAt: z.coerce.date(),
  endAt: z.coerce.date().optional(),
  doorsAt: z.coerce.date().nullable().optional(),
  venueId: zUuid.nullable().optional(),
  capacity: zInt(100_000),
  status: z.enum(['planned', 'confirmed', 'cancelled', 'done']).default('planned'),
  notes: zOptText(2000),
});
const STATUS: Record<string, string> = { planned: 'prévue', confirmed: 'confirmée', cancelled: 'annulée', done: 'jouée' };

@ApiTags('Scenorya Show')
@Controller()
export class ShowController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'show',
      check: async (db, associationId) => {
        const out: ModuleImpact[] = [];
        const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(showPerformances).innerJoin(shows, eq(shows.id, showPerformances.showId))
          .where(and(eq(shows.associationId, associationId), gt(showPerformances.startAt, new Date()), ne(showPerformances.status, 'cancelled')));
        if (r.n > 0) out.push({ module: 'show', level: 'warning', message: `${r.n} représentation(s) à venir : leurs événements d’agenda restent, mais ne seront plus mis à jour.` });
        const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(shows).where(eq(shows.associationId, associationId));
        if (s.n > 0) out.push({ module: 'show', level: 'info', message: `${s.n} spectacle(s) conservé(s).` });
        return out;
      },
    });
  }

  /* ============================================================ Accès */

  private async show(associationId: string, id: string) {
    parse(zUuid, id);
    const [s] = await this.db.select().from(shows).where(and(eq(shows.id, id), eq(shows.associationId, associationId)));
    if (!s) throw NotFound('Spectacle introuvable.');
    return s;
  }

  private async venue(associationId: string, id: string) {
    parse(zUuid, id);
    const [v] = await this.db.select().from(showVenues).where(and(eq(showVenues.id, id), eq(showVenues.associationId, associationId)));
    if (!v) throw NotFound('Lieu introuvable.');
    return v;
  }

  private async performance(associationId: string, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ p: showPerformances, s: shows }).from(showPerformances).innerJoin(shows, eq(shows.id, showPerformances.showId))
      .where(and(eq(showPerformances.id, id), eq(shows.associationId, associationId)));
    if (!r) throw NotFound('Représentation introuvable.');
    return r;
  }

  /* ============================================================ Lieux */

  @Access('show', 'show.venues.read')
  @Get('show/venues')
  venues(@AssocContext() c: AssocCtx) {
    return this.db.select().from(showVenues).where(eq(showVenues.associationId, c.association.id)).orderBy(asc(showVenues.name));
  }

  @Access('show', 'show.venues.update')
  @Post('show/venues')
  async addVenue(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zVenue, body);
    const [v] = await this.db.insert(showVenues).values({ ...input, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'show.venue.create', resourceType: 'show_venue', resourceId: v.id, summary: `Lieu « ${v.name} » ajouté` });
    return v;
  }

  @Access('show', 'show.venues.update')
  @Patch('show/venues/:id')
  async updateVenue(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.venue(c.association.id, id);
    const [v] = await this.db.update(showVenues).set({ ...parse(patchOf(zVenue), body), updatedAt: new Date() }).where(eq(showVenues.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'show.venue.update', resourceType: 'show_venue', resourceId: id, summary: `Lieu « ${v.name} » modifié` });
    return v;
  }

  /** Les représentations prévues dans ce lieu le perdent (lieu « à préciser »). */
  @Access('show', 'show.venues.update')
  @Delete('show/venues/:id')
  async removeVenue(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const v = await this.venue(c.association.id, id);
    const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(showPerformances).where(eq(showPerformances.venueId, id));
    await this.db.delete(showVenues).where(eq(showVenues.id, id));
    await this.audit.log({ ...log(c), action: 'show.venue.delete', resourceType: 'show_venue', resourceId: id, summary: `Lieu « ${v.name} » supprimé (${n.n} représentation(s) sans lieu)` });
    return { ok: true, performances: n.n };
  }

  /* ============================================================ Spectacles */

  @Access('show', 'show.shows.read')
  @Get('show/shows')
  async list(@AssocContext() c: AssocCtx) {
    const rows = await this.db.select().from(shows).where(eq(shows.associationId, c.association.id)).orderBy(sql`${shows.status} = 'archived'`, desc(shows.createdAt));
    if (!rows.length) return [];
    const stats = await this.db.execute<{ id: string; total: number; upcoming: number; next: string | null }>(sql`
      select s.id,
        (select count(*)::int from show_performances p where p.show_id = s.id and p.status <> 'cancelled') as total,
        (select count(*)::int from show_performances p where p.show_id = s.id and p.status <> 'cancelled' and p.start_at > now()) as upcoming,
        (select min(start_at) from show_performances p where p.show_id = s.id and p.status <> 'cancelled' and p.start_at > now()) as next
      from shows s where s.id in ${rows.map((r) => r.id)}`);
    const st = new Map(stats.rows.map((r) => [r.id, r]));
    return rows.map((s) => ({ ...s, performances: st.get(s.id)?.total ?? 0, upcoming: st.get(s.id)?.upcoming ?? 0, nextPerformance: st.get(s.id)?.next ?? null }));
  }

  @Access('show', 'show.shows.create')
  @Post('show/shows')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zShow, body);
    const [s] = await this.db.insert(shows).values({ ...input, associationId: c.association.id, createdBy: c.user.id }).returning();
    await this.audit.log({ ...log(c), action: 'show.create', resourceType: 'show', resourceId: s.id, summary: `Création du spectacle « ${s.title} »` });
    return s;
  }

  @Access('show', 'show.shows.read')
  @Get('show/shows/:id')
  async detail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.show(c.association.id, id);
    const perfs = await this.db.select({ p: showPerformances, v: showVenues }).from(showPerformances).leftJoin(showVenues, eq(showVenues.id, showPerformances.venueId))
      .where(eq(showPerformances.showId, id)).orderBy(asc(showPerformances.startAt));
    const crew = await this.db.select({ id: showCrew.id, job: showCrew.job, memberId: members.id, name: sql<string>`${members.firstName} || ' ' || ${members.lastName}` })
      .from(showCrew).innerJoin(members, eq(members.id, showCrew.memberId)).where(eq(showCrew.showId, id)).orderBy(asc(showCrew.job), asc(members.lastName));
    const castOn = !!c.modules.cast?.usable && isFeatureEnabled(c.modules, 'cast.distributions');
    let productions: { id: string; title: string; status: string; roles: { role: string; leads: string[] }[] }[] = [];
    if (castOn) {
      const prods = await this.db.select().from(castProductions).where(and(eq(castProductions.showId, id), eq(castProductions.associationId, c.association.id)));
      for (const p of prods) {
        const rows = await this.db.select({ role: castRoles.name, pos: castRoles.position, rid: castRoles.id, name: sql<string | null>`${members.firstName} || ' ' || ${members.lastName}` })
          .from(castRoles).leftJoin(castAssignments, and(eq(castAssignments.roleId, castRoles.id), eq(castAssignments.kind, 'lead'), eq(castAssignments.status, 'confirmed')))
          .leftJoin(members, eq(members.id, castAssignments.memberId)).where(eq(castRoles.productionId, p.id)).orderBy(asc(castRoles.position));
        const roles = new Map<string, { role: string; leads: string[] }>();
        for (const r of rows) {
          const cur = roles.get(r.rid) ?? { role: r.role, leads: [] };
          if (r.name) cur.leads.push(r.name);
          roles.set(r.rid, cur);
        }
        productions.push({ id: p.id, title: p.title, status: p.status, roles: [...roles.values()] });
      }
    }
    const answers = perfs.some((x) => x.p.eventId)
      ? await this.db.select({ e: eventParticipants.eventId, s: eventParticipants.status, n: sql<number>`count(*)::int` }).from(eventParticipants)
        .where(inArray(eventParticipants.eventId, perfs.map((x) => x.p.eventId).filter((x): x is string => !!x))).groupBy(eventParticipants.eventId, eventParticipants.status)
      : [];
    return {
      ...s,
      performances: perfs.map(({ p, v }) => ({
        ...p, venue: v ? { id: v.id, name: v.name, city: v.city, capacity: v.capacity } : null, capacity: p.capacity ?? v?.capacity ?? null,
        answers: Object.fromEntries(answers.filter((a) => a.e === p.eventId).map((a) => [a.s, a.n])),
      })),
      crew, productions,
      features: { agenda: isFeatureEnabled(c.modules, 'show.agenda'), cast: castOn, attachments: isFeatureEnabled(c.modules, 'show.attachments') },
    };
  }

  @Access('show', 'show.shows.update')
  @Patch('show/shows/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.show(c.association.id, id);
    const input = parse(patchOf(zShow), body);
    const [s] = await this.db.update(shows).set({ ...input, updatedAt: new Date() }).where(eq(shows.id, id)).returning();
    // Le titre et la visibilité figurent dans les événements d'agenda des représentations.
    if (input.title !== undefined || input.status !== undefined) await resyncShow(this.db, sctx(c), id);
    await this.audit.log({ ...log(c), action: 'show.update', resourceType: 'show', resourceId: id, summary: `Modification du spectacle « ${before.title} »${s.title !== before.title ? ` (désormais « ${s.title} »)` : ''}` });
    return s;
  }

  /** Suppression définitive : représentations (et leurs événements d'agenda), équipe ; les distributions de Cast sont seulement détachées. */
  @Access('show', 'show.shows.delete')
  @Delete('show/shows/:id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.show(c.association.id, id);
    const n = await this.db.transaction(async (tx) => {
      const ev = (await tx.select({ e: showPerformances.eventId }).from(showPerformances).where(eq(showPerformances.showId, id))).map((r) => r.e).filter((x): x is string => !!x);
      const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(showPerformances).where(eq(showPerformances.showId, id));
      await tx.delete(driveLinks).where(and(eq(driveLinks.module, 'show'), eq(driveLinks.entityType, 'show'), eq(driveLinks.entityId, id)));
      await tx.delete(shows).where(eq(shows.id, id));
      if (ev.length) await tx.delete(events).where(and(inArray(events.id, ev), eq(events.associationId, c.association.id)));
      await this.audit.log({ ...log(c), action: 'show.delete', resourceType: 'show', resourceId: id, summary: `Suppression du spectacle « ${s.title} » (${cnt.n} représentation(s))` }, tx);
      return cnt.n;
    });
    return { ok: true, performances: n };
  }

  @Access('show', 'show.shows.download')
  @Get('show/shows/:id/sheet.pdf')
  async sheet(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const d = await this.detail(c, id);
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const crewBy = new Map<string, string[]>();
    for (const m of d.crew) crewBy.set(m.job, [...(crewBy.get(m.job) ?? []), m.name]);
    const pdf = await showSheetPdf(a, d,
      d.productions.flatMap((p) => p.roles).filter((r) => r.leads.length).map((r) => ({ role: r.role, names: r.leads })),
      [...crewBy.entries()].map(([job, names]) => ({ job, names })),
      d.performances.map((p) => ({ startAt: p.startAt, venue: p.venue ? [p.venue.name, p.venue.city].filter(Boolean).join(', ') : null, cancelled: p.status === 'cancelled' })));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="fiche-spectacle.pdf"');
    res.send(pdf);
  }

  /* ============================================================ Équipe et distributions */

  @Access('show', 'show.shows.update')
  @Post('show/shows/:id/crew')
  async addCrew(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const s = await this.show(c.association.id, id);
    const input = parse(z.object({ memberIds: z.array(zUuid).min(1).max(50), job: z.string().trim().min(1).max(80) }), body);
    const ok = await this.db.select({ id: members.id }).from(members).where(and(eq(members.associationId, c.association.id), inArray(members.id, input.memberIds), ne(members.status, 'archived')));
    if (ok.length !== new Set(input.memberIds).size) throw BadRequest('UNKNOWN_MEMBER', 'Adhérent inconnu ou archivé.');
    await this.db.insert(showCrew).values(input.memberIds.map((memberId) => ({ showId: id, memberId, job: input.job }))).onConflictDoNothing();
    await resyncShow(this.db, sctx(c), id);
    await this.audit.log({ ...log(c), action: 'show.crew.add', resourceType: 'show', resourceId: id, summary: `${input.memberIds.length} personne(s) ajoutée(s) à l’équipe de « ${s.title} » (${input.job})` });
    return { ok: true };
  }

  @Access('show', 'show.shows.update')
  @Delete('show/crew/:id')
  async removeCrew(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [row] = await this.db.select({ cr: showCrew, s: shows }).from(showCrew).innerJoin(shows, eq(shows.id, showCrew.showId)).where(and(eq(showCrew.id, id), eq(shows.associationId, c.association.id)));
    if (!row) throw NotFound('Membre de l’équipe introuvable.');
    await this.db.delete(showCrew).where(eq(showCrew.id, id));
    await resyncShow(this.db, sctx(c), row.s.id);
    await this.audit.log({ ...log(c), action: 'show.crew.remove', resourceType: 'show', resourceId: row.s.id, summary: `Retrait de l’équipe de « ${row.s.title} » (${row.cr.job})` });
    return { ok: true };
  }

  private assertCastLink(c: AssocCtx) {
    if (!c.modules.cast?.usable || !isFeatureEnabled(c.modules, 'cast.distributions')) throw Forbidden('FEATURE_DISABLED', 'Activez Scenorya Cast pour rattacher une distribution.');
  }

  @Access('show', 'show.shows.update')
  @Post('show/shows/:id/productions/:productionId')
  async link(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('productionId') pid: string) {
    this.assertCastLink(c);
    const s = await this.show(c.association.id, id);
    parse(zUuid, pid);
    const [p] = await this.db.update(castProductions).set({ showId: id, updatedAt: new Date() }).where(and(eq(castProductions.id, pid), eq(castProductions.associationId, c.association.id))).returning();
    if (!p) throw NotFound('Production introuvable.');
    await resyncShow(this.db, sctx(c), id);
    await this.audit.log({ ...log(c), action: 'show.production.link', resourceType: 'show', resourceId: id, summary: `Distribution « ${p.title} » rattachée au spectacle « ${s.title} »` });
    return { ok: true };
  }

  @Access('show', 'show.shows.update')
  @Delete('show/shows/:id/productions/:productionId')
  async unlink(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('productionId') pid: string) {
    const s = await this.show(c.association.id, id);
    parse(zUuid, pid);
    const [p] = await this.db.update(castProductions).set({ showId: null, updatedAt: new Date() }).where(and(eq(castProductions.id, pid), eq(castProductions.showId, id))).returning();
    if (!p) throw NotFound('Production introuvable.');
    await resyncShow(this.db, sctx(c), id);
    await this.audit.log({ ...log(c), action: 'show.production.unlink', resourceType: 'show', resourceId: id, summary: `Distribution « ${p.title} » détachée du spectacle « ${s.title} »` });
    return { ok: true };
  }

  /** Productions de Cast disponibles pour un rattachement. */
  @Access('show', 'show.shows.update')
  @Get('show/linkable-productions')
  async linkable(@AssocContext() c: AssocCtx) {
    if (!c.modules.cast?.usable || !isFeatureEnabled(c.modules, 'cast.distributions')) return [];
    return this.db.select({ id: castProductions.id, title: castProductions.title, showId: castProductions.showId }).from(castProductions)
      .where(eq(castProductions.associationId, c.association.id)).orderBy(asc(castProductions.title));
  }

  /* ============================================================ Représentations */

  private async endOf(showDuration: number | null, intermission: number | null, start: Date, end?: Date) {
    if (end) return end;
    const minutes = (showDuration ?? 120) + (intermission ?? 0);
    return new Date(start.getTime() + minutes * 60_000);
  }

  /** Une ou plusieurs dates (série) ; la fin se déduit de la durée du spectacle si elle n'est pas donnée. */
  @Access('show', 'show.performances.create')
  @Post('show/shows/:id/performances')
  async addPerformances(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const s = await this.show(c.association.id, id);
    const input = parse(zPerformance.omit({ startAt: true }).extend({ startAts: z.array(z.coerce.date()).min(1).max(60) }), body);
    if (input.venueId) await this.venue(c.association.id, input.venueId);
    const created = await this.db.transaction(async (tx) => {
      const out = [];
      for (const start of input.startAts) {
        const end = await this.endOf(s.durationMin, s.intermissionMin, start, input.endAt && input.startAts.length === 1 ? input.endAt : undefined);
        if (end <= start) throw BadRequest('INVALID_DATES', 'La fin doit suivre le début.');
        if (input.doorsAt && input.doorsAt > start) throw BadRequest('INVALID_DATES', 'L’accueil du public doit précéder le début.');
        const doors = input.startAts.length === 1 ? input.doorsAt ?? null : null;
        const [p] = await tx.insert(showPerformances).values({
          showId: id, startAt: start, endAt: end, doorsAt: doors, venueId: input.venueId ?? null, capacity: input.capacity ?? null, status: input.status, notes: input.notes ?? null, createdBy: c.user.id,
        }).returning();
        const eventId = await syncPerformanceEvent(tx, sctx(c), p);
        out.push({ ...p, eventId });
      }
      await this.audit.log({ ...log(c), action: 'show.performance.create', resourceType: 'show', resourceId: id, summary: `${out.length} représentation(s) de « ${s.title} » ajoutée(s) : ${out.map((p) => fr(p.startAt)).join(', ')}` }, tx);
      return out;
    });
    return { performances: created };
  }

  @Access('show', 'show.performances.update')
  @Patch('show/performances/:id')
  async updatePerformance(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { p: before, s } = await this.performance(c.association.id, id);
    const input = parse(patchOf(zPerformance), body);
    if (input.venueId) await this.venue(c.association.id, input.venueId);
    const start = input.startAt ?? before.startAt;
    // Déplacer le début sans fin explicite décale la fin d'autant (durée conservée).
    const end = input.endAt ?? (input.startAt ? new Date(before.endAt.getTime() + (input.startAt.getTime() - before.startAt.getTime())) : before.endAt);
    if (end <= start) throw BadRequest('INVALID_DATES', 'La fin doit suivre le début.');
    const doors = input.doorsAt !== undefined ? input.doorsAt : before.doorsAt;
    if (doors && doors > start) throw BadRequest('INVALID_DATES', 'L’accueil du public doit précéder le début.');
    return this.db.transaction(async (tx) => {
      const [p] = await tx.update(showPerformances).set({ ...input, startAt: start, endAt: end, doorsAt: doors, updatedAt: new Date() }).where(eq(showPerformances.id, id)).returning();
      const eventId = await syncPerformanceEvent(tx, sctx(c), p);
      await this.audit.log({ ...log(c), action: 'show.performance.update', resourceType: 'show', resourceId: s.id, summary: `Représentation du ${fr(before.startAt)} de « ${s.title} » modifiée${input.status && input.status !== before.status ? ` (${STATUS[input.status]})` : ''}` }, tx);
      return { ...p, eventId };
    });
  }

  @Access('show', 'show.performances.delete')
  @Delete('show/performances/:id')
  async removePerformance(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { p, s } = await this.performance(c.association.id, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(showPerformances).where(eq(showPerformances.id, id));
      if (p.eventId) await tx.delete(events).where(and(eq(events.id, p.eventId), eq(events.associationId, c.association.id)));
      await this.audit.log({ ...log(c), action: 'show.performance.delete', resourceType: 'show', resourceId: s.id, summary: `Représentation du ${fr(p.startAt)} de « ${s.title} » supprimée` }, tx);
    });
    return { ok: true };
  }

  /** Calendrier des représentations, tous spectacles confondus. */
  @Access('show', 'show.performances.read')
  @Get('show/performances')
  async calendar(@AssocContext() c: AssocCtx, @Query('past') past?: string) {
    const now = new Date();
    const rows = await this.db.select({ p: showPerformances, title: shows.title, v: showVenues }).from(showPerformances).innerJoin(shows, eq(shows.id, showPerformances.showId))
      .leftJoin(showVenues, eq(showVenues.id, showPerformances.venueId))
      .where(and(eq(shows.associationId, c.association.id), past === '1' ? lt(showPerformances.startAt, now) : gte(showPerformances.endAt, now)))
      .orderBy(past === '1' ? desc(showPerformances.startAt) : asc(showPerformances.startAt)).limit(300);
    return rows.map(({ p, title, v }) => ({ id: p.id, showId: p.showId, show: title, startAt: p.startAt, endAt: p.endAt, status: p.status, venue: v ? [v.name, v.city].filter(Boolean).join(', ') : null, capacity: p.capacity ?? v?.capacity ?? null }));
  }

  /* ============================================================ Espace */

  /** Représentations auxquelles l'adhérent connecté participe (équipe ou distribution). */
  @Access('espace', 'espace.read')
  @Get('espace/show')
  async mine(@AssocContext() c: AssocCtx) {
    if (!c.modules.show?.usable) return [];
    const [m] = await this.db.select().from(members).where(and(eq(members.associationId, c.association.id), eq(members.userId, c.user.id), ne(members.status, 'archived')));
    if (!m) return [];
    const crew = await this.db.select({ showId: showCrew.showId, job: showCrew.job }).from(showCrew).where(eq(showCrew.memberId, m.id));
    const cast = c.modules.cast?.usable && isFeatureEnabled(c.modules, 'cast.distributions')
      ? await this.db.select({ showId: castProductions.showId, job: castRoles.name }).from(castAssignments).innerJoin(castRoles, eq(castRoles.id, castAssignments.roleId))
        .innerJoin(castProductions, eq(castProductions.id, castRoles.productionId)).where(and(eq(castAssignments.memberId, m.id), eq(castAssignments.kind, 'lead'), eq(castAssignments.status, 'confirmed')))
      : [];
    const jobs = new Map<string, string[]>();
    for (const r of [...crew, ...cast]) if (r.showId) jobs.set(r.showId, [...(jobs.get(r.showId) ?? []), r.job]);
    if (!jobs.size) return [];
    const rows = await this.db.select({ p: showPerformances, title: shows.title, v: showVenues }).from(showPerformances).innerJoin(shows, eq(shows.id, showPerformances.showId))
      .leftJoin(showVenues, eq(showVenues.id, showPerformances.venueId))
      .where(and(inArray(showPerformances.showId, [...jobs.keys()]), gte(showPerformances.endAt, new Date()), ne(showPerformances.status, 'cancelled'))).orderBy(asc(showPerformances.startAt)).limit(60);
    return rows.map(({ p, title, v }) => ({ id: p.id, show: title, startAt: p.startAt, endAt: p.endAt, doorsAt: p.doorsAt, venue: v ? [v.name, v.addressLine, v.city].filter(Boolean).join(', ') : null, jobs: jobs.get(p.showId) ?? [], status: p.status }));
  }
}

