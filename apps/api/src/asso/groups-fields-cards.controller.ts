import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Access, AssocContext, AssocCtx, Public } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Conflict, NotFound } from '../common/errors';
import { randomToken } from '../common/crypto';
import { DB, Db, DbOrTx } from '../db/db';
import { associations, memberFieldDefs, memberGroupLinks, memberGroups, members, membershipDues } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModulesService } from '../modules/modules.service';
import { loadConfig } from '../config';
import { renderCards } from './card';

const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });

/* --------------------------------------------------- Groupes et commissions */

const GROUP_KINDS = ['group', 'commission', 'troupe', 'bureau'] as const;
const zGroup = z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(GROUP_KINDS).default('group'), description: zOptText(500) });

@ApiTags('Scenorya Asso — Groupes')
@Controller('asso/groups')
export class GroupsController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  private async find(associationId: string, id: string) {
    parse(zUuid, id);
    const [g] = await this.db.select().from(memberGroups).where(and(eq(memberGroups.id, id), eq(memberGroups.associationId, associationId)));
    if (!g) throw NotFound('Groupe introuvable.');
    return g;
  }

  @Access('asso', 'asso.groups.read')
  @Get()
  async list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ memberId: zUuid.optional(), archived: z.enum(['true', 'false']).default('false') }), query);
    const rows = await this.db
      .select({
        g: memberGroups,
        members: sql<number>`(select count(*)::int from member_group_links l join members m on m.id = l.member_id where l.group_id = ${memberGroups.id} and m.status <> 'archived')`,
        role: q.memberId ? sql<string | null>`(select l.role from member_group_links l where l.group_id = ${memberGroups.id} and l.member_id = ${q.memberId})` : sql<null>`null`,
      })
      .from(memberGroups)
      .where(
        and(
          eq(memberGroups.associationId, c.association.id),
          q.archived === 'true' ? sql`${memberGroups.archivedAt} is not null` : isNull(memberGroups.archivedAt),
          q.memberId ? sql`exists (select 1 from member_group_links l where l.group_id = ${memberGroups.id} and l.member_id = ${q.memberId})` : undefined,
        ),
      )
      .orderBy(asc(memberGroups.kind), asc(memberGroups.name));
    return rows.map((r) => ({ ...r.g, members: r.members, role: r.role }));
  }

  @Access('asso', 'asso.groups.create')
  @Post()
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zGroup, body);
    const [dupe] = await this.db.select({ id: memberGroups.id }).from(memberGroups).where(and(eq(memberGroups.associationId, c.association.id), eq(memberGroups.name, input.name)));
    if (dupe) throw Conflict('GROUP_EXISTS', 'Un groupe porte déjà ce nom.');
    const [g] = await this.db.insert(memberGroups).values({ ...input, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'group.create', resourceType: 'group', resourceId: g.id, summary: `Création du groupe « ${g.name} »` });
    return g;
  }

  @Access('asso', 'asso.groups.update')
  @Patch(':id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.find(c.association.id, id);
    const input = parse(patchOf(zGroup), body);
    if (input.name && input.name !== before.name) {
      const [dupe] = await this.db.select({ id: memberGroups.id }).from(memberGroups).where(and(eq(memberGroups.associationId, c.association.id), eq(memberGroups.name, input.name)));
      if (dupe) throw Conflict('GROUP_EXISTS', 'Un groupe porte déjà ce nom.');
    }
    const [g] = await this.db.update(memberGroups).set({ ...input, updatedAt: new Date() }).where(eq(memberGroups.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'group.update', resourceType: 'group', resourceId: id, summary: `Modification du groupe « ${g.name} »` });
    return g;
  }

  @Access('asso', 'asso.groups.archive')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const g = await this.find(c.association.id, id);
    const { restore } = parse(z.object({ restore: z.boolean().default(false) }), body ?? {});
    await this.db.update(memberGroups).set({ archivedAt: restore ? null : new Date(), updatedAt: new Date() }).where(eq(memberGroups.id, id));
    await this.audit.log({ ...log(c), action: restore ? 'group.restore' : 'group.archive', resourceType: 'group', resourceId: id, summary: `${restore ? 'Restauration' : 'Archivage'} du groupe « ${g.name} »` });
    return { ok: true };
  }

  @Access('asso', 'asso.groups.read')
  @Get(':id/members')
  async members(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    await this.find(c.association.id, id);
    return this.db
      .select({ id: members.id, number: members.number, firstName: members.firstName, lastName: members.lastName, email: members.email, status: members.status, role: memberGroupLinks.role, since: memberGroupLinks.createdAt })
      .from(memberGroupLinks)
      .innerJoin(members, eq(members.id, memberGroupLinks.memberId))
      .where(eq(memberGroupLinks.groupId, id))
      .orderBy(asc(members.lastName), asc(members.firstName));
  }

  /** Ajoute des adhérents (ou met à jour leur fonction). */
  @Access('asso', 'asso.groups.update')
  @Put(':id/members')
  async addMembers(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const g = await this.find(c.association.id, id);
    if (g.archivedAt) throw BadRequest('GROUP_ARCHIVED', 'Ce groupe est archivé.');
    const input = parse(z.object({ memberIds: z.array(zUuid).min(1).max(500), role: zOptText(80) }), body);
    const valid = await this.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.associationId, c.association.id), inArray(members.id, input.memberIds)));
    if (valid.length !== new Set(input.memberIds).size) throw NotFound('Adhérent introuvable dans cette association.');
    await this.db
      .insert(memberGroupLinks)
      .values(valid.map((m) => ({ groupId: id, memberId: m.id, role: input.role ?? null })))
      .onConflictDoUpdate({ target: [memberGroupLinks.groupId, memberGroupLinks.memberId], set: { role: sql`excluded.role` } });
    await this.audit.log({ ...log(c), action: 'group.members.add', resourceType: 'group', resourceId: id, summary: `${valid.length} adhérent(s) ajouté(s) à « ${g.name} »${input.role ? ` (${input.role})` : ''}` });
    return { added: valid.length };
  }

  @Access('asso', 'asso.groups.update')
  @Delete(':id/members/:memberId')
  async removeMember(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('memberId') memberId: string) {
    const g = await this.find(c.association.id, id);
    parse(zUuid, memberId);
    const removed = await this.db.delete(memberGroupLinks).where(and(eq(memberGroupLinks.groupId, id), eq(memberGroupLinks.memberId, memberId))).returning();
    if (!removed.length) throw NotFound('Cet adhérent ne fait pas partie du groupe.');
    await this.audit.log({ ...log(c), action: 'group.members.remove', resourceType: 'member', resourceId: memberId, summary: `Retrait du groupe « ${g.name} »` });
    return { ok: true };
  }
}

