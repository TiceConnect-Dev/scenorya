import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isModuleId, ModuleId } from '@scenorya/shared';
import { Ctx, Public, RequestContext, ScenoryaRequest, SuperAdminOnly } from '../common/access';
import { parse, zEmail, zOptText, zUuid } from '../common/validation';
import { AppError, NotFound } from '../common/errors';
import { DB, Db } from '../db/db';
import { backups } from '../db/schema';
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
