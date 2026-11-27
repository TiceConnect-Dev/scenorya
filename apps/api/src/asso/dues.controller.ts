import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { computePeriod, formatCents, PAYMENT_METHODS, PERIOD_TYPES, PeriodType } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Conflict, NotFound } from '../common/errors';
import { DB, Db, DbOrTx } from '../db/db';
import { associations, counters, members, membershipDues, membershipPayments, membershipPlans } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModulesService } from '../modules/modules.service';
import { toCsv } from '../common/csv';
import { renderReceipt } from './receipt';
import { allowPurge, requireConfirmation } from '../common/purge';
import { MEMBER_CATEGORIES } from './members.controller';

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date au format AAAA-MM-JJ');
const zCents = z.number().int('Montant en centimes entiers').min(0).max(100_000_000);
const today = () => new Date().toISOString().slice(0, 10);
const actorLog = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });

const zPlan = z.object({
  name: z.string().trim().min(2).max(120),
  description: zOptText(500),
  amountCents: zCents,
  periodType: z.enum(Object.keys(PERIOD_TYPES) as [PeriodType, ...PeriodType[]]),
  memberCategory: z.enum(MEMBER_CATEGORIES).nullable().optional(),
  active: z.boolean().default(true),
});

/* ------------------------------------------------------------- Formules */

@ApiTags('Scenorya Asso — Formules de cotisation')
@Controller('asso/plans')
export class PlansController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  @Access('asso', 'asso.plans.read')
  @Get()
  list(@AssocContext() c: AssocCtx) {
    return this.db
      .select({
        plan: membershipPlans,
        dues: sql<number>`(select count(*)::int from membership_dues d where d.plan_id = ${membershipPlans.id} and d.status <> 'cancelled')`,
      })
      .from(membershipPlans)
      .where(eq(membershipPlans.associationId, c.association.id))
      .orderBy(desc(membershipPlans.active), asc(membershipPlans.name))
      .then((rows) => rows.map((r) => ({ ...r.plan, dues: r.dues })));
  }

  @Access('asso', 'asso.plans.create')
  @Post()
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zPlan, body);
    const [dupe] = await this.db.select({ id: membershipPlans.id }).from(membershipPlans).where(and(eq(membershipPlans.associationId, c.association.id), eq(membershipPlans.name, input.name)));
    if (dupe) throw Conflict('PLAN_EXISTS', 'Une formule porte déjà ce nom.');
    const [p] = await this.db.insert(membershipPlans).values({ ...input, memberCategory: input.memberCategory ?? null, associationId: c.association.id }).returning();
    await this.audit.log({ ...actorLog(c), action: 'plan.create', resourceType: 'plan', resourceId: p.id, summary: `Création de la formule « ${p.name} » (${formatCents(p.amountCents)})` });
    return p;
  }

  /** Le montant d'une formule peut changer : les cotisations déjà émises gardent leur montant. */
  @Access('asso', 'asso.plans.update')
  @Patch(':id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const input = parse(patchOf(zPlan), body);
    const [before] = await this.db.select().from(membershipPlans).where(and(eq(membershipPlans.id, id), eq(membershipPlans.associationId, c.association.id)));
    if (!before) throw NotFound('Formule introuvable.');
    if (input.name && input.name !== before.name) {
      const [dupe] = await this.db.select({ id: membershipPlans.id }).from(membershipPlans).where(and(eq(membershipPlans.associationId, c.association.id), eq(membershipPlans.name, input.name)));
      if (dupe) throw Conflict('PLAN_EXISTS', 'Une formule porte déjà ce nom.');
    }
    const [p] = await this.db.update(membershipPlans).set({ ...input, updatedAt: new Date() }).where(eq(membershipPlans.id, id)).returning();
    await this.audit.log({ ...actorLog(c), action: 'plan.update', resourceType: 'plan', resourceId: id, summary: `Modification de la formule « ${p.name} »`, data: { before: { amountCents: before.amountCents, active: before.active }, after: { amountCents: p.amountCents, active: p.active } } });
    return p;
  }

  /** Les cotisations déjà émises gardent leur libellé et leur montant : elles sont simplement détachées de la formule. */
  @Access('asso', 'asso.plans.delete')
  @Delete(':id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [p] = await this.db.select().from(membershipPlans).where(and(eq(membershipPlans.id, id), eq(membershipPlans.associationId, c.association.id)));
    if (!p) throw NotFound('Formule introuvable.');
    const n = await this.db.transaction(async (tx) => {
      const d = await tx.update(membershipDues).set({ planId: null }).where(eq(membershipDues.planId, id)).returning({ id: membershipDues.id });
      await tx.delete(membershipPlans).where(eq(membershipPlans.id, id));
      await this.audit.log({ ...actorLog(c), action: 'plan.delete', resourceType: 'plan', resourceId: id, summary: `Suppression de la formule « ${p.name} » (${d.length} cotisation(s) conservée(s))` }, tx);
      return d.length;
    });
    return { ok: true, detachedDues: n };
  }
}