/* ------------------------------------------------- Champs personnalisés */

const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const;
const zField = z.object({
  label: z.string().trim().min(2).max(80),
  type: z.enum(FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  required: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  position: z.number().int().min(0).max(1000).default(0),
});

@ApiTags('Scenorya Asso — Champs personnalisés')
@Controller('asso/fields')
export class FieldsController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  /** Nécessaire pour afficher les fiches : accessible avec la lecture des adhérents. */
  @Access('asso', 'asso.members.read')
  @Get()
  list(@AssocContext() c: AssocCtx) {
    return this.db.select().from(memberFieldDefs).where(eq(memberFieldDefs.associationId, c.association.id)).orderBy(asc(memberFieldDefs.position), asc(memberFieldDefs.label));
  }

  @Access('asso', 'asso.fields.admin')
  @Post()
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zField, body);
    if (input.type === 'select' && input.options.length < 2) throw BadRequest('OPTIONS_REQUIRED', 'Une liste doit proposer au moins deux valeurs.');
    const base = input.label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'champ';
    let key = base;
    for (let i = 2; ; i++) {
      const [hit] = await this.db.select({ id: memberFieldDefs.id }).from(memberFieldDefs).where(and(eq(memberFieldDefs.associationId, c.association.id), eq(memberFieldDefs.key, key)));
      if (!hit) break;
      key = `${base}_${i}`;
    }
    const [f] = await this.db.insert(memberFieldDefs).values({ ...input, key, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'field.create', resourceType: 'field', resourceId: f.id, summary: `Création du champ « ${f.label} » (${f.type})` });
    return f;
  }

  /** Le type n'est pas modifiable : les valeurs existantes resteraient incohérentes. */
  @Access('asso', 'asso.fields.admin')
  @Patch(':id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    // Schéma sans valeurs par défaut : une modification partielle ne doit rien réinitialiser.
    const zPatch = z.object({
      label: z.string().trim().min(2).max(80).optional(),
      options: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
      required: z.boolean().optional(),
      sensitive: z.boolean().optional(),
      position: z.number().int().min(0).max(1000).optional(),
      archived: z.boolean().optional(),
    });
    const input = parse(zPatch, body);
    const [before] = await this.db.select().from(memberFieldDefs).where(and(eq(memberFieldDefs.id, id), eq(memberFieldDefs.associationId, c.association.id)));
    if (!before) throw NotFound('Champ introuvable.');
    const { archived, ...rest } = input;
    if (before.type === 'select' && rest.options && rest.options.length < 2) throw BadRequest('OPTIONS_REQUIRED', 'Une liste doit proposer au moins deux valeurs.');
    const [f] = await this.db
      .update(memberFieldDefs)
      .set({ ...rest, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) })
      .where(eq(memberFieldDefs.id, id))
      .returning();
    await this.audit.log({ ...log(c), action: 'field.update', resourceType: 'field', resourceId: id, summary: `Modification du champ « ${f.label} »${archived ? ' (archivé, valeurs conservées)' : ''}` });
    return f;
  }
}

