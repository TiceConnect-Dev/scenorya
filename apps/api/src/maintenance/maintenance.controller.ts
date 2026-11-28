import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { aliasedTable, and, asc, desc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, NotFound } from '../common/errors';
import { DB, Db } from '../db/db';
import { associationUsers, maintenanceLogs, maintenancePlans, maintenanceTickets, stockItems, users } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';

const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zDate = z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional());
const CLOSED = ['done', 'cancelled'];
const STATUS: Record<string, string> = { open: 'ouverte', in_progress: 'en cours', waiting_parts: 'en attente de pièces', done: 'terminée', cancelled: 'annulée' };
const zTicket = z.object({
  itemId: zUuid.nullable().optional(),
  title: z.string().trim().min(1).max(160), description: zOptText(4000),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  status: z.enum(['open', 'in_progress', 'waiting_parts', 'done', 'cancelled']).default('open'),
  unitsOut: z.number().int().min(0).max(1_000_000).default(0),
  assigneeId: zUuid.nullable().optional(), dueOn: zDate,
  costCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  resolution: zOptText(4000),
});
const zPlan = z.object({
  itemId: zUuid.nullable().optional(), title: z.string().trim().min(1).max(160),
  intervalDays: z.number().int().min(1).max(3650), nextDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), notes: zOptText(2000),
});
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

