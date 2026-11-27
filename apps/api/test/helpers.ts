import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://scenorya:scenorya_dev@localhost:5432/scenorya_test';

export function configureTestEnv() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DB;
  process.env.APP_SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuv';
  process.env.SETUP_TOKEN = 'setup-token-for-tests-123';
  process.env.DATA_DIR = '/tmp/scenorya-test-data';
  process.env.RUN_MIGRATIONS = 'true';
  process.env.WEB_DIST = '/nonexistent';
}

export async function resetDatabase() {
  const pool = new Pool({ connectionString: TEST_DB });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  await pool.end();
}

/** Client HTTP avec cookie de session, jeton CSRF et association courante. */
export class Client {
  cookie = '';
  csrf = '';
  association = '';
  constructor(private app: INestApplication) {}

  private wrap(t: request.Test) {
    if (this.cookie) t.set('Cookie', this.cookie);
    if (this.csrf) t.set('X-CSRF-Token', this.csrf);
    if (this.association) t.set('X-Scenorya-Association', this.association);
    return t;
  }
  private capture(res: request.Response) {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined;
    const c = set?.find((s) => s.startsWith('scn_session='));
    if (c) this.cookie = c.split(';')[0];
    if (res.body?.csrfToken) this.csrf = res.body.csrfToken;
    return res;
  }
  get(url: string) {
    return this.wrap(request(this.app.getHttpServer()).get(url));
  }
  async post(url: string, body: unknown = {}) {
    return this.capture(await this.wrap(request(this.app.getHttpServer()).post(url).send(body as object)));
  }
  patch(url: string, body: unknown) {
    return this.wrap(request(this.app.getHttpServer()).patch(url).send(body as object));
  }
  put(url: string, body: unknown) {
    return this.wrap(request(this.app.getHttpServer()).put(url).send(body as object));
  }
  delete(url: string) {
    return this.wrap(request(this.app.getHttpServer()).delete(url));
  }
  async login(email: string, password: string) {
    const res = await this.post('/api/auth/login', { email, password });
    if (res.status !== 200) throw new Error(`login ${email} : ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  }
}

export const ADMIN = { email: 'admin@scenorya.test', displayName: 'Camille Admin', password: 'Mot-de-passe-solide-42' };
