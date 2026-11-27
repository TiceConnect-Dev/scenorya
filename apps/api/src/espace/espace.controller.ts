import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { grantsCover, isFeatureEnabled } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx, Authenticated, Ctx, Public, RequestContext } from '../common/access';
import { parse, zEmail, zOptText, zPassword, zUuid } from '../common/validation';
import { BadRequest, Conflict, Forbidden, NotFound } from '../common/errors';
import { randomToken, sha256 } from '../common/crypto';
import { DB, Db, DbOrTx } from '../db/db';
import {
  associationUsers, associations, driveAccessLog, driveFiles, driveFolders, eventParticipants, events, mandates, meetingAttendees, meetings, memberGroupLinks,
  memberGroups, memberInvitations, members, membershipDues, membershipPayments, resolutions, roleAssignments, roles, users,
} from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { SettingsService, brandingDir, emailLayout } from '../system/settings.service';
import { loadConfig } from '../config';
import { coverage, ensureCardTokens, verifyUrl } from '../asso/groups-fields-cards.controller';
import { renderCards } from '../asso/card';
import { renderReceipt } from '../asso/receipt';
import { convocationPdf, minutesPdf } from '../asso/governance-pdf';
import { signatoriesOf } from '../asso/governance.controller';
import { occurrencesOf } from '../agenda/agenda.controller';
import { blobExists, blobPath, canPreview, fileHeaders } from '../drive/storage';

type Member = typeof members.$inferSelect;
const INVITE_DAYS = 14;
const DAY = 86_400_000;
const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const inviteUrl = (token: string) => `${loadConfig().PUBLIC_URL.replace(/\/$/, '')}/invitation/${token}`;

/** Champs de sa fiche qu'un membre peut corriger lui-même. */
const zSelfUpdate = z.object({
  email: zEmail.nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  addressLine: z.string().trim().max(200).nullable().optional(),
  postalCode: z.string().trim().max(12).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  imageRights: z.boolean().optional(),
}).strip();

