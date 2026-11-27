import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_TIMEZONE, isFeatureEnabled, localDate } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Forbidden, NotFound } from '../common/errors';
import { DB, Db, DbOrTx } from '../db/db';
import {
  associations, castAssignments, castProductions, castRehearsals, castRoles, castSceneRoles, castScenes, castUnavailabilities, eventParticipants, events, members,
} from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';
import { occurrencesOf } from '../agenda/agenda.controller';
import { callSheetPdf, distributionPdf } from './cast-pdf';

const TZ = DEFAULT_TIMEZONE;
const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue (AAAA-MM-JJ)');
const zDateOpt = z.preprocess((v) => (v === '' ? null : v), zDate.nullable().optional());
const STATUSES = ['preparation', 'rehearsal', 'running', 'closed'] as const;
const STATUS_LABEL: Record<string, string> = { preparation: 'en préparation', rehearsal: 'en répétition', running: 'à l’affiche', closed: 'terminée' };

const zProduction = z.object({
  title: z.string().trim().min(1).max(200),
  author: zOptText(200),
  description: zOptText(4000),
  season: zOptText(40),
  status: z.enum(STATUSES).default('preparation'),
  premiereDate: zDateOpt,
});
const zRole = z.object({
  name: z.string().trim().min(1).max(120),
  description: zOptText(1000),
  category: z.enum(['main', 'secondary', 'ensemble']).default('main'),
  position: z.number().int().min(0).max(10_000).optional(),
});
const zScene = z.object({
  act: z.number().int().min(0).max(99).nullable().optional(),
  number: z.number().int().min(0).max(999).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  durationMin: z.number().int().min(0).max(600).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  roleIds: z.array(zUuid).max(200).optional(),
});
const zRehearsal = z.object({
  title: zOptText(200),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  location: zOptText(200),
  sceneIds: z.array(zUuid).max(300).default([]),
  includeUnderstudies: z.boolean().default(false),
  notes: zOptText(2000),
});

type Production = typeof castProductions.$inferSelect;
type Rehearsal = typeof castRehearsals.$inferSelect;
interface Call { memberId: string; name: string; phone: string | null; roles: string[]; understudy: boolean }

