import { INestApplication, RequestMethod } from '@nestjs/common';
import { Pool } from 'pg';
import { io as ioClient, Socket } from 'socket.io-client';
import { ADMIN, Client, configureTestEnv, resetDatabase, TEST_DB } from './helpers';

configureTestEnv();
// Imports après la configuration de l'environnement.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ACCESS_KEY } = require('../src/common/access') as typeof import('../src/common/access');

let app: INestApplication;
let admin: Client;
let assocA: string;
let port: number;

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.listen(0);
  port = (app.getHttpServer().address() as { port: number }).port;
  admin = new Client(app);
});

afterAll(async () => {
  await app?.close();
});

describe('Refus par défaut', () => {
  it('chaque route HTTP déclare une règle d’accès explicite', () => {
    const controllers: Function[] = Reflect.getMetadata('controllers', AppModule);
    const missing: string[] = [];
    for (const ctrl of controllers) {
      const classRule = Reflect.getMetadata(ACCESS_KEY, ctrl);
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata('method', handler) === undefined) continue; // pas une route
        if (!classRule && !Reflect.getMetadata(ACCESS_KEY, handler)) missing.push(`${ctrl.name}.${name}`);
      }
    }
    expect(missing).toEqual([]);
    expect(RequestMethod.GET).toBeDefined();
  });

  it('refuse les accès non authentifiés', async () => {
    const anon = new Client(app);
    expect((await anon.get('/api/hub/summary')).status).toBe(401);
    expect((await anon.get('/api/system/health')).status).toBe(401);
    expect((await anon.get('/api/system/healthz')).status).toBe(200);
  });
});

describe('Assistant de première configuration', () => {
  const payload = (token: string) => ({
    setupToken: token,
    admin: ADMIN,
    association: { name: 'Compagnie du Rideau Rouge', city: 'Fourmies' },
    modules: ['asso', 'scan'],
  });

  it('exige le jeton d’installation', async () => {
    const c = new Client(app);
    const res = await c.post('/api/setup', payload('mauvais-jeton'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SETUP_TOKEN_INVALID');
  });

  it('refuse un mot de passe faible', async () => {
    const res = await new Client(app).post('/api/setup', { ...payload('setup-token-for-tests-123'), admin: { ...ADMIN, password: 'court' } });
    expect(res.status).toBe(400);
  });

  it('crée l’administrateur, l’association et active les dépendances (Scan ⇒ Tickets)', async () => {
    const res = await admin.post('/api/setup', payload('setup-token-for-tests-123'));
    expect(res.status).toBe(201);
    expect(res.body.activated.sort()).toEqual(['asso', 'scan', 'tickets']);
    assocA = res.body.associationId;
    admin.association = assocA;
    const ctx = await admin.get('/api/context');
    expect(ctx.status).toBe(200);
    expect(ctx.body.modules.tickets.state).toBe('active');
    expect(ctx.body.modules.finance.state).toBe('inactive');
    expect(ctx.body.visibleModules).toEqual(expect.arrayContaining(['hub', 'asso', 'admin', 'system']));
  });

  it('ne peut pas être rejoué une fois l’instance configurée', async () => {
    const res = await new Client(app).post('/api/setup', payload('setup-token-for-tests-123'));
    expect(res.status).toBe(409);
  });
});

describe('Authentification et CSRF', () => {
  it('refuse une écriture sans jeton CSRF', async () => {
    const c = new Client(app);
    c.cookie = admin.cookie;
    c.association = assocA;
    const res = await c.post('/api/asso/members', { firstName: 'A', lastName: 'B' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
  });

  it('bloque après 5 échecs de connexion', async () => {
    const c = new Client(app);
    for (let i = 0; i < 5; i++) expect((await c.post('/api/auth/login', { email: 'inconnu@x.fr', password: 'nope' })).status).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'inconnu@x.fr', password: 'nope' })).status).toBe(429);
  });
});

