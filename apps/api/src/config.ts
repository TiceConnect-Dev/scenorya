import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  /** Secret principal (≥ 32 caractères) : dérive la clé de chiffrement des secrets stockés. */
  APP_SECRET: z.string().min(32, 'APP_SECRET doit contenir au moins 32 caractères'),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATA_DIR: z.string().default('./data'),
  WEB_DIST: z.string().optional(),
  COOKIE_SECURE: z.enum(['true', 'false', 'auto']).default('auto'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  RUN_MIGRATIONS: z.enum(['true', 'false']).default('true'),
  /** Jeton d'installation imposé ; sinon généré et affiché dans les journaux au premier démarrage. */
  SETUP_TOKEN: z.string().min(16).optional(),
  BACKUP_RETENTION: z.coerce.number().int().positive().default(14),
  TRUST_PROXY: z.enum(['true', 'false']).default('true'),
});

export type AppConfig = z.infer<typeof schema> & { dataDir: string; cookieSecure: boolean; version: string };

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide :\n${msg}`);
  }
  const c = parsed.data;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const version = (require('../package.json') as { version: string }).version;
  const cfg: AppConfig = {
    ...c,
    dataDir: resolve(c.DATA_DIR),
    cookieSecure: c.COOKIE_SECURE === 'auto' ? c.PUBLIC_URL.startsWith('https://') : c.COOKIE_SECURE === 'true',
    version,
  };
  if (env === process.env) cached = cfg;
  return cfg;
}

export function resetConfigCache() {
  cached = null;
}
