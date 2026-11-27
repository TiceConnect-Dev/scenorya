import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { grantsCover } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, NotFound } from '../common/errors';
import { DB, Db, DbOrTx } from '../db/db';
import { auditLogs, counters, mandates, meetingAttendees, meetings, memberFieldDefs, memberGroupLinks, members, membershipDues, membershipPayments } from '../db/schema';
import { allowPurge, requireConfirmation } from '../common/purge';
import { FieldDef, validateCustom, visibleCustom } from './custom-fields';
import { AuditService } from '../audit/audit.service';
import { ModulesService } from '../modules/modules.service';
import { parseCsv, toCsv } from '../common/csv';

export const MEMBER_CATEGORIES = ['actif', 'benevole', 'responsable', 'bienfaiteur', 'honneur', 'ancien'] as const;
export const MEMBER_STATUSES = ['pending', 'active', 'expired', 'archived'] as const;
/** Champs considérés comme sensibles : visibles uniquement avec asso.members.sensitive. */
const SENSITIVE_FIELDS = ['birthDate', 'addressLine', 'postalCode', 'city', 'guardianName', 'guardianPhone', 'guardianEmail', 'notes'] as const;

const zDate = z.preprocess(
  (v) => (v === '' ? null : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date au format AAAA-MM-JJ').nullable().optional(),
).transform((v) => v ?? null);

const zMember = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide').max(254).optional().nullable().or(z.literal('')).transform((v) => v || null),
  phone: zOptText(40),
  birthDate: zDate,
  addressLine: zOptText(255),
  postalCode: zOptText(20),
  city: zOptText(120),
  category: z.enum(MEMBER_CATEGORIES).default('actif'),
  status: z.enum(['pending', 'active', 'expired']).default('active'),
  joinedAt: zDate,
  isMinor: z.boolean().default(false),
  guardianName: zOptText(200),
  guardianPhone: zOptText(40),
  guardianEmail: zOptText(254),
  imageRights: z.boolean().default(false),
  skills: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  custom: z.record(z.string(), z.unknown()).optional(),
  notes: zOptText(4000),
});

