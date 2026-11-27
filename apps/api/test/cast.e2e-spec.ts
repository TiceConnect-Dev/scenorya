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
let prod: string;
const role: Record<string, string> = {};
const scene: Record<string, string> = {};
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
const dateOnly = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Théâtre du Pont' }, modules: ['asso', 'cast', 'agenda', 'espace'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  for (const [k, f, l] of [['orgon', 'Olivier', 'Orgon'], ['elmire', 'Élise', 'Elmire'], ['tartuffe', 'Théo', 'Tartuffe'], ['doublure', 'Denis', 'Double']]) {
    m[k] = (await admin.post('/api/asso/members', { firstName: f, lastName: l, email: `${k}@example.org`, phone: '0600000000' })).body.id;
  }
});

afterAll(async () => {
  await app?.close();
});

describe('Production et distribution', () => {
  it('crée une production, ses rôles et sa distribution (titulaires, doublure)', async () => {
    const p = await admin.post('/api/cast/productions', { title: 'Tartuffe', author: 'Molière', season: '2026-2027' });
    expect(p.status).toBe(201);
    prod = p.body.id;
    for (const n of ['Orgon', 'Elmire', 'Tartuffe']) role[n] = (await admin.post(`/api/cast/productions/${prod}/roles`, { name: n })).body.id;
    await admin.post(`/api/cast/roles/${role.Orgon}/assignments`, { memberId: m.orgon });
    await admin.post(`/api/cast/roles/${role.Elmire}/assignments`, { memberId: m.elmire });
    await admin.post(`/api/cast/roles/${role.Tartuffe}/assignments`, { memberId: m.tartuffe });
    await admin.post(`/api/cast/roles/${role.Tartuffe}/assignments`, { memberId: m.doublure, kind: 'understudy' });
    const d = (await admin.get(`/api/cast/productions/${prod}`)).body;
    expect(d.roles.map((r: { name: string }) => r.name)).toEqual(['Orgon', 'Elmire', 'Tartuffe']);
    expect(d.roles[2].assignments.map((a: { kind: string }) => a.kind).sort()).toEqual(['lead', 'understudy']);
    expect((await admin.post(`/api/cast/roles/${role.Orgon}/assignments`, { memberId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('UNKNOWN_MEMBER');
  });

  it('scènes et grille de présence des personnages', async () => {
    scene.s1 = (await admin.post(`/api/cast/productions/${prod}/scenes`, { act: 1, number: 1, title: 'Orgon et Elmire', roleIds: [role.Orgon, role.Elmire] })).body.id;
    scene.s2 = (await admin.post(`/api/cast/productions/${prod}/scenes`, { act: 3, number: 3, title: 'La déclaration' })).body.id;
    await admin.put(`/api/cast/scenes/${scene.s2}/roles/${role.Tartuffe}`, { present: true });
    await admin.put(`/api/cast/scenes/${scene.s2}/roles/${role.Elmire}`, { present: true });
    const d = (await admin.get(`/api/cast/productions/${prod}`)).body;
    expect(d.scenes.map((s: { label: string }) => s.label)).toEqual(['Acte 1, sc. 1 — Orgon et Elmire', 'Acte 3, sc. 3 — La déclaration']);
    expect(d.scenes[1].roleIds.sort()).toEqual([role.Elmire, role.Tartuffe].sort());
    const pdf = await admin.get(`/api/cast/productions/${prod}/distribution.pdf`).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('Répétitions', () => {
  let reh: string;
  it('calcule les convoqués à partir des scènes, avec doublures sur demande', async () => {
    const base = { startAt: day(5, 17), endAt: day(5, 20) };
    const p1 = await admin.post(`/api/cast/productions/${prod}/rehearsals/preview`, { ...base, sceneIds: [scene.s2] });
    expect(p1.body.calls.map((k: { name: string }) => k.name).sort()).toEqual(['Théo Tartuffe', 'Élise Elmire']);
    const p2 = await admin.post(`/api/cast/productions/${prod}/rehearsals/preview`, { ...base, sceneIds: [scene.s2], includeUnderstudies: true });
    expect(p2.body.calls.find((k: { name: string }) => k.name === 'Denis Double').understudy).toBe(true);
    const filage = await admin.post(`/api/cast/productions/${prod}/rehearsals/preview`, { ...base, sceneIds: [] });
    expect(filage.body.calls).toHaveLength(3);
  });

  it('signale les indisponibilités, puis crée la répétition et son événement d’agenda', async () => {
    await admin.post('/api/cast/unavailabilities', { memberId: m.elmire, startsOn: dateOnly(5), endsOn: dateOnly(6), reason: 'Déplacement' });
    const pv = await admin.post(`/api/cast/productions/${prod}/rehearsals/preview`, { startAt: day(5, 17), endAt: day(5, 20), sceneIds: [scene.s2] });
    expect(pv.body.calls.find((k: { name: string }) => k.name === 'Élise Elmire').conflicts[0]).toContain('Déplacement');
    const r = await admin.post(`/api/cast/productions/${prod}/rehearsals`, { startAt: day(5, 17), endAt: day(5, 20), location: 'Salle Molière', sceneIds: [scene.s2] });
    expect(r.status).toBe(201);
    reh = r.body.id;
    expect(r.body.eventId).toBeTruthy();
    const ev = (await admin.get(`/api/agenda/events/${r.body.eventId}`)).body;
    expect(ev.title).toBe('Répétition — Tartuffe');
    expect(ev.participants).toHaveLength(2);
  });

  it('met à jour les convocations quand la distribution change', async () => {
    const ev0 = (await admin.get(`/api/cast/rehearsals/${reh}`)).body;
    await admin.put(`/api/cast/scenes/${scene.s2}/roles/${role.Orgon}`, { present: true });
    const ev = (await admin.get(`/api/agenda/events/${ev0.eventId}`)).body;
    expect(ev.participants).toHaveLength(3);
    const detail = (await admin.get(`/api/cast/rehearsals/${reh}`)).body;
    expect(detail.calls.map((k: { name: string }) => k.name)).toContain('Olivier Orgon');
    const sheet = await admin.get(`/api/cast/rehearsals/${reh}/call-sheet.pdf`).buffer(true).parse(binary);
    expect(sheet.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('détecte le conflit avec une autre répétition au même moment', async () => {
    const other = await admin.post('/api/cast/productions', { title: 'Les Fourberies' });
    const r2 = (await admin.post(`/api/cast/productions/${other.body.id}/roles`, { name: 'Scapin' })).body.id;
    await admin.post(`/api/cast/roles/${r2}/assignments`, { memberId: m.tartuffe });
    const pv = await admin.post(`/api/cast/productions/${other.body.id}/rehearsals/preview`, { startAt: day(5, 18), endAt: day(5, 19), sceneIds: [] });
    expect(pv.body.calls[0].conflicts.join(' ')).toContain('autre répétition : Tartuffe');
    expect((await admin.delete(`/api/cast/productions/${other.body.id}`)).status).toBe(200);
  });
});

describe('Espace du comédien', () => {
  it('voit ses rôles et ses répétitions, et déclare ses indisponibilités', async () => {
    const inv = await admin.post(`/api/asso/members/${m.tartuffe}/espace/invite`, { send: false });
    const token = inv.body.url.split('/invitation/')[1];
    await request(app.getHttpServer()).post(`/api/public/invitations/${token}/accept`).send({ password: 'Theo-Tartuffe-2026' });
    const me = new Client(app);
    await me.login('tartuffe@example.org', 'Theo-Tartuffe-2026');
    me.association = assoc;
    const mine = (await me.get('/api/espace/cast')).body;
    expect(mine.roles).toEqual([expect.objectContaining({ role: 'Tartuffe', production: 'Tartuffe', kind: 'lead' })]);
    expect(mine.rehearsals[0]).toMatchObject({ location: 'Salle Molière', scenes: ['Acte 3, sc. 3 — La déclaration'] });
    const u = await me.post('/api/espace/cast/unavailabilities', { startsOn: dateOnly(10), endsOn: dateOnly(12), reason: 'Vacances' });
    expect(u.status).toBe(201);
    const list = (await admin.get('/api/cast/unavailabilities')).body;
    expect(list.some((x: { name: string; reason: string }) => x.name === 'Théo Tartuffe' && x.reason === 'Vacances')).toBe(true);
    // Il ne peut supprimer que les siennes, et n'accède pas à la gestion de Cast.
    const other = list.find((x: { name: string }) => x.name === 'Élise Elmire');
    expect((await me.delete(`/api/espace/cast/unavailabilities/${other.id}`)).status).toBe(404);
    expect((await me.delete(`/api/espace/cast/unavailabilities/${u.body.id}`)).status).toBe(200);
    expect((await me.get('/api/cast/productions')).status).toBe(403);
  });
});

describe('Suppressions', () => {
  it('supprime une répétition (et son événement), une scène, un rôle, une indisponibilité puis la production', async () => {
    const d = (await admin.get(`/api/cast/productions/${prod}`)).body;
    const reh = d.rehearsals[0];
    expect((await admin.delete(`/api/cast/rehearsals/${reh.id}`)).status).toBe(200);
    expect((await admin.get(`/api/agenda/events/${reh.eventId}`)).status).toBe(404);
    expect((await admin.delete(`/api/cast/scenes/${scene.s1}`)).status).toBe(200);
    expect((await admin.delete(`/api/cast/roles/${role.Orgon}`)).status).toBe(200);
    const a = d.roles.find((r: { name: string }) => r.name === 'Tartuffe').assignments[1];
    expect((await admin.delete(`/api/cast/assignments/${a.id}`)).status).toBe(200);
    const u = (await admin.get('/api/cast/unavailabilities')).body[0];
    expect((await admin.delete(`/api/cast/unavailabilities/${u.id}`)).status).toBe(200);
    const r = await admin.delete(`/api/cast/productions/${prod}`);
    expect(r.body).toMatchObject({ ok: true, roles: 2 });
    expect((await admin.get('/api/cast/productions')).body).toEqual([]);
    // Un adhérent distribué se supprime aussi : sa distribution part avec lui.
    expect((await admin.delete(`/api/asso/members/${m.doublure}`)).body.mode).toBe('deleted');
  });
});
