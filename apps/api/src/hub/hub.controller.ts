import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { DEFAULT_TIMEZONE, expandOccurrences, grantsCover, MODULES, RecurrenceRule } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { DB, Db } from '../db/db';
import { associationUsers, auditLogs, events, members, membershipDues, projects, tasks } from '../db/schema';

/**
 * Tableau de bord : chaque widget n'est calculé que si le module source est
 * utilisable ET que l'utilisateur détient la permission correspondante.
 */
@ApiTags('Scenorya Hub')
@Controller('hub')
export class HubController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Access('hub', 'hub.read')
  @Get('summary')
  async summary(@AssocContext() c: AssocCtx) {
    const widgets: Record<string, unknown> = {};
    const can = (p: string) => grantsCover(c.grants, p);

    widgets.modules = {
      active: MODULES.filter((m) => !m.core && c.modules[m.id].state === 'active').length,
      readonly: MODULES.filter((m) => c.modules[m.id].state === 'readonly').length,
      missingDependency: MODULES.filter((m) => c.modules[m.id].state === 'missing_dependency').map((m) => m.id),
    };

    if (c.modules.asso.usable && can('asso.members.read')) {
      const [r] = await this.db
        .select({
          active: sql<number>`count(*) filter (where ${members.status} = 'active')::int`,
          pending: sql<number>`count(*) filter (where ${members.status} = 'pending')::int`,
          volunteers: sql<number>`count(*) filter (where ${members.status} = 'active' and ${members.category} = 'benevole')::int`,
          newThisMonth: sql<number>`count(*) filter (where ${members.joinedAt} >= date_trunc('month', now()))::int`,
        })
        .from(members)
        .where(eq(members.associationId, c.association.id));
      widgets.members = r;
    }

    if (c.modules.asso.usable && can('asso.dues.read')) {
      const [r] = await this.db
        .select({
          open: sql<number>`count(*)::int`,
          outstandingCents: sql<number>`coalesce(sum(${membershipDues.amountCents} - coalesce((select sum(p.amount_cents) from membership_payments p where p.due_id = ${membershipDues.id} and p.cancelled_at is null),0)),0)::int`,
        })
        .from(membershipDues)
        .where(and(eq(membershipDues.associationId, c.association.id), sql`${membershipDues.status} in ('due','partial')`));
      widgets.dues = r;
    }

    if (c.modules.agenda.usable && can('agenda.events.read')) {
      const from = new Date();
      const to = new Date(Date.now() + 14 * 86_400_000);
      const rows = await this.db
        .select()
        .from(events)
        .where(and(eq(events.associationId, c.association.id), isNull(events.cancelledAt), lt(events.startAt, to), or(gt(events.endAt, from), sql`${events.rule} is not null`)));
      widgets.upcoming = rows
        .flatMap((e) => expandOccurrences({ start: e.startAt, end: e.endAt, rule: e.rule as RecurrenceRule | null, exdates: e.exdates }, from, to, DEFAULT_TIMEZONE).map((o) => ({ id: e.id, title: e.title, category: e.category, location: e.location, allDay: e.allDay, start: o.start, end: o.end })))
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .slice(0, 6);
    }

    if (c.modules.projects.usable && can('projects.tasks.read')) {
      const [r] = await this.db
        .select({
          mine: sql<number>`count(*)::int`,
          overdue: sql<number>`count(*) filter (where ${tasks.dueDate} < current_date)::int`,
          dueSoon: sql<number>`count(*) filter (where ${tasks.dueDate} between current_date and current_date + 7)::int`,
        })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(eq(tasks.assigneeId, c.membershipId), sql`${tasks.status} <> 'done'`, isNull(projects.archivedAt), eq(projects.isTemplate, false)));
      widgets.tasks = r;
    }

    if (can('admin.users.read')) {
      const [r] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(associationUsers)
        .where(and(eq(associationUsers.associationId, c.association.id), eq(associationUsers.status, 'active')));
      widgets.users = { active: r.n };
    }

    if (can('admin.audit.read')) {
      widgets.recentActivity = await this.db
        .select({ id: auditLogs.id, action: auditLogs.action, summary: auditLogs.summary, actorLabel: auditLogs.actorLabel, createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .where(eq(auditLogs.associationId, c.association.id))
        .orderBy(desc(auditLogs.id))
        .limit(8);
    }
    return { association: c.association, widgets };
  }
}
