import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, asc, eq, inArray, isNull, ne, sql, gt, or } from 'drizzle-orm';
import { z } from 'zod';
import { grantsCover, isValidGrant, PERMISSIONS, PERMISSION_RESOURCES, PERMISSION_ACTIONS } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, zEmail, zPassword, zUuid } from '../common/validation';
import { BadRequest, Conflict, Forbidden, NotFound } from '../common/errors';
import { DB, Db, DbOrTx } from '../db/db';
import { associationUsers, roleAssignments, roles, users } from '../db/schema';
import { SessionService } from '../auth/session.service';
import { AuditService } from '../audit/audit.service';

/** Un acteur ne peut accorder que des permissions qu'il détient lui-même (anti-escalade). */
function assertCanGrant(actorGrants: string[], permissions: string[]) {
  const missing = permissions.filter((p) => {
    if (actorGrants.includes('*')) return false;
    if (p === '*') return true;
    if (p.endsWith('.*')) return !actorGrants.includes(p) && !grantsCover(actorGrants, p);
    return !grantsCover(actorGrants, p);
  });
  if (missing.length) throw Forbidden('PRIVILEGE_ESCALATION', 'Vous ne pouvez pas accorder des droits que vous ne possédez pas.', { missing });
}

/** Garantit qu'il reste au moins un administrateur actif (rôle « * ») dans l'association. */
async function assertAdminRemains(tx: DbOrTx, associationId: string) {
  const now = new Date();
  const [r] = await tx
    .select({ n: sql<number>`count(distinct ${associationUsers.id})::int` })
    .from(associationUsers)
    .innerJoin(users, eq(users.id, associationUsers.userId))
    .innerJoin(roleAssignments, eq(roleAssignments.associationUserId, associationUsers.id))
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(associationUsers.associationId, associationId),
        eq(associationUsers.status, 'active'),
        eq(users.status, 'active'),
        or(isNull(associationUsers.expiresAt), gt(associationUsers.expiresAt, now)),
        or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, now)),
        isNull(roleAssignments.scopeType),
        sql`'*' = ANY(${roles.permissions})`,
      ),
    );
  if (r.n === 0) throw Conflict('LAST_ADMIN', "L'association doit conserver au moins un administrateur actif.");
}

const zRoleIds = z.array(zUuid).max(30);
const zExpires = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .optional()
  .transform((v) => (v ? new Date(v) : v === null ? null : undefined));

@ApiTags('Scenorya Admin — Utilisateurs')
@Controller('admin/users')
export class AdminUsersController {
  constructor(@Inject(DB) private readonly db: Db, private readonly sessions: SessionService, private readonly audit: AuditService) {}

  private async loadRoles(associationId: string, roleIds: string[]) {
    if (roleIds.length === 0) return [];
    const found = await this.db.select().from(roles).where(and(eq(roles.associationId, associationId), inArray(roles.id, roleIds)));
    if (found.length !== new Set(roleIds).size) throw BadRequest('UNKNOWN_ROLE', 'Rôle inconnu dans cette association.');
    return found;
  }

  private async membership(associationId: string, id: string) {
    const [m] = await this.db
      .select({ m: associationUsers, u: users })
      .from(associationUsers)
      .innerJoin(users, eq(users.id, associationUsers.userId))
      .where(and(eq(associationUsers.id, id), eq(associationUsers.associationId, associationId)));
    if (!m) throw NotFound('Utilisateur introuvable dans cette association.');
    return m;
  }

