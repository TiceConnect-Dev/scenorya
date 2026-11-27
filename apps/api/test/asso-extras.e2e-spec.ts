import { INestApplication } from '@nestjs/common';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let assoc: string;
const ids: string[] = [];

const binary = (r: import('supertest').Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Théâtre des Groupes' }, modules: ['asso'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  for (const [f, l] of [['Molière', 'Poquelin'], ['Madeleine', 'Béjart'], ['Armande', 'Béjart']]) {
    ids.push((await admin.post('/api/asso/members', { firstName: f, lastName: l })).body.id);
  }
});

afterAll(async () => {
  await app?.close();
});

describe('Groupes et commissions', () => {
  let groupId: string;
  it('crée un groupe, ajoute des membres avec fonction et filtre la liste', async () => {
    const g = await admin.post('/api/asso/groups', { name: 'Commission programmation', kind: 'commission' });
    expect(g.status).toBe(201);
    groupId = g.body.id;
    expect((await admin.post('/api/asso/groups', { name: 'Commission programmation' })).status).toBe(409);
    expect((await admin.put(`/api/asso/groups/${groupId}/members`, { memberIds: [ids[0]], role: 'Président' })).status).toBe(200);
    expect((await admin.put(`/api/asso/groups/${groupId}/members`, { memberIds: [ids[1]] })).status).toBe(200);
    const members = await admin.get(`/api/asso/groups/${groupId}/members`);
    expect(members.body).toHaveLength(2);
    expect(members.body.find((m: { id: string }) => m.id === ids[0]).role).toBe('Président');
    const filtered = await admin.get(`/api/asso/members?groupId=${groupId}`);
    expect(filtered.body.total).toBe(2);
    const ofMember = await admin.get(`/api/asso/groups?memberId=${ids[0]}`);
    expect(ofMember.body[0].role).toBe('Président');
  });

  it('retire un membre et archive le groupe', async () => {
    expect((await admin.delete(`/api/asso/groups/${groupId}/members/${ids[1]}`)).status).toBe(200);
    expect((await admin.post(`/api/asso/groups/${groupId}/archive`, {})).status).toBe(200);
    expect((await admin.get('/api/asso/groups')).body).toHaveLength(0);
    expect((await admin.put(`/api/asso/groups/${groupId}/members`, { memberIds: [ids[2]] })).body.code).toBe('GROUP_ARCHIVED');
  });

  it('refuse un adhérent d’une autre association', async () => {
    const g = await admin.post('/api/asso/groups', { name: 'Troupe', kind: 'troupe' });
    const b = await admin.post('/api/system/associations', { name: 'Autre', modules: ['asso'] });
    const other = new Client(app);
    other.cookie = admin.cookie;
    other.csrf = admin.csrf;
    other.association = b.body.association.id;
    const foreign = await other.post('/api/asso/members', { firstName: 'X', lastName: 'Y' });
    expect((await admin.put(`/api/asso/groups/${g.body.id}/members`, { memberIds: [foreign.body.id] })).status).toBe(404);
  });
});

describe('Champs personnalisés', () => {
  it('valide les types, les listes et les champs obligatoires', async () => {
    expect((await admin.post('/api/asso/fields', { label: 'Taille de costume', type: 'select', options: ['S'] })).body.code).toBe('OPTIONS_REQUIRED');
    const size = await admin.post('/api/asso/fields', { label: 'Taille de costume', type: 'select', options: ['S', 'M', 'L'], required: true });
    expect(size.body.key).toBe('taille_de_costume');
    await admin.post('/api/asso/fields', { label: 'Allergies', type: 'text', sensitive: true });
    await admin.post('/api/asso/fields', { label: 'Permis B', type: 'boolean' });
    expect((await admin.post('/api/asso/members', { firstName: 'A', lastName: 'B' })).status).toBe(400); // obligatoire manquant
    expect((await admin.post('/api/asso/members', { firstName: 'A', lastName: 'B', custom: { taille_de_costume: 'XXL' } })).status).toBe(400);
    expect((await admin.post('/api/asso/members', { firstName: 'A', lastName: 'B', custom: { taille_de_costume: 'M', inconnu: 1 } })).status).toBe(400);
    const ok = await admin.post('/api/asso/members', { firstName: 'Jean', lastName: 'Racine', custom: { taille_de_costume: 'M', allergies: 'Arachides', permis_b: true } });
    expect(ok.status).toBe(201);
    expect(ok.body.custom).toEqual({ taille_de_costume: 'M', allergies: 'Arachides', permis_b: true });
    // Mise à jour partielle : les autres valeurs sont conservées.
    const upd = await admin.patch(`/api/asso/members/${ok.body.id}`, { custom: { permis_b: false } });
    expect(upd.body.custom).toEqual({ taille_de_costume: 'M', allergies: 'Arachides', permis_b: false });
  });

  it('masque les champs sensibles sans le droit dédié et les exporte avec', async () => {
    const role = await admin.post('/api/admin/roles', { name: 'Lecture', permissions: ['asso.read', 'asso.members.read', 'asso.members.export'] });
    await admin.post('/api/admin/users', { email: 'l@x.fr', displayName: 'Lecteur', password: 'Provisoire-123456', roleIds: [role.body.id] });
    const l = new Client(app);
    await l.login('l@x.fr', 'Provisoire-123456');
    await l.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Lecteur-Pass-2026' });
    l.association = assoc;
    const r = await l.get('/api/asso/members?q=Racine');
    expect(r.body.items[0].custom).toEqual({ taille_de_costume: 'M', permis_b: false });
    const csv = await l.get('/api/asso/members/export.csv?q=Racine');
    expect(csv.text).toContain('Taille de costume');
    expect(csv.text).not.toContain('Arachides');
    expect((await admin.get('/api/asso/members/export.csv?q=Racine')).text).toContain('Arachides');
  });

  it('archiver un champ conserve les valeurs et lève l’obligation', async () => {
    const fields = (await admin.get('/api/asso/fields')).body as { id: string; key: string }[];
    const size = fields.find((f) => f.key === 'taille_de_costume')!;
    expect((await admin.patch(`/api/asso/fields/${size.id}`, { archived: true })).status).toBe(200);
    expect((await admin.post('/api/asso/members', { firstName: 'Sans', lastName: 'Taille' })).status).toBe(201);
  });
});