const zList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
  status: z.enum([...MEMBER_STATUSES, 'all']).default('all'),
  category: z.enum(MEMBER_CATEGORIES).optional(),
  groupId: zUuid.optional(),
  sort: z.enum(['number', 'lastName', 'joinedAt', 'createdAt']).default('lastName'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

type MemberRow = typeof members.$inferSelect;

function present(row: MemberRow, sensitive: boolean, defs: FieldDef[]) {
  // Le jeton de carte n'est communiqué que par les routes de carte.
  const { cardToken: _token, ...m } = row;
  const custom = visibleCustom(defs, (m.custom ?? {}) as Record<string, unknown>, sensitive);
  if (sensitive) return { ...m, custom, sensitiveHidden: false };
  const copy: Record<string, unknown> = { ...m, custom, sensitiveHidden: true };
  for (const f of SENSITIVE_FIELDS) copy[f] = null;
  return copy;
}

@ApiTags('Scenorya Asso — Adhérents')
@Controller('asso/members')
export class MembersController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    // Conséquences d'une désactivation d'Asso présentées à l'administrateur.
    this.modules.registerImpactProvider({
      module: 'asso',
      check: async (db, associationId) => {
        const [r] = await db
          .select({ n: sql<number>`count(*)::int`, minors: sql<number>`count(*) filter (where ${members.isMinor})::int` })
          .from(members)
          .where(and(eq(members.associationId, associationId), sql`${members.status} <> 'archived'`));
        if (r.n === 0) return [];
        return [
          { module: 'asso', level: 'warning', message: `${r.n} fiche(s) d'adhérent seront conservées mais inaccessibles jusqu'à la réactivation du module.` },
          ...(r.minors > 0 ? [{ module: 'asso' as const, level: 'info' as const, message: `${r.minors} fiche(s) concernent des mineurs : vérifiez vos obligations de conservation.` }] : []),
        ];
      },
    });
  }

  private async nextNumber(tx: DbOrTx, associationId: string) {
    const [row] = await tx
      .insert(counters)
      .values({ associationId, key: 'member', value: 1 })
      .onConflictDoUpdate({ target: [counters.associationId, counters.key], set: { value: sql`${counters.value} + 1` } })
      .returning({ value: counters.value });
    // Si des fiches ont été importées avec un numéro supérieur, on se cale dessus.
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${members.number}), 0)::int` }).from(members).where(eq(members.associationId, associationId));
    if (row.value <= max) {
      await tx.update(counters).set({ value: max + 1 }).where(and(eq(counters.associationId, associationId), eq(counters.key, 'member')));
      return max + 1;
    }
    return row.value;
  }

  fieldDefs(associationId: string): Promise<FieldDef[]> {
    return this.db.select().from(memberFieldDefs).where(eq(memberFieldDefs.associationId, associationId));
  }

  private async find(associationId: string, id: string) {
    parse(zUuid, id);
    const [m] = await this.db.select().from(members).where(and(eq(members.id, id), eq(members.associationId, associationId)));
    if (!m) throw NotFound('Adhérent introuvable.');
    return m;
  }

  private where(associationId: string, q: z.infer<typeof zList>) {
    const conds: SQL[] = [eq(members.associationId, associationId)];
    if (q.status !== 'all') conds.push(eq(members.status, q.status));
    if (q.category) conds.push(eq(members.category, q.category));
    if (q.groupId) conds.push(sql`exists (select 1 from ${memberGroupLinks} gl where gl.member_id = ${members.id} and gl.group_id = ${q.groupId})`);
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      const numeric = /^\d+$/.test(q.q) ? eq(members.number, Number(q.q)) : undefined;
      conds.push(or(ilike(members.lastName, like), ilike(members.firstName, like), ilike(members.email, like), numeric)!);
    }
    return and(...conds);
  }

  @Access('asso', 'asso.members.read')
  @Get()
  async list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(zList, query);
    const where = this.where(c.association.id, q);
    const col = { number: members.number, lastName: members.lastName, joinedAt: members.joinedAt, createdAt: members.createdAt }[q.sort];
    const order = q.dir === 'asc' ? asc(col) : desc(col);
    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` }).from(members).where(where);
    const rows = await this.db.select().from(members).where(where).orderBy(order, asc(members.firstName)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const sensitive = grantsCover(c.grants, 'asso.members.sensitive');
    const defs = await this.fieldDefs(c.association.id);
    return { items: rows.map((r) => present(r, sensitive, defs)), total, page: q.page, pageSize: q.pageSize };
  }

  @Access('asso', 'asso.members.read')
  @Get('stats')
  async stats(@AssocContext() c: AssocCtx) {
    const rows = await this.db
      .select({ status: members.status, category: members.category, n: sql<number>`count(*)::int` })
      .from(members)
      .where(eq(members.associationId, c.association.id))
      .groupBy(members.status, members.category);
    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
      if (r.status !== 'archived') byCategory[r.category] = (byCategory[r.category] ?? 0) + r.n;
    }
    return { byStatus, byCategory, active: byStatus.active ?? 0 };
  }

  @Access('asso', 'asso.members.export')
  @Get('export.csv')
  async export(@AssocContext() c: AssocCtx, @Query() query: unknown, @Res() res: Response) {
    const q = parse(zList, query);
    const rows = await this.db.select().from(members).where(this.where(c.association.id, q)).orderBy(asc(members.number));
    const sensitive = grantsCover(c.grants, 'asso.members.sensitive');
    const headers = ['Numéro', 'Nom', 'Prénom', 'E-mail', 'Téléphone', 'Catégorie', 'Statut', 'Date d’adhésion', 'Droit à l’image', 'Mineur'];
    if (sensitive) headers.push('Date de naissance', 'Adresse', 'Code postal', 'Ville', 'Représentant légal', 'Téléphone représentant', 'E-mail représentant');
    const defs = (await this.fieldDefs(c.association.id)).filter((d) => !d.archivedAt && (sensitive || !d.sensitive));
    headers.push(...defs.map((d) => d.label));
    const data = rows.map((m) => {
      const base: unknown[] = [m.number, m.lastName, m.firstName, m.email, m.phone, m.category, m.status, m.joinedAt, m.imageRights ? 'oui' : 'non', m.isMinor ? 'oui' : 'non'];
      if (sensitive) base.push(m.birthDate, m.addressLine, m.postalCode, m.city, m.guardianName, m.guardianPhone, m.guardianEmail);
      const custom = (m.custom ?? {}) as Record<string, unknown>;
      base.push(...defs.map((d) => (typeof custom[d.key] === 'boolean' ? (custom[d.key] ? 'oui' : 'non') : custom[d.key] ?? '')));
      return base;
    });
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'member.export', resourceType: 'member', summary: `Export CSV de ${rows.length} adhérent(s)`, data: { sensitive }, ip: c.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="adherents.csv"');
    res.send(toCsv(headers, data));
  }

  @Access('asso', 'asso.members.import')
  @Post('import')
  @HttpCode(200)
  async import(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(true) }), body);
    const rows = parseCsv(input.csv);
    if (rows.length < 2) throw BadRequest('EMPTY_CSV', 'Le fichier ne contient aucune ligne de données.');
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
    const aliases: Record<string, keyof z.input<typeof zMember>> = {
      nom: 'lastName', lastname: 'lastName', prenom: 'firstName', firstname: 'firstName', email: 'email', mail: 'email', courriel: 'email',
      telephone: 'phone', tel: 'phone', phone: 'phone', datedenaissance: 'birthDate', naissance: 'birthDate', adresse: 'addressLine',
      codepostal: 'postalCode', cp: 'postalCode', ville: 'city', categorie: 'category', datedadhesion: 'joinedAt', adhesion: 'joinedAt',
    };
    const header = rows[0].map((h) => aliases[norm(h)] ?? null);
    if (!header.includes('lastName') || !header.includes('firstName')) {
      throw BadRequest('CSV_HEADER', 'Les colonnes « Nom » et « Prénom » sont obligatoires.', { recognized: header });
    }
    const frDate = (v: string) => (/^\d{2}\/\d{2}\/\d{4}$/.test(v) ? v.split('/').reverse().join('-') : v);
    const valid: z.infer<typeof zMember>[] = [];
    const errors: { line: number; errors: string[] }[] = [];
    rows.slice(1).forEach((r, idx) => {
      const obj: Record<string, unknown> = {};
      header.forEach((key, i) => {
        if (!key) return;
        const v = (r[i] ?? '').trim();
        obj[key] = key === 'birthDate' || key === 'joinedAt' ? frDate(v) : key === 'category' ? norm(v) || undefined : v;
      });
      const parsed = zMember.safeParse(obj);
      if (parsed.success) valid.push(parsed.data);
      else errors.push({ line: idx + 2, errors: parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`) });
    });
    if (input.dryRun || valid.length === 0) return { dryRun: true, valid: valid.length, errors, recognizedColumns: header.filter(Boolean) };
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'members:' + c.association.id}))`);
      for (const m of valid) {
        await tx.insert(members).values({ ...m, joinedAt: m.joinedAt ?? undefined, associationId: c.association.id, number: await this.nextNumber(tx, c.association.id), createdBy: c.user.id });
      }
      await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'member.import', resourceType: 'member', summary: `Import CSV de ${valid.length} adhérent(s) (${errors.length} ligne(s) rejetée(s))`, ip: c.ip }, tx);
    });
    return { dryRun: false, imported: valid.length, errors };
  }

  @Access('asso', 'asso.members.read')
  @Get(':id')
  async get(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    return present(await this.find(c.association.id, id), grantsCover(c.grants, 'asso.members.sensitive'), await this.fieldDefs(c.association.id));
  }

  @Access('asso', 'asso.members.history')
  @Get(':id/history')
  async history(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const m = await this.find(c.association.id, id);
    return this.db
      .select({ id: auditLogs.id, action: auditLogs.action, summary: auditLogs.summary, actorLabel: auditLogs.actorLabel, createdAt: auditLogs.createdAt, data: auditLogs.data })
      .from(auditLogs)
      .where(and(eq(auditLogs.associationId, c.association.id), eq(auditLogs.resourceType, 'member'), eq(auditLogs.resourceId, m.id)))
      .orderBy(desc(auditLogs.id))
      .limit(200);
  }

  @Access('asso', 'asso.members.create')
  @Post()
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zMember, body);
    const sensitive = grantsCover(c.grants, 'asso.members.sensitive');
    if (!sensitive) for (const f of SENSITIVE_FIELDS) (input as Record<string, unknown>)[f] = null;
    const defs = await this.fieldDefs(c.association.id);
    const custom = validateCustom(defs, input.custom, { sensitive, partial: false });
    const created = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'members:' + c.association.id}))`);
      const number = await this.nextNumber(tx, c.association.id);
      const [m] = await tx
        .insert(members)
        .values({ ...input, custom, joinedAt: input.joinedAt ?? undefined, associationId: c.association.id, number, createdBy: c.user.id })
        .returning();
      await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'member.create', resourceType: 'member', resourceId: m.id, summary: `Création de la fiche n° ${m.number} — ${m.firstName} ${m.lastName}`, ip: c.ip }, tx);
      return m;
    });
    return present(created, sensitive, defs);
  }

  @Access('asso', 'asso.members.update')
  @Patch(':id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.find(c.association.id, id);
    if (before.status === 'archived') throw BadRequest('ARCHIVED', 'Restaurez la fiche avant de la modifier.');
    const input = parse(patchOf(zMember), body);
    const sensitive = grantsCover(c.grants, 'asso.members.sensitive');
    if (!sensitive) for (const f of SENSITIVE_FIELDS) delete (input as Record<string, unknown>)[f];
    const defs = await this.fieldDefs(c.association.id);
    const { custom: customInput, ...rest } = input;
    const patch: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (customInput) patch.custom = validateCustom(defs, customInput, { sensitive, partial: true, previous: before.custom as Record<string, unknown> });
    const [m] = await this.db.update(members).set({ ...patch, updatedAt: new Date() }).where(eq(members.id, id)).returning();
    const changed = Object.keys(patch).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((m as Record<string, unknown>)[k]));
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'member.update', resourceType: 'member', resourceId: id, summary: `Modification de la fiche n° ${m.number} — ${m.firstName} ${m.lastName}`, data: { fields: changed }, ip: c.ip });
    return present(m, sensitive, defs);
  }

  @Access('asso', 'asso.members.archive')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const m = await this.find(c.association.id, id);
    await this.db.update(members).set({ status: 'archived', archivedAt: new Date(), updatedAt: new Date() }).where(eq(members.id, id));
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'member.archive', resourceType: 'member', resourceId: id, summary: `Archivage de la fiche n° ${m.number} — ${m.firstName} ${m.lastName}`, ip: c.ip });
    return { ok: true };
  }

  @Access('asso', 'asso.members.restore')
  @Post(':id/restore')
  @HttpCode(200)
  async restore(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const m = await this.find(c.association.id, id);
    await this.db.update(members).set({ status: 'active', archivedAt: null, updatedAt: new Date() }).where(eq(members.id, id));
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'member.restore', resourceType: 'member', resourceId: id, summary: `Restauration de la fiche n° ${m.number} — ${m.firstName} ${m.lastName}`, ip: c.ip });
    return { ok: true };
  }

  /**
   * Suppression définitive. Si l'adhérent figure dans un procès-verbal figé (réunion clôturée),
   * la fiche ne peut pas disparaître du document : elle est alors anonymisée (RGPD) et tout le reste supprimé.
   */
  @Access('asso', 'asso.members.delete')
  @Delete(':id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query('force') force?: string) {
    const m = await this.find(c.association.id, id);
    const dues = await this.db.select({ id: membershipDues.id, receipt: membershipDues.receiptNumber }).from(membershipDues).where(eq(membershipDues.memberId, id));
    const [pay] = dues.length
      ? await this.db.select({ n: sql<number>`count(*)::int` }).from(membershipPayments).where(and(inArray(membershipPayments.dueId, dues.map((d) => d.id)), isNull(membershipPayments.cancelledAt)))
      : [{ n: 0 }];
    const closedRows = await this.db.select({ id: meetings.id }).from(meetingAttendees).innerJoin(meetings, eq(meetings.id, meetingAttendees.meetingId))
      .where(and(or(eq(meetingAttendees.memberId, id), eq(meetingAttendees.proxyMemberId, id)), isNotNull(meetings.closedAt)));
    const [mand] = await this.db.select({ n: sql<number>`count(*)::int` }).from(mandates).where(eq(mandates.memberId, id));
    const receipts = dues.filter((d) => d.receipt).map((d) => d.receipt!);
    if (pay.n > 0 || closedRows.length > 0 || mand.n > 0) {
      const parts = [
        pay.n && `${pay.n} règlement(s)${receipts.length ? ` et ${receipts.length} reçu(s) (n° ${receipts.join(', ')})` : ''} seront supprimés`,
        mand.n && `${mand.n} mandat(s) seront supprimés`,
        closedRows.length && `la fiche figure dans ${closedRows.length} procès-verbal(aux) figé(s) : elle sera anonymisée au lieu d’être effacée`,
      ].filter(Boolean);
      requireConfirmation(force, `Suppression de ${m.firstName} ${m.lastName} : ${parts.join(' ; ')}. Confirmez pour continuer.`, { payments: pay.n, receipts, mandates: mand.n, closedMeetings: closedRows.length });
    }
    const mode = closedRows.length ? 'anonymized' : 'deleted';
    await this.db.transaction(async (tx) => {
      await allowPurge(tx);
      if (dues.length) {
        await tx.delete(membershipPayments).where(inArray(membershipPayments.dueId, dues.map((d) => d.id)));
        await tx.delete(membershipDues).where(eq(membershipDues.memberId, id));
      }
      await tx.delete(mandates).where(eq(mandates.memberId, id));
      // Réunions non clôturées : retrait de la liste et des procurations.
      await tx.execute(sql`update meeting_attendees set proxy_member_id = null, status = case when status = 'represented' then 'excused' else status end
        where proxy_member_id = ${id} and meeting_id in (select id from meetings where closed_at is null)`);
      await tx.execute(sql`delete from meeting_attendees where member_id = ${id} and meeting_id in (select id from meetings where closed_at is null)`);
      if (mode === 'deleted') {
        await tx.delete(members).where(eq(members.id, id));
      } else {
        await tx.update(members).set({
          firstName: 'Adhérent', lastName: `supprimé (n° ${m.number})`, email: null, phone: null, birthDate: null, addressLine: null, postalCode: null, city: null,
          guardianName: null, guardianPhone: null, guardianEmail: null, imageRights: false, skills: [], notes: null, custom: {}, cardToken: null, userId: null,
          status: 'archived', archivedAt: new Date(), updatedAt: new Date(),
        }).where(eq(members.id, id));
        await tx.delete(memberGroupLinks).where(eq(memberGroupLinks.memberId, id));
      }
      await this.audit.log({
        associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip,
        action: mode === 'deleted' ? 'member.delete' : 'member.anonymize', resourceType: 'member', resourceId: id,
        summary: mode === 'deleted'
          ? `Suppression définitive de la fiche n° ${m.number} — ${m.firstName} ${m.lastName} (${dues.length} cotisation(s), ${pay.n} règlement(s))`
          : `Anonymisation de la fiche n° ${m.number} (citée dans un procès-verbal figé) ; cotisations, règlements et coordonnées supprimés`,
        data: { receipts },
      }, tx);
    });
    return { ok: true, mode };
  }
}