  @Access('admin', 'admin.users.read')
  @Get()
  async list(@AssocContext() c: AssocCtx) {
    const rows = await this.db
      .select({
        id: associationUsers.id, userId: users.id, email: users.email, displayName: users.displayName, userStatus: users.status,
        status: associationUsers.status, expiresAt: associationUsers.expiresAt, createdAt: associationUsers.createdAt,
        lastLoginAt: users.lastLoginAt, isSuperAdmin: users.isSuperAdmin, mustChangePassword: users.mustChangePassword,
      })
      .from(associationUsers)
      .innerJoin(users, eq(users.id, associationUsers.userId))
      .where(eq(associationUsers.associationId, c.association.id))
      .orderBy(asc(users.displayName));
    const assignments = rows.length
      ? await this.db
          .select({ membershipId: roleAssignments.associationUserId, roleId: roles.id, name: roles.name, expiresAt: roleAssignments.expiresAt, scopeType: roleAssignments.scopeType, scopeId: roleAssignments.scopeId })
          .from(roleAssignments)
          .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
          .where(inArray(roleAssignments.associationUserId, rows.map((r) => r.id)))
      : [];
    return rows.map((r) => ({ ...r, roles: assignments.filter((a) => a.membershipId === r.id) }));
  }

  @Access('admin', 'admin.users.create')
  @Post()
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(
      z.object({
        email: zEmail,
        displayName: z.string().trim().min(2).max(120),
        password: zPassword.optional(),
        roleIds: zRoleIds,
        expiresAt: zExpires,
      }),
      body,
    );
    const roleRows = await this.loadRoles(c.association.id, input.roleIds);
    assertCanGrant(c.grants, roleRows.flatMap((r) => r.permissions));
    const result = await this.db.transaction(async (tx) => {
      let [user] = await tx.select().from(users).where(sql`lower(${users.email}) = ${input.email}`);
      let createdUser = false;
      if (!user) {
        if (!input.password) throw BadRequest('PASSWORD_REQUIRED', 'Un mot de passe provisoire est requis pour un nouveau compte.');
        [user] = await tx
          .insert(users)
          .values({ email: input.email, displayName: input.displayName, passwordHash: await this.sessions.hashPassword(input.password), mustChangePassword: true })
          .returning();
        createdUser = true;
      }
      const [existing] = await tx
        .select()
        .from(associationUsers)
        .where(and(eq(associationUsers.associationId, c.association.id), eq(associationUsers.userId, user.id)));
      if (existing) throw Conflict('ALREADY_MEMBER', 'Cet utilisateur a déjà accès à cette association.');
      const [m] = await tx
        .insert(associationUsers)
        .values({ associationId: c.association.id, userId: user.id, expiresAt: input.expiresAt ?? null })
        .returning();
      if (roleRows.length) await tx.insert(roleAssignments).values(roleRows.map((r) => ({ associationUserId: m.id, roleId: r.id })));
      await this.audit.log(
        { associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'user.add', resourceType: 'user', resourceId: user.id, summary: `Ajout de ${user.displayName} (${user.email}) avec les rôles : ${roleRows.map((r) => r.name).join(', ') || 'aucun'}`, data: { createdUser, roles: roleRows.map((r) => r.name), expiresAt: input.expiresAt }, ip: c.ip },
        tx,
      );
      return { id: m.id, userId: user.id, createdUser };
    });
    return result;
  }

  @Access('admin', 'admin.users.update')
  @Patch(':id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const input = parse(z.object({ roleIds: zRoleIds.optional(), expiresAt: zExpires }), body);
    const target = await this.membership(c.association.id, id);
    return this.db.transaction(async (tx) => {
      if (input.roleIds) {
        const newRoles = await this.loadRoles(c.association.id, input.roleIds);
        const current = await tx
          .select({ roleId: roleAssignments.roleId, permissions: roles.permissions, name: roles.name })
          .from(roleAssignments)
          .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
          .where(and(eq(roleAssignments.associationUserId, id), isNull(roleAssignments.scopeType)));
        // Ajouter OU retirer un rôle exige d'en détenir les droits.
        const added = newRoles.filter((r) => !current.some((x) => x.roleId === r.id));
        const removed = current.filter((x) => !newRoles.some((r) => r.id === x.roleId));
        assertCanGrant(c.grants, [...added.flatMap((r) => r.permissions), ...removed.flatMap((r) => r.permissions)]);
        await tx.delete(roleAssignments).where(and(eq(roleAssignments.associationUserId, id), isNull(roleAssignments.scopeType)));
        if (newRoles.length) await tx.insert(roleAssignments).values(newRoles.map((r) => ({ associationUserId: id, roleId: r.id })));
        await this.audit.log(
          { associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'user.roles.update', resourceType: 'user', resourceId: target.u.id, summary: `Rôles de ${target.u.displayName} : ${newRoles.map((r) => r.name).join(', ') || 'aucun'}`, data: { added: added.map((r) => r.name), removed: removed.map((r) => r.name) }, ip: c.ip },
          tx,
        );
      }
      if (input.expiresAt !== undefined) {
        await tx.update(associationUsers).set({ expiresAt: input.expiresAt }).where(eq(associationUsers.id, id));
        await this.audit.log(
          { associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'user.expiry.update', resourceType: 'user', resourceId: target.u.id, summary: `Expiration de l'accès de ${target.u.displayName} : ${input.expiresAt ? input.expiresAt.toISOString() : 'aucune'}`, ip: c.ip },
          tx,
        );
      }
      await assertAdminRemains(tx, c.association.id);
      return { ok: true };
    });
  }

  @Access('admin', 'admin.users.archive')
  @Post(':id/disable')
  @HttpCode(200)
  async disable(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    if (id === c.membershipId) throw BadRequest('SELF_DISABLE', 'Vous ne pouvez pas désactiver votre propre accès.');
    const target = await this.membership(c.association.id, id);
    await this.db.transaction(async (tx) => {
      await tx.update(associationUsers).set({ status: 'disabled' }).where(eq(associationUsers.id, id));
      await assertAdminRemains(tx, c.association.id);
      await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'user.disable', resourceType: 'user', resourceId: target.u.id, summary: `Accès désactivé pour ${target.u.displayName}`, ip: c.ip }, tx);
    });
    return { ok: true };
  }

  @Access('admin', 'admin.users.restore')
  @Post(':id/enable')
  @HttpCode(200)
  async enable(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const target = await this.membership(c.association.id, id);
    await this.db.update(associationUsers).set({ status: 'active' }).where(eq(associationUsers.id, id));
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'user.enable', resourceType: 'user', resourceId: target.u.id, summary: `Accès réactivé pour ${target.u.displayName}`, ip: c.ip });
    return { ok: true };
  }

  @Access('admin', 'admin.users.update')
  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const input = parse(z.object({ password: zPassword }), body);
    const target = await this.membership(c.association.id, id);
    // Un compte partagé entre plusieurs associations ou superadministrateur ne
    // peut être réinitialisé que par un superadministrateur (anti prise de contrôle).
    const [other] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(associationUsers)
      .where(and(eq(associationUsers.userId, target.u.id), ne(associationUsers.associationId, c.association.id)));
    if ((target.u.isSuperAdmin || other.n > 0) && !c.user.isSuperAdmin) {
      throw Forbidden('SHARED_ACCOUNT', 'Ce compte est partagé avec une autre structure : seul un superadministrateur peut le réinitialiser.');
    }
    await this.db
      .update(users)
      .set({ passwordHash: await this.sessions.hashPassword(input.password), mustChangePassword: true, updatedAt: new Date() })
      .where(eq(users.id, target.u.id));
    await this.sessions.revokeAllForUser(target.u.id);
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'user.password.reset', resourceType: 'user', resourceId: target.u.id, summary: `Mot de passe provisoire défini pour ${target.u.displayName}`, ip: c.ip });
    return { ok: true };
  }
}

