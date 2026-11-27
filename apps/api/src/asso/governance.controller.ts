import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isFeatureEnabled } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Conflict, NotFound } from '../common/errors';
import { DB, Db, DbOrTx } from '../db/db';
import { associations, events, mandates, meetingAttendees, meetings, memberGroupLinks, members, resolutions } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { SettingsService, emailLayout, brandingDir } from '../system/settings.service';
import { attendancePdf, convocationPdf, MEETING_TYPES, minutesPdf, Signatories } from './governance-pdf';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const TYPES = ['ag_ordinaire', 'ag_extraordinaire', 'ca', 'bureau', 'autre'] as const;
const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zItem = z.object({ title: z.string().trim().min(2).max(200), description: zOptText(1000), vote: z.boolean().default(false) });
const zMeeting = z.object({
  type: z.enum(TYPES),
  title: z.string().trim().min(2).max(200),
  startAt: z.string().datetime({ offset: true }),
  location: zOptText(200),
  agendaItems: z.array(zItem).max(50).default([]),
  quorumPercent: z.number().int().min(1).max(100).nullable().optional(),
  maxProxies: z.number().int().min(0).max(50).nullable().optional(),
  minutes: zOptText(50_000),
});
type MeetingRow = typeof meetings.$inferSelect;

@ApiTags('Scenorya Asso — Gouvernance')
@Controller('asso')
export class GovernanceController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  private async meeting(associationId: string, id: string, editable = false) {
    parse(zUuid, id);
    const [m] = await this.db.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.associationId, associationId)));
    if (!m) throw NotFound('Réunion introuvable.');
    if (editable && m.closedAt) throw Conflict('MEETING_CLOSED', 'Réunion clôturée : le procès-verbal est figé.');
    return m;
  }

  private async attendees(meetingId: string) {
    const proxy = sql<string | null>`(select p.first_name || ' ' || p.last_name from members p where p.id = ${meetingAttendees.proxyMemberId})`;
    return this.db
      .select({ memberId: members.id, number: members.number, firstName: members.firstName, lastName: members.lastName, email: members.email, status: meetingAttendees.status, proxyMemberId: meetingAttendees.proxyMemberId, proxyName: proxy, emailStatus: meetingAttendees.emailStatus })
      .from(meetingAttendees)
      .innerJoin(members, eq(members.id, meetingAttendees.memberId))
      .where(eq(meetingAttendees.meetingId, meetingId))
      .orderBy(asc(members.lastName), asc(members.firstName));
  }

  private quorum(m: MeetingRow, list: { status: string }[]) {
    const total = list.length;
    const present = list.filter((a) => a.status === 'present').length;
    const represented = list.filter((a) => a.status === 'represented').length;
    const percent = total ? Math.round(((present + represented) / total) * 1000) / 10 : 0;
    return { total, present, represented, percent, required: m.quorumPercent, reached: m.quorumPercent ? percent >= m.quorumPercent : null };
  }

  /** Président(e) et secrétaire en exercice (mandats du bureau), pour les signatures. */
  private async signatories(associationId: string): Promise<Signatories> {
    const rows = await this.db
      .select({ role: mandates.role, firstName: members.firstName, lastName: members.lastName })
      .from(mandates)
      .innerJoin(members, eq(members.id, mandates.memberId))
      .where(and(eq(mandates.associationId, associationId), sql`${mandates.startDate} <= current_date and (${mandates.endDate} is null or ${mandates.endDate} >= current_date)`));
    const find = (re: RegExp) => rows.find((r) => re.test(r.role.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()));
    const p = find(/^presid/);
    const s = find(/^secretaire/);
    return { president: p ? `${p.firstName} ${p.lastName}` : null, secretary: s ? `${s.firstName} ${s.lastName}` : null };
  }

  /** Événement d'agenda lié (fonctionnalité conditionnée à Scenorya Agenda). */
  private async syncEvent(tx: DbOrTx, c: AssocCtx, m: MeetingRow) {
    if (!isFeatureEnabled(c.modules, 'asso.governanceAgenda')) return m.eventId;
    const values = {
      title: `${MEETING_TYPES[m.type]} — ${m.title}`,
      category: m.type.startsWith('ag_') ? 'general_assembly' : 'meeting',
      startAt: m.startAt,
      endAt: new Date(m.startAt.getTime() + 2 * 3600_000),
      location: m.location,
      updatedAt: new Date(),
    };
    if (m.eventId) {
      await tx.update(events).set(values).where(eq(events.id, m.eventId));
      return m.eventId;
    }
    const [e] = await tx.insert(events).values({ ...values, associationId: m.associationId, createdBy: c.user.id }).returning({ id: events.id });
    return e.id;
  }

  /* -------------------------------------------------------- Réunions */

  @Access('asso', 'asso.meetings.read')
  @Get('meetings')
  async list(@AssocContext() c: AssocCtx) {
    const rows = await this.db
      .select({
        m: meetings,
        attendees: sql<number>`(select count(*)::int from meeting_attendees a where a.meeting_id = ${meetings.id})`,
        resolutions: sql<number>`(select count(*)::int from resolutions r where r.meeting_id = ${meetings.id})`,
      })
      .from(meetings)
      .where(eq(meetings.associationId, c.association.id))
      .orderBy(desc(meetings.startAt));
    return rows.map((r) => ({ ...r.m, minutes: undefined, attendees: r.attendees, resolutions: r.resolutions }));
  }

  @Access('asso', 'asso.meetings.read')
  @Get('meetings/:id')
  async get(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const m = await this.meeting(c.association.id, id);
    const list = await this.attendees(id);
    const res = await this.db.select().from(resolutions).where(eq(resolutions.meetingId, id)).orderBy(asc(resolutions.number));
    return { ...m, attendees: list, resolutions: res, quorum: this.quorum(m, list) };
  }

  @Access('asso', 'asso.meetings.create')
  @Post('meetings')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zMeeting, body);
    return this.db.transaction(async (tx) => {
      const [m] = await tx.insert(meetings).values({ ...input, startAt: new Date(input.startAt), associationId: c.association.id, createdBy: c.user.id }).returning();
      const eventId = await this.syncEvent(tx, c, m);
      if (eventId) await tx.update(meetings).set({ eventId }).where(eq(meetings.id, m.id));
      await this.audit.log({ ...log(c), action: 'meeting.create', resourceType: 'meeting', resourceId: m.id, summary: `Création : ${MEETING_TYPES[m.type]} « ${m.title} »` }, tx);
      return { ...m, eventId };
    });
  }

  @Access('asso', 'asso.meetings.update')
  @Patch('meetings/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.meeting(c.association.id, id, true);
    const input = parse(patchOf(zMeeting.extend({ status: z.enum(['draft', 'convened', 'held']) })), body);
    return this.db.transaction(async (tx) => {
      const [m] = await tx
        .update(meetings)
        .set({ ...input, startAt: input.startAt ? new Date(input.startAt) : undefined, updatedAt: new Date() })
        .where(eq(meetings.id, id))
        .returning();
      if (input.startAt || input.location !== undefined || input.title || input.type) {
        const eventId = await this.syncEvent(tx, c, m);
        if (eventId !== m.eventId) await tx.update(meetings).set({ eventId }).where(eq(meetings.id, id));
      }
      await this.audit.log({ ...log(c), action: 'meeting.update', resourceType: 'meeting', resourceId: id, summary: `Modification de « ${m.title} »`, data: { fields: Object.keys(input) } }, tx);
      return m;
    });
  }

  /* ------------------------------------------------- Convocations */

  /** Ajoute des convoqués : adhérents, groupes ou tous les adhérents actifs. */
  @Access('asso', 'asso.meetings.update')
  @Put('meetings/:id/attendees')
  async addAttendees(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.meeting(c.association.id, id, true);
    const input = parse(z.object({ memberIds: z.array(zUuid).max(2000).default([]), groupIds: z.array(zUuid).max(50).default([]), allActive: z.boolean().default(false) }), body);
    const conds = [];
    if (input.memberIds.length) conds.push(inArray(members.id, input.memberIds));
    if (input.groupIds.length) conds.push(sql`exists (select 1 from ${memberGroupLinks} l where l.member_id = ${members.id} and l.group_id in ${input.groupIds})`);
    if (input.allActive) conds.push(eq(members.status, 'active'));
    if (!conds.length) throw BadRequest('NOTHING_TO_ADD', 'Précisez les adhérents à convoquer.');
    const found = await this.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.associationId, c.association.id), sql`${members.status} <> 'archived'`, or(...conds)));
    if (input.memberIds.length && found.filter((f) => input.memberIds.includes(f.id)).length !== new Set(input.memberIds).size) throw NotFound('Adhérent introuvable dans cette association.');
    if (found.length) await this.db.insert(meetingAttendees).values(found.map((f) => ({ meetingId: id, memberId: f.id }))).onConflictDoNothing();
    await this.audit.log({ ...log(c), action: 'meeting.attendees.add', resourceType: 'meeting', resourceId: id, summary: `${found.length} membre(s) ajouté(s) aux convoqués` });
    return { added: found.length };
  }

  @Access('asso', 'asso.meetings.update')
  @Delete('meetings/:id/attendees/:memberId')
  async removeAttendee(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('memberId') memberId: string) {
    await this.meeting(c.association.id, id, true);
    parse(zUuid, memberId);
    const [holder] = await this.db.select({ n: sql<number>`count(*)::int` }).from(meetingAttendees).where(and(eq(meetingAttendees.meetingId, id), eq(meetingAttendees.proxyMemberId, memberId)));
    if (holder.n > 0) throw Conflict('PROXY_HOLDER', 'Ce membre détient des procurations : modifiez-les d’abord.');
    await this.db.delete(meetingAttendees).where(and(eq(meetingAttendees.meetingId, id), eq(meetingAttendees.memberId, memberId)));
    return { ok: true };
  }

  /** Présence : présent, représenté (avec mandataire), excusé, absent. */
  @Access('asso', 'asso.meetings.update')
  @Patch('meetings/:id/attendees/:memberId')
  async attendance(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('memberId') memberId: string, @Body() body: unknown) {
    const m = await this.meeting(c.association.id, id, true);
    parse(zUuid, memberId);
    const input = parse(z.object({ status: z.enum(['convened', 'present', 'represented', 'excused', 'absent']), proxyMemberId: zUuid.nullable().optional() }), body);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'meeting:' + id}))`);
      const list = await tx.select().from(meetingAttendees).where(eq(meetingAttendees.meetingId, id));
      const me = list.find((a) => a.memberId === memberId);
      if (!me) throw NotFound('Ce membre n’est pas convoqué.');
      let proxy: string | null = null;
      if (input.status === 'represented') {
        if (!input.proxyMemberId) throw BadRequest('PROXY_REQUIRED', 'Indiquez le mandataire.');
        if (input.proxyMemberId === memberId) throw BadRequest('PROXY_SELF', 'Un membre ne peut pas se représenter lui-même.');
        const holder = list.find((a) => a.memberId === input.proxyMemberId);
        if (!holder || holder.status !== 'present') throw BadRequest('PROXY_NOT_PRESENT', 'Le mandataire doit être un membre convoqué et présent.');
        const count = list.filter((a) => a.proxyMemberId === input.proxyMemberId && a.memberId !== memberId).length;
        if (m.maxProxies !== null && count >= m.maxProxies) throw Conflict('PROXY_LIMIT', `Ce mandataire détient déjà ${count} procuration(s) (maximum : ${m.maxProxies}).`);
        proxy = input.proxyMemberId;
      }
      if (input.status !== 'present' && list.some((a) => a.proxyMemberId === memberId)) {
        throw Conflict('PROXY_HOLDER', 'Ce membre détient des procurations : il doit rester présent ou les procurations doivent être modifiées.');
      }
      await tx.update(meetingAttendees).set({ status: input.status, proxyMemberId: proxy }).where(and(eq(meetingAttendees.meetingId, id), eq(meetingAttendees.memberId, memberId)));
      return { ok: true };
    });
  }

  /** Convocation : passe la réunion à « convoquée » et, si demandé, envoie la convocation par e-mail (SMTP). */
  @Access('asso', 'asso.meetings.update')
  @Post('meetings/:id/convene')
  @HttpCode(200)
  async convene(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const m = await this.meeting(c.association.id, id, true);
    const { send, message } = parse(z.object({ send: z.boolean().default(false), message: zOptText(2000) }), body ?? {});
    if (m.agendaItems.length === 0) throw BadRequest('AGENDA_REQUIRED', 'L’ordre du jour est vide.');
    const list = await this.attendees(id);
    if (list.length === 0) throw BadRequest('NO_ATTENDEES', 'Aucun membre convoqué.');
    const report = { sent: 0, failed: 0, noEmail: 0 };
    if (send) {
      const { transporter, from } = await this.settings.transport();
      const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
      const pdf = await convocationPdf(a, m, await this.signatories(c.association.id));
      const logo = join(brandingDir(), 'derived', 'logos', 'scenorya-horizontal-small.png');
      const when = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(m.startAt);
      for (const p of list) {
        if (!p.email) {
          report.noEmail++;
          await this.db.update(meetingAttendees).set({ emailStatus: 'no_email' }).where(and(eq(meetingAttendees.meetingId, id), eq(meetingAttendees.memberId, p.memberId)));
          continue;
        }
        try {
          await transporter.sendMail({
            from, to: p.email,
            subject: `${a.name} — Convocation : ${MEETING_TYPES[m.type]} du ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(m.startAt)}`,
            text: `Bonjour ${p.firstName},\n\nVous êtes convoqué(e) : ${m.title}, le ${when}${m.location ? `, ${m.location}` : ''}.\n${message ? `\n${message}\n` : ''}\nLa convocation et l’ordre du jour sont joints à ce message.\n\n${a.name}`,
            html: emailLayout(`Convocation — ${m.title}`, `<p>Bonjour ${p.firstName},</p><p>Vous êtes convoqué(e) le <strong>${when}</strong>${m.location ? `, ${m.location}` : ''}.</p>${message ? `<p>${message.replace(/</g, '&lt;')}</p>` : ''}<ol>${m.agendaItems.map((i) => `<li>${i.title.replace(/</g, '&lt;')}</li>`).join('')}</ol><p>La convocation (avec un pouvoir à compléter si vous ne pouvez pas venir) est jointe à ce message.</p><p>${a.name}</p>`),
            attachments: [{ filename: 'convocation.pdf', content: pdf }, ...(existsSync(logo) ? [{ filename: 'scenorya.png', path: logo, cid: 'scenorya-logo' }] : [])],
          });
          report.sent++;
          await this.db.update(meetingAttendees).set({ emailStatus: 'sent' }).where(and(eq(meetingAttendees.meetingId, id), eq(meetingAttendees.memberId, p.memberId)));
        } catch (e) {
          report.failed++;
          await this.db.update(meetingAttendees).set({ emailStatus: `failed: ${(e as Error).message.slice(0, 120)}` }).where(and(eq(meetingAttendees.meetingId, id), eq(meetingAttendees.memberId, p.memberId)));
        }
      }
    }
    await this.db.update(meetings).set({ status: m.status === 'draft' ? 'convened' : m.status, convenedAt: new Date(), updatedAt: new Date() }).where(eq(meetings.id, id));
    await this.audit.log({ ...log(c), action: 'meeting.convene', resourceType: 'meeting', resourceId: id, summary: `Convocation de « ${m.title} » (${list.length} convoqué(s)${send ? `, ${report.sent} e-mail(s) envoyé(s), ${report.failed} échec(s), ${report.noEmail} sans adresse` : ', sans envoi'})` });
    return { convoked: list.length, ...report };
  }

  /* ----------------------------------------------- Délibérations */

  private zResolution = z.object({
    title: z.string().trim().min(2).max(300),
    text: zOptText(5000),
    votesFor: z.number().int().min(0).default(0),
    votesAgainst: z.number().int().min(0).default(0),
    abstentions: z.number().int().min(0).default(0),
    result: z.enum(['pending', 'adopted', 'rejected']).default('pending'),
  });

  private async checkVotes(meetingId: string, v: { votesFor?: number; votesAgainst?: number; abstentions?: number }) {
    const list = await this.db.select().from(meetingAttendees).where(eq(meetingAttendees.meetingId, meetingId));
    const voters = list.filter((a) => a.status === 'present' || a.status === 'represented').length;
    const total = (v.votesFor ?? 0) + (v.votesAgainst ?? 0) + (v.abstentions ?? 0);
    if (list.length && total > voters) throw BadRequest('TOO_MANY_VOTES', `Plus de voix (${total}) que de votants présents ou représentés (${voters}).`);
  }

  @Access('asso', 'asso.meetings.update')
  @Post('meetings/:id/resolutions')
  async addResolution(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.meeting(c.association.id, id, true);
    const input = parse(this.zResolution, body);
    await this.checkVotes(id, input);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'meeting:' + id}))`);
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${resolutions.number}), 0)::int` }).from(resolutions).where(eq(resolutions.meetingId, id));
      const [r] = await tx.insert(resolutions).values({ ...input, meetingId: id, number: n + 1 }).returning();
      await this.audit.log({ ...log(c), action: 'resolution.create', resourceType: 'meeting', resourceId: id, summary: `Résolution n° ${r.number} « ${r.title} » (${r.result})` }, tx);
      return r;
    });
  }

  @Access('asso', 'asso.meetings.update')
  @Patch('meetings/:id/resolutions/:rid')
  async updateResolution(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('rid') rid: string, @Body() body: unknown) {
    await this.meeting(c.association.id, id, true);
    parse(zUuid, rid);
    const input = parse(patchOf(this.zResolution), body);
    const [before] = await this.db.select().from(resolutions).where(and(eq(resolutions.id, rid), eq(resolutions.meetingId, id)));
    if (!before) throw NotFound('Résolution introuvable.');
    await this.checkVotes(id, { votesFor: input.votesFor ?? before.votesFor, votesAgainst: input.votesAgainst ?? before.votesAgainst, abstentions: input.abstentions ?? before.abstentions });
    const [r] = await this.db.update(resolutions).set(input).where(eq(resolutions.id, rid)).returning();
    await this.audit.log({ ...log(c), action: 'resolution.update', resourceType: 'meeting', resourceId: id, summary: `Résolution n° ${r.number} : pour ${r.votesFor}, contre ${r.votesAgainst}, abstentions ${r.abstentions} — ${r.result}` });
    return r;
  }

  @Access('asso', 'asso.meetings.update')
  @Delete('meetings/:id/resolutions/:rid')
  async deleteResolution(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('rid') rid: string) {
    await this.meeting(c.association.id, id, true);
    parse(zUuid, rid);
    await this.db.delete(resolutions).where(and(eq(resolutions.id, rid), eq(resolutions.meetingId, id)));
    return { ok: true };
  }

  /** Clôture : procès-verbal figé (déclencheurs PostgreSQL), plus aucune modification possible. */
  @Access('asso', 'asso.meetings.validate')
  @Post('meetings/:id/close')
  @HttpCode(200)
  async close(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const m = await this.meeting(c.association.id, id, true);
    if (m.status === 'draft') throw BadRequest('NOT_CONVENED', 'La réunion n’a pas été convoquée.');
    if (!m.minutes?.trim()) throw BadRequest('MINUTES_REQUIRED', 'Rédigez le compte rendu avant de clôturer.');
    const pending = await this.db.select({ n: sql<number>`count(*)::int` }).from(resolutions).where(and(eq(resolutions.meetingId, id), eq(resolutions.result, 'pending')));
    if (pending[0].n > 0) throw BadRequest('PENDING_RESOLUTIONS', `${pending[0].n} résolution(s) sans résultat.`);
    const list = await this.attendees(id);
    const q = this.quorum(m, list);
    await this.db.update(meetings).set({ status: 'closed', closedAt: new Date(), closedBy: c.user.id, updatedAt: new Date() }).where(eq(meetings.id, id));
    await this.audit.log({ ...log(c), action: 'meeting.close', resourceType: 'meeting', resourceId: id, summary: `Clôture de « ${m.title} » : procès-verbal figé`, data: { quorum: q } });
    return { ok: true, quorum: q };
  }

  /* ----------------------------------------------------------- PDF */

  @Access('asso', 'asso.meetings.download')
  @Get('meetings/:id/:doc.pdf')
  async pdf(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('doc') docName: string, @Res() res: Response) {
    const m = await this.meeting(c.association.id, id);
    if (!['convocation', 'emargement', 'proces-verbal'].includes(docName)) throw NotFound('Document inconnu.');
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const sig = await this.signatories(c.association.id);
    const list = await this.attendees(id);
    let pdf: Buffer;
    if (docName === 'convocation') pdf = await convocationPdf(a, m, sig);
    else if (docName === 'emargement') pdf = await attendancePdf(a, m, list);
    else {
      const res2 = await this.db.select().from(resolutions).where(eq(resolutions.meetingId, id)).orderBy(asc(resolutions.number));
      pdf = await minutesPdf(a, m, list, res2, sig);
    }
    await this.audit.log({ ...log(c), action: 'meeting.pdf', resourceType: 'meeting', resourceId: id, summary: `Téléchargement : ${docName} de « ${m.title} »` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${docName}-${m.startAt.toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  }

  /* -------------------------------------------------------- Mandats */

  @Access('asso', 'asso.mandates.read')
  @Get('mandates')
  async listMandates(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const { current } = parse(z.object({ current: z.enum(['true', 'false']).default('true') }), query);
    return this.db
      .select({ id: mandates.id, body: mandates.body, role: mandates.role, startDate: mandates.startDate, endDate: mandates.endDate, memberId: members.id, firstName: members.firstName, lastName: members.lastName, number: members.number })
      .from(mandates)
      .innerJoin(members, eq(members.id, mandates.memberId))
      .where(and(eq(mandates.associationId, c.association.id), current === 'true' ? sql`(${mandates.endDate} is null or ${mandates.endDate} >= current_date)` : undefined))
      .orderBy(asc(mandates.body), asc(mandates.role));
  }

  @Access('asso', 'asso.mandates.create')
  @Post('mandates')
  async createMandate(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ memberId: zUuid, body: z.enum(['bureau', 'ca', 'autre']), role: z.string().trim().min(2).max(80), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), meetingId: zUuid.nullable().optional() }), body);
    const [mem] = await this.db.select().from(members).where(and(eq(members.id, input.memberId), eq(members.associationId, c.association.id)));
    if (!mem) throw NotFound('Adhérent introuvable.');
    if (input.meetingId) await this.meeting(c.association.id, input.meetingId);
    if (input.endDate && input.endDate < input.startDate) throw BadRequest('INVALID_DATES', 'La fin du mandat précède son début.');
    const [r] = await this.db.insert(mandates).values({ ...input, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'mandate.create', resourceType: 'member', resourceId: mem.id, summary: `Mandat : ${mem.firstName} ${mem.lastName}, ${input.role} (${input.body})` });
    return r;
  }

  /** Fin de mandat (démission, renouvellement). */
  @Access('asso', 'asso.mandates.update')
  @Patch('mandates/:id')
  async endMandate(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const { endDate } = parse(z.object({ endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), body);
    const [r] = await this.db.update(mandates).set({ endDate }).where(and(eq(mandates.id, id), eq(mandates.associationId, c.association.id))).returning();
    if (!r) throw NotFound('Mandat introuvable.');
    if (endDate < r.startDate) throw BadRequest('INVALID_DATES', 'La fin du mandat précède son début.');
    await this.audit.log({ ...log(c), action: 'mandate.end', resourceType: 'member', resourceId: r.memberId, summary: `Fin de mandat (${r.role}) au ${endDate}` });
    return r;
  }
}

