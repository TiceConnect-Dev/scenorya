import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, asc, gt, isNull, or } from 'drizzle-orm';
import { ModuleId, ROLE_TEMPLATES } from '@scenorya/shared';
import { DB, Db, DbOrTx } from '../db/db';
import { associationUsers, associations, roleAssignments, roles } from '../db/schema';
import { ModulesService } from '../modules/modules.service';
import { AuditService } from '../audit/audit.service';

export function slugify(name: string) {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'association'
  );
}

@Injectable()
export class AssociationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly modules: ModulesService,
    private readonly audit: AuditService,
  ) {}

  private async uniqueSlug(tx: DbOrTx, name: string) {
    const base = slugify(name);
    for (let i = 0; i < 1000; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      const [hit] = await tx.select({ id: associations.id }).from(associations).where(eq(associations.slug, slug));
      if (!hit) return slug;
    }
    throw new Error('Impossible de générer un identifiant unique');
  }

  /**
   * Crée une association avec ses rôles prédéfinis et sa configuration de
   * modules. Si `adminUserId` est fourni, l'utilisateur en devient administrateur.
   */
  async create(
    tx: DbOrTx,
    data: { name: string; email?: string | null; city?: string | null },
    modules: ModuleId[],
    actor: { id: string; label: string; ip?: string | null },
    adminUserId: string | null,
  ) {
    const [assoc] = await tx
      .insert(associations)
      .values({ name: data.name, slug: await this.uniqueSlug(tx, data.name), email: data.email ?? null, city: data.city ?? null })
      .returning();
    const created = await tx
      .insert(roles)
      .values(ROLE_TEMPLATES.map((r) => ({ associationId: assoc.id, key: r.key, name: r.name, description: r.description, permissions: r.permissions, isSystem: r.key === 'admin' })))
      .returning();
    if (adminUserId) {
      const [m] = await tx.insert(associationUsers).values({ associationId: assoc.id, userId: adminUserId }).returning();
      const adminRole = created.find((r) => r.key === 'admin')!;
      await tx.insert(roleAssignments).values({ associationUserId: m.id, roleId: adminRole.id });
    }
    await this.audit.log(
      { associationId: assoc.id, actorId: actor.id, actorLabel: actor.label, action: 'association.create', resourceType: 'association', resourceId: assoc.id, summary: `Création de l'association « ${assoc.name} »`, ip: actor.ip },
      tx,
    );
    const activated = await this.modules.initialize(tx, assoc.id, modules, actor);
    return { association: assoc, activated };
  }

  /** Associations auxquelles l'utilisateur a accès. */
  listForUser(userId: string) {
    const now = new Date();
    return this.db
      .select({ id: associations.id, name: associations.name, slug: associations.slug, primaryColor: associations.primaryColor })
      .from(associationUsers)
      .innerJoin(associations, eq(associations.id, associationUsers.associationId))
      .where(
        and(
          eq(associationUsers.userId, userId),
          eq(associationUsers.status, 'active'),
          eq(associations.status, 'active'),
          or(isNull(associationUsers.expiresAt), gt(associationUsers.expiresAt, now)),
        ),
      )
      .orderBy(asc(associations.name));
  }

  listAll() {
    return this.db
      .select({
        id: associations.id, name: associations.name, slug: associations.slug, status: associations.status, createdAt: associations.createdAt,
        members: sql<number>`(select count(*)::int from association_users au where au.association_id = ${associations.id} and au.status = 'active')`,
      })
      .from(associations)
      .where(sql`${associations.status} <> 'deleted'`)
      .orderBy(asc(associations.name));
  }
}