/* ------------------------------------------------- Cartes d'adhérent */

async function coverage(db: DbOrTx, memberIds: string[]) {
  if (memberIds.length === 0) return new Map<string, { valid: boolean; until: string | null }>();
  const rows = await db
    .select({
      memberId: membershipDues.memberId,
      until: sql<string | null>`max(coalesce(${membershipDues.periodEnd}, '9999-12-31'::date))::text`,
    })
    .from(membershipDues)
    .where(
      and(
        inArray(membershipDues.memberId, memberIds),
        inArray(membershipDues.status, ['paid', 'waived']),
        sql`${membershipDues.periodStart} <= current_date and (${membershipDues.periodEnd} is null or ${membershipDues.periodEnd} >= current_date)`,
      ),
    )
    .groupBy(membershipDues.memberId);
  const map = new Map(rows.map((r) => [r.memberId, { valid: true, until: r.until === '9999-12-31' ? null : r.until }]));
  for (const id of memberIds) if (!map.has(id)) map.set(id, { valid: false, until: null });
  return map;
}

const verifyUrl = (token: string) => `${loadConfig().PUBLIC_URL.replace(/\/$/, '')}/verifier/carte/${token}`;

@ApiTags("Scenorya Asso — Cartes d'adhérent")
@Controller()
export class CardsController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  private async ensureTokens(associationId: string, ids: string[]) {
    const rows = await this.db.select().from(members).where(and(eq(members.associationId, associationId), inArray(members.id, ids)));
    for (const m of rows) {
      if (!m.cardToken) {
        m.cardToken = randomToken(18);
        await this.db.update(members).set({ cardToken: m.cardToken }).where(and(eq(members.id, m.id), isNull(members.cardToken)));
        const [fresh] = await this.db.select({ t: members.cardToken }).from(members).where(eq(members.id, m.id));
        m.cardToken = fresh.t;
      }
    }
    return rows;
  }

  private async render(c: AssocCtx, ids: string[], layout: 'single' | 'sheet', res: Response) {
    const [assoc] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const rows = (await this.ensureTokens(c.association.id, ids)).filter((m) => m.status !== 'archived');
    if (rows.length === 0) throw NotFound('Aucun adhérent à imprimer.');
    const cov = await coverage(this.db, rows.map((r) => r.id));
    rows.sort((a, b) => a.lastName.localeCompare(b.lastName, 'fr') || a.firstName.localeCompare(b.firstName, 'fr'));
    const pdf = await renderCards(
      rows.map((m) => ({ association: assoc, member: m, validUntil: cov.get(m.id)?.until ?? null, verifyUrl: verifyUrl(m.cardToken!) })),
      layout,
    );
    await this.audit.log({ ...log(c), action: 'member.card', resourceType: 'member', resourceId: rows.length === 1 ? rows[0].id : null, summary: `Édition de ${rows.length} carte(s) d'adhérent` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${rows.length === 1 ? `carte-${rows[0].number}` : 'cartes-adherents'}.pdf"`);
    res.send(pdf);
  }

  @Access('asso', 'asso.members.download')
  @Get('asso/members/:id/card.pdf')
  async card(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    parse(zUuid, id);
    return this.render(c, [id], 'single', res);
  }

  /** Planche A4 de 10 cartes : `ids` (liste) ou tous les adhérents actifs à jour. */
  @Access('asso', 'asso.members.download')
  @Get('asso/cards.pdf')
  async sheet(@AssocContext() c: AssocCtx, @Query() query: unknown, @Res() res: Response) {
    const q = parse(z.object({ ids: z.string().max(40_000).optional(), groupId: zUuid.optional() }), query);
    let ids = q.ids ? q.ids.split(',').filter(Boolean) : [];
    ids.forEach((i) => parse(zUuid, i));
    if (ids.length === 0) {
      const rows = await this.db
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.associationId, c.association.id),
            eq(members.status, 'active'),
            q.groupId ? sql`exists (select 1 from member_group_links l where l.member_id = ${members.id} and l.group_id = ${q.groupId})` : undefined,
          ),
        );
      ids = rows.map((r) => r.id);
    }
    if (ids.length > 500) throw BadRequest('TOO_MANY', '500 cartes au maximum par planche.');
    return this.render(c, ids, 'sheet', res);
  }

  /** Révoque la carte actuelle (perte, vol) : l'ancien QR devient invalide. */
  @Access('asso', 'asso.members.update')
  @Post('asso/members/:id/card/revoke')
  @HttpCode(200)
  async revoke(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [m] = await this.db.update(members).set({ cardToken: randomToken(18), updatedAt: new Date() }).where(and(eq(members.id, id), eq(members.associationId, c.association.id))).returning();
    if (!m) throw NotFound('Adhérent introuvable.');
    await this.audit.log({ ...log(c), action: 'member.card.revoke', resourceType: 'member', resourceId: id, summary: `Carte de ${m.firstName} ${m.lastName} révoquée (nouvelle carte à imprimer)` });
    return { ok: true };
  }

  /**
   * Vérification publique d'une carte (lecture du QR code).
   * Ne révèle que le prénom, l'initiale du nom et la validité.
   */
  @Public()
  @Get('public/cards/:token')
  async verify(@Param('token') token: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw NotFound('Carte inconnue.');
    const [row] = await this.db
      .select({ m: members, a: { id: associations.id, name: associations.name, status: associations.status } })
      .from(members)
      .innerJoin(associations, eq(associations.id, members.associationId))
      .where(eq(members.cardToken, token));
    if (!row || row.a.status !== 'active') throw NotFound('Carte inconnue ou révoquée.');
    const resolved = await this.modules.resolved(row.a.id);
    if (!resolved.asso.usable) return { association: row.a.name, available: false };
    const cov = (await coverage(this.db, [row.m.id])).get(row.m.id)!;
    const valid = row.m.status === 'active' && cov.valid;
    return {
      available: true,
      association: row.a.name,
      member: `${row.m.firstName} ${row.m.lastName.charAt(0).toUpperCase()}.`,
      number: row.m.number,
      valid,
      validUntil: cov.until,
      checkedAt: new Date().toISOString(),
    };
  }
}
