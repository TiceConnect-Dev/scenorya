import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { ADMIN, Client, configureTestEnv, resetDatabase, TEST_DB } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
const m: string[] = [];
let meetingId: string;

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
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Association Gouvernance' }, modules: ['asso', 'agenda'] });
  admin.association = res.body.associationId;
  for (const [f, l] of [['Anne', 'Présidente'], ['Bernard', 'Secrétaire'], ['Claire', 'Membre'], ['David', 'Membre'], ['Emma', 'Membre']]) {
    m.push((await admin.post('/api/asso/members', { firstName: f, lastName: l, email: `${f.toLowerCase()}@example.org` })).body.id);
  }
  await admin.post('/api/asso/members', { firstName: 'Inactif', lastName: 'Ancien', status: 'expired' });
});

afterAll(async () => {
  await app?.close();
});

describe('Mandats', () => {
  it('enregistre le bureau, utilisé pour les signatures', async () => {
    expect((await admin.post('/api/asso/mandates', { memberId: m[0], body: 'bureau', role: 'Présidente', startDate: '2025-06-01' })).status).toBe(201);
    expect((await admin.post('/api/asso/mandates', { memberId: m[1], body: 'bureau', role: 'Secrétaire', startDate: '2025-06-01' })).status).toBe(201);
    expect((await admin.post('/api/asso/mandates', { memberId: m[2], body: 'ca', role: 'Administratrice', startDate: '2025-06-01', endDate: '2025-01-01' })).body.code).toBe('INVALID_DATES');
    expect((await admin.get('/api/asso/mandates')).body).toHaveLength(2);
  });
});

