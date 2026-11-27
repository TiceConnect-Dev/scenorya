import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, OnModuleDestroy, OnModuleInit, Param, Patch, Post, Put, Query, Res, UploadedFile, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { grantsCover, isFeatureEnabled } from '@scenorya/shared';

import { Access, AssocContext, AssocCtx, Ctx, RequestContext, SuperAdminOnly } from '../common/access';
import { parse, zOptText, zUuid } from '../common/validation';
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../common/errors';
import { randomToken, sha256 } from '../common/crypto';
import { DB, Db, DbOrTx } from '../db/db';
import {
  associations, driveAccessLog, driveBlobs, driveFavorites, driveFileVersions, driveFiles, driveFolders, driveLinks, driveSettings, driveShares,
  roleAssignments, roles, shows, tasks, users,
} from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';
import { loadConfig } from '../config';
import { blobExists, blobPath, blockedReason, canPreview, cleanName, driveDirs, fileHeaders, hashFile, mimeOf, numbered, removeBlob, storeBlob } from './storage';

type Folder = typeof driveFolders.$inferSelect;
type FileRow = typeof driveFiles.$inferSelect;
interface Scope { admin: boolean; roleIds: Set<string>; folders: Map<string, Folder> }

const TRASH_DAYS = 30;
const MB = 1024 * 1024;
const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zName = z.string().trim().min(1).max(200).refine((s) => !/[/\\\u0000-\u001f]/.test(s), 'Le nom ne peut pas contenir « / » ni « \\ ».');
const zTags = z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20);

const uploadOptions = () => ({
  storage: diskStorage({
    destination: (_req, _f, cb) => {
      const d = driveDirs().tmp;
      mkdir(d, { recursive: true }).then(() => cb(null, d), (e: Error) => cb(e, d));
    },
    filename: (_req, _f, cb) => cb(null, `up-${randomUUID()}`),
  }),
  limits: { fileSize: loadConfig().DRIVE_MAX_UPLOAD_MB * MB, files: 20, fields: 20 },
});

/** Éléments d'autres modules auxquels un fichier peut être rattaché. */
const LINK_TARGETS: Record<string, { feature: string; exists: (db: Db, associationId: string, id: string) => Promise<boolean> }> = {
  'show:show': {
    feature: 'show.attachments',
    exists: async (db, associationId, id) => (await db.select({ id: shows.id }).from(shows).where(and(eq(shows.id, id), eq(shows.associationId, associationId)))).length > 0,
  },
  'projects:task': {
    feature: 'projects.attachments',
    exists: async (db, associationId, id) => (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, id), eq(tasks.associationId, associationId)))).length > 0,
  },
};

const RECOMMENDED: { name: string; restrictedTo?: string[] }[] = [
  { name: 'Administratif', restrictedTo: ['admin', 'president', 'vice_president', 'secretaire', 'tresorier'] },
  { name: 'Assemblées générales' },
  { name: 'Comptabilité', restrictedTo: ['admin', 'president', 'tresorier'] },
  { name: 'Communication' },
  { name: 'Spectacles' },
  { name: 'Technique' },
  { name: 'Photos et vidéos' },
  { name: 'Pièces jointes' },
];
const ATTACHMENTS_FOLDER = 'Pièces jointes';

