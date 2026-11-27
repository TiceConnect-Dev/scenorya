import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { count, sql } from 'drizzle-orm';
import { ModuleId } from '@scenorya/shared';
import { DB, Db } from '../db/db';
import { instanceSettings, users } from '../db/schema';
import { loadConfig } from '../config';
import { randomToken, safeEqual } from '../common/crypto';
import { Conflict, Forbidden } from '../common/errors';
import { SessionService } from '../auth/session.service';
import { AssociationsService } from '../associations/associations.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../system/settings.service';

/**
 * Assistant de première configuration.
 * Tant qu'aucun utilisateur n'existe, un jeton d'installation est exigé :
 * il est fourni par SETUP_TOKEN ou généré et affiché dans les journaux du
 * conteneur, ce qui empêche un tiers de « réclamer » une instance exposée.
 * Aucun compte par défaut n'est jamais créé.
 */
@Injectable()
export class SetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Installation');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly associationsService: AssociationsService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private get tokenFile() {
    return join(loadConfig().dataDir, 'setup-token');
  }

  async needsSetup() {
    const [r] = await this.db.select({ n: count() }).from(users);
    return r.n === 0;
  }

  async onApplicationBootstrap() {
    if (!(await this.needsSetup())) return;
    const token = this.ensureToken();
    if (!loadConfig().SETUP_TOKEN) {
      this.logger.warn('─────────────────────────────────────────────────────────────');
      this.logger.warn('Scenorya n’est pas encore configuré.');
      this.logger.warn(`Jeton d’installation : ${token}`);
      this.logger.warn(`Ouvrez ${loadConfig().PUBLIC_URL}/installation pour continuer.`);
      this.logger.warn('─────────────────────────────────────────────────────────────');
    }
  }

  ensureToken(): string {
    const env = loadConfig().SETUP_TOKEN;
    if (env) return env;
    if (existsSync(this.tokenFile)) return readFileSync(this.tokenFile, 'utf8').trim();
    mkdirSync(loadConfig().dataDir, { recursive: true });
    const token = randomToken(18);
    writeFileSync(this.tokenFile, token, { mode: 0o600 });
    return token;
  }

  async run(
    input: {
      setupToken: string;
      admin: { email: string; displayName: string; password: string };
      association: { name: string; email?: string | null; city?: string | null };
      modules: ModuleId[];
      smtp?: { host: string; port: number; secure: boolean; user?: string | null; password?: string | null; from: string } | null;
    },
    meta: { ip: string | null; userAgent: string | null },
  ) {
    if (!safeEqual(input.setupToken, this.ensureToken())) throw Forbidden('SETUP_TOKEN_INVALID', "Jeton d'installation invalide.");
    const passwordHash = await this.sessions.hashPassword(input.admin.password);

    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('scenorya:setup'))`);
      const [r] = await tx.select({ n: count() }).from(users);
      if (r.n > 0) throw Conflict('ALREADY_INSTALLED', 'Scenorya est déjà configuré.');
      const [admin] = await tx
        .insert(users)
        .values({ email: input.admin.email, displayName: input.admin.displayName, passwordHash, isSuperAdmin: true })
        .returning();
      const actor = { id: admin.id, label: admin.displayName, ip: meta.ip };
      await this.audit.log({ associationId: null, actorId: admin.id, actorLabel: admin.displayName, action: 'instance.setup', summary: 'Installation initiale de Scenorya', ip: meta.ip }, tx);
      const created = await this.associationsService.create(tx, input.association, input.modules, actor, admin.id);
      await tx.insert(instanceSettings).values({ key: 'installation', value: { completedAt: new Date().toISOString(), by: admin.id } });
      if (input.smtp) await this.settings.saveSmtp(tx, input.smtp, actor);
      return { admin, association: created.association, activated: created.activated };
    });
    if (existsSync(this.tokenFile)) rmSync(this.tokenFile);
    const session = await this.sessions.create(result.admin.id, meta);
    return { ...result, session };
  }
}