describe('Cycle de vie des modules', () => {
  it('exige une confirmation pour activer les dépendances', async () => {
    let res = await admin.post('/api/admin/modules/maintenance/activate', {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEPENDENCIES_CONFIRMATION_REQUIRED');
    expect(res.body.details.toActivate).toEqual(['stock']);
    res = await admin.post('/api/admin/modules/maintenance/activate', { confirmDependencies: true });
    expect(res.status).toBe(200);
    expect(res.body.resolved.stock.state).toBe('active');
    expect(res.body.resolved.maintenance.state).toBe('active');
  });

  it('ne désactive jamais silencieusement un module dépendant', async () => {
    const preview = await admin.post('/api/admin/modules/tickets/preview-deactivation', { mode: 'inactive' });
    expect(preview.status).toBe(200);
    expect(preview.body.dependents).toEqual(['scan']);
    let res = await admin.post('/api/admin/modules/tickets/deactivate', { mode: 'inactive' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEPENDENTS_CONFIRMATION_REQUIRED');
    res = await admin.post('/api/admin/modules/tickets/deactivate', { mode: 'inactive', confirmDependents: true });
    expect(res.status).toBe(200);
    expect(res.body.resolved.scan.state).toBe('inactive');
    expect(res.body.resolved.tickets.state).toBe('inactive');
    const history = await admin.get('/api/admin/modules/history');
    expect(history.body.slice(0, 2).map((h: { moduleId: string }) => h.moduleId).sort()).toEqual(['scan', 'tickets']);
  });

  it('refuse la désactivation d’un module de socle', async () => {
    const res = await admin.post('/api/admin/modules/admin/deactivate', { mode: 'inactive', confirmDependents: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MODULE_DEACTIVATION_BLOCKED');
  });

  it('désactivation : accès direct refusé, données conservées, réactivation sans perte', async () => {
    const created = await admin.post('/api/asso/members', { firstName: 'Louise', lastName: 'Michel', email: 'louise@example.org' });
    expect(created.status).toBe(201);
    expect(created.body.number).toBe(1);

    let res = await admin.post('/api/admin/modules/asso/deactivate', { mode: 'inactive' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WARNINGS_ACKNOWLEDGEMENT_REQUIRED');
    res = await admin.post('/api/admin/modules/asso/deactivate', { mode: 'inactive', acknowledgeWarnings: true });
    expect(res.status).toBe(200);

    const denied = await admin.get('/api/asso/members');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('MODULE_DISABLED');
    const ctx = await admin.get('/api/context');
    expect(ctx.body.visibleModules).not.toContain('asso');

    expect((await admin.post('/api/admin/modules/asso/activate', {})).status).toBe(200);
    const list = await admin.get('/api/asso/members');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].lastName).toBe('Michel');
  });

  it('mode clôture (lecture seule) : lecture autorisée, écriture refusée', async () => {
    expect((await admin.post('/api/admin/modules/asso/deactivate', { mode: 'readonly' })).status).toBe(200);
    expect((await admin.get('/api/asso/members')).status).toBe(200);
    const w = await admin.post('/api/asso/members', { firstName: 'X', lastName: 'Y' });
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('MODULE_READONLY');
    expect((await admin.post('/api/admin/modules/asso/activate', {})).status).toBe(200);
  });

  it("un module désactivé au niveau de l'instance devient indisponible pour l'association", async () => {
    expect((await admin.put('/api/system/instance-modules/asso', { enabled: false })).status).toBe(200);
    const denied = await admin.get('/api/asso/members');
    expect(denied.status).toBe(403);
    expect(denied.body.details.state).toBe('unavailable');
    expect((await admin.put('/api/system/instance-modules/asso', { enabled: true })).status).toBe(200);
    expect((await admin.get('/api/asso/members')).status).toBe(200);
  });
});

describe('Permissions', () => {
  let adherent: Client;
  let roles: { id: string; key: string | null }[];

  beforeAll(async () => {
    roles = (await admin.get('/api/admin/roles')).body;
  });

  it('un module actif ne donne aucun droit automatiquement', async () => {
    const role = roles.find((r) => r.key === 'adherent')!;
    const res = await admin.post('/api/admin/users', { email: 'adherent@scenorya.test', displayName: 'Adhérent Test', password: 'Provisoire-123456', roleIds: [role.id] });
    expect(res.status).toBe(201);
    adherent = new Client(app);
    await adherent.login('adherent@scenorya.test', 'Provisoire-123456');
    adherent.association = assocA;
    // Changement de mot de passe obligatoire avant toute autre action.
    expect((await adherent.get('/api/context')).body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await adherent.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Nouveau-mot-de-passe-1' })).status).toBe(200);
    const denied = await adherent.get('/api/asso/members');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    expect((await adherent.get('/api/admin/users')).status).toBe(403);
    expect((await adherent.get('/api/system/health')).status).toBe(403);
    const ctx = await adherent.get('/api/context');
    expect(ctx.body.visibleModules).toEqual([]); // Espace inactif, aucun autre droit
  });

  it("empêche l'escalade de privilèges", async () => {
    const role = await admin.post('/api/admin/roles', { name: 'Gestion des comptes', permissions: ['admin.read', 'admin.users.read', 'admin.users.create', 'admin.roles.read'] });
    expect(role.status).toBe(201);
    await admin.post('/api/admin/users', { email: 'gestion@scenorya.test', displayName: 'Gestionnaire', password: 'Provisoire-123456', roleIds: [role.body.id] });
    const g = new Client(app);
    await g.login('gestion@scenorya.test', 'Provisoire-123456');
    await g.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Nouveau-mot-de-passe-2' });
    g.association = assocA;
    const adminRole = roles.find((r) => r.key === 'admin')!;
    const res = await g.post('/api/admin/users', { email: 'pirate@scenorya.test', displayName: 'Pirate', password: 'Provisoire-123456', roleIds: [adminRole.id] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRIVILEGE_ESCALATION');
    const custom = await g.post('/api/admin/roles', { name: 'Super', permissions: ['*'] });
    expect(custom.status).toBe(403);
  });

  it('masque les champs sensibles sans le droit dédié', async () => {
    const role = await admin.post('/api/admin/roles', { name: 'Lecture adhérents', permissions: ['asso.read', 'asso.members.read'] });
    await admin.post('/api/admin/users', { email: 'lecteur@scenorya.test', displayName: 'Lecteur', password: 'Provisoire-123456', roleIds: [role.body.id] });
    const l = new Client(app);
    await l.login('lecteur@scenorya.test', 'Provisoire-123456');
    await l.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Nouveau-mot-de-passe-3' });
    l.association = assocA;
    await admin.post('/api/asso/members', { firstName: 'Jean', lastName: 'Moulin', birthDate: '1999-06-20', city: 'Lyon' });
    const res = await l.get('/api/asso/members?q=Moulin');
    expect(res.status).toBe(200);
    expect(res.body.items[0].birthDate).toBeNull();
    expect(res.body.items[0].sensitiveHidden).toBe(true);
    const full = await admin.get('/api/asso/members?q=Moulin');
    expect(full.body.items[0].birthDate).toBe('1999-06-20');
    expect((await l.post('/api/asso/members', { firstName: 'a', lastName: 'b' })).status).toBe(403);
  });

  it("conserve toujours au moins un administrateur", async () => {
    const users = (await admin.get('/api/admin/users')).body as { id: string; email: string }[];
    const me = users.find((u) => u.email === ADMIN.email)!;
    const res = await admin.patch(`/api/admin/users/${me.id}`, { roleIds: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
    expect((await admin.post(`/api/admin/users/${me.id}/disable`)).status).toBe(400);
  });
});

describe('Isolation entre associations', () => {
  let assocB: string;
  it('sépare strictement les données', async () => {
    const res = await admin.post('/api/system/associations', { name: 'Festival des Lumières', modules: ['asso'], joinAsAdmin: true });
    expect(res.status).toBe(201);
    assocB = res.body.association.id;
    const b = new Client(app);
    b.cookie = admin.cookie;
    b.csrf = admin.csrf;
    b.association = assocB;
    const created = await b.post('/api/asso/members', { firstName: 'Membre', lastName: 'DeB' });
    expect(created.body.number).toBe(1); // numérotation indépendante
    const listA = await admin.get('/api/asso/members?q=DeB');
    expect(listA.body.total).toBe(0);
    // Accès à une fiche de B avec le contexte A : introuvable.
    expect((await admin.get(`/api/asso/members/${created.body.id}`)).status).toBe(404);
  });

  it("refuse l'accès à une association dont l'utilisateur n'est pas membre", async () => {
    const l = new Client(app);
    await l.login('lecteur@scenorya.test', 'Nouveau-mot-de-passe-3');
    l.association = assocB;
    const res = await l.get('/api/asso/members');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_MEMBER');
  });

  it('chaque association a sa propre configuration de modules', async () => {
    const b = new Client(app);
    b.cookie = admin.cookie;
    b.association = assocB;
    const ctxB = await b.get('/api/context');
    expect(ctxB.body.modules.stock.state).toBe('inactive');
    const ctxA = await admin.get('/api/context');
    expect(ctxA.body.modules.stock.state).toBe('active');
  });
});

describe('Concurrence', () => {
  it('attribue des numéros d’adhérent uniques lors de créations simultanées', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => admin.post('/api/asso/members', { firstName: `Simul${i}`, lastName: 'Tané' })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.number);
    expect(new Set(numbers).size).toBe(12);
  });

  it('sérialise les activations concurrentes sans incohérence', async () => {
    const results = await Promise.all([
      admin.post('/api/admin/modules/agenda/activate', {}),
      admin.post('/api/admin/modules/agenda/activate', {}),
      admin.post('/api/admin/modules/drive/activate', {}),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const ctx = await admin.get('/api/context');
    expect(ctx.body.modules.agenda.state).toBe('active');
    expect(ctx.body.modules.drive.state).toBe('active');
  });
});

describe("Journal d'audit", () => {
  it('chaîne les entrées et détecte toute altération', async () => {
    const v = await admin.get('/api/admin/audit/verify');
    expect(v.body.valid).toBe(true);
    expect(v.body.checked).toBeGreaterThan(10);
    const pool = new Pool({ connectionString: TEST_DB });
    await expect(pool.query("UPDATE audit_logs SET summary = 'falsifié'")).rejects.toThrow(/ajout seul/);
    await expect(pool.query('DELETE FROM audit_logs')).rejects.toThrow(/ajout seul/);
    await pool.end();
  });

  it('ne journalise jamais les mots de passe', async () => {
    const pool = new Pool({ connectionString: TEST_DB });
    const r = await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE data::text ILIKE '%Provisoire-123456%' OR data::text ILIKE '%Nouveau-mot-de-passe%'");
    expect(r.rows[0].n).toBe(0);
    await pool.end();
  });
});

describe('Temps réel', () => {
  it('refuse une connexion sans session et diffuse les changements de modules aux membres', async () => {
    const anon: Socket = ioClient(`http://localhost:${port}`, { path: '/api/realtime', transports: ['websocket'], reconnection: false });
    const err = await new Promise<Error>((resolve) => anon.on('connect_error', resolve));
    expect(err.message).toBe('UNAUTHENTICATED');
    anon.close();

    const socket: Socket = ioClient(`http://localhost:${port}`, {
      path: '/api/realtime', transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: admin.cookie },
    });
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    const joined = await socket.emitWithAck('join', { associationId: assocA });
    expect(joined.ok).toBe(true);
    const received = new Promise<{ changes: { module: string }[] }>((resolve) => socket.on('modules:changed', resolve));
    await admin.post('/api/admin/modules/projects/activate', {});
    const evt = await received;
    expect(evt.changes[0].module).toBe('projects');
    socket.close();
  });
});

describe('Validation des fiches', () => {
  it('accepte des champs de date vides (formulaire) et refuse une date mal formée', async () => {
    const ok = await admin.post('/api/asso/members', { firstName: 'Date', lastName: 'Vide', birthDate: '', joinedAt: '', email: '' });
    expect(ok.status).toBe(201);
    expect(ok.body.birthDate).toBeNull();
    const ko = await admin.post('/api/asso/members', { firstName: 'Date', lastName: 'Fausse', birthDate: '31/12/2000' });
    expect(ko.status).toBe(400);
  });

  it('importe un CSV après simulation et neutralise les formules à l’export', async () => {
    const csv = 'Nom;Prénom;E-mail;Date de naissance\nCurie;Marie;marie@example.org;07/11/1867\n=CMD();Formule;;\n;SansNom;;';
    const dry = await admin.post('/api/asso/members/import', { csv, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.valid).toBe(2);
    expect(dry.body.errors).toHaveLength(1);
    const real = await admin.post('/api/asso/members/import', { csv, dryRun: false });
    expect(real.body.imported).toBe(2);
    const exp = await admin.get('/api/asso/members/export.csv?q=Formule');
    expect(exp.status).toBe(200);
    expect(exp.text).toContain("'=CMD()");
  });
});
