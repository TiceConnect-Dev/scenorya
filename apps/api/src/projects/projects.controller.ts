import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { grantsCover } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { BadRequest, Forbidden, NotFound } from '../common/errors';
import { DB, Db, DbOrTx } from '../db/db';
import { associationUsers, driveLinks, projects, taskComments, tasks, users } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModulesService } from '../modules/modules.service';
import { SPECTACLE_TEMPLATE } from './templates';

const STATUSES = ['todo', 'doing', 'waiting', 'done'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const zProject = z.object({
  name: z.string().trim().min(2).max(160),
  description: zOptText(2000),
  referenceDate: zDate.nullable().optional(),
  isTemplate: z.boolean().default(false),
});

const zTask = z.object({
  title: z.string().trim().min(1).max(200),
  description: zOptText(5000),
  status: z.enum(STATUSES).default('todo'),
  priority: z.enum(PRIORITIES).default('normal'),
  assigneeId: zUuid.nullable().optional(),
  dueDate: zDate.nullable().optional(),
  dueOffsetDays: z.number().int().min(-3650).max(3650).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(200), done: z.boolean().default(false) })).max(50).default([]),
  parentId: zUuid.nullable().optional(),
});

type TaskRow = typeof tasks.$inferSelect;

@ApiTags('Scenorya Projects')
@Controller()
export class ProjectsController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'projects',
      check: async (db, associationId) => {
        const [r] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(tasks)
          .innerJoin(projects, eq(projects.id, tasks.projectId))
          .where(and(eq(tasks.associationId, associationId), ne(tasks.status, 'done'), eq(projects.isTemplate, false), isNull(projects.archivedAt)));
        return r.n > 0 ? [{ module: 'projects', level: 'warning', message: `${r.n} tâche(s) en cours ne seront plus visibles par les personnes concernées jusqu’à la réactivation.` }] : [];
      },
    });
  }

  /* --------------------------------------------------------- Aides */

  private async project(associationId: string, id: string, writable = false) {
    parse(zUuid, id);
    const [p] = await this.db.select().from(projects).where(and(eq(projects.id, id), eq(projects.associationId, associationId)));
    if (!p) throw NotFound('Projet introuvable.');
    if (writable && p.archivedAt) throw BadRequest('PROJECT_ARCHIVED', 'Projet archivé : restaurez-le pour le modifier.');
    return p;
  }

  private async task(associationId: string, id: string) {
    parse(zUuid, id);
    const [t] = await this.db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.associationId, associationId)));
    if (!t) throw NotFound('Tâche introuvable.');
    return t;
  }

  private async checkAssignee(associationId: string, assigneeId: string | null | undefined) {
    if (!assigneeId) return;
    const [m] = await this.db.select({ id: associationUsers.id }).from(associationUsers).where(and(eq(associationUsers.id, assigneeId), eq(associationUsers.associationId, associationId), eq(associationUsers.status, 'active')));
    if (!m) throw BadRequest('INVALID_ASSIGNEE', 'Cette personne n’a pas accès à l’association.');
  }

  private async checkParent(projectId: string, parentId: string | null | undefined, selfId?: string) {
    if (!parentId) return;
    if (parentId === selfId) throw BadRequest('INVALID_PARENT', 'Une tâche ne peut pas être sa propre sous-tâche.');
    const [p] = await this.db.select().from(tasks).where(eq(tasks.id, parentId));
    if (!p || p.projectId !== projectId) throw BadRequest('INVALID_PARENT', 'Tâche parente introuvable dans ce projet.');
    if (p.parentId) throw BadRequest('INVALID_PARENT', 'Un seul niveau de sous-tâches est possible.');
  }

  /** Modification complète (droit tasks.update) ou limitée à l'état/checklist pour la personne responsable. */
  private canFullyEdit(c: AssocCtx) {
    return grantsCover(c.grants, 'projects.tasks.update');
  }

  private taskSelect() {
    return {
      t: tasks,
      assignee: users.displayName,
      subtasks: sql<number>`(select count(*)::int from tasks s where s.parent_id = ${tasks.id})`,
      subtasksDone: sql<number>`(select count(*)::int from tasks s where s.parent_id = ${tasks.id} and s.status = 'done')`,
      comments: sql<number>`(select count(*)::int from task_comments k where k.task_id = ${tasks.id})`,
    };
  }

  private shape(r: { t: TaskRow; assignee: string | null; subtasks: number; subtasksDone: number; comments: number }) {
    return { ...r.t, assigneeName: r.assignee, subtasks: r.subtasks, subtasksDone: r.subtasksDone, comments: r.comments };
  }

  /* -------------------------------------------------------- Projets */

  @Access('projects', 'projects.projects.read')
  @Get('projects')
  async list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    const q = parse(z.object({ archived: z.enum(['true', 'false']).default('false'), templates: z.enum(['true', 'false']).default('false') }), query);
    const rows = await this.db
      .select({
        p: projects,
        open: sql<number>`(select count(*)::int from tasks t where t.project_id = ${projects.id} and t.parent_id is null and t.status <> 'done')`,
        done: sql<number>`(select count(*)::int from tasks t where t.project_id = ${projects.id} and t.parent_id is null and t.status = 'done')`,
        overdue: sql<number>`(select count(*)::int from tasks t where t.project_id = ${projects.id} and t.status <> 'done' and t.due_date < current_date)`,
      })
      .from(projects)
      .where(
        and(
          eq(projects.associationId, c.association.id),
          eq(projects.isTemplate, q.templates === 'true'),
          q.archived === 'true' ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(projects.referenceDate), asc(projects.name));
    return rows.map((r) => ({ ...r.p, open: r.open, done: r.done, overdue: r.overdue }));
  }

  @Access('projects', 'projects.tasks.read')
  @Get('projects/assignees')
  assignees(@AssocContext() c: AssocCtx) {
    return this.db
      .select({ id: associationUsers.id, displayName: users.displayName })
      .from(associationUsers)
      .innerJoin(users, eq(users.id, associationUsers.userId))
      .where(and(eq(associationUsers.associationId, c.association.id), eq(associationUsers.status, 'active'), eq(users.status, 'active')))
      .orderBy(asc(users.displayName));
  }

  @Access('projects', 'projects.projects.create')
  @Post('projects')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zProject.extend({ templateId: zUuid.optional() }), body);
    const template = input.templateId ? await this.project(c.association.id, input.templateId) : null;
    if (template && !template.isTemplate) throw BadRequest('NOT_TEMPLATE', 'Ce projet n’est pas un modèle.');
    const result = await this.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(projects)
        .values({ associationId: c.association.id, name: input.name, description: input.description ?? null, referenceDate: input.referenceDate ?? null, isTemplate: input.isTemplate, createdBy: c.user.id })
        .returning();
      let copied = 0;
      if (template) copied = await this.copyTasks(tx, template.id, p, c.user.id);
      await this.audit.log({ ...log(c), action: 'project.create', resourceType: 'project', resourceId: p.id, summary: `Création du ${p.isTemplate ? 'modèle' : 'projet'} « ${p.name} »${template ? ` à partir du modèle « ${template.name} » (${copied} tâche(s))` : ''}` }, tx);
      return p;
    });
    return result;
  }

  /** Copie les tâches d'un modèle ; les échéances relatives deviennent des dates si une date de référence est fournie. */
  private async copyTasks(tx: DbOrTx, fromProjectId: string, to: typeof projects.$inferSelect, userId: string) {
    const source = await tx.select().from(tasks).where(eq(tasks.projectId, fromProjectId)).orderBy(asc(tasks.position));
    const map = new Map<string, string>();
    let n = 0;
    for (const t of [...source.filter((s) => !s.parentId), ...source.filter((s) => s.parentId)]) {
      const due = to.isTemplate ? null : t.dueOffsetDays !== null && to.referenceDate ? addDays(to.referenceDate, t.dueOffsetDays) : null;
      const [copy] = await tx
        .insert(tasks)
        .values({
          associationId: to.associationId, projectId: to.id, parentId: t.parentId ? map.get(t.parentId) ?? null : null,
          title: t.title, description: t.description, priority: t.priority, labels: t.labels,
          checklist: t.checklist.map((i) => ({ text: i.text, done: false })), position: t.position,
          dueDate: due, dueOffsetDays: to.isTemplate ? t.dueOffsetDays : null, createdBy: userId,
        })
        .returning({ id: tasks.id });
      map.set(t.id, copy.id);
      n++;
    }
    return n;
  }

  /** Installe le modèle fourni « Organisation d'un spectacle » (modifiable ensuite). */
  @Access('projects', 'projects.projects.create')
  @Post('projects/templates/spectacle')
  async installTemplate(@AssocContext() c: AssocCtx) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(projects)
        .values({ associationId: c.association.id, name: SPECTACLE_TEMPLATE.name, description: SPECTACLE_TEMPLATE.description, isTemplate: true, createdBy: c.user.id })
        .returning();
      let pos = 0;
      for (const t of SPECTACLE_TEMPLATE.tasks) {
        const [parent] = await tx
          .insert(tasks)
          .values({ associationId: c.association.id, projectId: p.id, title: t.title, description: t.description ?? null, priority: t.priority ?? 'normal', labels: t.labels, dueOffsetDays: t.offset, checklist: (t.checklist ?? []).map((text) => ({ text, done: false })), position: (pos += 1000), createdBy: c.user.id })
          .returning();
        for (const s of t.subtasks ?? []) {
          await tx.insert(tasks).values({ associationId: c.association.id, projectId: p.id, parentId: parent.id, title: s, labels: [], dueOffsetDays: t.offset, position: (pos += 1000), createdBy: c.user.id });
        }
      }
      await this.audit.log({ ...log(c), action: 'project.template.install', resourceType: 'project', resourceId: p.id, summary: `Installation du modèle « ${p.name} »` }, tx);
      return p;
    });
  }

  @Access('projects', 'projects.projects.read')
  @Get('projects/:id')
  get(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    return this.project(c.association.id, id);
  }

  @Access('projects', 'projects.projects.update')
  @Patch('projects/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.project(c.association.id, id, true);
    const input = parse(patchOf(zProject.omit({ isTemplate: true })), body);
    const [p] = await this.db.update(projects).set({ ...input, updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    // Changement de date de référence : recalcul des échéances issues du modèle non modifiées à la main n'est pas automatique (choix explicite).
    await this.audit.log({ ...log(c), action: 'project.update', resourceType: 'project', resourceId: id, summary: `Modification du projet « ${p.name} »`, data: { fields: Object.keys(input), before: { referenceDate: before.referenceDate } } });
    return p;
  }

  @Access('projects', 'projects.projects.archive')
  @Post('projects/:id/archive')
  @HttpCode(200)
  async archive(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.project(c.association.id, id);
    const { restore } = parse(z.object({ restore: z.boolean().default(false) }), body ?? {});
    await this.db.update(projects).set({ archivedAt: restore ? null : new Date(), updatedAt: new Date() }).where(eq(projects.id, id));
    await this.audit.log({ ...log(c), action: restore ? 'project.restore' : 'project.archive', resourceType: 'project', resourceId: id, summary: `${restore ? 'Restauration' : 'Archivage'} du projet « ${p.name} »` });
    return { ok: true };
  }

  /* --------------------------------------------------------- Tâches */

  @Access('projects', 'projects.tasks.read')
  @Get('projects/:id/tasks')
  async tasks(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    await this.project(c.association.id, id);
    const rows = await this.db
      .select(this.taskSelect())
      .from(tasks)
      .leftJoin(associationUsers, eq(associationUsers.id, tasks.assigneeId))
      .leftJoin(users, eq(users.id, associationUsers.userId))
      .where(eq(tasks.projectId, id))
      .orderBy(asc(tasks.position), asc(tasks.createdAt));
    return rows.map((r) => this.shape(r));
  }

  /** Tâches qui me sont attribuées, tous projets actifs confondus. */
  @Access('projects', 'projects.tasks.read')
  @Get('tasks/mine')
  async mine(@AssocContext() c: AssocCtx) {
    const rows = await this.db
      .select({ ...this.taskSelect(), projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .leftJoin(associationUsers, eq(associationUsers.id, tasks.assigneeId))
      .leftJoin(users, eq(users.id, associationUsers.userId))
      .where(and(eq(tasks.assigneeId, c.membershipId), ne(tasks.status, 'done'), isNull(projects.archivedAt), eq(projects.isTemplate, false)))
      .orderBy(sql`${tasks.dueDate} asc nulls last`, desc(tasks.priority));
    return rows.map((r) => ({ ...this.shape(r), projectName: r.projectName }));
  }

  @Access('projects', 'projects.tasks.read')
  @Get('tasks/:id')
  async getTask(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const t = await this.task(c.association.id, id);
    const [row] = await this.db.select(this.taskSelect()).from(tasks).leftJoin(associationUsers, eq(associationUsers.id, tasks.assigneeId)).leftJoin(users, eq(users.id, associationUsers.userId)).where(eq(tasks.id, id));
    const subtasks = await this.db.select().from(tasks).where(eq(tasks.parentId, id)).orderBy(asc(tasks.position));
    const comments = await this.db
      .select({ id: taskComments.id, body: taskComments.body, createdAt: taskComments.createdAt, author: users.displayName, authorId: taskComments.authorId })
      .from(taskComments)
      .leftJoin(users, eq(users.id, taskComments.authorId))
      .where(eq(taskComments.taskId, id))
      .orderBy(asc(taskComments.createdAt));
    const [project] = await this.db.select({ name: projects.name, isTemplate: projects.isTemplate, archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, t.projectId));
    return { ...this.shape(row), subtasks, comments, project, mine: t.assigneeId === c.membershipId };
  }

  @Access('projects', 'projects.tasks.create')
  @Post('projects/:id/tasks')
  async createTask(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.project(c.association.id, id, true);
    const input = parse(zTask, body);
    await this.checkAssignee(c.association.id, input.assigneeId);
    await this.checkParent(p.id, input.parentId);
    const [{ max }] = await this.db.select({ max: sql<number>`coalesce(max(${tasks.position}), 0)::int` }).from(tasks).where(eq(tasks.projectId, id));
    const [t] = await this.db
      .insert(tasks)
      .values({ ...input, associationId: c.association.id, projectId: id, position: max + 1000, completedAt: input.status === 'done' ? new Date() : null, createdBy: c.user.id })
      .returning();
    await this.audit.log({ ...log(c), action: 'task.create', resourceType: 'task', resourceId: t.id, summary: `Tâche « ${t.title} » créée dans « ${p.name} »` });
    return t;
  }

  @Access('projects', 'projects.tasks.read', { write: true })
  @Patch('tasks/:id')
  async updateTask(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.task(c.association.id, id);
    await this.project(c.association.id, before.projectId, true);
    const input = parse(patchOf(zTask), body);
    if (!this.canFullyEdit(c)) {
      // Responsable de la tâche : uniquement l'état et la checklist.
      const allowed = new Set(['status', 'checklist']);
      if (before.assigneeId !== c.membershipId) throw Forbidden('PERMISSION_DENIED', 'Vous ne pouvez modifier que les tâches qui vous sont attribuées.');
      const extra = Object.keys(input).filter((k) => !allowed.has(k));
      if (extra.length) throw Forbidden('PERMISSION_DENIED', 'Vous pouvez seulement changer l’état et la checklist de vos tâches.', { fields: extra });
    }
    if (input.assigneeId !== undefined) await this.checkAssignee(c.association.id, input.assigneeId);
    if (input.parentId !== undefined) await this.checkParent(before.projectId, input.parentId, id);
    const patch: Partial<TaskRow> = { ...input, updatedAt: new Date() } as Partial<TaskRow>;
    if (input.status && input.status !== before.status) patch.completedAt = input.status === 'done' ? new Date() : null;
    const [t] = await this.db.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
    await this.audit.log({ ...log(c), action: 'task.update', resourceType: 'task', resourceId: id, summary: `Tâche « ${t.title} » modifiée${input.status && input.status !== before.status ? ` (état : ${input.status})` : ''}`, data: { fields: Object.keys(input) } });
    return t;
  }

  /** Réorganisation d'une colonne du Kanban : état + ordre des tâches. */
  @Access('projects', 'projects.tasks.update')
  @Post('projects/:id/board')
  @HttpCode(200)
  async board(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.project(c.association.id, id, true);
    const input = parse(z.object({ status: z.enum(STATUSES), orderedIds: z.array(zUuid).max(1000) }), body);
    if (input.orderedIds.length === 0) return { ok: true };
    await this.db.transaction(async (tx) => {
      const found = await tx.select().from(tasks).where(and(eq(tasks.projectId, id), inArray(tasks.id, input.orderedIds)));
      if (found.length !== new Set(input.orderedIds).size) throw NotFound('Tâche introuvable dans ce projet.');
      const byId = new Map(found.map((t) => [t.id, t]));
      for (const [i, tid] of input.orderedIds.entries()) {
        const t = byId.get(tid)!;
        const statusChanged = t.status !== input.status;
        await tx
          .update(tasks)
          .set({ status: input.status, position: (i + 1) * 1000, updatedAt: new Date(), ...(statusChanged ? { completedAt: input.status === 'done' ? new Date() : null } : {}) })
          .where(eq(tasks.id, tid));
        if (statusChanged) await this.audit.log({ ...log(c), action: 'task.move', resourceType: 'task', resourceId: tid, summary: `Tâche « ${t.title} » déplacée vers « ${input.status} »` }, tx);
      }
    });
    return { ok: true };
  }

  @Access('projects', 'projects.tasks.delete')
  @Delete('tasks/:id')
  async deleteTask(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const t = await this.task(c.association.id, id);
    await this.project(c.association.id, t.projectId, true);
    await this.db.transaction(async (tx) => {
      const ids = (await tx.execute<{ id: string }>(sql`with recursive t(id) as (select ${id}::uuid union all select x.id from tasks x join t on x.parent_id = t.id) select id from t`)).rows.map((r) => r.id);
      await tx.delete(driveLinks).where(and(eq(driveLinks.module, 'projects'), eq(driveLinks.entityType, 'task'), inArray(driveLinks.entityId, ids)));
      await tx.delete(tasks).where(eq(tasks.id, id));
      await this.audit.log({ ...log(c), action: 'task.delete', resourceType: 'task', resourceId: id, summary: `Suppression de la tâche « ${t.title} » (et de ses sous-tâches)` }, tx);
    });
    return { ok: true };
  }

  /** Suppression définitive : tâches, sous-tâches et commentaires ; les pièces jointes restent dans Drive. */
  @Access('projects', 'projects.projects.delete')
  @Delete('projects/:id')
  async deleteProject(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const p = await this.project(c.association.id, id);
    const n = await this.db.transaction(async (tx) => {
      const ids = (await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, id))).map((r) => r.id);
      if (ids.length) await tx.delete(driveLinks).where(and(eq(driveLinks.module, 'projects'), eq(driveLinks.entityType, 'task'), inArray(driveLinks.entityId, ids)));
      await tx.delete(projects).where(eq(projects.id, id));
      await this.audit.log({ ...log(c), action: 'project.delete', resourceType: 'project', resourceId: id, summary: `Suppression ${p.isTemplate ? 'du modèle' : 'du projet'} « ${p.name} » (${ids.length} tâche(s))` }, tx);
      return ids.length;
    });
    return { ok: true, tasks: n };
  }

  /** L'auteur peut supprimer son commentaire ; un gestionnaire des tâches, n'importe lequel. */
  @Access('projects', 'projects.tasks.read', { write: true })
  @Delete('tasks/:id/comments/:commentId')
  async deleteComment(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('commentId') commentId: string) {
    parse(zUuid, commentId);
    const t = await this.task(c.association.id, id);
    const [k] = await this.db.select().from(taskComments).where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, id)));
    if (!k) throw NotFound('Commentaire introuvable.');
    if (k.authorId !== c.user.id && !this.canFullyEdit(c)) throw Forbidden('PERMISSION_DENIED', 'Vous ne pouvez supprimer que vos propres commentaires.');
    await this.db.delete(taskComments).where(eq(taskComments.id, commentId));
    await this.audit.log({ ...log(c), action: 'task.comment.delete', resourceType: 'task', resourceId: id, summary: `Suppression d’un commentaire sur « ${t.title} »` });
    return { ok: true };
  }

  @Access('projects', 'projects.tasks.read', { write: true })
  @Post('tasks/:id/comments')
  async comment(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const t = await this.task(c.association.id, id);
    await this.project(c.association.id, t.projectId, true);
    if (!this.canFullyEdit(c) && t.assigneeId !== c.membershipId) throw Forbidden('PERMISSION_DENIED', 'Vous ne pouvez commenter que les tâches qui vous sont attribuées.');
    const { body: text } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), body);
    const [k] = await this.db.insert(taskComments).values({ taskId: id, authorId: c.user.id, body: text }).returning();
    await this.audit.log({ ...log(c), action: 'task.comment', resourceType: 'task', resourceId: id, summary: `Commentaire sur « ${t.title} »` });
    return { ...k, author: c.user.displayName };
  }
}