@ApiTags('Scenorya Cast')
@Controller()
export class CastController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'cast',
      check: async (db, associationId) => {
        const out: ModuleImpact[] = [];
        const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(castRehearsals).innerJoin(castProductions, eq(castProductions.id, castRehearsals.productionId))
          .where(and(eq(castProductions.associationId, associationId), gt(castRehearsals.startAt, new Date())));
        if (r.n > 0) out.push({ module: 'cast', level: 'warning', message: `${r.n} répétition(s) à venir : leurs événements d’agenda restent, mais ne seront plus mis à jour.` });
        const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(castProductions).where(eq(castProductions.associationId, associationId));
        if (p.n > 0) out.push({ module: 'cast', level: 'info', message: `${p.n} production(s) et leurs distributions sont conservées.` });
        return out;
      },
    });
  }

  /* ============================================================ Accès */

  private async production(associationId: string, id: string) {
    parse(zUuid, id);
    const [p] = await this.db.select().from(castProductions).where(and(eq(castProductions.id, id), eq(castProductions.associationId, associationId)));
    if (!p) throw NotFound('Production introuvable.');
    return p;
  }

  private async roleOf(associationId: string, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ r: castRoles, p: castProductions }).from(castRoles).innerJoin(castProductions, eq(castProductions.id, castRoles.productionId))
      .where(and(eq(castRoles.id, id), eq(castProductions.associationId, associationId)));
    if (!r) throw NotFound('Rôle introuvable.');
    return r;
  }

  private async sceneOf(associationId: string, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ s: castScenes, p: castProductions }).from(castScenes).innerJoin(castProductions, eq(castProductions.id, castScenes.productionId))
      .where(and(eq(castScenes.id, id), eq(castProductions.associationId, associationId)));
    if (!r) throw NotFound('Scène introuvable.');
    return r;
  }

  private async rehearsalOf(associationId: string, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ r: castRehearsals, p: castProductions }).from(castRehearsals).innerJoin(castProductions, eq(castProductions.id, castRehearsals.productionId))
      .where(and(eq(castRehearsals.id, id), eq(castProductions.associationId, associationId)));
    if (!r) throw NotFound('Répétition introuvable.');
    return r;
  }

  private async assertMembers(associationId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await this.db.select({ id: members.id }).from(members).where(and(eq(members.associationId, associationId), inArray(members.id, ids), ne(members.status, 'archived')));
    if (rows.length !== new Set(ids).size) throw BadRequest('UNKNOWN_MEMBER', 'Adhérent inconnu ou archivé.');
  }

  private async assertScenes(productionId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await this.db.select({ id: castScenes.id }).from(castScenes).where(and(eq(castScenes.productionId, productionId), inArray(castScenes.id, ids)));
    if (rows.length !== new Set(ids).size) throw BadRequest('UNKNOWN_SCENE', 'Scène inconnue dans cette production.');
  }

  private async assertRoles(productionId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await this.db.select({ id: castRoles.id }).from(castRoles).where(and(eq(castRoles.productionId, productionId), inArray(castRoles.id, ids)));
    if (rows.length !== new Set(ids).size) throw BadRequest('UNKNOWN_ROLE', 'Rôle inconnu dans cette production.');
  }

  /* ============================================================ Convocations et conflits */

  /** Convoqués d'une répétition : titulaires confirmés (et doublures si demandé) des rôles présents dans les scènes. */
  private async calls(db: DbOrTx, productionId: string, sceneIds: string[], includeUnderstudies: boolean): Promise<Call[]> {
    const roleIds = sceneIds.length
      ? (await db.selectDistinct({ id: castSceneRoles.roleId }).from(castSceneRoles).where(inArray(castSceneRoles.sceneId, sceneIds))).map((r) => r.id)
      : (await db.select({ id: castRoles.id }).from(castRoles).where(eq(castRoles.productionId, productionId))).map((r) => r.id);
    if (!roleIds.length) return [];
    const rows = await db.select({ a: castAssignments, role: castRoles.name, m: { id: members.id, firstName: members.firstName, lastName: members.lastName, phone: members.phone, status: members.status } })
      .from(castAssignments).innerJoin(castRoles, eq(castRoles.id, castAssignments.roleId)).innerJoin(members, eq(members.id, castAssignments.memberId))
      .where(and(inArray(castAssignments.roleId, roleIds), eq(castAssignments.status, 'confirmed'), ne(members.status, 'archived'), includeUnderstudies ? undefined : eq(castAssignments.kind, 'lead')))
      .orderBy(asc(members.lastName), asc(members.firstName));
    const by = new Map<string, Call>();
    for (const r of rows) {
      const cur = by.get(r.m.id) ?? { memberId: r.m.id, name: `${r.m.firstName} ${r.m.lastName}`, phone: r.m.phone, roles: [], understudy: true };
      cur.roles.push(r.role);
      if (r.a.kind === 'lead') cur.understudy = false;
      by.set(r.m.id, cur);
    }
    return [...by.values()];
  }

  /** Indisponibilités déclarées, autres répétitions et événements d'agenda qui chevauchent le créneau. */
  private async conflicts(associationId: string, memberIds: string[], start: Date, end: Date, exclude: { rehearsalId?: string; eventId?: string | null } = {}) {
    const out = new Map<string, string[]>();
    const add = (id: string, why: string) => out.set(id, [...(out.get(id) ?? []), why]);
    if (!memberIds.length) return out;
    const d0 = localDate(start, TZ);
    const d1 = localDate(new Date(end.getTime() - 1), TZ);
    const unav = await this.db.select().from(castUnavailabilities)
      .where(and(eq(castUnavailabilities.associationId, associationId), inArray(castUnavailabilities.memberId, memberIds), lte(castUnavailabilities.startsOn, d1), gte(castUnavailabilities.endsOn, d0)));
    for (const u of unav) add(u.memberId, `indisponible${u.startsOn === u.endsOn ? ` le ${fr(u.startsOn)}` : ` du ${fr(u.startsOn)} au ${fr(u.endsOn)}`}${u.reason ? ` (${u.reason})` : ''}`);
    const others = await this.db.select({ r: castRehearsals, title: castProductions.title }).from(castRehearsals).innerJoin(castProductions, eq(castProductions.id, castRehearsals.productionId))
      .where(and(eq(castProductions.associationId, associationId), lt(castRehearsals.startAt, end), gt(castRehearsals.endAt, start), exclude.rehearsalId ? ne(castRehearsals.id, exclude.rehearsalId) : undefined));
    const wanted = new Set(memberIds);
    for (const o of others) {
      for (const k of await this.calls(this.db, o.r.productionId, o.r.sceneIds, o.r.includeUnderstudies)) if (wanted.has(k.memberId)) add(k.memberId, `autre répétition : ${o.title}`);
    }
    const cast = new Set(others.map((o) => o.r.eventId).filter(Boolean));
    const evs = await this.db.select({ e: events, memberId: eventParticipants.memberId }).from(eventParticipants).innerJoin(events, eq(events.id, eventParticipants.eventId))
      .where(and(eq(events.associationId, associationId), isNull(events.cancelledAt), inArray(eventParticipants.memberId, memberIds), ne(eventParticipants.status, 'no'),
        lt(events.startAt, end), or(gt(events.endAt, start), sql`${events.rule} is not null`)));
    for (const { e, memberId } of evs) {
      if (e.id === exclude.eventId || cast.has(e.id)) continue;
      if (occurrencesOf(e, new Date(start.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000)).some((o) => o.start < end && start < o.end)) add(memberId, `agenda : ${e.title}`);
    }
    return out;
  }

  private async withConflicts(associationId: string, calls: Call[], start: Date, end: Date, exclude: { rehearsalId?: string; eventId?: string | null } = {}) {
    const conf = await this.conflicts(associationId, calls.map((k) => k.memberId), start, end, exclude);
    return calls.map((k) => ({ ...k, conflicts: conf.get(k.memberId) ?? [] }));
  }

  /** Événement d'agenda de la répétition et ses participants (réponses déjà données conservées). */
  private async syncEvent(tx: DbOrTx, c: AssocCtx, p: Production, r: Rehearsal) {
    if (!isFeatureEnabled(c.modules, 'cast.agendaCalls')) return r.eventId;
    const scenes = r.sceneIds.length ? await tx.select().from(castScenes).where(inArray(castScenes.id, r.sceneIds)).orderBy(asc(castScenes.position), asc(castScenes.act), asc(castScenes.number)) : [];
    const values = {
      title: r.title || `Répétition — ${p.title}`, category: 'rehearsal', startAt: r.startAt, endAt: r.endAt, location: r.location,
      description: [scenes.length ? `Scènes : ${scenes.map(sceneLabel).join(' ; ')}` : 'Filage', r.notes].filter(Boolean).join('\n\n'), updatedAt: new Date(),
    };
    let eventId = r.eventId;
    if (eventId) {
      const [still] = await tx.update(events).set(values).where(eq(events.id, eventId)).returning({ id: events.id });
      if (!still) eventId = null;
    }
    if (!eventId) {
      const [e] = await tx.insert(events).values({ ...values, associationId: c.association.id, createdBy: c.user.id }).returning({ id: events.id });
      eventId = e.id;
      await tx.update(castRehearsals).set({ eventId }).where(eq(castRehearsals.id, r.id));
    }
    const wanted = (await this.calls(tx, p.id, r.sceneIds, r.includeUnderstudies)).map((k) => k.memberId);
    const current = (await tx.select({ m: eventParticipants.memberId }).from(eventParticipants).where(eq(eventParticipants.eventId, eventId))).map((x) => x.m);
    const gone = current.filter((m) => !wanted.includes(m));
    const fresh = wanted.filter((m) => !current.includes(m));
    if (gone.length) await tx.delete(eventParticipants).where(and(eq(eventParticipants.eventId, eventId), inArray(eventParticipants.memberId, gone)));
    if (fresh.length) await tx.insert(eventParticipants).values(fresh.map((memberId) => ({ eventId: eventId!, memberId }))).onConflictDoNothing();
    return eventId;
  }

  /** Après un changement de distribution ou de scènes : mise à jour des convocations à venir. */
  private async resyncUpcoming(c: AssocCtx, p: Production) {
    if (!isFeatureEnabled(c.modules, 'cast.agendaCalls')) return;
    const list = await this.db.select().from(castRehearsals).where(and(eq(castRehearsals.productionId, p.id), gt(castRehearsals.startAt, new Date())));
    for (const r of list) await this.db.transaction((tx) => this.syncEvent(tx, c, p, r));
  }

  /* ============================================================ Productions */

  @Access('cast', 'cast.productions.read')
  @Get('cast/productions')
  async list(@AssocContext() c: AssocCtx) {
    const rows = await this.db.select().from(castProductions).where(eq(castProductions.associationId, c.association.id)).orderBy(sql`${castProductions.status} = 'closed'`, desc(castProductions.createdAt));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const stats = await this.db.execute<{ id: string; roles: number; cast: number; scenes: number; next: string | null }>(sql`
      select p.id,
        (select count(*)::int from cast_roles r where r.production_id = p.id) as roles,
        (select count(distinct r.id)::int from cast_roles r join cast_assignments a on a.role_id = r.id and a.kind = 'lead' and a.status = 'confirmed' where r.production_id = p.id) as cast,
        (select count(*)::int from cast_scenes s where s.production_id = p.id) as scenes,
        (select min(start_at) from cast_rehearsals h where h.production_id = p.id and h.start_at > now()) as next
      from cast_productions p where p.id in ${ids}`);
    const st = new Map(stats.rows.map((r) => [r.id, r]));
    return rows.map((p) => ({ ...p, roles: st.get(p.id)?.roles ?? 0, castRoles: st.get(p.id)?.cast ?? 0, scenes: st.get(p.id)?.scenes ?? 0, nextRehearsal: st.get(p.id)?.next ?? null }));
  }

  @Access('cast', 'cast.productions.create')
  @Post('cast/productions')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zProduction, body);
    const [p] = await this.db.insert(castProductions).values({ ...input, premiereDate: input.premiereDate ?? null, associationId: c.association.id, createdBy: c.user.id }).returning();
    await this.audit.log({ ...log(c), action: 'cast.production.create', resourceType: 'cast_production', resourceId: p.id, summary: `Création de la production « ${p.title} »` });
    return p;
  }

  @Access('cast', 'cast.productions.read')
  @Get('cast/productions/:id')
  async detail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const p = await this.production(c.association.id, id);
    const roles = await this.db.select().from(castRoles).where(eq(castRoles.productionId, id)).orderBy(asc(castRoles.position), asc(castRoles.createdAt));
    const assigns = roles.length ? await this.db.select({ a: castAssignments, m: { id: members.id, firstName: members.firstName, lastName: members.lastName, number: members.number, status: members.status } })
      .from(castAssignments).innerJoin(members, eq(members.id, castAssignments.memberId)).where(inArray(castAssignments.roleId, roles.map((r) => r.id))).orderBy(asc(castAssignments.createdAt)) : [];
    const scenes = await this.db.select().from(castScenes).where(eq(castScenes.productionId, id)).orderBy(asc(castScenes.position), asc(castScenes.act), asc(castScenes.number), asc(castScenes.createdAt));
    const links = scenes.length ? await this.db.select().from(castSceneRoles).where(inArray(castSceneRoles.sceneId, scenes.map((s) => s.id))) : [];
    const rehearsals = await this.db.select().from(castRehearsals).where(eq(castRehearsals.productionId, id)).orderBy(asc(castRehearsals.startAt));
    return {
      ...p,
      roles: roles.map((r) => ({
        ...r,
        assignments: assigns.filter((x) => x.a.roleId === r.id).map((x) => ({ id: x.a.id, kind: x.a.kind, status: x.a.status, note: x.a.note, member: { id: x.m.id, name: `${x.m.firstName} ${x.m.lastName}`, number: x.m.number, archived: x.m.status === 'archived' } })),
        scenes: links.filter((l) => l.roleId === r.id).length,
      })),
      scenes: scenes.map((s) => ({ ...s, label: sceneLabel(s), roleIds: links.filter((l) => l.sceneId === s.id).map((l) => l.roleId) })),
      rehearsals: rehearsals.map((r) => ({ ...r, scenes: r.sceneIds.map((sid) => scenes.find((s) => s.id === sid)).filter(Boolean).map((s) => sceneLabel(s!)) })),
      agendaCalls: isFeatureEnabled(c.modules, 'cast.agendaCalls'),
    };
  }

  @Access('cast', 'cast.productions.update')
  @Patch('cast/productions/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.production(c.association.id, id);
    const input = parse(patchOf(zProduction), body);
    const [p] = await this.db.update(castProductions).set({ ...input, updatedAt: new Date() }).where(eq(castProductions.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'cast.production.update', resourceType: 'cast_production', resourceId: id, summary: `Modification de la production « ${p.title} »${input.status && input.status !== before.status ? ` (désormais ${STATUS_LABEL[input.status]})` : ''}` });
    return p;
  }

  /** Suppression définitive : rôles, distribution, scènes, répétitions et leurs événements d'agenda. */
  @Access('cast', 'cast.productions.delete')
  @Delete('cast/productions/:id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const p = await this.production(c.association.id, id);
    const counts = await this.db.transaction(async (tx) => {
      const reh = await tx.select({ e: castRehearsals.eventId }).from(castRehearsals).where(eq(castRehearsals.productionId, id));
      const evIds = reh.map((r) => r.e).filter((x): x is string => !!x);
      const [roles] = await tx.select({ n: sql<number>`count(*)::int` }).from(castRoles).where(eq(castRoles.productionId, id));
      await tx.delete(castProductions).where(eq(castProductions.id, id));
      if (evIds.length) await tx.delete(events).where(and(inArray(events.id, evIds), eq(events.associationId, c.association.id)));
      await this.audit.log({ ...log(c), action: 'cast.production.delete', resourceType: 'cast_production', resourceId: id, summary: `Suppression de la production « ${p.title} » (${roles.n} rôle(s), ${reh.length} répétition(s))` }, tx);
      return { roles: roles.n, rehearsals: reh.length };
    });
    return { ok: true, ...counts };
  }

  @Access('cast', 'cast.productions.download')
  @Get('cast/productions/:id/distribution.pdf')
  async distributionPdf(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const d = await this.detail(c, id);
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const names = (r: (typeof d.roles)[number], kind: string) => r.assignments.filter((x) => x.kind === kind).map((x) => `${x.member.name}${x.status === 'considered' ? ' (pressenti)' : ''}`);
    const pdf = await distributionPdf(a, d,
      d.roles.map((r) => ({ name: r.name, category: r.category, leads: names(r, 'lead'), understudies: names(r, 'understudy') })),
      d.scenes.map((s) => ({ label: s.label, roles: s.roleIds.map((rid) => d.roles.find((r) => r.id === rid)?.name).filter((x): x is string => !!x) })));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="distribution.pdf"`);
    res.send(pdf);
  }

  /* ============================================================ Rôles et distribution */

  @Access('cast', 'cast.productions.update')
  @Post('cast/productions/:id/roles')
  async addRole(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.production(c.association.id, id);
    const input = parse(zRole, body);
    const [{ n }] = await this.db.select({ n: sql<number>`coalesce(max(${castRoles.position}), -1)::int + 1` }).from(castRoles).where(eq(castRoles.productionId, id));
    const [r] = await this.db.insert(castRoles).values({ ...input, position: input.position ?? n, productionId: id }).returning();
    await this.audit.log({ ...log(c), action: 'cast.role.create', resourceType: 'cast_production', resourceId: id, summary: `Rôle « ${r.name} » ajouté à « ${p.title} »` });
    return r;
  }

  @Access('cast', 'cast.productions.update')
  @Patch('cast/roles/:id')
  async updateRole(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { r: before, p } = await this.roleOf(c.association.id, id);
    const input = parse(patchOf(zRole), body);
    const [r] = await this.db.update(castRoles).set(input).where(eq(castRoles.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'cast.role.update', resourceType: 'cast_production', resourceId: p.id, summary: `Rôle « ${before.name} » modifié${r.name !== before.name ? ` (désormais « ${r.name} »)` : ''}` });
    return r;
  }

  @Access('cast', 'cast.productions.update')
  @Delete('cast/roles/:id')
  async removeRole(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { r, p } = await this.roleOf(c.association.id, id);
    await this.db.delete(castRoles).where(eq(castRoles.id, id));
    await this.audit.log({ ...log(c), action: 'cast.role.delete', resourceType: 'cast_production', resourceId: p.id, summary: `Rôle « ${r.name} » supprimé de « ${p.title} » (avec sa distribution)` });
    await this.resyncUpcoming(c, p);
    return { ok: true };
  }

  @Access('cast', 'cast.productions.update')
  @Post('cast/roles/:id/assignments')
  async assign(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { r, p } = await this.roleOf(c.association.id, id);
    const input = parse(z.object({ memberId: zUuid, kind: z.enum(['lead', 'understudy']).default('lead'), status: z.enum(['considered', 'confirmed']).default('confirmed'), note: zOptText(300) }), body);
    await this.assertMembers(c.association.id, [input.memberId]);
    const [a] = await this.db.insert(castAssignments).values({ ...input, roleId: id }).onConflictDoUpdate({ target: [castAssignments.roleId, castAssignments.memberId], set: { kind: input.kind, status: input.status, note: input.note ?? null } }).returning();
    const [m] = await this.db.select({ f: members.firstName, l: members.lastName }).from(members).where(eq(members.id, input.memberId));
    await this.audit.log({ ...log(c), action: 'cast.assign', resourceType: 'cast_production', resourceId: p.id, summary: `${m.f} ${m.l} : ${input.kind === 'lead' ? 'titulaire' : 'doublure'} du rôle « ${r.name} » (${input.status === 'confirmed' ? 'confirmé' : 'pressenti'}) dans « ${p.title} »` });
    await this.resyncUpcoming(c, p);
    return a;
  }

  @Access('cast', 'cast.productions.update')
  @Patch('cast/assignments/:id')
  async updateAssignment(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const input = parse(z.object({ kind: z.enum(['lead', 'understudy']).optional(), status: z.enum(['considered', 'confirmed']).optional(), note: zOptText(300) }), body);
    const [row] = await this.db.select({ a: castAssignments, r: castRoles, p: castProductions }).from(castAssignments).innerJoin(castRoles, eq(castRoles.id, castAssignments.roleId))
      .innerJoin(castProductions, eq(castProductions.id, castRoles.productionId)).where(and(eq(castAssignments.id, id), eq(castProductions.associationId, c.association.id)));
    if (!row) throw NotFound('Distribution introuvable.');
    const [a] = await this.db.update(castAssignments).set(input).where(eq(castAssignments.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'cast.assign.update', resourceType: 'cast_production', resourceId: row.p.id, summary: `Distribution du rôle « ${row.r.name} » modifiée` });
    await this.resyncUpcoming(c, row.p);
    return a;
  }

  @Access('cast', 'cast.productions.update')
  @Delete('cast/assignments/:id')
  async unassign(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [row] = await this.db.select({ a: castAssignments, r: castRoles, p: castProductions, f: members.firstName, l: members.lastName }).from(castAssignments)
      .innerJoin(castRoles, eq(castRoles.id, castAssignments.roleId)).innerJoin(castProductions, eq(castProductions.id, castRoles.productionId)).innerJoin(members, eq(members.id, castAssignments.memberId))
      .where(and(eq(castAssignments.id, id), eq(castProductions.associationId, c.association.id)));
    if (!row) throw NotFound('Distribution introuvable.');
    await this.db.delete(castAssignments).where(eq(castAssignments.id, id));
    await this.audit.log({ ...log(c), action: 'cast.unassign', resourceType: 'cast_production', resourceId: row.p.id, summary: `${row.f} ${row.l} retiré(e) du rôle « ${row.r.name} »` });
    await this.resyncUpcoming(c, row.p);
    return { ok: true };
  }

  /* ============================================================ Scènes */

  @Access('cast', 'cast.productions.update')
  @Post('cast/productions/:id/scenes')
  async addScene(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.production(c.association.id, id);
    const { roleIds, ...input } = parse(zScene, body);
    await this.assertRoles(id, roleIds ?? []);
    const [{ n }] = await this.db.select({ n: sql<number>`coalesce(max(${castScenes.position}), -1)::int + 1` }).from(castScenes).where(eq(castScenes.productionId, id));
    const s = await this.db.transaction(async (tx) => {
      const [s] = await tx.insert(castScenes).values({ ...input, position: input.position ?? n, productionId: id }).returning();
      if (roleIds?.length) await tx.insert(castSceneRoles).values([...new Set(roleIds)].map((roleId) => ({ sceneId: s.id, roleId })));
      return s;
    });
    await this.audit.log({ ...log(c), action: 'cast.scene.create', resourceType: 'cast_production', resourceId: id, summary: `Scène « ${sceneLabel(s)} » ajoutée à « ${p.title} »` });
    return s;
  }

  @Access('cast', 'cast.productions.update')
  @Patch('cast/scenes/:id')
  async updateScene(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { p } = await this.sceneOf(c.association.id, id);
    const { roleIds, ...input } = parse(patchOf(zScene), body) as z.infer<typeof zScene>;
    if (roleIds) await this.assertRoles(p.id, roleIds);
    const s = await this.db.transaction(async (tx) => {
      const [s] = Object.keys(input).length ? await tx.update(castScenes).set(input).where(eq(castScenes.id, id)).returning() : await tx.select().from(castScenes).where(eq(castScenes.id, id));
      if (roleIds) {
        await tx.delete(castSceneRoles).where(eq(castSceneRoles.sceneId, id));
        if (roleIds.length) await tx.insert(castSceneRoles).values([...new Set(roleIds)].map((roleId) => ({ sceneId: id, roleId })));
      }
      return s;
    });
    await this.audit.log({ ...log(c), action: 'cast.scene.update', resourceType: 'cast_production', resourceId: p.id, summary: `Scène « ${sceneLabel(s)} » modifiée` });
    if (roleIds) await this.resyncUpcoming(c, p);
    return s;
  }

  /** Grille de présence : un personnage entre dans une scène ou en sort. */
  @Access('cast', 'cast.productions.update')
  @Put('cast/scenes/:id/roles/:roleId')
  async toggle(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('roleId') roleId: string, @Body() body: unknown) {
    const { p } = await this.sceneOf(c.association.id, id);
    parse(zUuid, roleId);
    await this.assertRoles(p.id, [roleId]);
    const { present } = parse(z.object({ present: z.boolean() }), body);
    if (present) await this.db.insert(castSceneRoles).values({ sceneId: id, roleId }).onConflictDoNothing();
    else await this.db.delete(castSceneRoles).where(and(eq(castSceneRoles.sceneId, id), eq(castSceneRoles.roleId, roleId)));
    await this.resyncUpcoming(c, p);
    return { present };
  }

  @Access('cast', 'cast.productions.update')
  @Delete('cast/scenes/:id')
  async removeScene(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { s, p } = await this.sceneOf(c.association.id, id);
    await this.db.transaction(async (tx) => {
      // La scène disparaît aussi des répétitions qui la prévoyaient.
      await tx.execute(sql`update cast_rehearsals set scene_ids = array_remove(scene_ids, ${id}::uuid) where production_id = ${p.id}`);
      await tx.delete(castScenes).where(eq(castScenes.id, id));
      await this.audit.log({ ...log(c), action: 'cast.scene.delete', resourceType: 'cast_production', resourceId: p.id, summary: `Scène « ${sceneLabel(s)} » supprimée de « ${p.title} »` }, tx);
    });
    await this.resyncUpcoming(c, p);
    return { ok: true };
  }

  /* ============================================================ Répétitions */

  @Access('cast', 'cast.rehearsals.read')
  @Post('cast/productions/:id/rehearsals/preview')
  @HttpCode(200)
  async preview(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.production(c.association.id, id);
    const input = parse(zRehearsal.extend({ rehearsalId: zUuid.optional() }), body);
    await this.assertScenes(id, input.sceneIds);
    const calls = await this.calls(this.db, id, input.sceneIds, input.includeUnderstudies);
    let eventId: string | null = null;
    if (input.rehearsalId) eventId = (await this.rehearsalOf(c.association.id, input.rehearsalId)).r.eventId;
    return { calls: await this.withConflicts(c.association.id, calls, input.startAt, input.endAt, { rehearsalId: input.rehearsalId, eventId }) };
  }

  @Access('cast', 'cast.rehearsals.create')
  @Post('cast/productions/:id/rehearsals')
  async createRehearsal(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.production(c.association.id, id);
    const input = parse(zRehearsal, body);
    if (input.endAt <= input.startAt) throw BadRequest('INVALID_DATES', 'La fin doit suivre le début.');
    await this.assertScenes(id, input.sceneIds);
    const r = await this.db.transaction(async (tx) => {
      const [r] = await tx.insert(castRehearsals).values({ ...input, sceneIds: [...new Set(input.sceneIds)], productionId: id, createdBy: c.user.id }).returning();
      const eventId = await this.syncEvent(tx, c, p, r);
      await this.audit.log({ ...log(c), action: 'cast.rehearsal.create', resourceType: 'cast_production', resourceId: id, summary: `Répétition de « ${p.title} » prévue le ${frDateTime(r.startAt)}` }, tx);
      return { ...r, eventId };
    });
    return r;
  }

  @Access('cast', 'cast.rehearsals.read')
  @Get('cast/rehearsals/:id')
  async rehearsal(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { r, p } = await this.rehearsalOf(c.association.id, id);
    const scenes = r.sceneIds.length ? await this.db.select().from(castScenes).where(inArray(castScenes.id, r.sceneIds)) : [];
    const calls = await this.withConflicts(c.association.id, await this.calls(this.db, p.id, r.sceneIds, r.includeUnderstudies), r.startAt, r.endAt, { rehearsalId: r.id, eventId: r.eventId });
    const answers = r.eventId ? await this.db.select().from(eventParticipants).where(eq(eventParticipants.eventId, r.eventId)) : [];
    return {
      ...r, production: { id: p.id, title: p.title },
      scenes: scenes.sort((a, b) => a.position - b.position).map((s) => ({ id: s.id, label: sceneLabel(s) })),
      calls: calls.map((k) => ({ ...k, response: answers.find((x) => x.memberId === k.memberId)?.status ?? null, comment: answers.find((x) => x.memberId === k.memberId)?.comment ?? null })),
    };
  }

  @Access('cast', 'cast.rehearsals.update')
  @Patch('cast/rehearsals/:id')
  async updateRehearsal(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { r: before, p } = await this.rehearsalOf(c.association.id, id);
    const input = parse(patchOf(zRehearsal), body);
    const start = input.startAt ?? before.startAt;
    const end = input.endAt ?? before.endAt;
    if (end <= start) throw BadRequest('INVALID_DATES', 'La fin doit suivre le début.');
    if (input.sceneIds) await this.assertScenes(p.id, input.sceneIds);
    return this.db.transaction(async (tx) => {
      const [r] = await tx.update(castRehearsals).set({ ...input, updatedAt: new Date() }).where(eq(castRehearsals.id, id)).returning();
      const eventId = await this.syncEvent(tx, c, p, r);
      await this.audit.log({ ...log(c), action: 'cast.rehearsal.update', resourceType: 'cast_production', resourceId: p.id, summary: `Répétition du ${frDateTime(before.startAt)} de « ${p.title} » modifiée` }, tx);
      return { ...r, eventId };
    });
  }

  @Access('cast', 'cast.rehearsals.delete')
  @Delete('cast/rehearsals/:id')
  async removeRehearsal(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { r, p } = await this.rehearsalOf(c.association.id, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(castRehearsals).where(eq(castRehearsals.id, id));
      if (r.eventId) await tx.delete(events).where(and(eq(events.id, r.eventId), eq(events.associationId, c.association.id)));
      await this.audit.log({ ...log(c), action: 'cast.rehearsal.delete', resourceType: 'cast_production', resourceId: p.id, summary: `Répétition du ${frDateTime(r.startAt)} de « ${p.title} » supprimée${r.eventId ? ' (et son événement d’agenda)' : ''}` }, tx);
    });
    return { ok: true };
  }

  @Access('cast', 'cast.rehearsals.read')
  @Get('cast/rehearsals/:id/call-sheet.pdf')
  async callSheet(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const d = await this.rehearsal(c, id);
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const pdf = await callSheetPdf(a, d.production, d, d.scenes.map((s) => s.label),
      d.calls.map((k) => ({ name: k.name, roles: k.roles, understudy: k.understudy, phone: k.phone, unavailable: k.conflicts.find((x) => x.startsWith('indisponible'))?.replace(/^indisponible\s*/, '') ?? null })));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="feuille-de-service-${localDate(d.startAt, TZ)}.pdf"`);
    res.send(pdf);
  }

  /** Planning des répétitions, toutes productions confondues. */
  @Access('cast', 'cast.rehearsals.read')
  @Get('cast/rehearsals')
  async planning(@AssocContext() c: AssocCtx, @Query('past') past?: string) {
    const now = new Date();
    const rows = await this.db.select({ r: castRehearsals, title: castProductions.title }).from(castRehearsals).innerJoin(castProductions, eq(castProductions.id, castRehearsals.productionId))
      .where(and(eq(castProductions.associationId, c.association.id), past === '1' ? lt(castRehearsals.startAt, now) : gte(castRehearsals.endAt, now)))
      .orderBy(past === '1' ? desc(castRehearsals.startAt) : asc(castRehearsals.startAt)).limit(200);
    const out = [];
    for (const { r, title } of rows) {
      const calls = await this.calls(this.db, r.productionId, r.sceneIds, r.includeUnderstudies);
      out.push({ id: r.id, productionId: r.productionId, production: title, title: r.title, startAt: r.startAt, endAt: r.endAt, location: r.location, scenes: r.sceneIds.length, calls: calls.length });
    }
    return out;
  }

  /* ============================================================ Indisponibilités */

  @Access('cast', 'cast.availability.read')
  @Get('cast/unavailabilities')
  async unavailabilities(@AssocContext() c: AssocCtx, @Query('past') past?: string) {
    const today = localDate(new Date(), TZ);
    return this.db.select({ id: castUnavailabilities.id, memberId: members.id, name: sql<string>`${members.firstName} || ' ' || ${members.lastName}`, startsOn: castUnavailabilities.startsOn, endsOn: castUnavailabilities.endsOn, reason: castUnavailabilities.reason, createdAt: castUnavailabilities.createdAt })
      .from(castUnavailabilities).innerJoin(members, eq(members.id, castUnavailabilities.memberId))
      .where(and(eq(castUnavailabilities.associationId, c.association.id), past === '1' ? lt(castUnavailabilities.endsOn, today) : gte(castUnavailabilities.endsOn, today)))
      .orderBy(past === '1' ? desc(castUnavailabilities.startsOn) : asc(castUnavailabilities.startsOn)).limit(500);
  }

  @Access('cast', 'cast.availability.update')
  @Post('cast/unavailabilities')
  async addUnavailability(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ memberId: zUuid, startsOn: zDate, endsOn: zDate, reason: zOptText(200) }), body);
    if (input.endsOn < input.startsOn) throw BadRequest('INVALID_DATES', 'La fin précède le début.');
    await this.assertMembers(c.association.id, [input.memberId]);
    const [u] = await this.db.insert(castUnavailabilities).values({ ...input, associationId: c.association.id, createdBy: c.user.id }).returning();
    await this.audit.log({ ...log(c), action: 'cast.unavailability.create', resourceType: 'member', resourceId: input.memberId, summary: `Indisponibilité enregistrée du ${fr(input.startsOn)} au ${fr(input.endsOn)}` });
    return u;
  }

  @Access('cast', 'cast.availability.update')
  @Delete('cast/unavailabilities/:id')
  async removeUnavailability(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [u] = await this.db.delete(castUnavailabilities).where(and(eq(castUnavailabilities.id, id), eq(castUnavailabilities.associationId, c.association.id))).returning();
    if (!u) throw NotFound('Indisponibilité introuvable.');
    await this.audit.log({ ...log(c), action: 'cast.unavailability.delete', resourceType: 'member', resourceId: u.memberId, summary: `Indisponibilité du ${fr(u.startsOn)} au ${fr(u.endsOn)} supprimée` });
    return { ok: true };
  }

  /* ============================================================ Espace du comédien */

  private async self(c: AssocCtx) {
    if (!c.modules.cast?.usable || !isFeatureEnabled(c.modules, 'cast.espace')) throw Forbidden('FEATURE_DISABLED', 'Scenorya Cast n’est pas disponible dans votre espace.');
    const [m] = await this.db.select().from(members).where(and(eq(members.associationId, c.association.id), eq(members.userId, c.user.id), ne(members.status, 'archived')));
    if (!m) throw NotFound('Votre compte n’est relié à aucune fiche d’adhérent.');
    return m;
  }

  @Access('espace', 'espace.read')
  @Get('espace/cast')
  async mine(@AssocContext() c: AssocCtx) {
    const m = await this.self(c);
    const roles = await this.db.select({ role: castRoles.name, kind: castAssignments.kind, status: castAssignments.status, productionId: castProductions.id, production: castProductions.title, pStatus: castProductions.status, premiere: castProductions.premiereDate })
      .from(castAssignments).innerJoin(castRoles, eq(castRoles.id, castAssignments.roleId)).innerJoin(castProductions, eq(castProductions.id, castRoles.productionId))
      .where(and(eq(castAssignments.memberId, m.id), ne(castProductions.status, 'closed'))).orderBy(asc(castProductions.title), asc(castRoles.position));
    const productionIds = [...new Set(roles.map((r) => r.productionId))];
    const upcoming = productionIds.length ? await this.db.select({ r: castRehearsals, title: castProductions.title }).from(castRehearsals).innerJoin(castProductions, eq(castProductions.id, castRehearsals.productionId))
      .where(and(inArray(castRehearsals.productionId, productionIds), gte(castRehearsals.endAt, new Date()))).orderBy(asc(castRehearsals.startAt)).limit(60) : [];
    const rehearsals = [];
    for (const { r, title } of upcoming) {
      const call = (await this.calls(this.db, r.productionId, r.sceneIds, r.includeUnderstudies)).find((k) => k.memberId === m.id);
      if (!call) continue;
      const scenes = r.sceneIds.length ? await this.db.select().from(castScenes).where(inArray(castScenes.id, r.sceneIds)) : [];
      rehearsals.push({ id: r.id, production: title, title: r.title, startAt: r.startAt, endAt: r.endAt, location: r.location, roles: call.roles, understudy: call.understudy, scenes: scenes.sort((a, b) => a.position - b.position).map(sceneLabel), notes: r.notes, eventId: r.eventId });
    }
    const unav = await this.db.select().from(castUnavailabilities).where(and(eq(castUnavailabilities.memberId, m.id), gte(castUnavailabilities.endsOn, localDate(new Date(), TZ)))).orderBy(asc(castUnavailabilities.startsOn));
    return { roles, rehearsals, unavailabilities: unav.map((u) => ({ id: u.id, startsOn: u.startsOn, endsOn: u.endsOn, reason: u.reason })) };
  }

  @Access('espace', 'espace.read')
  @Post('espace/cast/unavailabilities')
  async declare(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const m = await this.self(c);
    const input = parse(z.object({ startsOn: zDate, endsOn: zDate, reason: zOptText(200) }), body);
    if (input.endsOn < input.startsOn) throw BadRequest('INVALID_DATES', 'La fin précède le début.');
    const [u] = await this.db.insert(castUnavailabilities).values({ ...input, memberId: m.id, associationId: c.association.id, createdBy: c.user.id }).returning();
    await this.audit.log({ ...log(c), action: 'espace.unavailability.create', resourceType: 'member', resourceId: m.id, summary: `${m.firstName} ${m.lastName} se déclare indisponible du ${fr(input.startsOn)} au ${fr(input.endsOn)}` });
    return u;
  }

  @Access('espace', 'espace.read')
  @Delete('espace/cast/unavailabilities/:id')
  async undeclare(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const m = await this.self(c);
    const [u] = await this.db.delete(castUnavailabilities).where(and(eq(castUnavailabilities.id, id), eq(castUnavailabilities.memberId, m.id))).returning();
    if (!u) throw NotFound('Indisponibilité introuvable.');
    await this.audit.log({ ...log(c), action: 'espace.unavailability.delete', resourceType: 'member', resourceId: m.id, summary: `${m.firstName} ${m.lastName} retire son indisponibilité du ${fr(u.startsOn)}` });
    return { ok: true };
  }
}

export function sceneLabel(s: { act: number | null; number: number | null; title: string }) {
  const ref = [s.act != null ? `Acte ${s.act}` : null, s.number != null ? `sc. ${s.number}` : null].filter(Boolean).join(', ');
  return ref ? `${ref} — ${s.title}` : s.title;
}
const fr = (d: string) => d.split('-').reverse().join('/');
const frDateTime = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(d);
