import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isModuleId, ModuleId } from '@scenorya/shared';
import { Ctx, Public, RequestContext, ScenoryaRequest, SuperAdminOnly } from '../common/access';
import { parse, zEmail, zOptText, zUuid } from '../common/validation';
import { AppError, BadRequest, NotFound } from '../common/errors';
import { allowPurge } from '../common/purge';
import { collectBlobs } from '../drive/drive.controller';
import { DB, Db } from '../db/db';
import { associations, backups, instanceSettings } from '../db/schema';
import { loadConfig } from '../config';
import { AssociationsService } from '../associations/associations.service';
import { SettingsService } from './settings.service';
import { BackupService } from './backup.service';
import { AuditService } from '../audit/audit.service';
import { zSmtp } from '../setup/setup.controller';
import { HttpStatus, Req } from '@nestjs/common';

const actorOf = (ctx: RequestContext, ip?: string) => ({ id: ctx.user!.id, label: ctx.user!.displayName, ip: ip ?? null });

@ApiTags('Scenorya System')
@Controller('system')
export class SystemController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly associations: AssociationsService,
    private readonly settings: SettingsService,
    private readonly backupsService: BackupService,
    private readonly audit: AuditService,
  ) {}

  /** Sonde de vie pour Docker / proxy : ne divulgue aucune information sensible. */
  @Public()
  @Get('healthz')
  async healthz() {
    await this.db.execute(sql`select 1`);
    return { status: 'ok' };
  }

  @SuperAdminOnly()
  @Get('health')
  async health() {
    const cfg = loadConfig();
    const t0 = Date.now();
    let database: Record<string, unknown>;
    try {
      const v = await this.db.execute(sql`select version() as v, pg_database_size(current_database()) as size`);
      const m = await this.db.execute(sql`select count(*)::int as n, max(created_at) as last from drizzle.__drizzle_migrations`).catch(() => ({ rows: [{}] }));
      database = { status: 'ok', latencyMs: Date.now() - t0, version: String(v.rows[0]?.v ?? '').split(',')[0], sizeBytes: Number(v.rows[0]?.size ?? 0), migrations: m.rows[0] };
    } catch (e) {
      database = { status: 'error', error: (e as Error).message };
    }
    let disk: Record<string, unknown> | null = null;
    try {
      const s = await statfs(existsSync(cfg.dataDir) ? cfg.dataDir : '.');
      disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize, path: cfg.dataDir };
    } catch {
      disk = null;
    }
    const mem = process.memoryUsage();
    const [lastBackup] = await this.db.select().from(backups).orderBy(desc(backups.createdAt)).limit(1);
    return {
      application: { name: 'Scenorya', edition: 'Community', version: cfg.version, node: process.version, env: cfg.NODE_ENV, uptimeSeconds: Math.round(process.uptime()) },
      system: { platform: `${os.type()} ${os.release()} (${os.arch()})`, totalMemBytes: os.totalmem(), freeMemBytes: os.freemem(), load: os.loadavg() },
      process: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      database,
      disk,
      smtp: { configured: Boolean(await this.settings.smtpPublic()) },
      backups: { last: lastBackup ?? null, pgDumpAvailable: await this.backupsService.pgDumpAvailable() },
      scheduledTasks: { status: 'none', note: 'Aucune tâche planifiée n’est encore enregistrée (sauvegardes automatiques : phase 8).' },
    };
  }

  /* ------------------------------------------------------- Associations */

  @SuperAdminOnly()
  @Get('associations')
  listAssociations() {
    return this.associations.listAll();
  }

  @SuperAdminOnly()
  @Post('associations')
  async createAssociation(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: ScenoryaRequest) {
    const input = parse(
      z.object({
        name: z.string().trim().min(2).max(160),
        email: zOptText(254),
        city: zOptText(120),
        modules: z.array(z.string()).max(30).refine((a) => a.every(isModuleId), 'Module inconnu'),
        joinAsAdmin: z.boolean().default(true),
      }),
      body,
    );
    const actor = actorOf(ctx, req.ip);
    const r = await this.db.transaction((tx) =>
      this.associations.create(tx, input, input.modules as ModuleId[], actor, input.joinAsAdmin ? ctx.user!.id : null),
    );
    await this.audit.log({ associationId: null, actorId: actor.id, actorLabel: actor.label, action: 'instance.association.create', resourceType: 'association', resourceId: r.association.id, summary: `Création de l'association « ${r.association.name} »`, ip: actor.ip });
    return r;
  }

  /**
   * Suppression d'une association et de toutes ses données (adhérents, cotisations, agenda, projets,
   * documents…). Seuls restent le journal d'audit et l'historique des modules, en ajout seul par conception :
   * l'association y demeure comme simple nom, à l'état « supprimée ». Confirmation par saisie du nom.
   */
  @SuperAdminOnly()
  @Delete('associations/:id')
  async deleteAssociation(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown, @Req() req: ScenoryaRequest) {
    parse(zUuid, id);
    const { confirmName } = parse(z.object({ confirmName: z.string() }), body ?? {});
    const [a] = await this.db.select().from(associations).where(and(eq(associations.id, id), sql`${associations.status} <> 'deleted'`));
    if (!a) throw NotFound('Association introuvable.');
    if (confirmName.trim() !== a.name) throw BadRequest('CONFIRM_NAME', 'Saisissez exactement le nom de l’association pour confirmer.');
    const shas = (await this.db.execute<{ sha256: string }>(sql`select distinct v.sha256 from drive_file_versions v join drive_files f on f.id = v.file_id where f.association_id = ${id}`)).rows.map((r) => r.sha256);
    const counts = (await this.db.execute<{ members: number; users: number; files: number }>(sql`select
      (select count(*)::int from members where association_id = ${id}) as members,
      (select count(*)::int from association_users where association_id = ${id}) as users,
      (select count(*)::int from drive_files where association_id = ${id}) as files`)).rows[0];
    await this.db.transaction(async (tx) => {
      await allowPurge(tx);
      const q = (s: ReturnType<typeof sql>) => tx.execute(s);
      await q(sql`delete from drive_access_log where association_id = ${id}`);
      await q(sql`delete from drive_links where file_id in (select id from drive_files where association_id = ${id})`);
      await q(sql`delete from drive_shares where association_id = ${id}`);
      await q(sql`delete from drive_files where association_id = ${id}`);
      await q(sql`delete from drive_folders where association_id = ${id}`);
      await q(sql`delete from drive_settings where association_id = ${id}`);
      await q(sql`delete from member_invitations where association_id = ${id}`);
      await q(sql`delete from events where id in (select event_id from cast_rehearsals h join cast_productions p on p.id = h.production_id where p.association_id = ${id})`);
      await q(sql`delete from events where id in (select event_id from show_performances h join shows s on s.id = h.show_id where s.association_id = ${id})`);
      await q(sql`delete from regie_cuesheets where association_id = ${id}`);
      await q(sql`delete from pos_registers where association_id = ${id}`);
      await q(sql`delete from pos_products where association_id = ${id}`);
      await q(sql`delete from pos_categories where association_id = ${id}`);
      await q(sql`delete from ticket_events where association_id = ${id}`);
      await q(sql`delete from maintenance_tickets where association_id = ${id}`);
      await q(sql`delete from maintenance_plans where association_id = ${id}`);
      await q(sql`delete from bookings where association_id = ${id}`);
      await q(sql`delete from booking_resources where association_id = ${id}`);
      await q(sql`delete from stock_items where association_id = ${id}`);
      await q(sql`delete from stock_locations where association_id = ${id}`);
      await q(sql`delete from cast_productions where association_id = ${id}`);
      await q(sql`delete from shows where association_id = ${id}`);
      await q(sql`delete from show_venues where association_id = ${id}`);
      await q(sql`delete from cast_unavailabilities where association_id = ${id}`);
      await q(sql`delete from mandates where association_id = ${id}`);
      await q(sql`delete from meetings where association_id = ${id}`);
      await q(sql`delete from projects where association_id = ${id}`);
      await q(sql`delete from tasks where association_id = ${id}`);
      await q(sql`delete from events where association_id = ${id}`);
      await q(sql`delete from membership_payments where association_id = ${id}`);
      await q(sql`delete from membership_dues where association_id = ${id}`);
      await q(sql`delete from membership_plans where association_id = ${id}`);
      await q(sql`delete from member_groups where association_id = ${id}`);
      await q(sql`delete from member_field_defs where association_id = ${id}`);
      await q(sql`delete from members where association_id = ${id}`);
      await q(sql`delete from association_users where association_id = ${id}`);
      await q(sql`delete from roles where association_id = ${id}`);
      await q(sql`delete from association_modules where association_id = ${id}`);
      await q(sql`delete from counters where association_id = ${id}`);
      await tx.update(associations).set({
        status: 'deleted', slug: `supprimee-${id}`, shortName: null, legalName: null, rna: null, siret: null, email: null, phone: null, website: null,
        addressLine: null, postalCode: null, city: null, updatedAt: new Date(),
      }).where(eq(associations.id, id));
      await this.audit.log({
        associationId: null, actorId: ctx.user!.id, actorLabel: ctx.user!.displayName, ip: req.ip, action: 'instance.association.delete', resourceType: 'association', resourceId: id,
        summary: `Suppression de l’association « ${a.name} » et de toutes ses données (${counts.members} adhérent(s), ${counts.users} accès, ${counts.files} document(s))`,
      }, tx);
    });
    await collectBlobs(this.db, shas);
    return { ok: true, ...counts };
  }

  /* ---------------------------------------------------------- Messagerie */

  @SuperAdminOnly()
  @Get('smtp')
  smtp() {
    return this.settings.smtpPublic();
  }

  @SuperAdminOnly()
  @Put('smtp')
  async saveSmtp(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: ScenoryaRequest) {
    const input = parse(zSmtp, body);
    await this.db.transaction((tx) => this.settings.saveSmtp(tx, input, actorOf(ctx, req.ip)));
    return this.settings.smtpPublic();
  }

  @SuperAdminOnly()
  @Delete('smtp')
  async deleteSmtp(@Ctx() ctx: RequestContext, @Req() req: ScenoryaRequest) {
    await this.db.transaction(async (tx) => {
      await tx.delete(instanceSettings).where(eq(instanceSettings.key, 'smtp'));
      await this.audit.log({ associationId: null, actorId: ctx.user!.id, actorLabel: ctx.user!.displayName, ip: req.ip, action: 'instance.smtp.delete', resourceType: 'settings', summary: 'Suppression de la configuration de la messagerie' }, tx);
    });
    return { ok: true };
  }

  @SuperAdminOnly()
  @Post('smtp/test')
  @HttpCode(200)
  async testSmtp(@Body() body: unknown) {
    const { to } = parse(z.object({ to: zEmail }), body);
    try {
      return { ok: true, ...(await this.settings.sendTest(to)) };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(HttpStatus.BAD_GATEWAY, 'SMTP_ERROR', `Échec de l'envoi : ${(e as Error).message}`);
    }
  }

  /* --------------------------------------------------------- Sauvegardes */

  @SuperAdminOnly()
  @Get('backups')
  listBackups() {
    return this.db.select().from(backups).orderBy(desc(backups.createdAt)).limit(100);
  }

  @SuperAdminOnly()
  @Post('backups')
  @HttpCode(200)
  createBackup(@Ctx() ctx: RequestContext, @Req() req: ScenoryaRequest) {
    return this.backupsService.run(actorOf(ctx, req.ip));
  }

  @SuperAdminOnly()
  @Delete('backups/:id')
  async deleteBackup(@Ctx() ctx: RequestContext, @Param('id') id: string, @Req() req: ScenoryaRequest) {
    parse(zUuid, id);
    const [b] = await this.db.select().from(backups).where(eq(backups.id, id));
    if (!b) throw NotFound('Sauvegarde introuvable.');
    if (b.status === 'running') throw BadRequest('BACKUP_RUNNING', 'Sauvegarde en cours : attendez qu’elle se termine.');
    const path = b.filename ? this.backupsService.pathOf(b.filename) : null;
    if (path) await unlink(path).catch(() => undefined);
    await this.db.delete(backups).where(eq(backups.id, id));
    await this.audit.log({ associationId: null, actorId: ctx.user!.id, actorLabel: ctx.user!.displayName, ip: req.ip, action: 'backup.delete', resourceType: 'backup', resourceId: id, summary: `Suppression de la sauvegarde ${b.filename ?? id}` });
    return { ok: true };
  }

  @SuperAdminOnly()
  @Get('backups/:id/download')
  async download(@Ctx() ctx: RequestContext, @Param('id') id: string, @Res() res: Response, @Req() req: ScenoryaRequest) {
    parse(zUuid, id);
    const [b] = await this.db.select().from(backups).where(eq(backups.id, id));
    const path = b ? this.backupsService.pathOf(b.filename) : null;
    if (!b || b.status !== 'success' || !path || !existsSync(path)) throw NotFound('Sauvegarde introuvable.');
    await this.audit.log({ associationId: null, actorId: ctx.user!.id, actorLabel: ctx.user!.displayName, action: 'backup.download', resourceType: 'backup', resourceId: id, summary: `Téléchargement de la sauvegarde ${b.filename}`, ip: req.ip });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${b.filename}"`);
    res.setHeader('X-Checksum-SHA256', b.sha256 ?? '');
    createReadStream(path).pipe(res);
  }

  /* ------------------------------------------------ Journal de l'instance */

  @SuperAdminOnly()
  @Get('audit')
  instanceAudit(@Query() query: unknown) {
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50), q: z.string().max(100).optional() }), query);
    return this.audit.list(null, q);
  }

  @SuperAdminOnly()
  @Get('audit/verify')
  verifyInstanceAudit() {
    return this.audit.verify(null);
  }
}