@ApiTags('Scenorya Maintenance')
@Controller()
export class MaintenanceController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'maintenance',
      check: async (db, associationId) => {
        const out: ModuleImpact[] = [];
        const [t] = await db.select({ n: sql<number>`count(*)::int`, u: sql<number>`coalesce(sum(units_out), 0)::int` }).from(maintenanceTickets).where(and(eq(maintenanceTickets.associationId, associationId), notInArray(maintenanceTickets.status, CLOSED)));
        if (t.n > 0) out.push({ module: 'maintenance', level: 'warning', message: `${t.n} intervention(s) ouverte(s)${t.u ? ` ; ${t.u} unité(s) hors service resteront indisponibles au prêt` : ''}.` });
        return out;
      },
    });
  }

  private async ticket(associationId: string, id: string) {
    parse(zUuid, id);
    const [t] = await this.db.select().from(maintenanceTickets).where(and(eq(maintenanceTickets.id, id), eq(maintenanceTickets.associationId, associationId)));
    if (!t) throw NotFound('Intervention introuvable.');
    return t;
  }

  private async plan(associationId: string, id: string) {
    parse(zUuid, id);
    const [p] = await this.db.select().from(maintenancePlans).where(and(eq(maintenancePlans.id, id), eq(maintenancePlans.associationId, associationId)));
    if (!p) throw NotFound('Entretien introuvable.');
    return p;
  }

  private async assertItem(c: AssocCtx, itemId: string | null | undefined, unitsOut = 0) {
    if (!itemId) { if (unitsOut > 0) throw BadRequest('NO_ITEM', 'Les unités hors service se rapportent à un article.'); return null; }
    const [i] = await this.db.select().from(stockItems).where(and(eq(stockItems.id, itemId), eq(stockItems.associationId, c.association.id)));
    if (!i) throw BadRequest('UNKNOWN_ITEM', 'Article inconnu.');
    if (unitsOut > i.quantity) throw BadRequest('INVALID_QUANTITY', `« ${i.name} » ne compte que ${i.quantity} unité(s).`);
    return i;
  }

  private async assertAssignee(c: AssocCtx, id: string | null | undefined) {
    if (!id) return;
    const [m] = await this.db.select({ id: associationUsers.id }).from(associationUsers).where(and(eq(associationUsers.id, id), eq(associationUsers.associationId, c.association.id), eq(associationUsers.status, 'active')));
    if (!m) throw BadRequest('UNKNOWN_ASSIGNEE', 'Personne inconnue.');
  }

  @Access('maintenance', 'maintenance.tickets.read')
  @Get('maintenance/assignees')
  async assignees(@AssocContext() c: AssocCtx) {
    return this.db.select({ id: associationUsers.id, displayName: users.displayName }).from(associationUsers).innerJoin(users, eq(users.id, associationUsers.userId))
      .where(and(eq(associationUsers.associationId, c.association.id), eq(associationUsers.status, 'active'), eq(users.status, 'active'))).orderBy(asc(users.displayName));
  }

  @Access('maintenance', 'maintenance.tickets.read')
  @Get('maintenance/summary')
  async summary(@AssocContext() c: AssocCtx) {
    const [t] = await this.db.select({
      open: sql<number>`count(*) filter (where status not in ('done', 'cancelled'))::int`,
      critical: sql<number>`count(*) filter (where status not in ('done', 'cancelled') and priority in ('high', 'critical'))::int`,
      unitsOut: sql<number>`coalesce(sum(units_out) filter (where status not in ('done', 'cancelled')), 0)::int`,
    }).from(maintenanceTickets).where(eq(maintenanceTickets.associationId, c.association.id));
    const [p] = await this.db.select({ n: sql<number>`count(*)::int` }).from(maintenancePlans).where(and(eq(maintenancePlans.associationId, c.association.id), lte(maintenancePlans.nextDueOn, today())));
    return { ...t, overduePlans: p.n };
  }

  /* ============================================================ Interventions */

  @Access('maintenance', 'maintenance.tickets.read')
  @Get('maintenance/tickets')
  async list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ status: z.enum(['active', 'closed', 'all']).default('active'), itemId: zUuid.optional(), mine: z.enum(['true', 'false']).optional() }), query);
    const reporter = aliasedTable(users, 'reporter');
    const rows = await this.db.select({ t: maintenanceTickets, item: stockItems.name, reference: stockItems.reference, assignee: users.displayName, reporter: reporter.displayName })
      .from(maintenanceTickets).leftJoin(stockItems, eq(stockItems.id, maintenanceTickets.itemId))
      .leftJoin(associationUsers, eq(associationUsers.id, maintenanceTickets.assigneeId)).leftJoin(users, eq(users.id, associationUsers.userId))
      .leftJoin(reporter, eq(reporter.id, maintenanceTickets.reportedBy))
      .where(and(
        eq(maintenanceTickets.associationId, c.association.id),
        q.status === 'active' ? notInArray(maintenanceTickets.status, CLOSED) : q.status === 'closed' ? inArray(maintenanceTickets.status, CLOSED) : undefined,
        q.itemId ? eq(maintenanceTickets.itemId, q.itemId) : undefined,
        q.mine === 'true' ? eq(maintenanceTickets.assigneeId, c.membershipId) : undefined,
      ))
      .orderBy(sql`case ${maintenanceTickets.priority} when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`, desc(maintenanceTickets.createdAt)).limit(1000);
    return rows.map((r) => ({ ...r.t, item: r.item, reference: r.reference, assignee: r.assignee, reporter: r.reporter }));
  }

  @Access('maintenance', 'maintenance.tickets.read')
  @Get('maintenance/tickets/:id')
  async detail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    await this.ticket(c.association.id, id);
    const [t] = (await this.list(c, { status: 'all' })).filter((x) => x.id === id);
    const logs = await this.db.select({ l: maintenanceLogs, user: users.displayName }).from(maintenanceLogs).leftJoin(users, eq(users.id, maintenanceLogs.userId))
      .where(eq(maintenanceLogs.ticketId, id)).orderBy(asc(maintenanceLogs.id));
    return { ...t, logs: logs.map((r) => ({ ...r.l, user: r.user })) };
  }

  /** Signalement d'une panne (techniciens compris) ; met les unités hors service si demandé. */
  @Access('maintenance', 'maintenance.tickets.create')
  @Post('maintenance/tickets')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zTicket, body);
    const item = await this.assertItem(c, input.itemId, input.unitsOut);
    await this.assertAssignee(c, input.assigneeId);
    return this.db.transaction(async (tx) => {
      const [t] = await tx.insert(maintenanceTickets).values({ ...input, itemId: input.itemId ?? null, dueOn: input.dueOn ?? null, associationId: c.association.id, reportedBy: c.user.id, closedAt: CLOSED.includes(input.status) ? new Date() : null }).returning();
      await this.audit.log({ ...log(c), action: 'maintenance.ticket.create', resourceType: 'maintenance_ticket', resourceId: t.id, summary: `Intervention « ${t.title} »${item ? ` sur « ${item.name} »` : ''}${t.unitsOut ? ` (${t.unitsOut} hors service)` : ''}` }, tx);
      return t;
    });
  }

  @Access('maintenance', 'maintenance.tickets.update')
  @Patch('maintenance/tickets/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.ticket(c.association.id, id);
    const input = parse(patchOf(zTicket), body);
    await this.assertItem(c, input.itemId !== undefined ? input.itemId : before.itemId, input.unitsOut ?? before.unitsOut);
    await this.assertAssignee(c, input.assigneeId);
    const status = input.status ?? before.status;
    const closedAt = CLOSED.includes(status) ? (before.closedAt ?? new Date()) : null;
    return this.db.transaction(async (tx) => {
      const [t] = await tx.update(maintenanceTickets).set({ ...input, closedAt, updatedAt: new Date() }).where(eq(maintenanceTickets.id, id)).returning();
      if (input.status && input.status !== before.status) await tx.insert(maintenanceLogs).values({ ticketId: id, note: `Statut : ${STATUS[input.status]}`, userId: c.user.id });
      await this.audit.log({ ...log(c), action: 'maintenance.ticket.update', resourceType: 'maintenance_ticket', resourceId: id, summary: `Intervention « ${t.title} » modifiée${input.status && input.status !== before.status ? ` (${STATUS[input.status]})` : ''}` }, tx);
      return t;
    });
  }

  @Access('maintenance', 'maintenance.tickets.create')
  @Post('maintenance/tickets/:id/logs')
  async addLog(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.ticket(c.association.id, id);
    const { note } = parse(z.object({ note: z.string().trim().min(1).max(4000) }), body);
    const [l] = await this.db.insert(maintenanceLogs).values({ ticketId: id, note, userId: c.user.id }).returning();
    await this.db.update(maintenanceTickets).set({ updatedAt: new Date() }).where(eq(maintenanceTickets.id, id));
    return l;
  }

  @Access('maintenance', 'maintenance.tickets.update')
  @Delete('maintenance/tickets/:id/logs/:logId')
  async removeLog(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('logId') logId: string) {
    await this.ticket(c.association.id, id);
    const n = parse(z.coerce.number().int().positive(), logId);
    const [l] = await this.db.delete(maintenanceLogs).where(and(eq(maintenanceLogs.id, n), eq(maintenanceLogs.ticketId, id))).returning();
    if (!l) throw NotFound('Note introuvable.');
    return { ok: true };
  }

  @Access('maintenance', 'maintenance.tickets.delete')
  @Delete('maintenance/tickets/:id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const t = await this.ticket(c.association.id, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(maintenanceTickets).where(eq(maintenanceTickets.id, id));
      await this.audit.log({ ...log(c), action: 'maintenance.ticket.delete', resourceType: 'maintenance_ticket', resourceId: id, summary: `Suppression de l’intervention « ${t.title} »` }, tx);
    });
    return { ok: true };
  }

  /* ============================================================ Entretien préventif */

  @Access('maintenance', 'maintenance.plans.read')
  @Get('maintenance/plans')
  async plans(@AssocContext() c: AssocCtx) {
    const rows = await this.db.select({ p: maintenancePlans, item: stockItems.name, reference: stockItems.reference }).from(maintenancePlans).leftJoin(stockItems, eq(stockItems.id, maintenancePlans.itemId))
      .where(eq(maintenancePlans.associationId, c.association.id)).orderBy(asc(maintenancePlans.nextDueOn));
    const t = today();
    return rows.map((r) => ({ ...r.p, item: r.item, reference: r.reference, overdue: r.p.nextDueOn <= t }));
  }

  @Access('maintenance', 'maintenance.plans.update')
  @Post('maintenance/plans')
  async addPlan(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zPlan, body);
    await this.assertItem(c, input.itemId);
    const [p] = await this.db.insert(maintenancePlans).values({ ...input, itemId: input.itemId ?? null, associationId: c.association.id }).returning();
    await this.audit.log({ ...log(c), action: 'maintenance.plan.create', resourceType: 'maintenance_plan', resourceId: p.id, summary: `Entretien « ${p.title} » tous les ${p.intervalDays} jour(s)` });
    return p;
  }

  @Access('maintenance', 'maintenance.plans.update')
  @Patch('maintenance/plans/:id')
  async updatePlan(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.plan(c.association.id, id);
    const input = parse(patchOf(zPlan), body);
    if (input.itemId !== undefined) await this.assertItem(c, input.itemId);
    const [p] = await this.db.update(maintenancePlans).set(input).where(eq(maintenancePlans.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'maintenance.plan.update', resourceType: 'maintenance_plan', resourceId: id, summary: `Entretien « ${p.title} » modifié` });
    return p;
  }

  /** Entretien effectué : intervention close au journal, prochaine échéance recalculée. */
  @Access('maintenance', 'maintenance.plans.update')
  @Post('maintenance/plans/:id/done')
  @HttpCode(200)
  async done(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.plan(c.association.id, id);
    const input = parse(z.object({ note: zOptText(2000), costCents: z.number().int().min(0).max(1_000_000_000).nullable().optional() }), body ?? {});
    const d = today();
    return this.db.transaction(async (tx) => {
      const [t] = await tx.insert(maintenanceTickets).values({ associationId: c.association.id, itemId: p.itemId, title: p.title, status: 'done', priority: 'normal', planId: p.id, resolution: input.note ?? 'Entretien préventif effectué.', costCents: input.costCents ?? null, reportedBy: c.user.id, closedAt: new Date() }).returning();
      const [n] = await tx.update(maintenancePlans).set({ lastDoneOn: d, nextDueOn: addDays(d, p.intervalDays) }).where(eq(maintenancePlans.id, id)).returning();
      await this.audit.log({ ...log(c), action: 'maintenance.plan.done', resourceType: 'maintenance_plan', resourceId: id, summary: `Entretien « ${p.title} » effectué ; prochain le ${n.nextDueOn}` }, tx);
      return { plan: n, ticket: t };
    });
  }

  @Access('maintenance', 'maintenance.plans.update')
  @Delete('maintenance/plans/:id')
  async removePlan(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const p = await this.plan(c.association.id, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(maintenancePlans).where(eq(maintenancePlans.id, id));
      await this.audit.log({ ...log(c), action: 'maintenance.plan.delete', resourceType: 'maintenance_plan', resourceId: id, summary: `Suppression de l’entretien « ${p.title} » (l’historique des interventions est conservé)` }, tx);
    });
    return { ok: true };
  }
}
