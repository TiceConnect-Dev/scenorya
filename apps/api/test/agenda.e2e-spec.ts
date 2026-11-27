import { INestApplication } from '@nestjs/common';
import { zonedParts, zonedToUtc } from '@scenorya/shared';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let assoc: string;
const m: string[] = [];
let groupId: string;
const y = new Date().getFullYear() + 1;
const iso = (mo: number, d: number, h: number, mi = 0) => zonedToUtc(y, mo, d, h, mi, 'Europe/Paris').toISOString();

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Compagnie Agenda' }, modules: ['asso', 'agenda'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  for (const n of ['Alice', 'Bruno', 'Chloé']) m.push((await admin.post('/api/asso/members', { firstName: n, lastName: 'Test' })).body.id);
  groupId = (await admin.post('/api/asso/groups', { name: 'Troupe', kind: 'troupe' })).body.id;
  await admin.put(`/api/asso/groups/${groupId}/members`, { memberIds: [m[1], m[2]] });
});

afterAll(async () => {
  await app?.close();
});

describe('Événements et récurrences', () => {
  let rehearsal: string;

  it('crée une répétition hebdomadaire et invite un groupe', async () => {
    const r = await admin.post('/api/agenda/events', {
      title: 'Répétition générale', category: 'rehearsal', location: 'Salle des fêtes',
      start: iso(3, 5, 19), end: iso(3, 5, 22),
      rule: { freq: 'weekly', interval: 1, until: `${y}-04-30` },
      groupIds: [groupId], memberIds: [m[0]],
    });
    expect(r.status).toBe(201);
    rehearsal = r.body.event.id;
    const detail = await admin.get(`/api/agenda/events/${rehearsal}`);
    expect(detail.body.participants).toHaveLength(3);
  });

  it('développe les occurrences à heure locale constante (changement d’heure)', async () => {
    const list = await admin.get(`/api/agenda/events?from=${iso(3, 1, 0)}&to=${iso(5, 1, 0)}`);
    const occ = list.body.items.filter((i: { id: string }) => i.id === rehearsal);
    expect(occ.length).toBeGreaterThanOrEqual(8);
    for (const o of occ) expect(zonedParts(new Date(o.start), 'Europe/Paris').hour).toBe(19);
    expect(occ[0].participants.invited).toBe(3);
  });

  it('annule une occurrence sans toucher la série', async () => {
    const list = await admin.get(`/api/agenda/events?from=${iso(3, 1, 0)}&to=${iso(5, 1, 0)}`);
    const second = list.body.items.filter((i: { id: string }) => i.id === rehearsal)[1].occurrence;
    expect((await admin.post(`/api/agenda/events/${rehearsal}/cancel-occurrence`, { occurrence: second })).status).toBe(200);
    expect((await admin.post(`/api/agenda/events/${rehearsal}/cancel-occurrence`, { occurrence: `${y}-03-06` })).status).toBe(404);
    const after = await admin.get(`/api/agenda/events?from=${iso(3, 1, 0)}&to=${iso(5, 1, 0)}`);
    expect(after.body.items.some((i: { id: string; occurrence: string }) => i.id === rehearsal && i.occurrence === second)).toBe(false);
  });

  it('détecte les conflits de participants et de lieu', async () => {
    const preview = await admin.post('/api/agenda/conflicts', { title: 'Réunion', start: iso(3, 19, 20), end: iso(3, 19, 21), memberIds: [m[0]] });
    expect(preview.body.conflicts).toHaveLength(1);
    expect(preview.body.conflicts[0].reasons[0]).toContain('Alice Test');
    const place = await admin.post('/api/agenda/conflicts', { title: 'Atelier', start: iso(3, 26, 21), end: iso(3, 26, 23), location: 'salle des fêtes ' });
    expect(place.body.conflicts[0].reasons[0]).toContain('même lieu');
    const free = await admin.post('/api/agenda/conflicts', { title: 'Libre', start: iso(3, 13, 20), end: iso(3, 13, 21), memberIds: [m[0]], location: 'Salle des fêtes' });
    expect(free.body.conflicts).toHaveLength(0);
    // Un participant excusé n'est plus en conflit.
    await admin.patch(`/api/agenda/events/${rehearsal}/participants/${m[0]}`, { status: 'no', comment: 'En déplacement' });
    expect((await admin.post('/api/agenda/conflicts', { title: 'Réunion', start: iso(3, 19, 20), end: iso(3, 19, 21), memberIds: [m[0]] })).body.conflicts).toHaveLength(0);
    // L'occurrence annulée du 12 mars ne crée pas de conflit.
    expect((await admin.post('/api/agenda/conflicts', { title: 'Réunion', start: iso(3, 12, 20), end: iso(3, 12, 21), memberIds: [m[1]] })).body.conflicts).toHaveLength(0);
  });

  it('événement sur la journée entière et validations', async () => {
    const ag = await admin.post('/api/agenda/events', { title: 'Assemblée générale', category: 'general_assembly', start: `${y}-06-13T00:00:00+02:00`, end: `${y}-06-13T00:00:00+02:00`, allDay: true });
    expect(ag.status).toBe(201);
    expect(new Date(ag.body.event.endAt).getTime() - new Date(ag.body.event.startAt).getTime()).toBe(86_400_000);
    expect((await admin.post('/api/agenda/events', { title: 'Inversé', start: iso(6, 2, 20), end: iso(6, 2, 19) })).body.code).toBe('INVALID_DATES');
    expect((await admin.post('/api/agenda/events', { title: 'Sans fin', start: iso(6, 2, 19), end: iso(6, 2, 20), rule: { freq: 'daily', interval: 1 } })).status).toBe(400);
  });

  it('modification partielle sans réinitialisation, puis annulation', async () => {
    const e = await admin.post('/api/agenda/events', { title: 'Permanence', category: 'permanence', location: 'Local', description: 'Accueil du public', start: iso(7, 1, 14), end: iso(7, 1, 17) });
    const u = await admin.patch(`/api/agenda/events/${e.body.event.id}`, { title: 'Permanence d’été' });
    expect(u.body.event).toMatchObject({ title: 'Permanence d’été', category: 'permanence', location: 'Local', description: 'Accueil du public' });
    expect((await admin.delete(`/api/agenda/events/${e.body.event.id}`)).status).toBe(200);
    const list = await admin.get(`/api/agenda/events?from=${iso(6, 30, 0)}&to=${iso(7, 2, 0)}`);
    expect(list.body.items).toHaveLength(0);
  });
});