describe("Cartes d'adhérent", () => {
  let token: string;

  it('génère une carte PDF et une planche A4', async () => {
    const one = await binary(admin.get(`/api/asso/members/${ids[0]}/card.pdf`));
    expect(one.status).toBe(200);
    expect((one.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const sheet = await binary(admin.get(`/api/asso/cards.pdf?ids=${ids.join(',')}`));
    expect(sheet.status).toBe(200);
    expect(sheet.headers['content-disposition']).toContain('cartes-adherents');
  });

  it('le jeton n’apparaît pas dans les fiches et le QR ne contient aucune donnée personnelle', async () => {
    const m = await admin.get(`/api/asso/members/${ids[0]}`);
    expect(m.body.cardToken).toBeUndefined();
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    token = (await pool.query('select card_token from members where id = $1', [ids[0]])).rows[0].card_token;
    await pool.end();
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(token.toLowerCase()).not.toContain('poquelin');
  });

  it('vérification publique : invalide sans cotisation, valide après règlement, minimum de données', async () => {
    const anon = new Client(app);
    let v = await anon.get(`/api/public/cards/${token}`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ available: true, association: 'Théâtre des Groupes', member: 'Molière P.', valid: false });
    expect(JSON.stringify(v.body)).not.toContain('Poquelin');
    const d = await admin.post('/api/asso/dues', { memberId: ids[0], amountCents: 0, periodType: 'calendar_year' });
    expect(d.body.status).toBe('paid'); // cotisation gratuite réglée d'office
    v = await anon.get(`/api/public/cards/${token}`);
    expect(v.body.valid).toBe(true);
    expect(v.body.validUntil).toBe(`${new Date().getFullYear()}-12-31`);
  });

  it('révocation : l’ancien QR devient inconnu', async () => {
    expect((await admin.post(`/api/asso/members/${ids[0]}/card/revoke`)).status).toBe(200);
    expect((await new Client(app).get(`/api/public/cards/${token}`)).status).toBe(404);
    expect((await new Client(app).get('/api/public/cards/court')).status).toBe(404);
  });

  it('module désactivé : la vérification publique indique l’indisponibilité', async () => {
    const card = await binary(admin.get(`/api/asso/members/${ids[1]}/card.pdf`));
    expect(card.status).toBe(200);
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const t = (await pool.query('select card_token from members where id = $1', [ids[1]])).rows[0].card_token;
    await pool.end();
    await admin.post('/api/admin/modules/asso/deactivate', { mode: 'inactive', acknowledgeWarnings: true });
    const v = await new Client(app).get(`/api/public/cards/${t}`);
    expect(v.body).toEqual({ association: 'Théâtre des Groupes', available: false });
    await admin.post('/api/admin/modules/asso/activate', {});
  });
});

describe('Modifications partielles', () => {
  it('ne réinitialise aucun champ non transmis (adhérent, formule, rôle)', async () => {
    const m = await admin.post('/api/asso/members', { firstName: 'Paul', lastName: 'Claudel', email: 'paul@example.org', phone: '0600000000', city: 'Villeneuve', category: 'benevole', status: 'pending', imageRights: true, skills: ['Écriture'] });
    const upd = await admin.patch(`/api/asso/members/${m.body.id}`, { firstName: 'Paul-Louis' });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ firstName: 'Paul-Louis', email: 'paul@example.org', phone: '0600000000', city: 'Villeneuve', category: 'benevole', status: 'pending', imageRights: true, skills: ['Écriture'] });
    const plan = await admin.post('/api/asso/plans', { name: 'Famille', amountCents: 4000, periodType: 'fiscal_year', memberCategory: 'actif', description: 'Deux adultes' });
    const p2 = await admin.patch(`/api/asso/plans/${plan.body.id}`, { amountCents: 4500 });
    expect(p2.body).toMatchObject({ amountCents: 4500, periodType: 'fiscal_year', memberCategory: 'actif', description: 'Deux adultes', active: true });
    const role = await admin.post('/api/admin/roles', { name: 'Accueil', description: 'Équipe d’accueil', permissions: ['asso.read'] });
    const r2 = await admin.patch(`/api/admin/roles/${role.body.id}`, { name: 'Accueil public' });
    expect(r2.body).toMatchObject({ name: 'Accueil public', description: 'Équipe d’accueil', permissions: ['asso.read'] });
    const g = await admin.post('/api/asso/groups', { name: 'Bureau', kind: 'bureau', description: 'Bureau élu' });
    const g2 = await admin.patch(`/api/asso/groups/${g.body.id}`, { description: 'Bureau élu en AG' });
    expect(g2.body).toMatchObject({ kind: 'bureau', name: 'Bureau' });
  });
});
