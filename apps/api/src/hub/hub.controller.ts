import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, sql } from 'drizzle-orm';
import { grantsCover, MODULES } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { DB, Db } from '../db/db';
import { associationUsers, auditLogs, members } from '../db/schema';

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
