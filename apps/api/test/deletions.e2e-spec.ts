import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let assoc: string;
const today = new Date().toISOString().slice(0, 10);
const del = (url: string, body?: object) => {
  const t = request(app.getHttpServer()).delete(url).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf).set('X-Scenorya-Association', assoc);
  return body ? t.send(body) : t;
};

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'À supprimer' }, modules: ['asso', 'agenda', 'projects', 'drive', 'espace'] });
  assoc = res.body.associationId;
  admin.association = assoc;
});

afterAll(async () => {
  await app?.close();
});

describe('Adhérents et cotisations', () => {
  it('supprime une fiche sans historique financier immédiatement', async () => {
    const m = await admin.post('/api/asso/members', { firstName: 'Erreur', lastName: 'De Saisie' });
    const r = await admin.delete(`/api/asso/members/${m.body.id}`);
    expect(r.body).toMatchObject({ ok: true, mode: 'deleted' });
    expect((await admin.get(`/api/asso/members/${m.body.id}`)).status).toBe(404);
  });

  it('demande confirmation quand des règlements existent, puis supprime tout', async () => {
    const m = await admin.post('/api/asso/members', { firstName: 'Paul', lastName: 'Payeur' });
    const plan = await admin.post('/api/asso/plans', { name: 'Annuelle', amountCents: 2000, periodType: 'calendar_year' });
    const due = await admin.post('/api/asso/dues', { memberId: m.body.id, planId: plan.body.id, periodStart: today });
    await admin.post(`/api/asso/dues/${due.body.id}/payments`, { amountCents: 2000, method: 'cash' });
    const first = await admin.delete(`/api/asso/members/${m.body.id}`);
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('CONFIRM_REQUIRED');
    expect(first.body.message).toContain('reçu');
    const ok = await admin.delete(`/api/asso/members/${m.body.id}?force=1`);
    expect(ok.body.mode).toBe('deleted');
    expect((await admin.get(`/api/asso/dues/${due.body.id}`)).status).toBe(404);
    // La formule se supprime ; ses cotisations éventuelles seraient conservées.
    expect((await admin.delete(`/api/asso/plans/${plan.body.id}`)).status).toBe(200);
    const audit = JSON.stringify((await admin.get('/api/admin/audit')).body);
    expect(audit).toContain('Suppression définitive de la fiche');
  });

  it('supprime une cotisation avec ses règlements après confirmation', async () => {
    const m = await admin.post('/api/asso/members', { firstName: 'Dora', lastName: 'Due' });
    const plan = await admin.post('/api/asso/plans', { name: 'Saison', amountCents: 1500, periodType: 'calendar_year' });
    const due = await admin.post('/api/asso/dues', { memberId: m.body.id, planId: plan.body.id, periodStart: today });
    await admin.post(`/api/asso/dues/${due.body.id}/payments`, { amountCents: 500, method: 'cash' });
    expect((await admin.delete(`/api/asso/dues/${due.body.id}`)).body.code).toBe('CONFIRM_REQUIRED');
    expect((await admin.delete(`/api/asso/dues/${due.body.id}?force=1`)).status).toBe(200);
    // Une formule utilisée se supprime aussi : les cotisations gardent libellé et montant.
    const due2 = await admin.post('/api/asso/dues', { memberId: m.body.id, planId: plan.body.id, periodStart: today });
    expect((await admin.delete(`/api/asso/plans/${plan.body.id}`)).body.detachedDues).toBe(1);
    expect((await admin.get(`/api/asso/dues/${due2.body.id}`)).body.amountCents).toBe(1500);
  });

  it('anonymise une fiche citée dans un procès-verbal figé', async () => {
    const m = await admin.post('/api/asso/members', { firstName: 'Victor', lastName: 'Votant', email: 'v@x.fr' });
    const mt = await admin.post('/api/asso/meetings', { type: 'bureau', title: 'Bureau', startAt: '2026-01-10T18:00:00+01:00', agendaItems: [{ title: 'Point' }] });
    await admin.put(`/api/asso/meetings/${mt.body.id}/attendees`, { memberIds: [m.body.id] });
    await admin.post(`/api/asso/meetings/${mt.body.id}/convene`, { send: false });
    await admin.patch(`/api/asso/meetings/${mt.body.id}/attendees/${m.body.id}`, { status: 'present' });
    await admin.patch(`/api/asso/meetings/${mt.body.id}`, { minutes: 'Compte rendu.' });
    expect((await admin.post(`/api/asso/meetings/${mt.body.id}/close`)).status).toBe(200);
    expect((await admin.delete(`/api/asso/members/${m.body.id}`)).body.code).toBe('CONFIRM_REQUIRED');
    const r = await admin.delete(`/api/asso/members/${m.body.id}?force=1`);
    expect(r.body.mode).toBe('anonymized');
    const fiche = (await admin.get(`/api/asso/members/${m.body.id}`)).body;
    expect(fiche).toMatchObject({ firstName: 'Adhérent', email: null, status: 'archived' });
    // La réunion clôturée elle-même : confirmation, puis suppression (le déclencheur ne l'ignore plus).
    expect((await admin.delete(`/api/asso/meetings/${mt.body.id}`)).body.code).toBe('CONFIRM_REQUIRED');
    expect((await admin.delete(`/api/asso/meetings/${mt.body.id}?force=1`)).status).toBe(200);
    expect((await admin.get(`/api/asso/meetings/${mt.body.id}`)).status).toBe(404);
  });

  it('supprime une réunion en préparation (correctif du déclencheur) et un mandat', async () => {
    const mt = await admin.post('/api/asso/meetings', { type: 'ca', title: 'CA', startAt: '2027-03-01T18:00:00+01:00', agendaItems: [] });
    expect((await admin.delete(`/api/asso/meetings/${mt.body.id}`)).status).toBe(200);
    expect((await admin.get(`/api/asso/meetings/${mt.body.id}`)).status).toBe(404);
    const m = await admin.post('/api/asso/members', { firstName: 'Marie', lastName: 'Mandat' });
    const md = await admin.post('/api/asso/mandates', { memberId: m.body.id, body: 'bureau', role: 'Trésorière', startDate: '2026-01-01' });
    expect((await admin.delete(`/api/asso/mandates/${md.body.id}`)).status).toBe(200);
    expect((await admin.get('/api/asso/mandates')).body).toEqual([]);
  });

  it('supprime groupes et champs personnalisés (valeurs effacées des fiches)', async () => {
    const g = await admin.post('/api/asso/groups', { name: 'Chorale' });
    const m = await admin.post('/api/asso/members', { firstName: 'Gaston', lastName: 'Groupe' });
    await admin.put(`/api/asso/groups/${g.body.id}/members`, { memberIds: [m.body.id] });
    expect((await admin.delete(`/api/asso/groups/${g.body.id}`)).status).toBe(200);
    expect((await admin.get(`/api/asso/members/${m.body.id}`)).status).toBe(200);
    const f = await admin.post('/api/asso/fields', { label: 'Pointure', type: 'number' });
    await admin.patch(`/api/asso/members/${m.body.id}`, { custom: { [f.body.key]: 42 } });
    expect((await admin.delete(`/api/asso/fields/${f.body.id}`)).body.cleared).toBe(1);
    expect((await admin.get(`/api/asso/members/${m.body.id}`)).body.custom).toEqual({});
  });
});

