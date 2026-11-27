import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let tech: Client;
let assoc: string;
let sheet: string;
let port: number;
const cue: Record<string, string> = {};
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const socketFor = (cl: Client) => io(`http://127.0.0.1:${port}`, { path: '/api/realtime', transports: ['websocket'], extraHeaders: { Cookie: cl.cookie }, reconnection: false });
const once = <T>(s: Socket, ev: string) => new Promise<T>((resolve) => s.once(ev, resolve));

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as { port: number }).port;
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Régie Test' }, modules: ['regie', 'drive', 'show'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  const roles = (await admin.get('/api/admin/roles')).body;
  await admin.post('/api/admin/users', { email: 'lumiere@x.fr', displayName: 'Tech Lumière', password: 'Provisoire-123456', roleIds: [roles.find((r: { key: string }) => r.key === 'tech_lumiere').id] });
  tech = new Client(app);
  await tech.login('lumiere@x.fr', 'Provisoire-123456');
  await tech.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Tech-Lumiere-2026' });
  tech.association = assoc;
});

afterAll(async () => {
  await app?.close();
});

describe('Conduite', () => {
  it('crée une conduite, insère des tops, renumérote par service', async () => {
    const s = await admin.post('/api/regie/cuesheets', { title: 'Tartuffe — conduite' });
    sheet = s.body.id;
    cue.a = (await admin.post(`/api/regie/cuesheets/${sheet}/cues`, { department: 'light', label: 'Pré-jeu', trigger: 'Entrée public' })).body.id;
    cue.c = (await admin.post(`/api/regie/cuesheets/${sheet}/cues`, { department: 'light', label: 'Plein feu', trigger: 'Noir salle' })).body.id;
    cue.b = (await admin.post(`/api/regie/cuesheets/${sheet}/cues`, { department: 'sound', label: 'Musique d’ouverture', afterCueId: cue.a })).body.id;
    await admin.post(`/api/regie/cuesheets/${sheet}/renumber`);
    const d = (await admin.get(`/api/regie/cuesheets/${sheet}`)).body;
    expect(d.cues.map((q: { number: string; label: string }) => `${q.number} ${q.label}`)).toEqual(['L1 Pré-jeu', 'S1 Musique d’ouverture', 'L2 Plein feu']);
    await admin.put(`/api/regie/cuesheets/${sheet}/order`, { cueIds: [cue.b, cue.a, cue.c] });
    expect((await admin.get(`/api/regie/cuesheets/${sheet}`)).body.cues[0].id).toBe(cue.b);
    expect((await admin.put(`/api/regie/cuesheets/${sheet}/order`, { cueIds: [cue.a] })).body.code).toBe('ORDER_MISMATCH');
    const pdf = await admin.get(`/api/regie/cuesheets/${sheet}/cuesheet.pdf?department=light`).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('le technicien suit la conduite mais ne la modifie pas', async () => {
    expect((await tech.get(`/api/regie/cuesheets/${sheet}`)).status).toBe(200);
    expect((await tech.post(`/api/regie/cuesheets/${sheet}/cues`, { label: 'X' })).status).toBe(403);
    expect((await tech.post(`/api/regie/cuesheets/${sheet}/runs`, {})).status).toBe(403);
  });

  it('cartoucheur : son envoyé dans Drive puis lu depuis la conduite', async () => {
    const up = await admin.upload('/api/drive/files', [{ name: 'ouverture.mp3', content: Buffer.from('ID3fake-mp3') }], { linkModule: 'regie', linkEntityType: 'cuesheet', linkEntityId: sheet });
    const fileId = up.body.files[0].id;
    const txt = await admin.upload('/api/drive/files', [{ name: 'notes.txt', content: 'x' }], { linkModule: 'regie', linkEntityType: 'cuesheet', linkEntityId: sheet });
    expect((await admin.post(`/api/regie/cuesheets/${sheet}/sounds`, { driveFileId: txt.body.files[0].id, label: 'Texte' })).body.code).toBe('NOT_AUDIO');
    const so = await admin.post(`/api/regie/cuesheets/${sheet}/sounds`, { driveFileId: fileId, label: 'Ouverture', hotkey: '1', volume: 80 });
    expect(so.status).toBe(201);
    await admin.patch(`/api/regie/cues/${cue.b}`, { soundId: so.body.id });
    const audio = await tech.get(`/api/regie/sounds/${so.body.id}/audio`).buffer(true).parse(binary);
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    expect(audio.body.toString()).toBe('ID3fake-mp3');
  });
});

describe('Séance en direct', () => {
  let run: string;
  it('diffuse les GO à tous les postes qui suivent la conduite', async () => {
    const s = socketFor(tech);
    await once(s, 'connect');
    const joined = await new Promise<{ ok: boolean }>((r) => s.emit('regie:join', { associationId: assoc, cuesheetId: sheet }, r));
    expect(joined.ok).toBe(true);
    const started = once<{ kind: string; standbyCueId: string }>(s, 'regie:state');
    const r = await admin.post(`/api/regie/cuesheets/${sheet}/runs`, { mode: 'show' });
    expect(r.status).toBe(201);
    run = r.body.id;
    expect((await started).standbyCueId).toBe(cue.b);
    expect((await admin.post(`/api/regie/cuesheets/${sheet}/runs`, {})).body.code).toBe('RUN_ACTIVE');
    const go = once<{ kind: string; currentCueId: string; standbyCueId: string; by: string }>(s, 'regie:state');
    await admin.post(`/api/regie/runs/${run}/actions`, { actions: [{ kind: 'go' }] });
    const st = await go;
    expect(st).toMatchObject({ kind: 'go', currentCueId: cue.b, standbyCueId: cue.a });
    s.close();
  });

  it('en représentation, la conduite est verrouillée', async () => {
    expect((await admin.patch(`/api/regie/cues/${cue.a}`, { label: 'Modif' })).body.code).toBe('SHOW_RUNNING');
  });

  it('rejoue des actions faites hors connexion avec leur heure d’origine', async () => {
    // Actions faites après le dernier GO reçu, transmises plus tard.
    const before = (await admin.get(`/api/regie/runs/${run}`)).body;
    const t0 = new Date(before.log[before.log.length - 1].at).getTime() + 40;
    await new Promise((r) => setTimeout(r, 60));
    const r = await admin.post(`/api/regie/runs/${run}/actions`, { actions: [
      { kind: 'go', at: new Date(t0 - 30).toISOString() },
      { kind: 'note', note: 'Projecteur 12 grillé', at: new Date(t0 - 20).toISOString() },
      { kind: 'go', at: new Date(t0 - 10).toISOString() },
    ] });
    expect(r.body.currentCueId).toBe(cue.c);
    expect((await admin.post(`/api/regie/runs/${run}/actions`, { actions: [{ kind: 'go' }] })).body.code).toBe('END_OF_SHEET');
    await admin.post(`/api/regie/runs/${run}/actions`, { actions: [{ kind: 'back' }] });
    const d = (await admin.get(`/api/regie/runs/${run}`)).body;
    expect(d.currentCueId).toBe(cue.a);
    expect(d.log.map((l: { kind: string }) => l.kind)).toEqual(['start', 'go', 'go', 'note', 'go', 'back']);
    expect(d.log[3].note).toBe('Projecteur 12 grillé');
  });

  it('termine la séance avec un rapport, PDF, puis la conduite redevient modifiable', async () => {
    await admin.post(`/api/regie/runs/${run}/end`, { report: 'RAS hormis le PC12.' });
    expect((await admin.post(`/api/regie/runs/${run}/actions`, { actions: [{ kind: 'go' }] })).body.code).toBe('RUN_ENDED');
    const pdf = await admin.get(`/api/regie/runs/${run}/report.pdf`).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await admin.patch(`/api/regie/cues/${cue.a}`, { label: 'Pré-jeu (bleu)' })).status).toBe(200);
    expect((await admin.get(`/api/regie/cuesheets/${sheet}/runs`)).body[0].gos).toBe(3);
  });

  it('une conduite figée refuse les modifications', async () => {
    await admin.patch(`/api/regie/cuesheets/${sheet}`, { locked: true });
    expect((await admin.post(`/api/regie/cuesheets/${sheet}/cues`, { label: 'X' })).body.code).toBe('CUESHEET_LOCKED');
    await admin.patch(`/api/regie/cuesheets/${sheet}`, { locked: false });
  });
});