/* ----------------------------------------------------------- Cotisations */

const zDuesList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  status: z.enum(['all', 'open', 'due', 'partial', 'paid', 'waived', 'cancelled']).default('all'),
  memberId: zUuid.optional(),
  planId: zUuid.optional(),
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  q: z.string().trim().max(100).optional(),
});

const zNewDue = z.object({
  memberId: zUuid,
  planId: zUuid.optional().nullable(),
  label: z.string().trim().min(2).max(160).optional(),
  amountCents: zCents.optional(),
  periodStart: zIsoDate.optional(),
  periodType: z.enum(Object.keys(PERIOD_TYPES) as [PeriodType, ...PeriodType[]]).optional(),
});

const zPayment = z.object({
  amountCents: zCents.refine((v) => v > 0, 'Le montant doit être positif'),
  method: z.enum(Object.keys(PAYMENT_METHODS) as [keyof typeof PAYMENT_METHODS, ...(keyof typeof PAYMENT_METHODS)[]]),
  paidAt: zIsoDate.default(today),
  reference: zOptText(120),
});

type DueRow = typeof membershipDues.$inferSelect;

@ApiTags('Scenorya Asso — Cotisations')
@Controller('asso/dues')
export class DuesController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'asso',
      check: async (db, associationId) => {
        const [r] = await db
          .select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${membershipDues.amountCents}),0)::int` })
          .from(membershipDues)
          .where(and(eq(membershipDues.associationId, associationId), inArray(membershipDues.status, ['due', 'partial'])));
        return r.n > 0
          ? [{ module: 'asso', level: 'warning', message: `${r.n} cotisation(s) en attente de règlement (${formatCents(r.cents)}) : elles ne pourront plus être encaissées tant que le module sera désactivé. Préférez la lecture seule pour une clôture.` }]
          : [];
      },
    });
  }

  /** Cotisation + somme des règlements valides. */
  private paidExpr = sql<number>`coalesce((select sum(p.amount_cents) from membership_payments p where p.due_id = ${membershipDues.id} and p.cancelled_at is null), 0)::int`;

  private async findDue(db: DbOrTx, associationId: string, id: string, lock = false): Promise<DueRow> {
    parse(zUuid, id);
    const q = db.select().from(membershipDues).where(and(eq(membershipDues.id, id), eq(membershipDues.associationId, associationId)));
    const [d] = lock ? await q.for('update') : await q;
    if (!d) throw NotFound('Cotisation introuvable.');
    return d;
  }

  private async nextReceiptNumber(tx: DbOrTx, associationId: string) {
    const year = new Date().getFullYear();
    const [row] = await tx
      .insert(counters)
      .values({ associationId, key: `receipt:${year}`, value: 1 })
      .onConflictDoUpdate({ target: [counters.associationId, counters.key], set: { value: sql`${counters.value} + 1` } })
      .returning({ value: counters.value });
    return `${year}-${String(row.value).padStart(4, '0')}`;
  }

  /** Recalcule le statut d'après les règlements valides ; émet ou annule le reçu ; met à jour l'adhérent. */
  private async settle(tx: DbOrTx, due: DueRow) {
    const [{ paid }] = await tx
      .select({ paid: sql<number>`coalesce(sum(${membershipPayments.amountCents}),0)::int` })
      .from(membershipPayments)
      .where(and(eq(membershipPayments.dueId, due.id), isNull(membershipPayments.cancelledAt)));
    const status = paid >= due.amountCents ? 'paid' : paid > 0 ? 'partial' : 'due';
    const patch: Partial<DueRow> = { status, updatedAt: new Date() };
    if (status === 'paid' && (!due.receiptNumber || due.receiptCancelledAt)) {
      patch.receiptNumber = await this.nextReceiptNumber(tx, due.associationId);
      patch.receiptIssuedAt = new Date();
      patch.receiptCancelledAt = null;
    }
    if (status !== 'paid' && due.receiptNumber && !due.receiptCancelledAt) patch.receiptCancelledAt = new Date();
    const [updated] = await tx.update(membershipDues).set(patch).where(eq(membershipDues.id, due.id)).returning();
    if (status === 'paid') await this.activateMember(tx, updated);
    return { due: updated, paid };
  }

  /** Une cotisation réglée ou exonérée couvrant aujourd'hui rend l'adhésion active. */
  private async activateMember(tx: DbOrTx, due: DueRow) {
    const t = today();
    const covers = due.periodStart <= t && (due.periodEnd === null || due.periodEnd >= t);
    if (!covers) return;
    let category: string | null = null;
    if (due.planId) [{ category }] = await tx.select({ category: membershipPlans.memberCategory }).from(membershipPlans).where(eq(membershipPlans.id, due.planId));
    await tx
      .update(members)
      .set({ status: 'active', ...(category ? { category } : {}), updatedAt: new Date() })
      .where(and(eq(members.id, due.memberId), inArray(members.status, ['pending', 'expired', 'active'])));
  }

  private async createDue(tx: DbOrTx, c: AssocCtx, input: z.infer<typeof zNewDue>) {
    const [member] = await tx.select().from(members).where(and(eq(members.id, input.memberId), eq(members.associationId, c.association.id)));
    if (!member) throw NotFound('Adhérent introuvable.');
    if (member.status === 'archived') throw BadRequest('MEMBER_ARCHIVED', `La fiche de ${member.firstName} ${member.lastName} est archivée.`);
    let plan: typeof membershipPlans.$inferSelect | null = null;
    if (input.planId) {
      [plan] = await tx.select().from(membershipPlans).where(and(eq(membershipPlans.id, input.planId), eq(membershipPlans.associationId, c.association.id)));
      if (!plan) throw NotFound('Formule introuvable.');
      if (!plan.active) throw BadRequest('PLAN_INACTIVE', 'Cette formule n’est plus proposée.');
    }
    const periodType = (plan?.periodType as PeriodType | undefined) ?? input.periodType ?? 'calendar_year';
    const amountCents = input.amountCents ?? plan?.amountCents;
    if (amountCents === undefined) throw BadRequest('AMOUNT_REQUIRED', 'Indiquez un montant ou une formule.');
    const [assoc] = await tx.select({ fy: associations.fiscalYearStartMonth }).from(associations).where(eq(associations.id, c.association.id));
    const period = computePeriod(periodType, input.periodStart ?? today(), assoc.fy);

    // Pas deux cotisations actives de la même formule sur des périodes qui se chevauchent.
    const overlap = await tx
      .select({ id: membershipDues.id })
      .from(membershipDues)
      .where(
        and(
          eq(membershipDues.associationId, c.association.id),
          eq(membershipDues.memberId, member.id),
          plan ? eq(membershipDues.planId, plan.id) : isNull(membershipDues.planId),
          sql`${membershipDues.status} <> 'cancelled'`,
          sql`daterange(${membershipDues.periodStart}, coalesce(${membershipDues.periodEnd}, 'infinity'::date), '[]') && daterange(${period.start}::date, coalesce(${period.end}::date, 'infinity'::date), '[]')`,
        ),
      )
      .limit(1);
    if (overlap.length) throw Conflict('DUE_EXISTS', `${member.firstName} ${member.lastName} a déjà une cotisation sur cette période.`, { memberId: member.id, dueId: overlap[0].id });

    const year = period.start.slice(0, 4);
    const label = input.label ?? (plan ? `${plan.name} ${period.end && period.end.slice(0, 4) !== year ? `${year}-${period.end.slice(0, 4)}` : year}` : `Cotisation ${year}`);
    const [due] = await tx
      .insert(membershipDues)
      .values({ associationId: c.association.id, memberId: member.id, planId: plan?.id ?? null, label, amountCents, periodStart: period.start, periodEnd: period.end, createdBy: c.user.id })
      .returning();
    await this.audit.log({ ...actorLog(c), action: 'due.create', resourceType: 'member', resourceId: member.id, summary: `Cotisation « ${label} » (${formatCents(amountCents)}) appelée pour ${member.firstName} ${member.lastName}`, data: { dueId: due.id } }, tx);
    // Une cotisation à 0 € est réglée d'office.
    if (amountCents === 0) return (await this.settle(tx, due)).due;
    return due;
  }

  private where(associationId: string, q: z.infer<typeof zDuesList>) {
    const conds: SQL[] = [eq(membershipDues.associationId, associationId)];
    if (q.status === 'open') conds.push(inArray(membershipDues.status, ['due', 'partial']));
    else if (q.status !== 'all') conds.push(eq(membershipDues.status, q.status));
    if (q.memberId) conds.push(eq(membershipDues.memberId, q.memberId));
    if (q.planId) conds.push(eq(membershipDues.planId, q.planId));
    if (q.year) conds.push(sql`extract(year from ${membershipDues.periodStart}) = ${q.year}`);
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
      conds.push(or(ilike(members.lastName, like), ilike(members.firstName, like), ilike(membershipDues.receiptNumber, like), ilike(membershipDues.label, like))!);
    }
    return and(...conds);
  }

  @Access('asso', 'asso.dues.read')
  @Get()
  async list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(zDuesList, query);
    const where = this.where(c.association.id, q);
    const base = this.db.select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${membershipDues.amountCents}),0)::int`, paid: sql<number>`coalesce(sum(${this.paidExpr}),0)::int` }).from(membershipDues).innerJoin(members, eq(members.id, membershipDues.memberId)).where(where);
    const [agg] = await base;
    const rows = await this.db
      .select({ due: membershipDues, paidCents: this.paidExpr, member: { id: members.id, number: members.number, firstName: members.firstName, lastName: members.lastName } })
      .from(membershipDues)
      .innerJoin(members, eq(members.id, membershipDues.memberId))
      .where(where)
      .orderBy(desc(membershipDues.periodStart), asc(members.lastName))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map((r) => ({ ...r.due, paidCents: r.paidCents, member: r.member })),
      total: agg.n,
      totals: { amountCents: agg.total, paidCents: agg.paid, outstandingCents: Math.max(0, agg.total - agg.paid) },
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  @Access('asso', 'asso.dues.read')
  @Get('summary')
  async summary(@AssocContext() c: AssocCtx) {
    const [r] = await this.db
      .select({
        open: sql<number>`count(*) filter (where ${membershipDues.status} in ('due','partial'))::int`,
        openCents: sql<number>`coalesce(sum(${membershipDues.amountCents} - ${this.paidExpr}) filter (where ${membershipDues.status} in ('due','partial')),0)::int`,
        paidThisYear: sql<number>`coalesce(sum(${this.paidExpr}) filter (where extract(year from ${membershipDues.periodStart}) = extract(year from now())),0)::int`,
      })
      .from(membershipDues)
      .where(eq(membershipDues.associationId, c.association.id));
    return r;
  }

  @Access('asso', 'asso.dues.export')
  @Get('export.csv')
  async export(@AssocContext() c: AssocCtx, @Query() query: unknown, @Res() res: Response) {
    const q = parse(zDuesList, query);
    const rows = await this.db
      .select({ due: membershipDues, paidCents: this.paidExpr, number: members.number, firstName: members.firstName, lastName: members.lastName })
      .from(membershipDues)
      .innerJoin(members, eq(members.id, membershipDues.memberId))
      .where(this.where(c.association.id, q))
      .orderBy(asc(membershipDues.periodStart), asc(members.lastName));
    const eur = (v: number) => (v / 100).toFixed(2).replace('.', ',');
    await this.audit.log({ ...actorLog(c), action: 'due.export', resourceType: 'due', summary: `Export CSV de ${rows.length} cotisation(s)` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cotisations.csv"');
    res.send(
      toCsv(
        ['N° adhérent', 'Nom', 'Prénom', 'Cotisation', 'Début', 'Fin', 'Montant (€)', 'Réglé (€)', 'Statut', 'N° de reçu'],
        rows.map((r) => [r.number, r.lastName, r.firstName, r.due.label, r.due.periodStart, r.due.periodEnd, eur(r.due.amountCents), eur(r.paidCents), r.due.status, r.due.receiptCancelledAt ? '' : r.due.receiptNumber]),
      ),
    );
  }

  /** Adhérents à renouveler : sans cotisation réglée couvrant aujourd'hui + `days` jours. */
  @Access('asso', 'asso.dues.read')
  @Get('renewals')
  async renewals(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(0).max(365).default(30) }), query);
    const rows = await this.db.execute(sql`
      select m.id, m.number, m.first_name as "firstName", m.last_name as "lastName", m.email, m.status, m.category,
        (select max(d.period_end) from membership_dues d where d.member_id = m.id and d.status in ('paid','waived')) as "coveredUntil",
        (select count(*)::int from membership_dues d where d.member_id = m.id and d.status in ('due','partial')) as "openDues"
      from members m
      where m.association_id = ${c.association.id} and m.status <> 'archived'
        and not exists (
          select 1 from membership_dues d where d.member_id = m.id and d.status in ('paid','waived')
            and d.period_start <= current_date and (d.period_end is null or d.period_end >= current_date + ${days}::int)
        )
      order by "coveredUntil" nulls first, m.last_name, m.first_name
      limit 1000`);
    return rows.rows;
  }

  @Access('asso', 'asso.dues.read')
  @Get(':id')
  async get(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const due = await this.findDue(this.db, c.association.id, id);
    const [member] = await this.db.select({ id: members.id, number: members.number, firstName: members.firstName, lastName: members.lastName, email: members.email }).from(members).where(eq(members.id, due.memberId));
    const payments = await this.db.select().from(membershipPayments).where(eq(membershipPayments.dueId, id)).orderBy(asc(membershipPayments.createdAt));
    const paidCents = payments.filter((p) => !p.cancelledAt).reduce((s, p) => s + p.amountCents, 0);
    return { ...due, member, payments, paidCents, remainingCents: Math.max(0, due.amountCents - paidCents) };
  }

  @Access('asso', 'asso.dues.create')
  @Post()
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zNewDue, body);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'dues:' + input.memberId}))`);
      return this.createDue(tx, c, input);
    });
  }

  /** Appel de cotisations groupé (renouvellements) : chaque adhérent est traité indépendamment. */
  @Access('asso', 'asso.dues.create')
  @Post('bulk')
  @HttpCode(200)
  async bulk(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ memberIds: z.array(zUuid).min(1).max(500), planId: zUuid, periodStart: zIsoDate.optional() }), body);
    const created: string[] = [];
    const skipped: { memberId: string; reason: string }[] = [];
    for (const memberId of [...new Set(input.memberIds)]) {
      try {
        await this.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'dues:' + memberId}))`);
          const d = await this.createDue(tx, c, { memberId, planId: input.planId, periodStart: input.periodStart });
          created.push(d.id);
        });
      } catch (e) {
        skipped.push({ memberId, reason: (e as { response?: { message?: string } }).response?.message ?? 'Erreur' });
      }
    }
    return { created: created.length, skipped };
  }

  @Access('asso', 'asso.dues.validate')
  @Post(':id/payments')
  async pay(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(zPayment, body);
    if (input.paidAt > today()) throw BadRequest('FUTURE_DATE', 'La date de règlement ne peut pas être dans le futur.');
    return this.db.transaction(async (tx) => {
      // Verrou de ligne : deux règlements simultanés ne peuvent pas dépasser le montant dû.
      const due = await this.findDue(tx, c.association.id, id, true);
      if (due.status === 'cancelled' || due.status === 'waived') throw Conflict('DUE_CLOSED', 'Cette cotisation est annulée ou exonérée.');
      const [{ paid }] = await tx
        .select({ paid: sql<number>`coalesce(sum(${membershipPayments.amountCents}),0)::int` })
        .from(membershipPayments)
        .where(and(eq(membershipPayments.dueId, id), isNull(membershipPayments.cancelledAt)));
      const remaining = due.amountCents - paid;
      if (input.amountCents > remaining) throw Conflict('OVERPAYMENT', `Le montant dépasse le reste à régler (${formatCents(Math.max(0, remaining))}).`, { remainingCents: remaining });
      const [payment] = await tx.insert(membershipPayments).values({ ...input, associationId: c.association.id, dueId: id, recordedBy: c.user.id }).returning();
      const result = await this.settle(tx, due);
      await this.audit.log({ ...actorLog(c), action: 'due.payment', resourceType: 'member', resourceId: due.memberId, summary: `Règlement de ${formatCents(input.amountCents)} (${PAYMENT_METHODS[input.method]}) pour « ${due.label} »${result.due.status === 'paid' ? ` — reçu n° ${result.due.receiptNumber}` : ''}`, data: { dueId: id, paymentId: payment.id } }, tx);
      return { payment, due: result.due, paidCents: result.paid };
    });
  }

  @Access('asso', 'asso.dues.cancel')
  @Post(':id/payments/:paymentId/cancel')
  @HttpCode(200)
  async cancelPayment(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('paymentId') paymentId: string, @Body() body: unknown) {
    parse(zUuid, paymentId);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Motif obligatoire').max(300) }), body);
    return this.db.transaction(async (tx) => {
      const due = await this.findDue(tx, c.association.id, id, true);
      const [p] = await tx.select().from(membershipPayments).where(and(eq(membershipPayments.id, paymentId), eq(membershipPayments.dueId, id)));
      if (!p) throw NotFound('Règlement introuvable.');
      if (p.cancelledAt) throw Conflict('ALREADY_CANCELLED', 'Ce règlement est déjà annulé.');
      await tx.update(membershipPayments).set({ cancelledAt: new Date(), cancelledBy: c.user.id, cancelReason: reason }).where(eq(membershipPayments.id, paymentId));
      const result = await this.settle(tx, due);
      await this.audit.log({ ...actorLog(c), action: 'due.payment.cancel', resourceType: 'member', resourceId: due.memberId, summary: `Annulation d'un règlement de ${formatCents(p.amountCents)} sur « ${due.label} » : ${reason}${due.receiptNumber && result.due.receiptCancelledAt ? ` — reçu n° ${due.receiptNumber} annulé` : ''}`, data: { dueId: id, paymentId } }, tx);
      return { due: result.due, paidCents: result.paid };
    });
  }

  @Access('asso', 'asso.dues.validate')
  @Post(':id/waive')
  @HttpCode(200)
  async waive(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Motif obligatoire').max(300) }), body);
    return this.db.transaction(async (tx) => {
      const due = await this.findDue(tx, c.association.id, id, true);
      if (due.status !== 'due') throw Conflict('DUE_NOT_OPEN', 'Seule une cotisation sans règlement peut être exonérée.');
      const [updated] = await tx.update(membershipDues).set({ status: 'waived', cancelReason: reason, updatedAt: new Date() }).where(eq(membershipDues.id, id)).returning();
      await this.activateMember(tx, updated);
      await this.audit.log({ ...actorLog(c), action: 'due.waive', resourceType: 'member', resourceId: due.memberId, summary: `Exonération de « ${due.label} » : ${reason}`, data: { dueId: id } }, tx);
      return updated;
    });
  }

  @Access('asso', 'asso.dues.cancel')
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Motif obligatoire').max(300) }), body);
    return this.db.transaction(async (tx) => {
      const due = await this.findDue(tx, c.association.id, id, true);
      if (due.status === 'cancelled') throw Conflict('ALREADY_CANCELLED', 'Cotisation déjà annulée.');
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(membershipPayments).where(and(eq(membershipPayments.dueId, id), isNull(membershipPayments.cancelledAt)));
      if (n > 0) throw Conflict('HAS_PAYMENTS', 'Annulez d’abord les règlements enregistrés.');
      const [updated] = await tx.update(membershipDues).set({ status: 'cancelled', cancelReason: reason, updatedAt: new Date() }).where(eq(membershipDues.id, id)).returning();
      await this.audit.log({ ...actorLog(c), action: 'due.cancel', resourceType: 'member', resourceId: due.memberId, summary: `Annulation de la cotisation « ${due.label} » : ${reason}`, data: { dueId: id } }, tx);
      return updated;
    });
  }

  @Access('asso', 'asso.dues.download')
  @Get(':id/receipt.pdf')
  async receipt(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const due = await this.findDue(this.db, c.association.id, id);
    if (due.status !== 'paid' || !due.receiptNumber || due.receiptCancelledAt) throw Conflict('NO_RECEIPT', 'Le reçu n’est disponible que pour une cotisation intégralement réglée.');
    const [assoc] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const [member] = await this.db.select().from(members).where(eq(members.id, due.memberId));
    const payments = await this.db.select().from(membershipPayments).where(and(eq(membershipPayments.dueId, id), isNull(membershipPayments.cancelledAt))).orderBy(asc(membershipPayments.paidAt));
    const pdf = await renderReceipt({
      association: assoc,
      member,
      due: { label: due.label, amountCents: due.amountCents, periodStart: due.periodStart, periodEnd: due.periodEnd, receiptNumber: due.receiptNumber, receiptIssuedAt: due.receiptIssuedAt ?? new Date() },
      payments,
    });
    await this.audit.log({ ...actorLog(c), action: 'due.receipt.download', resourceType: 'member', resourceId: due.memberId, summary: `Téléchargement du reçu n° ${due.receiptNumber}`, data: { dueId: id } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="recu-cotisation-${due.receiptNumber}.pdf"`);
    res.send(pdf);
  }

  /** Suppression définitive d'une cotisation ; si des règlements existent, ils sont supprimés après confirmation. */
  @Access('asso', 'asso.dues.delete')
  @Delete(':id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string, @Query('force') force?: string) {
    const due = await this.findDue(this.db, c.association.id, id);
    const pays = await this.db.select().from(membershipPayments).where(eq(membershipPayments.dueId, id));
    const active = pays.filter((x) => !x.cancelledAt);
    if (pays.length) {
      requireConfirmation(force, `La cotisation « ${due.label} » comporte ${pays.length} règlement(s)${active.length ? ` dont ${active.length} encaissé(s) (${formatCents(active.reduce((n, x) => n + x.amountCents, 0))})` : ''}${due.receiptNumber ? ` et le reçu n° ${due.receiptNumber}` : ''}. Ils seront supprimés définitivement : confirmez.`, { payments: pays.length, receipt: due.receiptNumber });
    }
    await this.db.transaction(async (tx) => {
      await allowPurge(tx);
      await tx.delete(membershipPayments).where(eq(membershipPayments.dueId, id));
      await tx.delete(membershipDues).where(eq(membershipDues.id, id));
      await this.audit.log({
        ...actorLog(c), action: 'due.delete', resourceType: 'member', resourceId: due.memberId,
        summary: `Suppression définitive de la cotisation « ${due.label} » (${formatCents(due.amountCents)}${pays.length ? `, ${pays.length} règlement(s)` : ''}${due.receiptNumber ? `, reçu n° ${due.receiptNumber}` : ''})`,
        data: { dueId: id, payments: pays.map((x) => ({ amountCents: x.amountCents, method: x.method, paidAt: x.paidAt, cancelled: !!x.cancelledAt })) },
      }, tx);
    });
    return { ok: true };
  }
}