describe('Assemblée générale', () => {
  it('crée la réunion et l’inscrit à l’agenda', async () => {
    const r = await admin.post('/api/asso/meetings', {
      type: 'ag_ordinaire', title: 'AG 2027', startAt: '2027-06-12T14:00:00+02:00', location: 'Salle des fêtes',
      quorumPercent: 50, maxProxies: 1,
      agendaItems: [{ title: 'Rapport moral', vote: true }, { title: 'Rapport financier', vote: true }, { title: 'Questions diverses' }],
    });
    expect(r.status).toBe(201);
    meetingId = r.body.id;
    expect(r.body.eventId).toBeTruthy();
    const ev = await admin.get(`/api/agenda/events/${r.body.eventId}`);
    expect(ev.body.title).toBe('Assemblée générale ordinaire — AG 2027');
  });

  it('convoque tous les adhérents actifs (sans les inactifs)', async () => {
    expect((await admin.post(`/api/asso/meetings/${meetingId}/convene`, {})).body.code).toBe('NO_ATTENDEES');
    const add = await admin.put(`/api/asso/meetings/${meetingId}/attendees`, { allActive: true });
    expect(add.body.added).toBe(5);
    // Envoi par e-mail impossible sans SMTP : refus explicite.
    expect((await admin.post(`/api/asso/meetings/${meetingId}/convene`, { send: true })).body.code).toBe('SMTP_NOT_CONFIGURED');
    const c = await admin.post(`/api/asso/meetings/${meetingId}/convene`, { send: false });
    expect(c.body.convoked).toBe(5);
    expect((await admin.get(`/api/asso/meetings/${meetingId}`)).body.status).toBe('convened');
  });

  it('présences, procurations (limite, mandataire présent) et quorum', async () => {
    const p = (id: string, body: object) => admin.patch(`/api/asso/meetings/${meetingId}/attendees/${id}`, body);
    expect((await p(m[3], { status: 'represented', proxyMemberId: m[0] })).body.code).toBe('PROXY_NOT_PRESENT');
    for (const i of [0, 1, 2]) expect((await p(m[i], { status: 'present' })).status).toBe(200);
    expect((await p(m[3], { status: 'represented' })).body.code).toBe('PROXY_REQUIRED');
    expect((await p(m[3], { status: 'represented', proxyMemberId: m[3] })).body.code).toBe('PROXY_SELF');
    expect((await p(m[3], { status: 'represented', proxyMemberId: m[0] })).status).toBe(200);
    expect((await p(m[4], { status: 'represented', proxyMemberId: m[0] })).body.code).toBe('PROXY_LIMIT');
    expect((await p(m[0], { status: 'absent' })).body.code).toBe('PROXY_HOLDER');
    expect((await p(m[4], { status: 'excused' })).status).toBe(200);
    const g = await admin.get(`/api/asso/meetings/${meetingId}`);
    expect(g.body.quorum).toMatchObject({ total: 5, present: 3, represented: 1, percent: 80, required: 50, reached: true });
  });

  it('délibérations : numérotation et contrôle du nombre de voix', async () => {
    expect((await admin.post(`/api/asso/meetings/${meetingId}/resolutions`, { title: 'Trop de voix', votesFor: 5 })).body.code).toBe('TOO_MANY_VOTES');
    const r1 = await admin.post(`/api/asso/meetings/${meetingId}/resolutions`, { title: 'Approbation du rapport moral', votesFor: 4, result: 'adopted' });
    const r2 = await admin.post(`/api/asso/meetings/${meetingId}/resolutions`, { title: 'Approbation des comptes' });
    expect([r1.body.number, r2.body.number]).toEqual([1, 2]);
    expect((await admin.post(`/api/asso/meetings/${meetingId}/close`)).body.code).toBe('MINUTES_REQUIRED');
    await admin.patch(`/api/asso/meetings/${meetingId}`, { minutes: 'La présidente présente le rapport moral. Débat sur la saison prochaine.' });
    expect((await admin.post(`/api/asso/meetings/${meetingId}/close`)).body.code).toBe('PENDING_RESOLUTIONS');
    expect((await admin.patch(`/api/asso/meetings/${meetingId}/resolutions/${r2.body.id}`, { votesFor: 3, votesAgainst: 1, result: 'adopted' })).status).toBe(200);
  });

  it('génère convocation, feuille d’émargement et procès-verbal en PDF', async () => {
    for (const doc of ['convocation', 'emargement', 'proces-verbal']) {
      const r = await binary(admin.get(`/api/asso/meetings/${meetingId}/${doc}.pdf`));
      expect(r.status).toBe(200);
      expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await admin.get(`/api/asso/meetings/${meetingId}/autre.pdf`)).status).toBe(404);
  });

  it('clôture : procès-verbal figé, y compris directement en base', async () => {
    const c = await admin.post(`/api/asso/meetings/${meetingId}/close`);
    expect(c.status).toBe(200);
    expect(c.body.quorum.reached).toBe(true);
    expect((await admin.patch(`/api/asso/meetings/${meetingId}`, { minutes: 'Falsifié' })).body.code).toBe('MEETING_CLOSED');
    expect((await admin.post(`/api/asso/meetings/${meetingId}/resolutions`, { title: 'Ajout tardif' })).body.code).toBe('MEETING_CLOSED');
    const pool = new Pool({ connectionString: TEST_DB });
    await expect(pool.query('UPDATE meetings SET minutes = $1 WHERE id = $2', ['x', meetingId])).rejects.toThrow(/figé/);
    await expect(pool.query('UPDATE resolutions SET votes_for = 0 WHERE meeting_id = $1', [meetingId])).rejects.toThrow(/figé/);
    await expect(pool.query('DELETE FROM meeting_attendees WHERE meeting_id = $1', [meetingId])).rejects.toThrow(/figé/);
    await pool.end();
    // Les documents restent téléchargeables.
    expect((await binary(admin.get(`/api/asso/meetings/${meetingId}/proces-verbal.pdf`))).status).toBe(200);
  });

  it('sans Agenda, la réunion est créée sans événement', async () => {
    await admin.post('/api/admin/modules/agenda/deactivate', { mode: 'inactive', acknowledgeWarnings: true });
    const r = await admin.post('/api/asso/meetings', { type: 'bureau', title: 'Bureau de rentrée', startAt: '2027-09-05T18:00:00+02:00' });
    expect(r.status).toBe(201);
    expect(r.body.eventId).toBeNull();
    await admin.post('/api/admin/modules/agenda/activate', {});
  });
});