@ApiTags('Scenorya Espace')
@Controller()
export class EspaceController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
  ) {}

  /* ============================================================ Côté membre */

  /** Fiche d'adhérent reliée au compte connecté (ou null). */
  private async self(c: AssocCtx) {
    const [m] = await this.db.select().from(members).where(and(eq(members.associationId, c.association.id), eq(members.userId, c.user.id), ne(members.status, 'archived')));
    return m ?? null;
  }

  private async requireSelf(c: AssocCtx) {
    const m = await this.self(c);
    if (!m) throw NotFound('Votre compte n’est relié à aucune fiche d’adhérent dans cette association.');
    return m;
  }

  private usable(c: AssocCtx, module: 'asso' | 'agenda' | 'drive') {
    return !!c.modules[module]?.usable;
  }

  @Access('espace', 'espace.read')
  @Get('espace/me')
  async me(@AssocContext() c: AssocCtx) {
    const m = await this.self(c);
    const sections = { dues: false, card: false, events: false, meetings: false, documents: false, cast: false };
    if (!m) return { member: null, association: c.association.name, sections };
    const asso = this.usable(c, 'asso');
    const cov = (await coverage(this.db, [m.id])).get(m.id)!;
    const groups = asso ? await this.db.select({ name: memberGroups.name, kind: memberGroups.kind }).from(memberGroupLinks).innerJoin(memberGroups, eq(memberGroups.id, memberGroupLinks.groupId))
      .where(and(eq(memberGroupLinks.memberId, m.id), isNull(memberGroups.archivedAt))).orderBy(asc(memberGroups.name)) : [];
    const mandatesNow = asso ? await this.db.select({ role: mandates.role, body: mandates.body, startDate: mandates.startDate, endDate: mandates.endDate }).from(mandates)
      .where(and(eq(mandates.memberId, m.id), sql`${mandates.startDate} <= current_date and (${mandates.endDate} is null or ${mandates.endDate} >= current_date)`)) : [];
    const docs = this.usable(c, 'drive') ? (await this.db.select({ n: sql<number>`count(*)::int` }).from(driveFolders).where(and(eq(driveFolders.associationId, c.association.id), eq(driveFolders.espace, true), isNull(driveFolders.deletedAt))))[0].n > 0 : false;
    return {
      association: c.association.name,
      member: {
        id: m.id, number: m.number, firstName: m.firstName, lastName: m.lastName, email: m.email, phone: m.phone, birthDate: m.birthDate,
        addressLine: m.addressLine, postalCode: m.postalCode, city: m.city, category: m.category, status: m.status, joinedAt: m.joinedAt,
        isMinor: m.isMinor, guardianName: m.guardianName, imageRights: m.imageRights,
      },
      upToDate: cov.valid, validUntil: cov.until, groups, mandates: mandatesNow,
      sections: { dues: asso, card: asso && m.status !== 'archived', events: this.usable(c, 'agenda'), meetings: asso, documents: docs, cast: !!c.modules.cast?.usable && isFeatureEnabled(c.modules, 'cast.espace') },
    };
  }

  @Access('espace', 'espace.read')
  @Patch('espace/me')
  async updateMe(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const m = await this.requireSelf(c);
    const input = parse(zSelfUpdate, body);
    const changes = Object.entries(input).filter(([k, v]) => v !== undefined && (m as Record<string, unknown>)[k] !== v);
    if (!changes.length) return { ok: true, changed: [] };
    await this.db.update(members).set({ ...Object.fromEntries(changes), updatedAt: new Date() }).where(eq(members.id, m.id));
    const labels: Record<string, string> = { email: 'e-mail', phone: 'téléphone', addressLine: 'adresse', postalCode: 'code postal', city: 'ville', imageRights: 'droit à l’image' };
    await this.audit.log({
      ...log(c), action: 'member.self_update', resourceType: 'member', resourceId: m.id,
      summary: `${m.firstName} ${m.lastName} a mis à jour sa fiche depuis son espace : ${changes.map(([k]) => labels[k]).join(', ')}`,
      data: { before: Object.fromEntries(changes.map(([k]) => [k, (m as Record<string, unknown>)[k]])), after: Object.fromEntries(changes) },
    });
    return { ok: true, changed: changes.map(([k]) => k) };
  }

  @Access('espace', 'espace.read')
  @Get('espace/dues')
  async dues(@AssocContext() c: AssocCtx) {
    if (!this.usable(c, 'asso')) return [];
    const m = await this.requireSelf(c);
    const rows = await this.db.select().from(membershipDues).where(and(eq(membershipDues.memberId, m.id), ne(membershipDues.status, 'cancelled'))).orderBy(desc(membershipDues.periodStart));
    const paid = rows.length ? await this.db.select({ dueId: membershipPayments.dueId, n: sql<number>`coalesce(sum(${membershipPayments.amountCents}), 0)::int` }).from(membershipPayments)
      .where(and(inArray(membershipPayments.dueId, rows.map((r) => r.id)), isNull(membershipPayments.cancelledAt))).groupBy(membershipPayments.dueId) : [];
    const p = new Map(paid.map((r) => [r.dueId, r.n]));
    return rows.map((d) => ({
      id: d.id, label: d.label, amountCents: d.amountCents, paidCents: p.get(d.id) ?? 0, status: d.status, periodStart: d.periodStart, periodEnd: d.periodEnd,
      receipt: d.status === 'paid' && !!d.receiptNumber && !d.receiptCancelledAt ? d.receiptNumber : null,
    }));
  }

  @Access('espace', 'espace.read')
  @Get('espace/dues/:id/receipt.pdf')
  async receipt(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    parse(zUuid, id);
    if (!this.usable(c, 'asso')) throw NotFound();
    const m = await this.requireSelf(c);
    const [due] = await this.db.select().from(membershipDues).where(and(eq(membershipDues.id, id), eq(membershipDues.memberId, m.id)));
    if (!due) throw NotFound('Cotisation introuvable.');
    if (due.status !== 'paid' || !due.receiptNumber || due.receiptCancelledAt) throw Conflict('NO_RECEIPT', 'Le reçu n’est disponible que pour une cotisation intégralement réglée.');
    const [assoc] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const payments = await this.db.select().from(membershipPayments).where(and(eq(membershipPayments.dueId, id), isNull(membershipPayments.cancelledAt))).orderBy(asc(membershipPayments.paidAt));
    const pdf = await renderReceipt({
      association: assoc, member: m, payments,
      due: { label: due.label, amountCents: due.amountCents, periodStart: due.periodStart, periodEnd: due.periodEnd, receiptNumber: due.receiptNumber, receiptIssuedAt: due.receiptIssuedAt ?? new Date() },
    });
    await this.audit.log({ ...log(c), action: 'espace.receipt', resourceType: 'member', resourceId: m.id, summary: `Téléchargement de son reçu n° ${due.receiptNumber} depuis l’Espace` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="recu-cotisation-${due.receiptNumber}.pdf"`);
    res.send(pdf);
  }

  @Access('espace', 'espace.read')
  @Get('espace/card.pdf')
  async card(@AssocContext() c: AssocCtx, @Res() res: Response) {
    if (!this.usable(c, 'asso')) throw NotFound();
    const self = await this.requireSelf(c);
    const [m] = await ensureCardTokens(this.db, c.association.id, [self.id]);
    const [assoc] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const cov = (await coverage(this.db, [m.id])).get(m.id)!;
    const pdf = await renderCards([{ association: assoc, member: m, validUntil: cov.until, verifyUrl: verifyUrl(m.cardToken!) }], 'single');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="carte-${m.number}.pdf"`);
    res.send(pdf);
  }

  @Access('espace', 'espace.read')
  @Get('espace/events')
  async events(@AssocContext() c: AssocCtx) {
    if (!this.usable(c, 'agenda')) return [];
    const m = await this.requireSelf(c);
    const from = new Date(Date.now() - DAY);
    const to = new Date(Date.now() + 180 * DAY);
    const rows = await this.db.select({ e: events, p: eventParticipants }).from(eventParticipants).innerJoin(events, eq(events.id, eventParticipants.eventId))
      .where(and(eq(eventParticipants.memberId, m.id), eq(events.associationId, c.association.id), isNull(events.cancelledAt)));
    return rows.flatMap(({ e, p }) => occurrencesOf(e, from, to).slice(0, 30).map((o) => ({
      id: e.id, occurrence: o.key, title: e.title, category: e.category, location: e.location, allDay: e.allDay, start: o.start, end: o.end,
      description: e.description, status: p.status, comment: p.comment, recurring: !!e.rule,
    }))).sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, 100);
  }

  @Access('espace', 'espace.read')
  @Post('espace/events/:id/response')
  @HttpCode(200)
  async respond(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    if (!this.usable(c, 'agenda')) throw NotFound();
    const m = await this.requireSelf(c);
    const input = parse(z.object({ status: z.enum(['yes', 'no', 'maybe']), comment: zOptText(300) }), body);
    const [e] = await this.db.select().from(events).where(and(eq(events.id, id), eq(events.associationId, c.association.id), isNull(events.cancelledAt)));
    if (!e) throw NotFound('Événement introuvable.');
    const [p] = await this.db.update(eventParticipants).set({ status: input.status, comment: input.comment ?? null, respondedAt: new Date() })
      .where(and(eq(eventParticipants.eventId, id), eq(eventParticipants.memberId, m.id))).returning();
    if (!p) throw NotFound('Vous n’êtes pas invité(e) à cet événement.');
    const label = { yes: 'présent(e)', no: 'absent(e)', maybe: 'incertain(e)' }[input.status];
    await this.audit.log({ ...log(c), action: 'espace.event.respond', resourceType: 'member', resourceId: m.id, summary: `${m.firstName} ${m.lastName} répond « ${label} » à « ${e.title} »` });
    return { status: p.status };
  }

  @Access('espace', 'espace.read')
  @Get('espace/meetings')
  async meetings(@AssocContext() c: AssocCtx) {
    if (!this.usable(c, 'asso')) return [];
    const m = await this.requireSelf(c);
    const rows = await this.db.select({ mt: meetings, a: meetingAttendees }).from(meetingAttendees).innerJoin(meetings, eq(meetings.id, meetingAttendees.meetingId))
      .where(and(eq(meetingAttendees.memberId, m.id), eq(meetings.associationId, c.association.id), ne(meetings.status, 'draft'))).orderBy(desc(meetings.startAt)).limit(50);
    return rows.map(({ mt, a }) => ({
      id: mt.id, title: mt.title, type: mt.type, startAt: mt.startAt, location: mt.location, status: mt.status, attendance: a.status,
      agenda: mt.agendaItems.map((i) => i.title), convocation: !!mt.convenedAt, minutes: !!mt.closedAt,
    }));
  }

  @Access('espace', 'espace.read')
  @Get('espace/meetings/:id/:doc.pdf')
  async meetingPdf(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('doc') doc: string, @Res() res: Response) {
    parse(zUuid, id);
    if (!this.usable(c, 'asso')) throw NotFound();
    const m = await this.requireSelf(c);
    const [row] = await this.db.select({ mt: meetings }).from(meetingAttendees).innerJoin(meetings, eq(meetings.id, meetingAttendees.meetingId))
      .where(and(eq(meetingAttendees.memberId, m.id), eq(meetings.id, id), eq(meetings.associationId, c.association.id), ne(meetings.status, 'draft')));
    if (!row) throw NotFound('Réunion introuvable.');
    const mt = row.mt;
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const sig = await signatoriesOf(this.db, c.association.id);
    let pdf: Buffer;
    if (doc === 'convocation' && mt.convenedAt) pdf = await convocationPdf(a, mt, sig);
    else if (doc === 'proces-verbal' && mt.closedAt) {
      // Le procès-verbal n'est communiqué qu'une fois figé (réunion clôturée).
      const list = await this.db.select({ memberId: members.id, number: members.number, firstName: members.firstName, lastName: members.lastName, email: members.email, status: meetingAttendees.status, proxyMemberId: meetingAttendees.proxyMemberId, proxyName: sql<string | null>`(select p.first_name || ' ' || p.last_name from members p where p.id = ${meetingAttendees.proxyMemberId})`, emailStatus: meetingAttendees.emailStatus })
        .from(meetingAttendees).innerJoin(members, eq(members.id, meetingAttendees.memberId)).where(eq(meetingAttendees.meetingId, id)).orderBy(asc(members.lastName), asc(members.firstName));
      const res2 = await this.db.select().from(resolutions).where(eq(resolutions.meetingId, id)).orderBy(asc(resolutions.number));
      pdf = await minutesPdf(a, mt, list, res2, sig);
    } else throw NotFound('Document indisponible.');
    await this.audit.log({ ...log(c), action: 'espace.meeting.pdf', resourceType: 'meeting', resourceId: id, summary: `Téléchargement depuis l’Espace : ${doc} de « ${mt.title} »` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc}-${mt.startAt.toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  }

  /** Dossiers Drive publiés dans l'Espace (et leurs sous-dossiers). */
  private async espaceFolders(associationId: string) {
    const all = await this.db.select().from(driveFolders).where(and(eq(driveFolders.associationId, associationId), isNull(driveFolders.deletedAt)));
    const byId = new Map(all.map((f) => [f.id, f]));
    const root = (id: string) => {
      let cur = byId.get(id);
      for (let i = 0; cur && i < 200; i++) {
        if (cur.espace) return cur;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return null;
    };
    const visible = new Map<string, { id: string; name: string; path: string }>();
    for (const f of all) {
      const r = root(f.id);
      if (!r) continue;
      const parts: string[] = [];
      let cur: typeof f | undefined = f;
      for (let i = 0; cur && i < 200; i++) {
        parts.unshift(cur.name);
        if (cur.id === r.id) break;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      visible.set(f.id, { id: f.id, name: f.name, path: parts.join(' / ') });
    }
    return visible;
  }

  @Access('espace', 'espace.read')
  @Get('espace/documents')
  async documents(@AssocContext() c: AssocCtx) {
    if (!this.usable(c, 'drive')) return [];
    await this.requireSelf(c);
    const folders = await this.espaceFolders(c.association.id);
    if (!folders.size) return [];
    const files = await this.db.select().from(driveFiles).where(and(eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt), inArray(driveFiles.folderId, [...folders.keys()])))
      .orderBy(sql`lower(${driveFiles.name})`);
    return files.map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, updatedAt: f.updatedAt, description: f.description, folder: folders.get(f.folderId!)!.path, preview: canPreview(f.mime) }));
  }

  @Access('espace', 'espace.read')
  @Get('espace/documents/:id')
  async document(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    parse(zUuid, id);
    if (!this.usable(c, 'drive')) throw NotFound();
    await this.requireSelf(c);
    const folders = await this.espaceFolders(c.association.id);
    const [f] = await this.db.select().from(driveFiles).where(and(eq(driveFiles.id, id), eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt)));
    if (!f || !f.folderId || !folders.has(f.folderId)) throw NotFound('Document introuvable.');
    if (!(await blobExists(f.sha256))) throw NotFound('Le contenu de ce document est indisponible.');
    await this.db.insert(driveAccessLog).values({ associationId: c.association.id, fileId: f.id, fileName: f.name, userId: c.user.id, action: 'download', version: f.version, ip: c.ip });
    res.set(fileHeaders(f.name, f.mime, f.size, false));
    createReadStream(blobPath(f.sha256)).on('error', () => res.destroy()).pipe(res);
  }

  /* ============================================================ Gestion des accès (Asso) */

  @Access('asso', 'asso.members.read')
  @Get('asso/members/:id/espace')
  async access(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const m = await this.member(c, id);
    const [u] = m.userId ? await this.db.select({ id: users.id, email: users.email, displayName: users.displayName, lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.id, m.userId)) : [];
    const [inv] = await this.db.select().from(memberInvitations)
      .where(and(eq(memberInvitations.memberId, m.id), isNull(memberInvitations.acceptedAt), isNull(memberInvitations.revokedAt), gt(memberInvitations.expiresAt, new Date())))
      .orderBy(desc(memberInvitations.createdAt)).limit(1);
    return {
      account: u ?? null,
      invitation: inv ? { id: inv.id, email: inv.email, createdAt: inv.createdAt, expiresAt: inv.expiresAt, emailStatus: inv.emailStatus } : null,
      espaceActive: !!c.modules.espace?.usable,
    };
  }

  private async member(c: AssocCtx, id: string) {
    parse(zUuid, id);
    const [m] = await this.db.select().from(members).where(and(eq(members.id, id), eq(members.associationId, c.association.id)));
    if (!m) throw NotFound('Adhérent introuvable.');
    return m;
  }

  @Access('asso', 'asso.members.update')
  @Post('asso/members/:id/espace/invite')
  async invite(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const m = await this.member(c, id);
    if (m.status === 'archived') throw Conflict('MEMBER_ARCHIVED', 'Adhérent archivé.');
    if (m.userId) throw Conflict('ALREADY_LINKED', 'Cet adhérent est déjà relié à un compte.');
    const input = parse(z.object({ email: zEmail.optional(), send: z.boolean().default(true) }), body ?? {});
    const email = input.email ?? m.email?.toLowerCase() ?? (m.isMinor ? m.guardianEmail?.toLowerCase() : undefined);
    if (!email) throw BadRequest('EMAIL_REQUIRED', 'Indiquez une adresse e-mail : la fiche n’en comporte pas.');
    const token = randomToken(24);
    const now = new Date();
    const [inv] = await this.db.transaction(async (tx) => {
      await tx.update(memberInvitations).set({ revokedAt: now }).where(and(eq(memberInvitations.memberId, m.id), isNull(memberInvitations.acceptedAt), isNull(memberInvitations.revokedAt)));
      return tx.insert(memberInvitations).values({
        associationId: c.association.id, memberId: m.id, email, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY), emailStatus: 'not_sent', createdBy: c.user.id,
      }).returning();
    });
    let emailStatus = 'not_sent';
    if (input.send) {
      try {
        const { transporter, from } = await this.settings.transport();
        const url = inviteUrl(token);
        const logo = join(brandingDir(), 'derived', 'logos', 'scenorya-horizontal-small.png');
        await transporter.sendMail({
          from, to: email, subject: `${c.association.name} — Votre espace personnel`,
          text: `Bonjour ${m.firstName},\n\n${c.association.name} vous invite à accéder à votre espace personnel : fiche, cotisations et reçus, carte d’adhérent, agenda, convocations et documents.\n\nCréez votre accès (lien valable ${INVITE_DAYS} jours) :\n${url}\n\nSi vous n’attendiez pas ce message, ignorez-le.`,
          html: emailLayout('Votre espace personnel', `<p>Bonjour ${esc(m.firstName)},</p><p>${esc(c.association.name)} vous invite à accéder à votre espace personnel : fiche, cotisations et reçus, carte d’adhérent, agenda, convocations et documents.</p><p><a href="${url}">Créer mon accès</a> (lien valable ${INVITE_DAYS} jours)</p><p>Si vous n’attendiez pas ce message, ignorez-le.</p>`),
          attachments: existsSync(logo) ? [{ filename: 'scenorya.png', path: logo, cid: 'scenorya-logo' }] : [],
        });
        emailStatus = 'sent';
      } catch (e) {
        emailStatus = `failed: ${(e as Error).message.slice(0, 120)}`;
      }
      await this.db.update(memberInvitations).set({ emailStatus }).where(eq(memberInvitations.id, inv.id));
    }
    await this.audit.log({ ...log(c), action: 'espace.invite', resourceType: 'member', resourceId: m.id, summary: `Invitation à l’Espace pour ${m.firstName} ${m.lastName} (${email})${emailStatus === 'sent' ? ', envoyée par e-mail' : emailStatus === 'not_sent' ? ', lien à transmettre' : ', échec de l’envoi'}` });
    return { url: inviteUrl(token), expiresAt: inv.expiresAt, emailStatus };
  }

  @Access('asso', 'asso.members.update')
  @Post('asso/members/:id/espace/link')
  async link(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const m = await this.member(c, id);
    const { userId } = parse(z.object({ userId: zUuid }), body);
    const [au] = await this.db.select({ u: users }).from(associationUsers).innerJoin(users, eq(users.id, associationUsers.userId))
      .where(and(eq(associationUsers.associationId, c.association.id), eq(associationUsers.userId, userId)));
    if (!au) throw NotFound('Utilisateur introuvable dans cette association.');
    await this.db.transaction(async (tx) => {
      await this.attach(tx, c.association.id, m, userId);
      await this.audit.log({ ...log(c), action: 'espace.link', resourceType: 'member', resourceId: m.id, summary: `Fiche de ${m.firstName} ${m.lastName} reliée au compte ${au.u.displayName} (${au.u.email})` }, tx);
    });
    return { ok: true };
  }

  @Access('asso', 'asso.members.update')
  @Delete('asso/members/:id/espace')
  async unlink(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const m = await this.member(c, id);
    await this.db.transaction(async (tx) => {
      await tx.update(members).set({ userId: null, updatedAt: new Date() }).where(eq(members.id, m.id));
      await tx.update(memberInvitations).set({ revokedAt: new Date() }).where(and(eq(memberInvitations.memberId, m.id), isNull(memberInvitations.acceptedAt), isNull(memberInvitations.revokedAt)));
      await this.audit.log({ ...log(c), action: 'espace.unlink', resourceType: 'member', resourceId: m.id, summary: `Accès à l’Espace retiré pour ${m.firstName} ${m.lastName} (fiche détachée du compte, invitations révoquées)` }, tx);
    });
    return { ok: true };
  }

  /** Relie la fiche au compte et garantit l'accès à l'association avec le rôle « Adhérent » si nécessaire. */
  private async attach(tx: DbOrTx, associationId: string, m: Member, userId: string) {
    const [taken] = await tx.select({ id: members.id }).from(members).where(and(eq(members.associationId, associationId), eq(members.userId, userId), ne(members.id, m.id)));
    if (taken) throw Conflict('ACCOUNT_ALREADY_LINKED', 'Ce compte est déjà relié à une autre fiche d’adhérent de l’association.');
    let [au] = await tx.select().from(associationUsers).where(and(eq(associationUsers.associationId, associationId), eq(associationUsers.userId, userId)));
    if (!au) [au] = await tx.insert(associationUsers).values({ associationId, userId }).returning();
    const grants = (await tx.select({ p: roles.permissions }).from(roleAssignments).innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(and(eq(roleAssignments.associationUserId, au.id), isNull(roleAssignments.scopeType)))).flatMap((r) => r.p);
    if (!grantsCover(grants, 'espace.read')) {
      const [role] = await tx.select().from(roles).where(and(eq(roles.associationId, associationId), eq(roles.key, 'adherent')));
      if (!role) throw Conflict('ROLE_MISSING', 'Le rôle « Adhérent » n’existe plus dans cette association : recréez-le (Admin → Rôles) avec la permission espace.read.');
      await tx.insert(roleAssignments).values({ associationUserId: au.id, roleId: role.id }).onConflictDoNothing();
    }
    await tx.update(members).set({ userId, updatedAt: new Date() }).where(eq(members.id, m.id));
  }

  /* ============================================================ Invitation (publique) */

  private async invitation(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw NotFound('Invitation invalide ou expirée.');
    const [row] = await this.db.select({ inv: memberInvitations, m: members, a: associations }).from(memberInvitations)
      .innerJoin(members, eq(members.id, memberInvitations.memberId)).innerJoin(associations, eq(associations.id, memberInvitations.associationId))
      .where(eq(memberInvitations.tokenHash, sha256(token)));
    if (!row || row.inv.acceptedAt || row.inv.revokedAt || row.inv.expiresAt <= new Date() || row.m.status === 'archived' || row.a.status !== 'active') {
      throw NotFound('Invitation invalide ou expirée. Demandez une nouvelle invitation à votre association.');
    }
    return row;
  }

  @Public()
  @Get('public/invitations/:token')
  async invitationInfo(@Param('token') token: string) {
    const { inv, m, a } = await this.invitation(token);
    const [u] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${inv.email.toLowerCase()}`);
    return { association: a.name, firstName: m.firstName, lastName: m.lastName, email: inv.email, accountExists: !!u, expiresAt: inv.expiresAt };
  }

  /** Création du compte à partir de l'invitation (adresse sans compte existant). */
  @Public()
  @Post('public/invitations/:token/accept')
  async accept(@Param('token') token: string, @Body() body: unknown) {
    const input = parse(z.object({ password: zPassword, displayName: z.string().trim().min(2).max(120).optional() }), body);
    const { inv, m, a } = await this.invitation(token);
    const hash = await this.sessions.hashPassword(input.password);
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(memberInvitations).where(eq(memberInvitations.id, inv.id)).for('update');
      if (locked.acceptedAt || locked.revokedAt) throw NotFound('Invitation déjà utilisée.');
      const [exists] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${inv.email.toLowerCase()}`);
      if (exists) throw Conflict('ACCOUNT_EXISTS', 'Un compte existe déjà pour cette adresse : connectez-vous pour accepter l’invitation.');
      const [u] = await tx.insert(users).values({ email: inv.email, displayName: input.displayName ?? `${m.firstName} ${m.lastName}`, passwordHash: hash, mustChangePassword: false }).returning();
      const [fresh] = await tx.select().from(members).where(eq(members.id, m.id)).for('update');
      if (fresh.userId) throw Conflict('ALREADY_LINKED', 'Cette fiche est déjà reliée à un compte.');
      await this.attach(tx, a.id, fresh, u.id);
      await tx.update(memberInvitations).set({ acceptedAt: new Date() }).where(eq(memberInvitations.id, inv.id));
      await this.audit.log({ associationId: a.id, actorId: u.id, actorLabel: u.displayName, action: 'espace.accept', resourceType: 'member', resourceId: m.id, summary: `${m.firstName} ${m.lastName} a créé son compte et accède à son espace (${inv.email})` }, tx);
    });
    return { ok: true, email: inv.email };
  }

  /** Acceptation par un compte existant, connecté avec la même adresse e-mail. */
  @Authenticated()
  @Post('espace/invitations/:token/claim')
  @HttpCode(200)
  async claim(@Param('token') token: string, @Ctx() ctx: RequestContext) {
    const { inv, m, a } = await this.invitation(token);
    const user = ctx.user!;
    if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
      throw Forbidden('INVITATION_EMAIL_MISMATCH', `Cette invitation est destinée à ${inv.email}. Connectez-vous avec ce compte.`);
    }
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(memberInvitations).where(eq(memberInvitations.id, inv.id)).for('update');
      if (locked.acceptedAt || locked.revokedAt) throw NotFound('Invitation déjà utilisée.');
      const [fresh] = await tx.select().from(members).where(eq(members.id, m.id)).for('update');
      if (fresh.userId && fresh.userId !== user.id) throw Conflict('ALREADY_LINKED', 'Cette fiche est déjà reliée à un autre compte.');
      await this.attach(tx, a.id, fresh, user.id);
      await tx.update(memberInvitations).set({ acceptedAt: new Date() }).where(eq(memberInvitations.id, inv.id));
      await this.audit.log({ associationId: a.id, actorId: user.id, actorLabel: user.displayName, action: 'espace.accept', resourceType: 'member', resourceId: m.id, summary: `${m.firstName} ${m.lastName} a relié son compte existant et accède à son espace` }, tx);
    });
    return { ok: true, associationId: a.id };
  }
}
