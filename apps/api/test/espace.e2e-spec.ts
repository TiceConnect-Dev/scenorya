import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let assoc: string;
let alice: string;
let bob: string;
let token: string;
const pub = () => request(app.getHttpServer());
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const soon = (days: number, h = 19) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString();
};

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Les Tréteaux' }, modules: ['asso', 'espace', 'agenda', 'drive'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  alice = (await admin.post('/api/asso/members', { firstName: 'Alice', lastName: 'Martin', email: 'alice@example.org', phone: '0600000000' })).body.id;
  bob = (await admin.post('/api/asso/members', { firstName: 'Bob', lastName: 'Durand', email: 'bob@example.org' })).body.id;
});

afterAll(async () => {
  await app?.close();
});

describe('Invitation', () => {
  it('crée une invitation (lien à transmettre sans SMTP) et refuse les doublons de liaison', async () => {
    const r = await admin.post(`/api/asso/members/${alice}/espace/invite`, { send: true });
    expect(r.status).toBe(201);
    expect(r.body.emailStatus).toMatch(/^failed/); // messagerie non configurée : l'échec est signalé, le lien reste utilisable
    token = r.body.url.split('/invitation/')[1];
    const st = (await admin.get(`/api/asso/members/${alice}/espace`)).body;
    expect(st.account).toBeNull();
    expect(st.invitation.email).toBe('alice@example.org');
    // Une nouvelle invitation révoque la précédente.
    const again = await admin.post(`/api/asso/members/${alice}/espace/invite`, { send: false });
    expect((await pub().get(`/api/public/invitations/${token}`)).status).toBe(404);
    token = again.body.url.split('/invitation/')[1];
    const info = await pub().get(`/api/public/invitations/${token}`);
    expect(info.body).toMatchObject({ association: 'Les Tréteaux', firstName: 'Alice', accountExists: false });
  });

  it('crée le compte, avec le rôle Adhérent, et l’invitation devient inutilisable', async () => {
    expect((await pub().post(`/api/public/invitations/${token}/accept`).send({ password: 'court' })).status).toBe(400);
    const ok = await pub().post(`/api/public/invitations/${token}/accept`).send({ password: 'Alice-Espace-2026' });
    expect(ok.status).toBe(201);
    expect((await pub().post(`/api/public/invitations/${token}/accept`).send({ password: 'Alice-Espace-2026' })).status).toBe(404);
    const st = (await admin.get(`/api/asso/members/${alice}/espace`)).body;
    expect(st.account.email).toBe('alice@example.org');
    const users = (await admin.get('/api/admin/users')).body;
    expect(JSON.stringify(users.find((u: { email: string }) => u.email === 'alice@example.org'))).toContain('Adhérent');
  });

  it('un compte existant doit se connecter avec la même adresse pour accepter', async () => {
    await admin.post('/api/admin/users', { email: 'bob@example.org', displayName: 'Bob D.', password: 'Provisoire-123456', roleIds: [] });
    const r = await admin.post(`/api/asso/members/${bob}/espace/invite`, { send: false });
    const t = r.body.url.split('/invitation/')[1];
    expect((await pub().get(`/api/public/invitations/${t}`)).body.accountExists).toBe(true);
    expect((await pub().post(`/api/public/invitations/${t}/accept`).send({ password: 'Autre-Mot-De-Passe-1' })).body.code).toBe('ACCOUNT_EXISTS');
    // Alice (autre adresse) ne peut pas s'en emparer.
    const a = new Client(app);
    await a.login('alice@example.org', 'Alice-Espace-2026');
    expect((await a.post(`/api/espace/invitations/${t}/claim`)).body.code).toBe('INVITATION_EMAIL_MISMATCH');
    const b = new Client(app);
    await b.login('bob@example.org', 'Provisoire-123456');
    await b.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Bob-Espace-2026-ok' });
    const claim = await b.post(`/api/espace/invitations/${t}/claim`);
    expect(claim.status).toBe(200);
    b.association = assoc;
    expect((await b.get('/api/espace/me')).body.member.firstName).toBe('Bob');
  });
});