@ApiTags('Scenorya Admin — Rôles')
@Controller('admin')
export class AdminRolesController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  @Access('admin', 'admin.roles.read')
  @Get('permissions')
  catalogue() {
    return { permissions: PERMISSIONS, resources: PERMISSION_RESOURCES, actions: PERMISSION_ACTIONS };
  }

  @Access('admin', 'admin.roles.read')
  @Get('roles')
  async list(@AssocContext() c: AssocCtx) {
    return this.db
      .select({
        id: roles.id, key: roles.key, name: roles.name, description: roles.description, permissions: roles.permissions, isSystem: roles.isSystem,
        assigned: sql<number>`(select count(*)::int from role_assignments ra where ra.role_id = ${roles.id})`,
      })
      .from(roles)
      .where(eq(roles.associationId, c.association.id))
      .orderBy(asc(roles.name));
  }

  private zRole = z.object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).default(''),
    permissions: z.array(z.string()).max(500).refine((a) => a.every(isValidGrant), 'Permission inconnue'),
  });

  @Access('admin', 'admin.roles.create')
  @Post('roles')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(this.zRole, body);
    assertCanGrant(c.grants, input.permissions);
    const [dupe] = await this.db.select({ id: roles.id }).from(roles).where(and(eq(roles.associationId, c.association.id), eq(roles.name, input.name)));
    if (dupe) throw Conflict('ROLE_EXISTS', 'Un rôle porte déjà ce nom.');
    const [role] = await this.db.insert(roles).values({ associationId: c.association.id, ...input, permissions: [...new Set(input.permissions)] }).returning();
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'role.create', resourceType: 'role', resourceId: role.id, summary: `Création du rôle « ${role.name} »`, data: { permissions: role.permissions }, ip: c.ip });
    return role;
  }

  @Access('admin', 'admin.roles.update')
  @Patch('roles/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    parse(zUuid, id);
    const input = parse(this.zRole.partial(), body);
    const [role] = await this.db.select().from(roles).where(and(eq(roles.id, id), eq(roles.associationId, c.association.id)));
    if (!role) throw NotFound('Rôle introuvable.');
    if (role.isSystem) throw Forbidden('SYSTEM_ROLE', 'Le rôle administrateur ne peut pas être modifié.');
    if (input.permissions) {
      const added = input.permissions.filter((p) => !role.permissions.includes(p));
      const removed = role.permissions.filter((p) => !input.permissions!.includes(p));
      assertCanGrant(c.grants, [...added, ...removed]);
    }
    if (input.name && input.name !== role.name) {
      const [dupe] = await this.db.select({ id: roles.id }).from(roles).where(and(eq(roles.associationId, c.association.id), eq(roles.name, input.name)));
      if (dupe) throw Conflict('ROLE_EXISTS', 'Un rôle porte déjà ce nom.');
    }
    const [updated] = await this.db
      .update(roles)
      .set({ ...input, ...(input.permissions ? { permissions: [...new Set(input.permissions)] } : {}), updatedAt: new Date() })
      .where(eq(roles.id, id))
      .returning();
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'role.update', resourceType: 'role', resourceId: id, summary: `Modification du rôle « ${updated.name} »`, data: { before: role.permissions, after: updated.permissions }, ip: c.ip });
    return updated;
  }

  @Access('admin', 'admin.roles.delete')
  @Delete('roles/:id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [role] = await this.db.select().from(roles).where(and(eq(roles.id, id), eq(roles.associationId, c.association.id)));
    if (!role) throw NotFound('Rôle introuvable.');
    if (role.isSystem) throw Forbidden('SYSTEM_ROLE', 'Le rôle administrateur ne peut pas être supprimé.');
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(roleAssignments).where(eq(roleAssignments.roleId, id));
    if (n > 0) throw Conflict('ROLE_IN_USE', `Ce rôle est attribué à ${n} utilisateur(s) : retirez-le d'abord.`);
    assertCanGrant(c.grants, role.permissions);
    await this.db.delete(roles).where(eq(roles.id, id));
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'role.delete', resourceType: 'role', resourceId: id, summary: `Suppression du rôle « ${role.name} »`, ip: c.ip });
    return { ok: true };
  }
}