describe('Suppressions', () => {
  it('copie, puis supprime top, son, séance et conduites', async () => {
    const copy = await admin.post(`/api/regie/cuesheets/${sheet}/duplicate`);
    const cd = (await admin.get(`/api/regie/cuesheets/${copy.body.id}`)).body;
    expect(cd.cues).toHaveLength(3);
    expect(cd.sounds).toHaveLength(1);
    expect(cd.cues.find((q: { label: string }) => q.label === 'Musique d’ouverture').soundId).toBe(cd.sounds[0].id);
    const d = (await admin.get(`/api/regie/cuesheets/${sheet}`)).body;
    expect((await admin.delete(`/api/regie/cues/${cue.c}`)).status).toBe(200);
    expect((await admin.delete(`/api/regie/sounds/${d.sounds[0].id}`)).status).toBe(200);
    expect((await admin.get(`/api/regie/cuesheets/${sheet}`)).body.cues.find((q: { id: string }) => q.id === cue.b).soundId).toBeNull();
    const runs = (await admin.get(`/api/regie/cuesheets/${sheet}/runs`)).body;
    expect((await admin.delete(`/api/regie/runs/${runs[0].id}`)).status).toBe(200);
    expect((await admin.delete(`/api/regie/cuesheets/${sheet}`)).status).toBe(200);
    expect((await admin.delete(`/api/regie/cuesheets/${copy.body.id}`)).status).toBe(200);
    expect((await admin.get('/api/regie/cuesheets')).body).toEqual([]);
  });
});
