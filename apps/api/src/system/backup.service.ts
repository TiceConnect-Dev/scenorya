import { Inject, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { DB, Db } from '../db/db';
import { backups } from '../db/schema';
import { loadConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { Conflict } from '../common/errors';

/**
 * Sauvegarde de la base PostgreSQL via pg_dump (format personnalisé), avec
 * empreinte SHA-256 et rétention configurable. La restauration se fait hors
 * de l'interface web (procédure documentée dans docs/sauvegarde-restauration.md).
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger('Sauvegardes');
  private running = false;
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  get dir() {
    return join(loadConfig().dataDir, 'backups');
  }

  pathOf(filename: string) {
    const safe = basename(filename);
    return safe === filename ? join(this.dir, safe) : null;
  }

  private pgEnv() {
    const u = new URL(loadConfig().DATABASE_URL);
    return {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: u.pathname.replace(/^\//, ''),
    };
  }

  pgDumpAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn('pg_dump', ['--version']);
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }

  async run(actor: { id: string; label: string; ip?: string | null }) {
    if (this.running) throw Conflict('BACKUP_RUNNING', 'Une sauvegarde est déjà en cours.');
    this.running = true;
    mkdirSync(this.dir, { recursive: true });
    const filename = `scenorya-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
    const path = join(this.dir, filename);
    const [row] = await this.db.insert(backups).values({ filename, status: 'running', createdBy: actor.id }).returning();
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn('pg_dump', ['--format=custom', '--no-owner', '--file', path], { env: this.pgEnv() });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('error', (e) => reject(new Error(`pg_dump introuvable : ${e.message}`)));
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `pg_dump a échoué (code ${code})`))));
      });
      const sha256 = await new Promise<string>((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
      });
      const [done] = await this.db
        .update(backups)
        .set({ status: 'success', sizeBytes: statSync(path).size, sha256 })
        .where(eq(backups.id, row.id))
        .returning();
      await this.audit.log({ associationId: null, actorId: actor.id, actorLabel: actor.label, action: 'backup.create', resourceType: 'backup', resourceId: row.id, summary: `Sauvegarde ${filename} créée`, data: { sha256 }, ip: actor.ip });
      await this.applyRetention();
      return done;
    } catch (e) {
      if (existsSync(path)) rmSync(path);
      const message = (e as Error).message.slice(0, 500);
      await this.db.update(backups).set({ status: 'failed', error: message }).where(eq(backups.id, row.id));
      this.logger.error(message);
      throw Conflict('BACKUP_FAILED', `La sauvegarde a échoué : ${message}`);
    } finally {
      this.running = false;
    }
  }

  private async applyRetention() {
    const keep = loadConfig().BACKUP_RETENTION;
    const all = await this.db.select().from(backups).where(eq(backups.status, 'success')).orderBy(asc(backups.createdAt));
    for (const b of all.slice(0, Math.max(0, all.length - keep))) {
      const p = this.pathOf(b.filename);
      if (p && existsSync(p)) rmSync(p);
      await this.db.update(backups).set({ status: 'expired' }).where(eq(backups.id, b.id));
    }
  }
}
