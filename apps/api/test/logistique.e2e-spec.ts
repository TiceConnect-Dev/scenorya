import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let regie: Client;
let assoc: string;
const id: Record<string, string> = {};
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const day = (n: number, h: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Logistique Test' }, modules: ['stock', 'booking', 'maintenance', 'agenda'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  const roles = (await admin.get('/api/admin/roles')).body;
  await admin.post('/api/admin/users', { email: 'regie@x.fr', displayName: 'Régisseur', password: 'Provisoire-123456', roleIds: [roles.find((r: { key: string }) => r.key === 'regisseur').id] });
  regie = new Client(app);
  await regie.login('regie@x.fr', 'Provisoire-123456');
  await regie.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Regisseur-Gen-2026' });
  regie.association = assoc;
});

afterAll(async () => {
  await app?.close();
});

describe('Stock', () => {
  it('emplacements, articles, référence unique', async () => {
    id.loc = (await admin.post('/api/stock/locations', { name: 'Local technique' })).body.id;
    const pc = await admin.post('/api/stock/items', { name: 'Projecteur PC 1 kW', reference: 'LUM-001', category: 'Lumière', quantity: 8, locationId: id.loc, valueCents: 25000 });
    expect(pc.status).toBe(201);
    id.pc = pc.body.id;
    id.gaff = (await admin.post('/api/stock/items', { name: 'Gaffer noir', kind: 'consumable', quantity: 10, unit: 'rouleaux', minQuantity: 3, loanable: false })).body.id;
    expect((await admin.post('/api/stock/items', { name: 'Doublon', reference: 'LUM-001' })).body.code).toBe('REFERENCE_TAKEN');
    expect((await admin.get('/api/stock/items?q=lum')).body).toHaveLength(1);
    expect((await admin.get('/api/stock/categories')).body).toEqual(['Lumière']);
    expect((await admin.get('/api/stock/locations')).body[0].items).toBe(1);
  });

  it('mouvements : sortie, inventaire, stock bas, refus du négatif', async () => {
    await admin.post(`/api/stock/items/${id.gaff}/movements`, { kind: 'out', quantity: 7, reason: 'Montage' });
    expect((await admin.post(`/api/stock/items/${id.gaff}/movements`, { kind: 'out', quantity: 9 })).body.code).toBe('INSUFFICIENT_STOCK');
    expect((await admin.get('/api/stock/items?low=true')).body.map((i: { id: string }) => i.id)).toEqual([id.gaff]);
    await admin.post(`/api/stock/items/${id.gaff}/movements`, { kind: 'adjust', quantity: 12, reason: 'Inventaire' });
    const d = (await admin.get(`/api/stock/items/${id.gaff}`)).body;
    expect(d.quantity).toBe(12);
    expect(d.movements.map((m: { delta: number }) => m.delta)).toEqual([9, -7, 10]);
    // La quantité ne change pas par une simple modification.
    await admin.patch(`/api/stock/items/${id.gaff}`, { quantity: 99, name: 'Gaffer noir 50 mm' });
    expect((await admin.get(`/api/stock/items/${id.gaff}`)).body.quantity).toBe(12);
  });

  it('export CSV et étiquettes QR', async () => {
    const csv = await admin.get('/api/stock/items.csv');
    expect(csv.text).toContain('LUM-001');
    const pdf = await admin.get(`/api/stock/labels.pdf?ids=${id.pc},${id.gaff}`).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('le régisseur consulte sans modifier', async () => {
    expect((await regie.get('/api/stock/items')).status).toBe(200);
    expect((await regie.post('/api/stock/items', { name: 'X' })).status).toBe(403);
    expect((await regie.post(`/api/stock/items/${id.pc}/movements`, { kind: 'out', quantity: 1 })).status).toBe(403);
  });
});

describe('Maintenance', () => {
  it('panne signalée par le régisseur : unités hors service', async () => {
    const t = await regie.post('/api/maintenance/tickets', { itemId: id.pc, title: 'Lampe grillée', priority: 'high', unitsOut: 2 });
    expect(t.status).toBe(201);
    id.ticket = t.body.id;
    expect((await regie.patch(`/api/maintenance/tickets/${id.ticket}`, { status: 'done' })).status).toBe(403);
    expect((await admin.post('/api/maintenance/tickets', { itemId: id.pc, title: 'Trop', unitsOut: 50 })).body.code).toBe('INVALID_QUANTITY');
    expect((await admin.get(`/api/stock/items/${id.pc}`)).body.availableNow).toBe(6);
    expect((await admin.get('/api/maintenance/summary')).body).toMatchObject({ open: 1, critical: 1, unitsOut: 2 });
  });

  it('entretien préventif : effectué, prochaine échéance', async () => {
    const p = await admin.post('/api/maintenance/plans', { itemId: id.pc, title: 'Vérification électrique', intervalDays: 365, nextDueOn: '2020-01-01' });
    id.plan = p.body.id;
    expect((await admin.get('/api/maintenance/plans')).body[0].overdue).toBe(true);
    const d = await admin.post(`/api/maintenance/plans/${id.plan}/done`, { note: 'RAS' });
    expect(d.body.plan.lastDoneOn).toBeTruthy();
    expect(d.body.plan.nextDueOn > d.body.plan.lastDoneOn).toBe(true);
    expect(d.body.ticket.status).toBe('done');
  });
});

describe('Booking', () => {
  it('salle : réservation confirmée, double réservation refusée, agenda', async () => {
    id.room = (await admin.post('/api/booking/resources', { name: 'Salle de répétition', capacity: 30, requiresApproval: true })).body.id;
    const b = await admin.post('/api/booking/bookings', { resourceId: id.room, title: 'Filage', startAt: day(3, 18), endAt: day(3, 22) });
    expect(b.body.status).toBe('confirmed');
    id.b1 = b.body.id;
    expect(b.body.eventId).toBeFalsy();
    expect((await admin.get(`/api/booking/bookings/${id.b1}`)).body.eventId).toBeTruthy();
    const clash = await admin.post('/api/booking/bookings', { resourceId: id.room, title: 'Autre', startAt: day(3, 20), endAt: day(3, 23) });
    expect(clash.body.code).toBe('RESOURCE_BUSY');
  });

  it('demande du régisseur en attente, puis acceptée', async () => {
    const b = await regie.post('/api/booking/bookings', { resourceId: id.room, title: 'Réglages', startAt: day(4, 9), endAt: day(4, 12) });
    expect(b.body.status).toBe('pending');
    expect((await regie.post(`/api/booking/bookings/${b.body.id}/decision`, { accept: true })).status).toBe(403);
    expect((await admin.post(`/api/booking/bookings/${b.body.id}/decision`, { accept: true })).body.status).toBe('confirmed');
    expect((await regie.post(`/api/booking/bookings/${b.body.id}/cancel`)).body.status).toBe('cancelled');
  });

  it('prêt de matériel : disponibilité, sortie, retour incomplet', async () => {
    expect((await admin.post('/api/booking/bookings', { title: 'Prêt', startAt: day(5, 8), endAt: day(6, 8), items: [{ itemId: id.gaff, quantity: 1 }] })).body.code).toBe('NOT_LOANABLE');
    // 8 projecteurs, 2 en panne : 6 disponibles.
    expect((await admin.post('/api/booking/bookings', { title: 'Trop', startAt: day(5, 8), endAt: day(6, 8), items: [{ itemId: id.pc, quantity: 7 }] })).body.code).toBe('NOT_AVAILABLE');
    const b = await admin.post('/api/booking/bookings', { title: 'Prêt au théâtre voisin', startAt: day(5, 8), endAt: day(6, 8), items: [{ itemId: id.pc, quantity: 4 }] });
    id.loan = b.body.id;
    const av = (await admin.get(`/api/booking/availability?from=${day(5, 10)}&to=${day(5, 12)}`)).body;
    expect(av.items.find((i: { id: string }) => i.id === id.pc).available).toBe(2);
    expect((await admin.post(`/api/booking/bookings/${id.loan}/return`, {})).body.code).toBe('NOT_OUT');
    await admin.post(`/api/booking/bookings/${id.loan}/checkout`);
    expect((await admin.post(`/api/booking/bookings/${id.loan}/cancel`)).body.code).toBe('ALREADY_OUT');
    const r = await admin.post(`/api/booking/bookings/${id.loan}/return`, { items: [{ itemId: id.pc, returned: 3 }] });
    expect(r.body.losses).toEqual(['1 × Projecteur PC 1 kW']);
    const d = (await admin.get(`/api/stock/items/${id.pc}`)).body;
    expect(d.quantity).toBe(7);
    expect(d.movements[0].kind).toBe('lost');
  });
});

describe('Suppressions', () => {
  it('supprime réservation, ressource, intervention, entretien, article, emplacement', async () => {
    expect((await admin.delete(`/api/booking/bookings/${id.loan}`)).status).toBe(200);
    expect((await admin.delete(`/api/booking/resources/${id.room}`)).body.code).toBe('CONFIRM_REQUIRED');
    expect((await admin.delete(`/api/booking/resources/${id.room}?force=1`)).status).toBe(200);
    expect((await admin.get('/api/booking/bookings')).body).toHaveLength(0);
    expect((await admin.delete(`/api/maintenance/plans/${id.plan}`)).status).toBe(200);
    expect((await admin.delete(`/api/stock/items/${id.pc}`)).body.code).toBe('CONFIRM_REQUIRED');
    expect((await admin.delete(`/api/maintenance/tickets/${id.ticket}`)).status).toBe(200);
    expect((await admin.delete(`/api/stock/items/${id.pc}`)).status).toBe(200);
    expect((await admin.delete(`/api/stock/locations/${id.loc}`)).status).toBe(200);
    expect((await admin.get('/api/stock/items')).body).toHaveLength(1);
  });

  it('purge complète de l’association', async () => {
    await admin.post('/api/booking/resources', { name: 'Hall' });
    const res = await admin.delete(`/api/system/associations/${assoc}?force=1`).send({ confirmName: 'Logistique Test' });
    expect(res.status).toBe(200);
  });
});