describe('iCalendar', () => {
  it('exporte un fichier ICS valide', async () => {
    const res = await admin.get('/api/agenda/events.ics?from=' + iso(3, 1, 0) + '&to=' + iso(7, 1, 0));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(res.text).toContain('SUMMARY:Répétition générale');
    expect(res.text).toContain('DTSTART;VALUE=DATE:');
    for (const line of res.text.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });

  it('abonnement personnel : URL secrète, révocable, droits réévalués', async () => {
    const feed = await admin.post('/api/agenda/feed');
    expect(feed.status).toBe(201);
    const path = new URL(feed.body.url).pathname;
    const anon = new Client(app);
    const ok = await anon.get(path);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('BEGIN:VEVENT');
    expect((await admin.get('/api/agenda/feed')).body.active).toBe(true);
    // Module désactivé : le flux cesse.
    await admin.post('/api/admin/modules/agenda/deactivate', { mode: 'inactive', acknowledgeWarnings: true });
    expect((await anon.get(path)).status).toBe(404);
    await admin.post('/api/admin/modules/agenda/activate', {});
    expect((await anon.get(path)).status).toBe(200);
    await admin.delete('/api/agenda/feed');
    expect((await anon.get(path)).status).toBe(404);
  });
});

describe('Droits et dépendances', () => {
  it('sans Asso, les invitations sont refusées mais l’agenda fonctionne', async () => {
    await admin.post('/api/admin/modules/asso/deactivate', { mode: 'inactive', acknowledgeWarnings: true });
    expect((await admin.post('/api/agenda/events', { title: 'Seul', start: iso(8, 1, 10), end: iso(8, 1, 11) })).status).toBe(201);
    expect((await admin.post('/api/agenda/events', { title: 'Invités', start: iso(8, 1, 10), end: iso(8, 1, 11), memberIds: [m[0]] })).body.code).toBe('FEATURE_UNAVAILABLE');
    await admin.post('/api/admin/modules/asso/activate', {});
  });

  it('un lecteur de l’agenda ne voit pas les noms des participants', async () => {
    const role = await admin.post('/api/admin/roles', { name: 'Agenda seul', permissions: ['agenda.read', 'agenda.events.read'] });
    await admin.post('/api/admin/users', { email: 'ag@x.fr', displayName: 'Lecteur agenda', password: 'Provisoire-123456', roleIds: [role.body.id] });
    const u = new Client(app);
    await u.login('ag@x.fr', 'Provisoire-123456');
    await u.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Agenda-Pass-2026' });
    u.association = assoc;
    const list = await u.get(`/api/agenda/events?from=${iso(3, 1, 0)}&to=${iso(4, 1, 0)}`);
    const id = list.body.items[0].id;
    const d = await u.get(`/api/agenda/events/${id}`);
    expect(d.body.participants).toEqual([]);
    expect(d.body.participantCounts.invited).toBe(2);
    expect((await u.post('/api/agenda/events', { title: 'Non', start: iso(8, 1, 10), end: iso(8, 1, 11) })).body.code).toBe('PERMISSION_DENIED');
    const hub = await u.get('/api/hub/summary');
    expect(hub.status).toBe(403); // pas de hub.read
  });

  it('widget Hub : prochains événements', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000);
    await admin.post('/api/agenda/events', { title: 'Bientôt', start: soon.toISOString(), end: new Date(soon.getTime() + 3600_000).toISOString() });
    const hub = await admin.get('/api/hub/summary');
    expect(hub.body.widgets.upcoming.some((e: { title: string }) => e.title === 'Bientôt')).toBe(true);
  });
});
