import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { grantsCover } from '@scenorya/shared';
import { DB, Db } from '../db/db';
import { associationUsers, associations, roleAssignments, roles } from '../db/schema';

export interface Membership {
  id: string;
  association: { id: string; name: string };
}

@Injectable()
export class PermissionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Appartenance active et non expirée à une association active. */
  async membership(userId: string, associationId: string): Promise<Membership | null> {
    const now = new Date();
    const [row] = await this.db
      .select({ id: associationUsers.id, aid: associations.id, name: associations.name })
      .from(associationUsers)
      .innerJoin(associations, eq(associations.id, associationUsers.associationId))
      .where(
        and(
          eq(associationUsers.userId, userId),
          eq(associationUsers.associationId, associationId),
          eq(associationUsers.status, 'active'),
          eq(associations.status, 'active'),
          or(isNull(associationUsers.expiresAt), gt(associationUsers.expiresAt, now)),
        ),
      )
      .limit(1);
    return row ? { id: row.id, association: { id: row.aid, name: row.name } } : null;
  }

  /**
   * Permissions accordées à une appartenance. Sans `scope`, seules les
   * attributions globales (sans portée) sont prises en compte ; avec `scope`,
   * les attributions portant sur cette ressource précise s'y ajoutent.
   */
  async grants(membershipId: string, scope?: { type: string; id: string }): Promise<string[]> {
    const now = new Date();
    const rows = await this.db
      .select({ permissions: roles.permissions, scopeType: roleAssignments.scopeType, scopeId: roleAssignments.scopeId })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(
        and(
          eq(roleAssignments.associationUserId, membershipId),
          or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, now)),
        ),
      );
    const out = new Set<string>();
    for (const r of rows) {
      const applies = r.scopeType === null || (scope && r.scopeType === scope.type && r.scopeId === scope.id);
      if (applies) for (const p of r.permissions) out.add(p);
    }
    return [...out];
  }

  async can(membershipId: string, permission: string, scope?: { type: string; id: string }) {
    return grantsCover(await this.grants(membershipId, scope), permission);
  }
}