describe('Espace personnel', () => {
  let me: Client;
  beforeAll(async () => {
    me = new Client(app);
    await me.login('alice@example.org', 'Alice-Espace-2026');
    me.association = assoc;
  });

  it('affiche uniquement sa propre fiche et refuse le reste de l’association', async () => {
    const r = (await me.get('/api/espace/me')).body;
    expect(r.member).toMatchObject({ firstName: 'Alice', email: 'alice@example.org' });
    expect(r.upToDate).toBe(false);
    expect((await me.get('/api/asso/members')).status).toBe(403);
    expect((await me.get(`/api/asso/members/${bob}`)).status).toBe(403);
    expect((await me.get('/api/drive/browse')).status).toBe(403);
  });

  it('modifie ses coordonnées (champs autorisés uniquement), avec trace dans l’audit', async () => {
    const r = await me.patch('/api/espace/me', { phone: '0611223344', city: 'Lille', number: 999, notes: 'pirate', status: 'archived' });
    expect(r.body.changed.sort()).toEqual(['city', 'phone']);
    const fiche = (await admin.get(`/api/asso/members/${alice}`)).body;
    expect(fiche).toMatchObject({ phone: '0611223344', city: 'Lille', status: 'active' });
    expect(fiche.notes ?? null).toBeNull();
    const audit = (await admin.get('/api/admin/audit')).body;
    expect(JSON.stringify(audit)).toContain('a mis à jour sa fiche depuis son espace');
  });

  it('cotisations : liste, reçu et carte', async () => {
    const plan = await admin.post('/api/asso/plans', { name: 'Adhésion', amountCents: 3000, periodType: 'calendar_year' });
    const due = await admin.post('/api/asso/dues', { memberId: alice, planId: plan.body.id, periodStart: new Date().toISOString().slice(0, 10) });
    const other = await admin.post('/api/asso/dues', { memberId: bob, planId: plan.body.id, periodStart: new Date().toISOString().slice(0, 10) });
    await admin.post(`/api/asso/dues/${due.body.id}/payments`, { amountCents: 3000, method: 'cash' });
    await admin.post(`/api/asso/dues/${other.body.id}/payments`, { amountCents: 3000, method: 'cash' });
    const list = (await me.get('/api/espace/dues')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ paidCents: 3000, status: 'paid' });
    expect(list[0].receipt).toBeTruthy();
    const pdf = await me.get(`/api/espace/dues/${due.body.id}/receipt.pdf`).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await me.get(`/api/espace/dues/${other.body.id}/receipt.pdf`)).status).toBe(404); // reçu d'un autre adhérent
    expect((await me.get('/api/espace/me')).body.upToDate).toBe(true);
    const card = await me.get('/api/espace/card.pdf').buffer(true).parse(binary);
    expect(card.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('agenda : voit ses invitations et y répond', async () => {
    const ev = await admin.post('/api/agenda/events', { title: 'Répétition', category: 'rehearsal', start: soon(3), end: soon(3, 21), memberIds: [alice] });
    await admin.post('/api/agenda/events', { title: 'Réunion technique', start: soon(4), end: soon(4, 21), memberIds: [bob] });
    const list = (await me.get('/api/espace/events')).body;
    expect(list.map((e: { title: string }) => e.title)).toEqual(['Répétition']);
    expect((await me.post(`/api/espace/events/${ev.body.event.id}/response`, { status: 'yes', comment: 'Avec le texte su' })).body.status).toBe('yes');
    const detail = (await admin.get(`/api/agenda/events/${ev.body.event.id}`)).body;
    expect(detail.participants[0]).toMatchObject({ status: 'yes' });
  });

  it('réunions : convocation disponible, procès-verbal seulement après clôture', async () => {
    const mt = await admin.post('/api/asso/meetings', { type: 'ag_ordinaire', title: 'AG', startAt: soon(20, 13), agendaItems: [{ title: 'Rapport moral' }] });
    await admin.put(`/api/asso/meetings/${mt.body.id}/attendees`, { allActive: true });
    expect((await me.get('/api/espace/meetings')).body).toEqual([]); // brouillon : invisible
    await admin.post(`/api/asso/meetings/${mt.body.id}/convene`, { send: false });
    const list = (await me.get('/api/espace/meetings')).body;
    expect(list[0]).toMatchObject({ title: 'AG', convocation: true, minutes: false });
    expect((await me.get(`/api/espace/meetings/${mt.body.id}/convocation.pdf`)).status).toBe(200);
    expect((await me.get(`/api/espace/meetings/${mt.body.id}/proces-verbal.pdf`)).status).toBe(404);
    expect((await me.get(`/api/espace/meetings/${mt.body.id}/emargement.pdf`)).status).toBe(404);
  });

  it('documents : seuls les dossiers Drive publiés dans l’Espace sont visibles', async () => {
    const pubF = await admin.post('/api/drive/folders', { name: 'Pour les membres' });
    const sub = await admin.post('/api/drive/folders', { name: 'Textes', parentId: pubF.body.id });
    const priv = await admin.post('/api/drive/folders', { name: 'Bureau' });
    await admin.upload('/api/drive/files', [{ name: 'Règlement intérieur.pdf', content: '%PDF règlement' }], { folderId: sub.body.id });
    const secret = await admin.upload('/api/drive/files', [{ name: 'Budget.xlsx', content: 'budget' }], { folderId: priv.body.id });
    expect((await me.get('/api/espace/documents')).body).toEqual([]);
    await admin.put(`/api/drive/folders/${pubF.body.id}/access`, { restricted: false, espace: true });
    const docs = (await me.get('/api/espace/documents')).body;
    expect(docs.map((d: { name: string; folder: string }) => `${d.folder}/${d.name}`)).toEqual(['Pour les membres / Textes/Règlement intérieur.pdf']);
    const dl = await me.get(`/api/espace/documents/${docs[0].id}`).buffer(true).parse(binary);
    expect(dl.body.toString()).toBe('%PDF règlement');
    expect((await me.get(`/api/espace/documents/${secret.body.files[0].id}`)).status).toBe(404);
  });

  it('retirer l’accès détache la fiche', async () => {
    await admin.delete(`/api/asso/members/${alice}/espace`).expect(200);
    expect((await me.get('/api/espace/me')).body.member).toBeNull();
    expect((await me.get('/api/espace/dues')).status).toBe(404);
  });
});
