import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { verify } from '@node-rs/argon2';
import { Public } from '../common/access';
import { parse } from '../common/validation';
import { AppError, NotFound } from '../common/errors';
import { sha256 } from '../common/crypto';
import { DB, Db } from '../db/db';
import { associations, driveAccessLog, driveFiles, driveShares } from '../db/schema';
import { ModulesService } from '../modules/modules.service';
import { blobExists, blobPath, fileHeaders } from './storage';

const MAX_FAILURES = 10;
const LOCK_MINUTES = 15;
const GONE = 'Ce lien de partage n’existe pas, a expiré ou a été révoqué.';

/** Liens de partage publics (sans compte). */
@ApiTags('Scenorya Drive — partage public')
@Controller('public/shares')
export class ShareController {
  constructor(@Inject(DB) private readonly db: Db, private readonly modules: ModulesService) {}

  private async load(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw NotFound(GONE);
    const [row] = await this.db.select({ sh: driveShares, f: driveFiles, a: { id: associations.id, name: associations.name, status: associations.status } })
      .from(driveShares).innerJoin(driveFiles, eq(driveFiles.id, driveShares.fileId)).innerJoin(associations, eq(associations.id, driveShares.associationId))
      .where(eq(driveShares.tokenHash, sha256(token)));
    if (!row || row.sh.revokedAt || row.sh.expiresAt <= new Date() || row.f.deletedAt || row.a.status !== 'active') throw NotFound(GONE);
    if (row.sh.maxDownloads !== null && row.sh.downloadCount >= row.sh.maxDownloads) throw NotFound('Ce lien a atteint son nombre maximal de téléchargements.');
    // Module désactivé : les liens sont suspendus (et reprennent à la réactivation).
    if (!(await this.modules.resolved(row.a.id)).drive.usable) throw NotFound(GONE);
    return row;
  }

  @Public()
  @Get(':token')
  async info(@Param('token') token: string) {
    const { sh, f, a } = await this.load(token);
    return {
      association: a.name, name: f.name, size: f.size, mime: f.mime, expiresAt: sh.expiresAt, needsPassword: !!sh.passwordHash,
      remaining: sh.maxDownloads === null ? null : sh.maxDownloads - sh.downloadCount,
      locked: !!(sh.lockedUntil && sh.lockedUntil > new Date()),
    };
  }

  @Public()
  @Post(':token/download')
  @HttpCode(200)
  async download(@Param('token') token: string, @Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    const { password } = parse(z.object({ password: z.string().max(128).optional() }), body ?? {});
    const { sh, f } = await this.load(token);
    const ip = req.ip ?? null;
    if (sh.lockedUntil && sh.lockedUntil > new Date()) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'SHARE_LOCKED', `Trop d’essais de mot de passe : réessayez dans ${LOCK_MINUTES} minutes.`);
    }
    if (sh.passwordHash) {
      const ok = !!password && (await verify(sh.passwordHash, password).catch(() => false));
      if (!ok) {
        const failures = sh.failedAttempts + 1;
        await this.db.update(driveShares).set(failures >= MAX_FAILURES
          ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
          : { failedAttempts: failures }).where(eq(driveShares.id, sh.id));
        await this.db.insert(driveAccessLog).values({ associationId: sh.associationId, fileId: f.id, fileName: f.name, shareId: sh.id, action: 'share_denied', ip });
        throw new AppError(HttpStatus.UNAUTHORIZED, 'SHARE_PASSWORD', password ? 'Mot de passe incorrect.' : 'Ce document est protégé par un mot de passe.');
      }
    }
    // Comptage atomique : la limite de téléchargements ne peut pas être dépassée par des requêtes simultanées.
    const [counted] = await this.db.update(driveShares).set({ downloadCount: sql`${driveShares.downloadCount} + 1`, failedAttempts: 0 })
      .where(and(eq(driveShares.id, sh.id), isNull(driveShares.revokedAt), sql`(${driveShares.maxDownloads} is null or ${driveShares.downloadCount} < ${driveShares.maxDownloads})`))
      .returning({ id: driveShares.id });
    if (!counted) throw NotFound('Ce lien a atteint son nombre maximal de téléchargements.');
    if (!(await blobExists(f.sha256))) throw NotFound('Le contenu de ce document est indisponible.');
    await this.db.insert(driveAccessLog).values({ associationId: sh.associationId, fileId: f.id, fileName: f.name, shareId: sh.id, action: 'share_download', version: f.version, ip });
    res.set(fileHeaders(f.name, f.mime, f.size, false));
    createReadStream(blobPath(f.sha256)).on('error', () => res.destroy()).pipe(res);
  }
}