describe('Projets, utilisateurs, instance', () => {
  it('supprime un projet, ses tâches et un commentaire', async () => {
    const p = await admin.post('/api/projects', { name: 'Tournée' });
    const t = await admin.post(`/api/projects/${p.body.id}/tasks`, { title: 'Camion' });
    const k = await admin.post(`/api/tasks/${t.body.id}/comments`, { body: 'à voir' });
    expect((await admin.delete(`/api/tasks/${t.body.id}/comments/${k.body.id}`)).status).toBe(200);
    expect((await admin.delete(`/api/projects/${p.body.id}`)).body.tasks).toBe(1);
    expect((await admin.get(`/api/tasks/${t.body.id}`)).status).toBe(404);
  });

  it('retire un utilisateur ; sans autre association, son compte est supprimé', async () => {
    const roles = (await admin.get('/api/admin/roles')).body;
    await admin.post('/api/admin/users', { email: 'temp@x.fr', displayName: 'Temporaire', password: 'Provisoire-123456', roleIds: [roles.find((r: { key: string }) => r.key === 'benevole').id] });
    const u = (await admin.get('/api/admin/users')).body.find((x: { email: string }) => x.email === 'temp@x.fr');
    const me = (await admin.get('/api/admin/users')).body.find((x: { email: string }) => x.email === ADMIN.email);
    expect((await admin.delete(`/api/admin/users/${me.id}`)).body.code).toBe('SELF_DELETE');
    const r = await admin.delete(`/api/admin/users/${u.id}`);
    expect(r.body.accountDeleted).toBe(true);
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'temp@x.fr', password: 'Provisoire-123456' });
    expect(login.status).toBe(401);
  });

  it('supprime la configuration SMTP', async () => {
    await admin.put('/api/system/smtp', { host: 'smtp.example.org', port: 587, secure: false, user: 'u', password: 'p', from: 'Scenorya <no-reply@example.org>' });
    expect((await admin.get('/api/system/smtp')).body).not.toBeNull();
    expect((await admin.delete('/api/system/smtp')).status).toBe(200);
    expect((await admin.get('/api/system/smtp')).body.host).toBeUndefined();
  });

  it('supprime une association entière après saisie de son nom', async () => {
    const other = await admin.post('/api/system/associations', { name: 'Éphémère', modules: ['asso', 'drive'], joinAsAdmin: true });
    const id = other.body.association.id;
    admin.association = id;
    await admin.post('/api/asso/members', { firstName: 'A', lastName: 'B' });
    await admin.upload('/api/drive/files', [{ name: 'note.txt', content: 'contenu propre à Éphémère' }]);
    const blobsBefore = (await admin.get('/api/system/drive')).body.blobs;
    admin.association = assoc;
    expect((await del(`/api/system/associations/${id}`, { confirmName: 'Ephemere' })).body.code).toBe('CONFIRM_NAME');
    const r = await del(`/api/system/associations/${id}`, { confirmName: 'Éphémère' });
    expect(r.status).toBe(200);
    expect(r.body.members).toBe(1);
    expect((await admin.get('/api/system/associations')).body.map((a: { name: string }) => a.name)).not.toContain('Éphémère');
    expect((await admin.get('/api/system/drive')).body.blobs).toBe(blobsBefore - 1);
    const me = (await admin.get('/api/auth/me')).body;
    expect(me.associations.map((a: { id: string }) => a.id)).not.toContain(id);
    // Le journal d'audit, en ajout seul, conserve la trace.
    expect(JSON.stringify((await admin.get('/api/system/audit')).body)).toContain('Suppression de l’association « Éphémère »');
  });
});
