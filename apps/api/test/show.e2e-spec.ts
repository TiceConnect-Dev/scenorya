import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let assoc: string;
const m: Record<string, string> = {};
let showId: string;
let venueId: string;
let prod: string;
let leadRole: string;
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const day = (n: number, h: number) => {
  const d = new Date(Date.now() + n * 86_400_000);
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString();
};

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Les Planches' }, modules: ['asso', 'show', 'cast', 'agenda', 'drive', 'espace'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  for (const [k, f, l] of [['lumiere', 'Lucie', 'Lumière'], ['comedien', 'Cyrano', 'Bergerac'], ['accueil', 'Agnès', 'Accueil']]) {
    m[k] = (await admin.post('/api/asso/members', { firstName: f, lastName: l, email: `${k}@example.org` })).body.id;
  }
});

afterAll(async () => {
  await app?.close();
});

describe('Spectacles et lieux', () => {
  it('crée un lieu et un spectacle', async () => {
    const v = await admin.post('/api/show/venues', { name: 'Théâtre municipal', city: 'Fourmies', capacity: 320 });
    venueId = v.body.id;
    const s = await admin.post('/api/show/shows', { title: 'Cyrano', author: 'Edmond Rostand', durationMin: 150, intermissionMin: 20, ageMin: 10, synopsis: 'Panache et nez.' });
    expect(s.status).toBe(201);
    showId = s.body.id;
  });

  it('ajoute une série de représentations ; la fin se déduit de la durée', async () => {
    const r = await admin.post(`/api/show/shows/${showId}/performances`, { startAts: [day(10, 19), day(11, 19), day(12, 14)], venueId });
    expect(r.body.performances).toHaveLength(3);
    const p = r.body.performances[0];
    expect((new Date(p.endAt).getTime() - new Date(p.startAt).getTime()) / 60000).toBe(170);
    expect(p.eventId).toBeTruthy();
    const d = (await admin.get(`/api/show/shows/${showId}`)).body;
    expect(d.performances[0].capacity).toBe(320);
    expect((await admin.get('/api/show/performances')).body).toHaveLength(3);
    const ev = (await admin.get(`/api/agenda/events/${p.eventId}`)).body;
    expect(ev).toMatchObject({ title: 'Représentation — Cyrano', category: 'performance', location: 'Théâtre municipal, Fourmies' });
  });

  it('équipe et distribution de Cast sont convoquées aux représentations', async () => {
    await admin.post(`/api/show/shows/${showId}/crew`, { memberIds: [m.lumiere], job: 'Régie lumière' });
    prod = (await admin.post('/api/cast/productions', { title: 'Cyrano — distribution' })).body.id;
    leadRole = (await admin.post(`/api/cast/productions/${prod}/roles`, { name: 'Cyrano' })).body.id;
    await admin.post(`/api/cast/roles/${leadRole}/assignments`, { memberId: m.comedien });
    expect((await admin.get('/api/show/linkable-productions')).body).toHaveLength(1);
    await admin.post(`/api/show/shows/${showId}/productions/${prod}`);
    const d = (await admin.get(`/api/show/shows/${showId}`)).body;
    expect(d.productions[0].roles).toEqual([{ role: 'Cyrano', leads: ['Cyrano Bergerac'] }]);
    const ev = (await admin.get(`/api/agenda/events/${d.performances[0].eventId}`)).body;
    expect(ev.participants.map((p: { lastName: string }) => p.lastName).sort()).toEqual(['Bergerac', 'Lumière']);
    // Un changement de distribution dans Cast met à jour les représentations.
    const r2 = (await admin.post(`/api/cast/productions/${prod}/roles`, { name: 'Roxane' })).body.id;
    await admin.post(`/api/cast/roles/${r2}/assignments`, { memberId: m.accueil });
    const ev2 = (await admin.get(`/api/agenda/events/${d.performances[0].eventId}`)).body;
    expect(ev2.participants).toHaveLength(3);
  });

  it('annuler une représentation annule son événement ; fiche spectacle PDF', async () => {
    const d = (await admin.get(`/api/show/shows/${showId}`)).body;
    const last = d.performances[2];
    await admin.patch(`/api/show/performances/${last.id}`, { status: 'cancelled' });
    const evs = (await admin.get(`/api/agenda/events?from=${new Date().toISOString()}&to=${day(30, 0)}`)).body.items;
    expect(evs.filter((e: { category: string }) => e.category === 'performance')).toHaveLength(2);
    // Déplacer le début décale la fin (durée conservée).
    const moved = await admin.patch(`/api/show/performances/${d.performances[1].id}`, { startAt: day(11, 20) });
    expect(new Date(moved.body.endAt).toISOString()).toBe(new Date(new Date(day(11, 20)).getTime() + 170 * 60000).toISOString());
    const pdf = await admin.get(`/api/show/shows/${showId}/sheet.pdf`).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('documents du spectacle rangés dans Drive', async () => {
    const up = await admin.upload('/api/drive/files', [{ name: 'Fiche technique.pdf', content: '%PDF ft' }], { linkModule: 'show', linkEntityType: 'show', linkEntityId: showId });
    expect(up.status).toBe(201);
    expect((await admin.get(`/api/drive/links?module=show&entityType=show&entityId=${showId}`)).body).toHaveLength(1);
  });
});

describe('Espace', () => {
  it('l’adhérent voit les représentations où il est attendu', async () => {
    const inv = await admin.post(`/api/asso/members/${m.lumiere}/espace/invite`, { send: false });
    const token = inv.body.url.split('/invitation/')[1];
    await request(app.getHttpServer()).post(`/api/public/invitations/${token}/accept`).send({ password: 'Lucie-Lumiere-2026' });
    const me = new Client(app);
    await me.login('lumiere@example.org', 'Lucie-Lumiere-2026');
    me.association = assoc;
    const mine = (await me.get('/api/espace/show')).body;
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ show: 'Cyrano', jobs: ['Régie lumière'] });
    expect((await me.get('/api/show/shows')).status).toBe(403);
  });
});

describe('Suppressions', () => {
  it('supprime équipe, rattachement, représentation, lieu et spectacle', async () => {
    const d = (await admin.get(`/api/show/shows/${showId}`)).body;
    expect((await admin.delete(`/api/show/crew/${d.crew[0].id}`)).status).toBe(200);
    expect((await admin.delete(`/api/show/shows/${showId}/productions/${prod}`)).status).toBe(200);
    const p0 = d.performances[0];
    expect((await admin.delete(`/api/show/performances/${p0.id}`)).status).toBe(200);
    expect((await admin.get(`/api/agenda/events/${p0.eventId}`)).status).toBe(404);
    expect((await admin.delete(`/api/show/venues/${venueId}`)).body.performances).toBe(2);
    const r = await admin.delete(`/api/show/shows/${showId}`);
    expect(r.body).toMatchObject({ ok: true, performances: 2 });
    expect((await admin.get('/api/show/shows')).body).toEqual([]);
    // La distribution de Cast survit au spectacle.
    expect((await admin.get(`/api/cast/productions/${prod}`)).status).toBe(200);
  });
});