@ApiTags('Scenorya Drive')
@Controller()
export class DriveController implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'drive',
      check: async (db, associationId) => {
        const out: ModuleImpact[] = [];
        const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(driveShares)
          .where(and(eq(driveShares.associationId, associationId), isNull(driveShares.revokedAt), gt(driveShares.expiresAt, new Date())));
        if (s.n > 0) out.push({ module: 'drive', level: 'warning', message: `${s.n} lien(s) de partage public cesseront de fonctionner jusqu’à la réactivation.` });
        const [f] = await db.select({ n: sql<number>`count(*)::int` }).from(driveFiles).where(and(eq(driveFiles.associationId, associationId), isNull(driveFiles.deletedAt)));
        if (f.n > 0) out.push({ module: 'drive', level: 'info', message: `${f.n} document(s) sont conservés et redeviendront accessibles à la réactivation.` });
        return out;
      },
    });
    if (loadConfig().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.purgeExpired().catch(() => undefined), 3_600_000);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ============================================================ Accès */

  private async scope(c: AssocCtx): Promise<Scope> {
    const folders = await this.db.select().from(driveFolders).where(eq(driveFolders.associationId, c.association.id));
    const ra = await this.db.select({ roleId: roleAssignments.roleId }).from(roleAssignments)
      .where(and(eq(roleAssignments.associationUserId, c.membershipId), or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, new Date()))));
    return { admin: grantsCover(c.grants, 'drive.files.admin'), roleIds: new Set(ra.map((r) => r.roleId)), folders: new Map(folders.map((f) => [f.id, f])) };
  }

  /** Dossiers restreints au-dessus de (et y compris) `folderId`. */
  private restrictedChain(s: Scope, folderId: string | null): Folder[] {
    const out: Folder[] = [];
    let cur = folderId ? s.folders.get(folderId) : undefined;
    for (let guard = 0; cur && guard < 200; guard++) {
      if (cur.restricted) out.push(cur);
      cur = cur.parentId ? s.folders.get(cur.parentId) : undefined;
    }
    return out;
  }

  private canSee(s: Scope, folderId: string | null) {
    if (s.admin) return true;
    return this.restrictedChain(s, folderId).every((f) => f.allowedRoleIds.some((r) => s.roleIds.has(r)));
  }

  /** Déplacer hors d'une zone restreinte l'exposerait : réservé aux administrateurs de Drive. */
  private assertMoveAllowed(s: Scope, from: string | null, to: string | null) {
    if (s.admin) return;
    const dest = new Set(this.restrictedChain(s, to).map((f) => f.id));
    if (this.restrictedChain(s, from).some((f) => !dest.has(f.id))) {
      throw Forbidden('DRIVE_RESTRICTED_MOVE', 'Sortir un document d’un dossier restreint est réservé aux administrateurs de Drive.');
    }
  }

  private folderOf(s: Scope, id: string | null, opts: { allowDeleted?: boolean } = {}) {
    if (!id) return null;
    parse(zUuid, id);
    const f = s.folders.get(id);
    if (!f || (!opts.allowDeleted && f.deletedAt) || !this.canSee(s, id)) throw NotFound('Dossier introuvable.');
    return f;
  }

  private async fileOf(c: AssocCtx, s: Scope, id: string, opts: { allowDeleted?: boolean } = {}) {
    parse(zUuid, id);
    const [f] = await this.db.select().from(driveFiles).where(and(eq(driveFiles.id, id), eq(driveFiles.associationId, c.association.id)));
    if (!f || (!opts.allowDeleted && f.deletedAt) || !this.canSee(s, f.folderId)) throw NotFound('Document introuvable.');
    return f;
  }

  private breadcrumb(s: Scope, id: string | null) {
    const out: { id: string; name: string; restricted: boolean }[] = [];
    let cur = id ? s.folders.get(id) : undefined;
    for (let guard = 0; cur && guard < 200; guard++) {
      out.unshift({ id: cur.id, name: cur.name, restricted: cur.restricted });
      cur = cur.parentId ? s.folders.get(cur.parentId) : undefined;
    }
    return out;
  }

  private descendants(s: Scope, id: string) {
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of s.folders.values()) {
        if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
          out.add(f.id);
          grew = true;
        }
      }
    }
    return out;
  }

  /* ============================================================ Quota */

  private async quotaBytes(db: DbOrTx, associationId: string) {
    const [row] = await db.select().from(driveSettings).where(eq(driveSettings.associationId, associationId));
    return row?.quotaBytes ?? loadConfig().DRIVE_DEFAULT_QUOTA_MB * MB;
  }

  private async usedBytes(db: DbOrTx, associationId: string) {
    const [r] = await db.select({ n: sql<string>`coalesce(sum(${driveFileVersions.size}), 0)` }).from(driveFileVersions)
      .innerJoin(driveFiles, eq(driveFiles.id, driveFileVersions.fileId)).where(eq(driveFiles.associationId, associationId));
    return Number(r.n);
  }

  /* ============================================================ Lecture */

  @Access('drive', 'drive.files.read')
  @Get('drive/overview')
  async overview(@AssocContext() c: AssocCtx) {
    const s = await this.scope(c);
    const [used, quota] = await Promise.all([this.usedBytes(this.db, c.association.id), this.quotaBytes(this.db, c.association.id)]);
    const roleList = s.admin ? await this.db.select({ id: roles.id, name: roles.name, key: roles.key }).from(roles).where(eq(roles.associationId, c.association.id)).orderBy(asc(roles.name)) : [];
    return {
      used, quota, maxUploadBytes: loadConfig().DRIVE_MAX_UPLOAD_MB * MB, trashDays: TRASH_DAYS, roles: roleList,
      can: {
        admin: s.admin, create: grantsCover(c.grants, 'drive.files.create'), update: grantsCover(c.grants, 'drive.files.update'),
        delete: grantsCover(c.grants, 'drive.files.delete'), publish: grantsCover(c.grants, 'drive.files.publish'),
      },
      hasFolders: [...s.folders.values()].some((f) => !f.deletedAt),
    };
  }

  private async decorate(c: AssocCtx, rows: FileRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const favs = new Set((await this.db.select({ id: driveFavorites.fileId }).from(driveFavorites).where(and(eq(driveFavorites.userId, c.user.id), inArray(driveFavorites.fileId, ids)))).map((r) => r.id));
    const shared = new Set((await this.db.select({ id: driveShares.fileId }).from(driveShares)
      .where(and(inArray(driveShares.fileId, ids), isNull(driveShares.revokedAt), gt(driveShares.expiresAt, new Date())))).map((r) => r.id));
    const userIds = [...new Set(rows.map((r) => r.updatedBy ?? r.createdBy).filter((x): x is string => !!x))];
    const names = new Map(userIds.length ? (await this.db.select({ id: users.id, n: users.displayName }).from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u.n]) : []);
    return rows.map((r) => ({
      id: r.id, name: r.name, folderId: r.folderId, mime: r.mime, size: r.size, version: r.version, tags: r.tags, description: r.description,
      updatedAt: r.updatedAt, updatedBy: names.get(r.updatedBy ?? r.createdBy ?? '') ?? null, deletedAt: r.deletedAt,
      favorite: favs.has(r.id), shared: shared.has(r.id), preview: canPreview(r.mime),
    }));
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/browse')
  async browse(@AssocContext() c: AssocCtx, @Query('folderId') folderId?: string) {
    const s = await this.scope(c);
    const folder = this.folderOf(s, folderId || null);
    const fid = folder?.id ?? null;
    const subfolders = [...s.folders.values()]
      .filter((f) => !f.deletedAt && (f.parentId ?? null) === fid && this.canSee(s, f.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      .map((f) => ({ id: f.id, name: f.name, restricted: f.restricted, espace: f.espace, allowedRoleIds: s.admin ? f.allowedRoleIds : undefined, updatedAt: f.updatedAt }));
    const files = await this.db.select().from(driveFiles)
      .where(and(eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt), fid ? eq(driveFiles.folderId, fid) : isNull(driveFiles.folderId)))
      .orderBy(sql`lower(${driveFiles.name})`);
    return {
      folder: folder ? { id: folder.id, name: folder.name, parentId: folder.parentId, restricted: folder.restricted, allowedRoleIds: s.admin ? folder.allowedRoleIds : undefined } : null,
      breadcrumb: this.breadcrumb(s, fid), folders: subfolders, files: await this.decorate(c, files),
    };
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/tree')
  async tree(@AssocContext() c: AssocCtx) {
    const s = await this.scope(c);
    return [...s.folders.values()].filter((f) => !f.deletedAt && this.canSee(s, f.id))
      .map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, restricted: f.restricted, path: this.breadcrumb(s, f.id).map((b) => b.name).join(' / ') }))
      .sort((a, b) => a.path.localeCompare(b.path, 'fr'));
  }

  private visibleFiles(s: Scope, rows: FileRow[]) {
    return rows.filter((r) => this.canSee(s, r.folderId) && !(r.folderId && s.folders.get(r.folderId)?.deletedAt));
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/search')
  async search(@AssocContext() c: AssocCtx, @Query('q') q = '', @Query('tag') tag = '') {
    const s = await this.scope(c);
    const term = q.trim().slice(0, 100);
    const t = tag.trim().toLowerCase().slice(0, 40);
    if (!term && !t) return [];
    const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await this.db.select().from(driveFiles).where(and(
      eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt),
      term ? or(ilike(driveFiles.name, like), ilike(driveFiles.description, like), sql`exists (select 1 from unnest(${driveFiles.tags}) x where x ilike ${like})`) : undefined,
      t ? sql`${t} = any(${driveFiles.tags})` : undefined,
    )).orderBy(desc(driveFiles.updatedAt)).limit(200);
    const files = await this.decorate(c, this.visibleFiles(s, rows));
    return files.map((f) => ({ ...f, path: this.breadcrumb(s, f.folderId).map((b) => b.name).join(' / ') }));
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/recent')
  async recent(@AssocContext() c: AssocCtx) {
    const s = await this.scope(c);
    const rows = await this.db.select().from(driveFiles).where(and(eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt))).orderBy(desc(driveFiles.updatedAt)).limit(60);
    const files = await this.decorate(c, this.visibleFiles(s, rows).slice(0, 20));
    return files.map((f) => ({ ...f, path: this.breadcrumb(s, f.folderId).map((b) => b.name).join(' / ') }));
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/favorites')
  async favorites(@AssocContext() c: AssocCtx) {
    const s = await this.scope(c);
    const rows = await this.db.select({ f: driveFiles }).from(driveFavorites).innerJoin(driveFiles, eq(driveFiles.id, driveFavorites.fileId))
      .where(and(eq(driveFavorites.userId, c.user.id), eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt))).orderBy(sql`lower(${driveFiles.name})`);
    const files = await this.decorate(c, this.visibleFiles(s, rows.map((r) => r.f)));
    return files.map((f) => ({ ...f, path: this.breadcrumb(s, f.folderId).map((b) => b.name).join(' / ') }));
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/tags')
  async tags(@AssocContext() c: AssocCtx) {
    const rows = await this.db.execute<{ tag: string; n: number }>(sql`select t as tag, count(*)::int as n from ${driveFiles}, unnest(${driveFiles.tags}) t where ${driveFiles.associationId} = ${c.association.id} and ${driveFiles.deletedAt} is null group by t order by t`);
    return rows.rows;
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/files/:id')
  async detail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, id);
    const [decorated] = await this.decorate(c, [f]);
    const versions = await this.db.select({ v: driveFileVersions, by: users.displayName }).from(driveFileVersions).leftJoin(users, eq(users.id, driveFileVersions.createdBy))
      .where(eq(driveFileVersions.fileId, f.id)).orderBy(desc(driveFileVersions.version));
    const shares = grantsCover(c.grants, 'drive.files.publish')
      ? await this.db.select({ id: driveShares.id, expiresAt: driveShares.expiresAt, hasPassword: sql<boolean>`${driveShares.passwordHash} is not null`, maxDownloads: driveShares.maxDownloads, downloadCount: driveShares.downloadCount, createdAt: driveShares.createdAt, by: users.displayName })
        .from(driveShares).leftJoin(users, eq(users.id, driveShares.createdBy))
        .where(and(eq(driveShares.fileId, f.id), isNull(driveShares.revokedAt), gt(driveShares.expiresAt, new Date()))).orderBy(desc(driveShares.createdAt))
      : [];
    const links = await this.db.select().from(driveLinks).where(eq(driveLinks.fileId, f.id));
    return {
      ...decorated, path: this.breadcrumb(s, f.folderId), restricted: this.restrictedChain(s, f.folderId).length > 0,
      versions: versions.map((r) => ({ version: r.v.version, size: r.v.size, mime: r.v.mime, originalName: r.v.originalName, comment: r.v.comment, createdAt: r.v.createdAt, by: r.by })),
      shares, links: links.map((l) => ({ module: l.module, entityType: l.entityType, entityId: l.entityId })),
    };
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/files/:id/content')
  async content(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response, @Query('version') v?: string, @Query('inline') inline?: string) {
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, id);
    let sha = f.sha256, size = f.size, mime = f.mime, version = f.version;
    if (v) {
      const n = parse(z.coerce.number().int().positive(), v);
      const [row] = await this.db.select().from(driveFileVersions).where(and(eq(driveFileVersions.fileId, f.id), eq(driveFileVersions.version, n)));
      if (!row) throw NotFound('Version introuvable.');
      ({ sha256: sha, size, mime, version } = row);
    }
    if (!(await blobExists(sha))) throw new AppError(HttpStatus.GONE, 'DRIVE_BLOB_MISSING', 'Le contenu de ce document est introuvable sur le serveur. Restaurez une sauvegarde du volume de données.');
    const asInline = inline === '1';
    await this.db.insert(driveAccessLog).values({ associationId: c.association.id, fileId: f.id, fileName: f.name, userId: c.user.id, action: asInline ? 'preview' : 'download', version, ip: c.ip });
    const name = v && Number(v) !== f.version ? `${f.name.replace(/(\.[^.]+)?$/, ` (v${version})$1`)}` : f.name;
    res.set(fileHeaders(name, mime, size, asInline));
    createReadStream(blobPath(sha)).on('error', () => res.destroy()).pipe(res);
  }

  /* ============================================================ Dossiers */

  @Access('drive', 'drive.files.create')
  @Post('drive/folders')
  async createFolder(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ name: zName, parentId: zUuid.nullable().optional() }), body);
    const s = await this.scope(c);
    const parent = this.folderOf(s, input.parentId ?? null);
    const [f] = await this.db.insert(driveFolders).values({ associationId: c.association.id, parentId: parent?.id ?? null, name: input.name, createdBy: c.user.id })
      .returning().catch((e) => this.nameConflict(e));
    await this.audit.log({ ...log(c), action: 'drive.folder.create', resourceType: 'drive_folder', resourceId: f.id, summary: `Création du dossier « ${this.breadcrumb({ ...s, folders: new Map([...s.folders, [f.id, f]]) }, f.id).map((b) => b.name).join(' / ')} »` });
    return f;
  }

  private nameConflict(e: unknown): never {
    if ((e as { code?: string }).code === '23505') throw Conflict('DRIVE_NAME_TAKEN', 'Un élément porte déjà ce nom à cet endroit.');
    throw e;
  }

  @Access('drive', 'drive.files.update')
  @Patch('drive/folders/:id')
  async updateFolder(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ name: zName.optional(), parentId: zUuid.nullable().optional() }), body);
    const s = await this.scope(c);
    const f = this.folderOf(s, id)!;
    const patch: Partial<Folder> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.parentId !== undefined && input.parentId !== f.parentId) {
      const target = this.folderOf(s, input.parentId);
      if (target && this.descendants(s, f.id).has(target.id)) throw BadRequest('DRIVE_CYCLE', 'Un dossier ne peut pas être déplacé dans lui-même ou dans l’un de ses sous-dossiers.');
      this.assertMoveAllowed(s, f.parentId, target?.id ?? null);
      if (f.restricted && !s.admin) throw Forbidden('DRIVE_RESTRICTED_MOVE', 'Déplacer un dossier restreint est réservé aux administrateurs de Drive.');
      patch.parentId = target?.id ?? null;
    }
    const [u] = await this.db.update(driveFolders).set(patch).where(eq(driveFolders.id, f.id)).returning().catch((e) => this.nameConflict(e));
    await this.audit.log({ ...log(c), action: 'drive.folder.update', resourceType: 'drive_folder', resourceId: f.id, summary: `Modification du dossier « ${f.name} »${patch.name && patch.name !== f.name ? ` (renommé « ${patch.name} »)` : ''}${patch.parentId !== undefined ? ' (déplacé)' : ''}` });
    return u;
  }

  @Access('drive', 'drive.files.admin')
  @Put('drive/folders/:id/access')
  async folderAccess(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ restricted: z.boolean(), allowedRoleIds: z.array(zUuid).max(50).default([]), espace: z.boolean().optional() }), body);
    const s = await this.scope(c);
    const f = this.folderOf(s, id)!;
    if (input.allowedRoleIds.length) {
      const known = await this.db.select({ id: roles.id }).from(roles).where(and(eq(roles.associationId, c.association.id), inArray(roles.id, input.allowedRoleIds)));
      if (known.length !== new Set(input.allowedRoleIds).size) throw BadRequest('UNKNOWN_ROLE', 'Rôle inconnu.');
    }
    const allowed = input.restricted ? [...new Set(input.allowedRoleIds)] : [];
    await this.db.update(driveFolders).set({ restricted: input.restricted, allowedRoleIds: allowed, ...(input.espace !== undefined ? { espace: input.espace } : {}), updatedAt: new Date() }).where(eq(driveFolders.id, f.id));
    const names = allowed.length ? (await this.db.select({ n: roles.name }).from(roles).where(inArray(roles.id, allowed))).map((r) => r.n) : [];
    await this.audit.log({
      ...log(c), action: 'drive.folder.access', resourceType: 'drive_folder', resourceId: f.id,
      summary: `${input.restricted ? `Dossier « ${f.name} » restreint à : ${names.join(', ') || 'administrateurs de Drive uniquement'}` : `Dossier « ${f.name} » ouvert à tous les utilisateurs de Drive`}${input.espace !== undefined && input.espace !== f.espace ? (input.espace ? ' ; publié dans l’Espace des membres' : ' ; retiré de l’Espace des membres') : ''}`,
      data: { before: { restricted: f.restricted, allowedRoleIds: f.allowedRoleIds }, after: { restricted: input.restricted, allowedRoleIds: allowed } },
    });
    return { ok: true };
  }

  @Access('drive', 'drive.files.delete')
  @Delete('drive/folders/:id')
  async deleteFolder(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.scope(c);
    const f = this.folderOf(s, id)!;
    const ids = [...this.descendants(s, f.id)].filter((x) => !s.folders.get(x)!.deletedAt);
    // Un dossier contenant des éléments restreints invisibles pour l'utilisateur ne peut pas être supprimé par lui.
    if (ids.some((x) => !this.canSee(s, x))) throw Forbidden('DRIVE_RESTRICTED_CONTENT', 'Ce dossier contient des dossiers restreints : seul un administrateur de Drive peut le supprimer.');
    const batch = randomUUID();
    const now = new Date();
    let n = 0;
    await this.db.transaction(async (tx) => {
      await tx.update(driveFolders).set({ deletedAt: now, trashBatch: batch }).where(and(inArray(driveFolders.id, ids), isNull(driveFolders.deletedAt)));
      const r = await tx.update(driveFiles).set({ deletedAt: now, trashBatch: batch, deletedBy: c.user.id }).where(and(inArray(driveFiles.folderId, ids), isNull(driveFiles.deletedAt))).returning({ id: driveFiles.id });
      n = r.length;
      await tx.update(driveShares).set({ revokedAt: now }).where(and(inArray(driveShares.fileId, r.length ? r.map((x) => x.id) : [randomUUID()]), isNull(driveShares.revokedAt)));
      await this.audit.log({ ...log(c), action: 'drive.folder.trash', resourceType: 'drive_folder', resourceId: f.id, summary: `Dossier « ${f.name} » placé dans la corbeille (${ids.length - 1} sous-dossier(s), ${n} document(s))` }, tx);
    });
    return { ok: true, files: n };
  }

  @Access('drive', 'drive.files.admin')
  @Post('drive/recommended')
  async recommended(@AssocContext() c: AssocCtx) {
    const s = await this.scope(c);
    const existing = new Set([...s.folders.values()].filter((f) => !f.deletedAt && !f.parentId).map((f) => f.name.toLowerCase()));
    const roleRows = await this.db.select({ id: roles.id, key: roles.key }).from(roles).where(eq(roles.associationId, c.association.id));
    const created: string[] = [];
    for (const r of RECOMMENDED) {
      if (existing.has(r.name.toLowerCase())) continue;
      const allowed = r.restrictedTo ? roleRows.filter((x) => x.key && r.restrictedTo!.includes(x.key)).map((x) => x.id) : [];
      await this.db.insert(driveFolders).values({ associationId: c.association.id, name: r.name, restricted: !!r.restrictedTo, allowedRoleIds: allowed, createdBy: c.user.id });
      created.push(r.name);
    }
    if (created.length) await this.audit.log({ ...log(c), action: 'drive.folder.recommended', resourceType: 'drive_folder', summary: `Création des espaces recommandés : ${created.join(', ')}` });
    return { created };
  }

  /* ============================================================ Envoi */

  @Access('drive', 'drive.files.create')
  @Post('drive/files')
  @UseInterceptors(FilesInterceptor('files', 20, uploadOptions()))
  async upload(@AssocContext() c: AssocCtx, @UploadedFiles() uploaded: Express.Multer.File[] = [], @Body() body: Record<string, string>) {
    try {
      if (!uploaded.length) throw BadRequest('DRIVE_NO_FILE', 'Aucun fichier reçu.');
      const input = parse(z.object({
        folderId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
        conflict: z.enum(['rename', 'version', 'error']).default('rename'),
        linkModule: z.string().max(40).optional(), linkEntityType: z.string().max(40).optional(), linkEntityId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
      }), body ?? {});
      const s = await this.scope(c);
      let folderId = this.folderOf(s, input.folderId ?? null)?.id ?? null;
      let link: { module: string; entityType: string; entityId: string } | null = null;
      if (input.linkModule || input.linkEntityType || input.linkEntityId) {
        link = await this.checkLink(c, input.linkModule, input.linkEntityType, input.linkEntityId);
        if (!input.folderId) folderId = await this.attachmentsFolder(c, s);
      }
      if (input.conflict === 'version' && !grantsCover(c.grants, 'drive.files.update')) throw Forbidden('PERMISSION_DENIED', 'Remplacer un document existant nécessite le droit de modification.');

      const items: { tmp: string; name: string; sha256: string; size: number; head: Buffer; mime: string }[] = [];
      for (const up of uploaded) {
        const name = cleanName(Buffer.from(up.originalname, 'latin1').toString('utf8'));
        const h = await hashFile(up.path);
        const reason = blockedReason(name, h.head);
        if (reason) throw BadRequest('DRIVE_BLOCKED_TYPE', `« ${name} » : ${reason}`);
        items.push({ tmp: up.path, name, ...h, mime: mimeOf(name) });
      }
      items.sort((a, b) => a.sha256.localeCompare(b.sha256)); // ordre stable des verrous

      const results = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`drive-quota:${c.association.id}`}))`);
        const [used, quota] = [await this.usedBytes(tx, c.association.id), await this.quotaBytes(tx, c.association.id)];
        const incoming = items.reduce((n, i) => n + i.size, 0);
        if (used + incoming > quota) {
          throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'DRIVE_QUOTA_EXCEEDED', `Espace de stockage insuffisant : ${fmt(quota - used)} disponible(s) pour ${fmt(incoming)} à envoyer. Libérez de la place (corbeille, anciennes versions) ou demandez une augmentation du quota.`);
        }
        const out: { id: string; name: string; version: number; deduplicated: boolean }[] = [];
        for (const it of items) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`drive-blob:${it.sha256}`}))`);
          const known = (await tx.select({ s: driveBlobs.sha256 }).from(driveBlobs).where(eq(driveBlobs.sha256, it.sha256))).length > 0;
          await storeBlob(it.tmp, it.sha256);
          await tx.insert(driveBlobs).values({ sha256: it.sha256, size: it.size }).onConflictDoNothing();
          const [same] = await tx.select().from(driveFiles).where(and(
            eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt), folderId ? eq(driveFiles.folderId, folderId) : isNull(driveFiles.folderId),
            sql`lower(${driveFiles.name}) = lower(${it.name})`,
          ));
          let file: FileRow;
          if (same && input.conflict === 'version') {
            file = await this.addVersion(tx, c, same, it, null);
          } else {
            if (same && input.conflict === 'error') throw Conflict('DRIVE_NAME_TAKEN', `Un document nommé « ${it.name} » existe déjà dans ce dossier.`);
            let name = it.name;
            for (let n = 2; await this.nameTaken(tx, c.association.id, folderId, name); n++) name = numbered(it.name, n);
            [file] = await tx.insert(driveFiles).values({
              associationId: c.association.id, folderId, name, mime: it.mime, size: it.size, sha256: it.sha256, createdBy: c.user.id, updatedBy: c.user.id,
            }).returning();
            await tx.insert(driveFileVersions).values({ fileId: file.id, version: 1, sha256: it.sha256, size: it.size, mime: it.mime, originalName: it.name, createdBy: c.user.id });
          }
          if (link) await tx.insert(driveLinks).values({ fileId: file.id, ...link, createdBy: c.user.id }).onConflictDoNothing();
          out.push({ id: file.id, name: file.name, version: file.version, deduplicated: known });
        }
        await this.audit.log({
          ...log(c), action: 'drive.file.upload', resourceType: 'drive_file', resourceId: out.length === 1 ? out[0].id : null,
          summary: `Envoi de ${out.length} document(s) dans « ${this.breadcrumb(s, folderId).map((b) => b.name).join(' / ') || 'Racine'} » : ${out.map((o) => `${o.name}${o.version > 1 ? ` (v${o.version})` : ''}`).join(', ')}`,
          data: { files: out.map((o) => ({ id: o.id, version: o.version })), link },
        }, tx);
        return out;
      });
      return { files: results };
    } finally {
      await Promise.all(uploaded.map((u) => unlink(u.path).catch(() => undefined)));
    }
  }

  private async nameTaken(db: DbOrTx, associationId: string, folderId: string | null, name: string) {
    const r = await db.select({ id: driveFiles.id }).from(driveFiles).where(and(
      eq(driveFiles.associationId, associationId), isNull(driveFiles.deletedAt), folderId ? eq(driveFiles.folderId, folderId) : isNull(driveFiles.folderId), sql`lower(${driveFiles.name}) = lower(${name})`,
    ));
    return r.length > 0;
  }

  private async addVersion(tx: DbOrTx, c: AssocCtx, f: FileRow, it: { sha256: string; size: number; mime: string; name: string }, comment: string | null) {
    const version = f.version + 1;
    await tx.insert(driveFileVersions).values({ fileId: f.id, version, sha256: it.sha256, size: it.size, mime: it.mime, originalName: it.name, comment, createdBy: c.user.id });
    const [u] = await tx.update(driveFiles).set({ version, sha256: it.sha256, size: it.size, mime: mimeOf(f.name) === 'application/octet-stream' ? it.mime : mimeOf(f.name), updatedBy: c.user.id, updatedAt: new Date() })
      .where(eq(driveFiles.id, f.id)).returning();
    return u;
  }

  @Access('drive', 'drive.files.update')
  @Post('drive/files/:id/versions')
  @UseInterceptors(FileInterceptor('file', uploadOptions()))
  async newVersion(@AssocContext() c: AssocCtx, @Param('id') id: string, @UploadedFile() up: Express.Multer.File | undefined, @Body() body: Record<string, string>) {
    try {
      if (!up) throw BadRequest('DRIVE_NO_FILE', 'Aucun fichier reçu.');
      const comment = parse(z.object({ comment: zOptText(500) }), body ?? {}).comment ?? null;
      const s = await this.scope(c);
      const f = await this.fileOf(c, s, id);
      const name = cleanName(Buffer.from(up.originalname, 'latin1').toString('utf8'));
      const h = await hashFile(up.path);
      const reason = blockedReason(name, h.head) ?? blockedReason(f.name, h.head);
      if (reason) throw BadRequest('DRIVE_BLOCKED_TYPE', reason);
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`drive-quota:${c.association.id}`}))`);
        const used = await this.usedBytes(tx, c.association.id);
        const quota = await this.quotaBytes(tx, c.association.id);
        if (used + h.size > quota) throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'DRIVE_QUOTA_EXCEEDED', `Espace de stockage insuffisant : ${fmt(quota - used)} disponible(s).`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`drive-blob:${h.sha256}`}))`);
        await storeBlob(up.path, h.sha256);
        await tx.insert(driveBlobs).values({ sha256: h.sha256, size: h.size }).onConflictDoNothing();
        const [locked] = await tx.select().from(driveFiles).where(eq(driveFiles.id, f.id)).for('update');
        const u = await this.addVersion(tx, c, locked, { ...h, mime: mimeOf(name), name }, comment);
        await this.audit.log({ ...log(c), action: 'drive.file.version', resourceType: 'drive_file', resourceId: f.id, summary: `Nouvelle version (v${u.version}) de « ${f.name} »${comment ? ` : ${comment}` : ''}` }, tx);
        return { id: u.id, version: u.version };
      });
    } finally {
      if (up) await unlink(up.path).catch(() => undefined);
    }
  }

  @Access('drive', 'drive.files.update')
  @Post('drive/files/:id/versions/:version/restore')
  async restoreVersion(@AssocContext() c: AssocCtx, @Param('id') id: string, @Param('version') v: string) {
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, id);
    const n = parse(z.coerce.number().int().positive(), v);
    const [old] = await this.db.select().from(driveFileVersions).where(and(eq(driveFileVersions.fileId, f.id), eq(driveFileVersions.version, n)));
    if (!old) throw NotFound('Version introuvable.');
    if (n === f.version) throw BadRequest('DRIVE_SAME_VERSION', 'C’est déjà la version en cours.');
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(driveFiles).where(eq(driveFiles.id, f.id)).for('update');
      // Restaurer crée une nouvelle version au contenu identique (aucun octet de plus : contenu dédupliqué, mais compté dans le quota).
      const u = await this.addVersion(tx, c, locked, { sha256: old.sha256, size: old.size, mime: old.mime, name: old.originalName }, `Restauration de la version ${n}`);
      await this.audit.log({ ...log(c), action: 'drive.file.restore_version', resourceType: 'drive_file', resourceId: f.id, summary: `Restauration de la version ${n} de « ${f.name} » (devient v${u.version})` }, tx);
      return { version: u.version };
    });
  }

  @Access('drive', 'drive.files.update')
  @Patch('drive/files/:id')
  async updateFile(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ name: zName.optional(), folderId: zUuid.nullable().optional(), description: zOptText(2000), tags: zTags.optional() }), body);
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, id);
    const patch: Partial<FileRow> = { updatedAt: new Date(), updatedBy: c.user.id };
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      if (blockedReason(name, Buffer.alloc(0))) throw BadRequest('DRIVE_BLOCKED_TYPE', 'Cette extension n’est pas autorisée.');
      patch.name = name;
      patch.mime = mimeOf(name) === 'application/octet-stream' ? f.mime : mimeOf(name);
    }
    if (input.description !== undefined) patch.description = input.description;
    if (input.tags !== undefined) patch.tags = [...new Set(input.tags)];
    if (input.folderId !== undefined && input.folderId !== f.folderId) {
      const target = this.folderOf(s, input.folderId);
      this.assertMoveAllowed(s, f.folderId, target?.id ?? null);
      patch.folderId = target?.id ?? null;
    }
    const [u] = await this.db.update(driveFiles).set(patch).where(eq(driveFiles.id, f.id)).returning().catch((e) => this.nameConflict(e));
    const changes = [patch.name && patch.name !== f.name && `renommé « ${patch.name} »`, patch.folderId !== undefined && 'déplacé', input.tags && 'étiquettes', input.description !== undefined && 'description'].filter(Boolean);
    await this.audit.log({ ...log(c), action: 'drive.file.update', resourceType: 'drive_file', resourceId: f.id, summary: `Modification de « ${f.name} » (${changes.join(', ') || 'aucun changement'})` });
    return (await this.decorate(c, [u]))[0];
  }

  @Access('drive', 'drive.files.read')
  @Post('drive/files/:id/favorite')
  @HttpCode(200)
  async favorite(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { on } = parse(z.object({ on: z.boolean() }), body);
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, id);
    if (on) await this.db.insert(driveFavorites).values({ userId: c.user.id, fileId: f.id }).onConflictDoNothing();
    else await this.db.delete(driveFavorites).where(and(eq(driveFavorites.userId, c.user.id), eq(driveFavorites.fileId, f.id)));
    return { favorite: on };
  }

  @Access('drive', 'drive.files.delete')
  @Delete('drive/files/:id')
  async deleteFile(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, id);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(driveFiles).set({ deletedAt: now, trashBatch: randomUUID(), deletedBy: c.user.id }).where(eq(driveFiles.id, f.id));
      await tx.update(driveShares).set({ revokedAt: now }).where(and(eq(driveShares.fileId, f.id), isNull(driveShares.revokedAt)));
      await this.audit.log({ ...log(c), action: 'drive.file.trash', resourceType: 'drive_file', resourceId: f.id, summary: `« ${f.name} » placé dans la corbeille` }, tx);
    });
    return { ok: true };
  }

  /* ============================================================ Corbeille */

  @Access('drive', 'drive.files.read')
  @Get('drive/trash')
  async trash(@AssocContext() c: AssocCtx) {
    const s = await this.scope(c);
    const folders = [...s.folders.values()].filter((f) => f.deletedAt && this.canSee(s, f.id) && !(f.parentId && s.folders.get(f.parentId)?.trashBatch === f.trashBatch && s.folders.get(f.parentId)?.deletedAt));
    const files = (await this.db.select({ f: driveFiles, by: users.displayName }).from(driveFiles).leftJoin(users, eq(users.id, driveFiles.deletedBy))
      .where(and(eq(driveFiles.associationId, c.association.id), isNotNull(driveFiles.deletedAt))).orderBy(desc(driveFiles.deletedAt)))
      .filter(({ f }) => this.canSee(s, f.folderId) && !(f.folderId && s.folders.get(f.folderId)?.trashBatch === f.trashBatch));
    const expires = (d: Date) => new Date(d.getTime() + TRASH_DAYS * 86_400_000);
    const batchCount = new Map<string, number>();
    for (const r of await this.db.select({ b: driveFiles.trashBatch, n: sql<number>`count(*)::int` }).from(driveFiles).where(and(eq(driveFiles.associationId, c.association.id), isNotNull(driveFiles.deletedAt))).groupBy(driveFiles.trashBatch)) {
      if (r.b) batchCount.set(r.b, r.n);
    }
    return [
      ...folders.map((f) => ({ kind: 'folder' as const, id: f.id, name: f.name, deletedAt: f.deletedAt!, purgeAt: expires(f.deletedAt!), by: null, size: null, contains: batchCount.get(f.trashBatch ?? '') ?? 0, origin: this.breadcrumb(s, f.parentId).map((b) => b.name).join(' / ') })),
      ...files.map(({ f, by }) => ({ kind: 'file' as const, id: f.id, name: f.name, deletedAt: f.deletedAt!, purgeAt: expires(f.deletedAt!), by, size: f.size, contains: null, origin: this.breadcrumb(s, f.folderId).map((b) => b.name).join(' / ') })),
    ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
  }

  private async trashItem(c: AssocCtx, s: Scope, kind: string, id: string) {
    parse(zUuid, id);
    if (kind === 'folder') {
      const f = s.folders.get(id);
      if (!f || !f.deletedAt || !this.canSee(s, f.id)) throw NotFound('Élément introuvable dans la corbeille.');
      return { batch: f.trashBatch!, name: f.name, root: { kind: 'folder' as const, row: f } };
    }
    if (kind === 'file') {
      const f = await this.fileOf(c, s, id, { allowDeleted: true });
      if (!f.deletedAt) throw NotFound('Élément introuvable dans la corbeille.');
      return { batch: f.trashBatch!, name: f.name, root: { kind: 'file' as const, row: f } };
    }
    throw NotFound();
  }

  @Access('drive', 'drive.files.delete')
  @Post('drive/trash/:kind/:id/restore')
  @HttpCode(200)
  async restore(@AssocContext() c: AssocCtx, @Param('kind') kind: string, @Param('id') id: string) {
    const s = await this.scope(c);
    const item = await this.trashItem(c, s, kind, id);
    let restoredName = item.name;
    await this.db.transaction(async (tx) => {
      const root = item.root;
      const parentId = root.kind === 'folder' ? root.row.parentId : root.row.folderId;
      // Parent disparu entre-temps (supprimé séparément) : l'élément revient à la racine.
      const parentOk = !parentId || !s.folders.get(parentId)?.deletedAt;
      const target = parentOk ? parentId : null;
      if (root.kind === 'folder') {
        const siblings = new Set([...s.folders.values()].filter((f) => !f.deletedAt && (f.parentId ?? null) === (target ?? null)).map((f) => f.name.toLowerCase()));
        for (let n = 2; siblings.has(restoredName.toLowerCase()); n++) restoredName = `${item.name} (${n})`;
        // Renommer et replacer d'abord (encore en corbeille), puis restaurer le lot : pas de conflit de nom transitoire.
        await tx.update(driveFolders).set({ parentId: target, name: restoredName }).where(eq(driveFolders.id, root.row.id));
        await tx.update(driveFolders).set({ deletedAt: null, trashBatch: null }).where(and(eq(driveFolders.associationId, c.association.id), eq(driveFolders.trashBatch, item.batch)));
      } else {
        for (let n = 2; await this.nameTaken(tx, c.association.id, target, restoredName); n++) restoredName = numbered(item.name, n);
        await tx.update(driveFiles).set({ folderId: target, name: restoredName }).where(eq(driveFiles.id, root.row.id));
      }
      await tx.update(driveFiles).set({ deletedAt: null, trashBatch: null, deletedBy: null }).where(and(eq(driveFiles.associationId, c.association.id), eq(driveFiles.trashBatch, item.batch)));
      await this.audit.log({ ...log(c), action: 'drive.trash.restore', resourceType: root.kind === 'folder' ? 'drive_folder' : 'drive_file', resourceId: root.row.id, summary: `Restauration de « ${restoredName} » depuis la corbeille${parentOk ? '' : ' (à la racine : son dossier d’origine est supprimé)'}` }, tx);
    });
    return { ok: true, name: restoredName };
  }

  @Access('drive', 'drive.files.delete')
  @Delete('drive/trash/:kind/:id')
  async purge(@AssocContext() c: AssocCtx, @Param('kind') kind: string, @Param('id') id: string) {
    const s = await this.scope(c);
    const item = await this.trashItem(c, s, kind, id);
    const n = await this.purgeBatches(c.association.id, [item.batch]);
    await this.audit.log({ ...log(c), action: 'drive.trash.purge', resourceType: kind === 'folder' ? 'drive_folder' : 'drive_file', resourceId: id, summary: `Suppression définitive de « ${item.name} » (${n} document(s))` });
    return { ok: true, files: n };
  }

  @Access('drive', 'drive.files.admin')
  @Post('drive/trash/empty')
  @HttpCode(200)
  async emptyTrash(@AssocContext() c: AssocCtx) {
    const rows = await this.db.selectDistinct({ b: driveFiles.trashBatch }).from(driveFiles).where(and(eq(driveFiles.associationId, c.association.id), isNotNull(driveFiles.trashBatch)));
    const frows = await this.db.selectDistinct({ b: driveFolders.trashBatch }).from(driveFolders).where(and(eq(driveFolders.associationId, c.association.id), isNotNull(driveFolders.trashBatch)));
    const batches = [...new Set([...rows, ...frows].map((r) => r.b!))];
    const n = await this.purgeBatches(c.association.id, batches);
    await this.audit.log({ ...log(c), action: 'drive.trash.empty', resourceType: 'drive_file', summary: `Corbeille vidée (${n} document(s) supprimé(s) définitivement)` });
    return { files: n };
  }

  /** Suppression définitive de lots de corbeille, puis libération des contenus qui ne sont plus référencés. */
  private async purgeBatches(associationId: string, batches: string[]) {
    if (!batches.length) return 0;
    let shas: string[] = [];
    let count = 0;
    await this.db.transaction(async (tx) => {
      const files = await tx.select({ id: driveFiles.id }).from(driveFiles).where(and(eq(driveFiles.associationId, associationId), inArray(driveFiles.trashBatch, batches), isNotNull(driveFiles.deletedAt)));
      const ids = files.map((f) => f.id);
      if (ids.length) {
        shas = (await tx.selectDistinct({ s: driveFileVersions.sha256 }).from(driveFileVersions).where(inArray(driveFileVersions.fileId, ids))).map((r) => r.s);
        await tx.delete(driveFiles).where(inArray(driveFiles.id, ids));
      }
      count = ids.length;
      await tx.delete(driveFolders).where(and(eq(driveFolders.associationId, associationId), inArray(driveFolders.trashBatch, batches), isNotNull(driveFolders.deletedAt)));
    });
    await this.collect(shas);
    return count;
  }

  private collect(shas: string[]) {
    return collectBlobs(this.db, shas);
  }

  /** Vidage automatique des éléments en corbeille depuis plus de 30 jours. */
  async purgeExpired() {
    const limit = new Date(Date.now() - TRASH_DAYS * 86_400_000);
    const rows = await this.db.selectDistinct({ a: driveFiles.associationId, b: driveFiles.trashBatch }).from(driveFiles).where(and(isNotNull(driveFiles.deletedAt), lt(driveFiles.deletedAt, limit)));
    const frows = await this.db.selectDistinct({ a: driveFolders.associationId, b: driveFolders.trashBatch }).from(driveFolders).where(and(isNotNull(driveFolders.deletedAt), lt(driveFolders.deletedAt, limit)));
    const byAssoc = new Map<string, Set<string>>();
    for (const r of [...rows, ...frows]) if (r.b) byAssoc.set(r.a, (byAssoc.get(r.a) ?? new Set()).add(r.b));
    let total = 0;
    for (const [a, b] of byAssoc) total += await this.purgeBatches(a, [...b]);
    return total;
  }

  /* ============================================================ Partage */

  @Access('drive', 'drive.files.publish')
  @Post('drive/files/:id/shares')
  async share(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({
      expiresInDays: z.number().int().min(1).max(90).default(7),
      password: z.string().min(6, 'Mot de passe de 6 caractères minimum').max(128).optional().or(z.literal('').transform(() => undefined)),
      maxDownloads: z.number().int().min(1).max(10_000).nullable().optional(),
    }), body);
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, id);
    if (this.restrictedChain(s, f.folderId).length && !s.admin) {
      throw Forbidden('DRIVE_RESTRICTED_SHARE', 'Les documents d’un dossier restreint ne peuvent être partagés publiquement que par un administrateur de Drive.');
    }
    const token = randomToken(24);
    const { hash } = await import('@node-rs/argon2');
    const [row] = await this.db.insert(driveShares).values({
      associationId: c.association.id, fileId: f.id, tokenHash: sha256(token),
      passwordHash: input.password ? await hash(input.password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) : null,
      expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000), maxDownloads: input.maxDownloads ?? null, createdBy: c.user.id,
    }).returning();
    await this.audit.log({
      ...log(c), action: 'drive.share.create', resourceType: 'drive_file', resourceId: f.id,
      summary: `Lien de partage public pour « ${f.name} » (${input.expiresInDays} jour(s)${input.password ? ', protégé par mot de passe' : ''}${input.maxDownloads ? `, ${input.maxDownloads} téléchargement(s) au plus` : ''})`,
    });
    return { id: row.id, url: `${loadConfig().PUBLIC_URL.replace(/\/$/, '')}/partage/${token}`, expiresAt: row.expiresAt };
  }

  @Access('drive', 'drive.files.publish')
  @Get('drive/shares')
  async shares(@AssocContext() c: AssocCtx) {
    const s = await this.scope(c);
    const rows = await this.db.select({ sh: driveShares, f: driveFiles, by: users.displayName }).from(driveShares)
      .innerJoin(driveFiles, eq(driveFiles.id, driveShares.fileId)).leftJoin(users, eq(users.id, driveShares.createdBy))
      .where(and(eq(driveShares.associationId, c.association.id), isNull(driveShares.revokedAt), gt(driveShares.expiresAt, new Date()), isNull(driveFiles.deletedAt)))
      .orderBy(asc(driveShares.expiresAt));
    return rows.filter((r) => this.canSee(s, r.f.folderId)).map((r) => ({
      id: r.sh.id, fileId: r.f.id, fileName: r.f.name, expiresAt: r.sh.expiresAt, hasPassword: !!r.sh.passwordHash, maxDownloads: r.sh.maxDownloads, downloadCount: r.sh.downloadCount, createdAt: r.sh.createdAt, by: r.by,
    }));
  }

  @Access('drive', 'drive.files.publish')
  @Delete('drive/shares/:id')
  async revoke(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    parse(zUuid, id);
    const [row] = await this.db.select({ sh: driveShares, name: driveFiles.name }).from(driveShares).innerJoin(driveFiles, eq(driveFiles.id, driveShares.fileId))
      .where(and(eq(driveShares.id, id), eq(driveShares.associationId, c.association.id)));
    if (!row) throw NotFound('Lien introuvable.');
    await this.db.update(driveShares).set({ revokedAt: new Date() }).where(and(eq(driveShares.id, id), isNull(driveShares.revokedAt)));
    await this.audit.log({ ...log(c), action: 'drive.share.revoke', resourceType: 'drive_file', resourceId: row.sh.fileId, summary: `Révocation d’un lien de partage de « ${row.name} »` });
    return { ok: true };
  }

  /* ============================================================ Journal */

  @Access('drive', 'drive.files.admin')
  @Get('drive/access-log')
  async accessLog(@AssocContext() c: AssocCtx, @Query('page') page = '1', @Query('fileId') fileId?: string) {
    const p = Math.max(1, Number(page) || 1);
    const where = and(eq(driveAccessLog.associationId, c.association.id), fileId ? eq(driveAccessLog.fileId, parse(zUuid, fileId)) : undefined);
    const [t] = await this.db.select({ n: sql<number>`count(*)::int` }).from(driveAccessLog).where(where);
    const rows = await this.db.select({ l: driveAccessLog, user: users.displayName }).from(driveAccessLog).leftJoin(users, eq(users.id, driveAccessLog.userId))
      .where(where).orderBy(desc(driveAccessLog.id)).limit(50).offset((p - 1) * 50);
    return {
      total: t.n, page: p, pageSize: 50,
      items: rows.map((r) => ({ id: r.l.id, at: r.l.createdAt, action: r.l.action, fileId: r.l.fileId, fileName: r.l.fileName, version: r.l.version, user: r.user, viaShare: !!r.l.shareId, ip: r.l.ip })),
    };
  }

  /* ============================================================ Liens avec les autres modules */

  private async checkLink(c: AssocCtx, module?: string, entityType?: string, entityId?: string) {
    const target = LINK_TARGETS[`${module}:${entityType}`];
    if (!target || !entityId) throw BadRequest('DRIVE_LINK_TARGET', 'Élément de rattachement inconnu.');
    if (!isFeatureEnabled(c.modules, target.feature)) throw Forbidden('FEATURE_DISABLED', 'Les pièces jointes ne sont pas activées pour ce module.');
    if (!(await target.exists(this.db, c.association.id, entityId))) throw NotFound('Élément de rattachement introuvable.');
    return { module: module!, entityType: entityType!, entityId };
  }

  private async attachmentsFolder(c: AssocCtx, s: Scope) {
    const existing = [...s.folders.values()].find((f) => !f.deletedAt && !f.parentId && f.name.toLowerCase() === ATTACHMENTS_FOLDER.toLowerCase());
    if (existing) {
      if (!this.canSee(s, existing.id)) throw Forbidden('DRIVE_RESTRICTED', 'Le dossier « Pièces jointes » est restreint : vous ne pouvez pas y déposer de document.');
      return existing.id;
    }
    const [f] = await this.db.insert(driveFolders).values({ associationId: c.association.id, name: ATTACHMENTS_FOLDER, createdBy: c.user.id }).onConflictDoNothing().returning();
    if (f) return f.id;
    const [again] = await this.db.select().from(driveFolders).where(and(eq(driveFolders.associationId, c.association.id), isNull(driveFolders.parentId), isNull(driveFolders.deletedAt), sql`lower(${driveFolders.name}) = lower(${ATTACHMENTS_FOLDER})`));
    return again.id;
  }

  @Access('drive', 'drive.files.read')
  @Get('drive/links')
  async links(@AssocContext() c: AssocCtx, @Query('module') module: string, @Query('entityType') entityType: string, @Query('entityId') entityId: string) {
    parse(zUuid, entityId);
    const s = await this.scope(c);
    const rows = await this.db.select({ f: driveFiles }).from(driveLinks).innerJoin(driveFiles, eq(driveFiles.id, driveLinks.fileId))
      .where(and(eq(driveLinks.module, String(module)), eq(driveLinks.entityType, String(entityType)), eq(driveLinks.entityId, entityId), eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt)))
      .orderBy(sql`lower(${driveFiles.name})`);
    return this.decorate(c, this.visibleFiles(s, rows.map((r) => r.f)));
  }

  @Access('drive', 'drive.files.update')
  @Post('drive/links')
  async addLink(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ fileId: zUuid, module: z.string().max(40), entityType: z.string().max(40), entityId: zUuid }), body);
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, input.fileId);
    const link = await this.checkLink(c, input.module, input.entityType, input.entityId);
    await this.db.insert(driveLinks).values({ fileId: f.id, ...link, createdBy: c.user.id }).onConflictDoNothing();
    await this.audit.log({ ...log(c), action: 'drive.link.add', resourceType: 'drive_file', resourceId: f.id, summary: `« ${f.name} » rattaché à ${link.module}/${link.entityType}` });
    return { ok: true };
  }

  @Access('drive', 'drive.files.update')
  @Delete('drive/links/:fileId/:module/:entityType/:entityId')
  async removeLink(@AssocContext() c: AssocCtx, @Param('fileId') fileId: string, @Param('module') module: string, @Param('entityType') entityType: string, @Param('entityId') entityId: string) {
    parse(zUuid, entityId);
    const s = await this.scope(c);
    const f = await this.fileOf(c, s, fileId);
    await this.db.delete(driveLinks).where(and(eq(driveLinks.fileId, f.id), eq(driveLinks.module, module), eq(driveLinks.entityType, entityType), eq(driveLinks.entityId, entityId)));
    await this.audit.log({ ...log(c), action: 'drive.link.remove', resourceType: 'drive_file', resourceId: f.id, summary: `« ${f.name} » détaché de ${module}/${entityType}` });
    return { ok: true };
  }

  /* ============================================================ Instance (superadministrateur) */

  @SuperAdminOnly()
  @Get('system/drive')
  async instanceUsage() {
    const list = await this.db.select({ id: associations.id, name: associations.name }).from(associations).where(sql`${associations.status} <> 'deleted'`).orderBy(asc(associations.name));
    const used = await this.db.select({ a: driveFiles.associationId, n: sql<string>`coalesce(sum(${driveFileVersions.size}), 0)` }).from(driveFileVersions)
      .innerJoin(driveFiles, eq(driveFiles.id, driveFileVersions.fileId)).groupBy(driveFiles.associationId);
    const quotas = await this.db.select().from(driveSettings);
    const [disk] = await this.db.select({ n: sql<string>`coalesce(sum(${driveBlobs.size}), 0)`, c: sql<number>`count(*)::int` }).from(driveBlobs);
    const u = new Map(used.map((r) => [r.a, Number(r.n)]));
    const q = new Map(quotas.map((r) => [r.associationId, r.quotaBytes]));
    return {
      storedBytes: Number(disk.n), blobs: disk.c, defaultQuota: loadConfig().DRIVE_DEFAULT_QUOTA_MB * MB, maxUpload: loadConfig().DRIVE_MAX_UPLOAD_MB * MB,
      associations: list.map((a) => ({ ...a, used: u.get(a.id) ?? 0, quota: q.get(a.id) ?? null })),
    };
  }

  @SuperAdminOnly()
  @Put('system/associations/:id/drive-quota')
  async setQuota(@Param('id') id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    parse(zUuid, id);
    const { quotaMb } = parse(z.object({ quotaMb: z.number().int().min(1).max(10_000_000).nullable() }), body);
    const [a] = await this.db.select({ id: associations.id, name: associations.name }).from(associations).where(eq(associations.id, id));
    if (!a) throw NotFound('Association introuvable.');
    await this.db.insert(driveSettings).values({ associationId: id, quotaBytes: quotaMb === null ? null : quotaMb * MB })
      .onConflictDoUpdate({ target: driveSettings.associationId, set: { quotaBytes: quotaMb === null ? null : quotaMb * MB, updatedAt: new Date() } });
    await this.audit.log({ associationId: null, actorId: ctx.user!.id, actorLabel: ctx.user!.displayName, ip: null, action: 'system.drive.quota', resourceType: 'association', resourceId: id, summary: `Quota Drive de « ${a.name} » : ${quotaMb === null ? 'valeur par défaut' : `${quotaMb} Mo`}` });
    return { ok: true };
  }
}

/** Libère les contenus qui ne sont plus référencés par aucun document ni aucune version. */
export async function collectBlobs(db: Db, shas: string[]) {
  for (const sha of [...new Set(shas)].sort()) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`drive-blob:${sha}`}))`);
      const gone = await tx.delete(driveBlobs).where(and(
        eq(driveBlobs.sha256, sha),
        sql`not exists (select 1 from ${driveFileVersions} where ${driveFileVersions.sha256} = ${sha})`,
        sql`not exists (select 1 from ${driveFiles} where ${driveFiles.sha256} = ${sha})`,
      )).returning();
      if (gone.length) await removeBlob(sha);
    });
  }
}

export function fmt(bytes: number) {
  if (bytes < 1024) return `${Math.max(0, bytes)} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${units[i]}`;
}
