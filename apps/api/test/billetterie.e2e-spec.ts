import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let ctrl: Client;
let anon: Client;
let assoc: string;
let slug: string;
const id: Record<string, string> = {};
const codes: string[] = [];
let valid: string[] = [];
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const day = (n: number, h: number) => { const d = new Date(Date.now() + n * 86_400_000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Théâtre du Lavoir' }, modules: ['tickets', 'scan', 'show'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  slug = (await admin.get('/api/admin/association')).body.slug;
  const roles = (await admin.get('/api/admin/roles')).body;
  await admin.post('/api/admin/users', { email: 'controle@x.fr', displayName: 'Contrôleur', password: 'Provisoire-123456', roleIds: [roles.find((r: { key: string }) => r.key === 'controleur').id] });
  ctrl = new Client(app);
  await ctrl.login('controle@x.fr', 'Provisoire-123456');
  await ctrl.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Controleur-Entree-2026' });
  ctrl.association = assoc;
  anon = new Client(app);
});

afterAll(async () => {
  await app?.close();
});

describe('Séances et tarifs', () => {
  it('séance autonome avec tarifs par défaut, jauge', async () => {
    const e = await admin.post('/api/tickets/events', { title: 'Concert de printemps', startAt: day(10, 19), venue: 'Salle des fêtes', capacity: 5, status: 'on_sale', publicSale: true, maxPerOrder: 4 });
    expect(e.status).toBe(201);
    id.event = e.body.id;
    const d = (await admin.get(`/api/tickets/events/${id.event}`)).body;
    expect(d.rates.map((r: { name: string }) => r.name)).toEqual(['Plein tarif', 'Tarif réduit', 'Invitation']);
    id.plein = d.rates[0].id; id.reduit = d.rates[1].id; id.invit = d.rates[2].id;
    await admin.patch(`/api/tickets/rates/${id.reduit}`, { quota: 2 });
    expect(d.publicUrl).toContain(`/billetterie/${slug}`);
  });

  it('représentation de Show : date et lieu suivent Show', async () => {
    const s = await admin.post('/api/show/shows', { title: 'Le Malade imaginaire' });
    const p = await admin.post(`/api/show/shows/${s.body.id}/performances`, { startAts: [day(20, 18)], endAt: day(20, 20), capacity: 80 });
    const perfId = p.body.performances[0].id;
    const perfs = (await admin.get('/api/tickets/performances')).body;
    expect(perfs.length).toBe(1);
    const e = await admin.post('/api/tickets/events', { performanceId: perfs[0].id });
    expect(e.body.title).toBe('Le Malade imaginaire');
    expect(e.body.capacity).toBe(80);
    id.showEvent = e.body.id;
    expect((await admin.get('/api/tickets/performances')).body).toHaveLength(0);
    await admin.patch(`/api/show/performances/${perfId}`, { startAt: day(21, 18), endAt: day(21, 20) });
    expect((await admin.get(`/api/tickets/events/${id.showEvent}`)).body.startAt).toBe(day(21, 18));
  });
});

describe('Vente au guichet', () => {
  it('vend, refuse au-delà du quota et de la jauge', async () => {
    const o = await admin.post(`/api/tickets/events/${id.event}/orders`, { buyerName: 'Mme Martin', lines: [{ rateId: id.plein, quantity: 1 }, { rateId: id.reduit, quantity: 2 }], paymentMethod: 'cash' });
    expect(o.status).toBe(201);
    expect(o.body.totalCents).toBe(2400);
    expect(o.body.number).toMatch(/^B\d{4}-00001$/);
    id.order = o.body.id;
    expect((await admin.post(`/api/tickets/events/${id.event}/orders`, { buyerName: 'X', lines: [{ rateId: id.reduit, quantity: 1 }] })).body.code).toBe('RATE_SOLD_OUT');
    expect((await admin.post(`/api/tickets/events/${id.event}/orders`, { buyerName: 'X', lines: [{ rateId: id.plein, quantity: 3 }] })).body.code).toBe('SOLD_OUT');
    const inv = await admin.post(`/api/tickets/events/${id.event}/orders`, { buyerName: 'Presse', channel: 'invitation', lines: [{ rateId: id.invit, quantity: 1 }] });
    expect(inv.body.paymentMethod).toBe('free');
    const d = (await admin.get(`/api/tickets/orders/${id.order}`)).body;
    codes.push(...d.tickets.map((t: { code: string }) => t.code));
    const pdf = await admin.get(`/api/tickets/orders/${id.order}/tickets.pdf`).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await admin.get(`/api/tickets/events/${id.event}`)).body).toMatchObject({ sold: 4, revenueCents: 2400, byMethod: { cash: 2400 } });
  });

  it('annule un billet : place libérée, montant recalculé', async () => {
    const d = (await admin.get(`/api/tickets/orders/${id.order}`)).body;
    const reduit = d.tickets.find((t: { rateName: string }) => t.rateName === 'Tarif réduit');
    const r = await admin.post(`/api/tickets/tickets/${reduit.id}/cancel`);
    expect(r.body.totalCents).toBe(1700);
    expect((await admin.get(`/api/tickets/events/${id.event}`)).body.sold).toBe(3);
    valid = (await admin.get(`/api/tickets/orders/${id.order}`)).body.tickets.filter((t: { status: string }) => t.status === 'valid').map((t: { code: string }) => t.code);
  });
});

describe('Réservation en ligne', () => {
  it('page publique, réservation à régler sur place, limites', async () => {
    const pg = await anon.get(`/api/public/tickets/${slug}`);
    expect(pg.status).toBe(200);
    expect(pg.body.events).toHaveLength(1);
    expect(pg.body.events[0].rates.map((r: { name: string }) => r.name)).toEqual(['Plein tarif', 'Tarif réduit']);
    expect(pg.body.events[0].remaining).toBe(2);
    expect((await anon.post(`/api/public/tickets/${slug}/events/${id.event}/orders`, { buyerName: 'Robot', buyerEmail: 'r@x.fr', lines: [{ rateId: id.plein, quantity: 1 }], website: 'http://spam' })).body.code).toBe('REJECTED');
    expect((await anon.post(`/api/public/tickets/${slug}/events/${id.event}/orders`, { buyerName: 'Paul', buyerEmail: 'p@x.fr', lines: [{ rateId: id.invit, quantity: 1 }] })).body.code).toBe('UNKNOWN_RATE');
    const r = await anon.post(`/api/public/tickets/${slug}/events/${id.event}/orders`, { buyerName: 'Paul Durand', buyerEmail: 'paul@example.org', lines: [{ rateId: id.plein, quantity: 1 }] });
    expect(r.status).toBe(201);
    id.token = r.body.token;
    const o = (await anon.get(`/api/public/orders/${id.token}`)).body;
    expect(o.order.status).toBe('pending');
    expect(o.canCancel).toBe(true);
    codes.push(o.tickets[0].code);
    expect((await anon.get(`/api/public/ticket/${o.tickets[0].code}`)).body).toMatchObject({ valid: true, used: false, pending: true });
    expect((await anon.get(`/api/public/orders/${id.token}/tickets.pdf`)).status).toBe(200);
  });

  it('séance en préparation : invisible et non réservable', async () => {
    await admin.patch(`/api/tickets/events/${id.event}`, { status: 'draft' });
    expect((await anon.get(`/api/public/tickets/${slug}`)).body.events).toHaveLength(0);
    expect((await anon.post(`/api/public/tickets/${slug}/events/${id.event}/orders`, { buyerName: 'Paul', buyerEmail: 'p@x.fr', lines: [{ rateId: id.plein, quantity: 1 }] })).status).toBe(404);
    await admin.patch(`/api/tickets/events/${id.event}`, { status: 'on_sale' });
  });
});

describe('Contrôle des entrées', () => {
  it('le contrôleur voit les séances mais pas les commandes', async () => {
    expect((await ctrl.get('/api/scan/events')).body.map((e: { id: string }) => e.id)).toContain(id.event);
    expect((await ctrl.get(`/api/tickets/events/${id.event}/orders`)).status).toBe(403);
  });

  it('valide une fois, refuse le doublon, l’annulé et l’inconnu', async () => {
    const ok = await ctrl.post(`/api/scan/events/${id.event}/check`, { code: `http://localhost:3000/billet/${valid[0]}` });
    expect(ok.body).toMatchObject({ result: 'ok', ok: true, ticket: { holder: 'Mme Martin' } });
    const again = await ctrl.post(`/api/scan/events/${id.event}/check`, { code: valid[0] });
    expect(again.body.result).toBe('already');
    expect(again.body.message).toMatch(/déjà utilisé à/);
    const cancelled = (await admin.get(`/api/tickets/orders/${id.order}`)).body.tickets.find((t: { status: string }) => t.status === 'cancelled');
    expect((await ctrl.post(`/api/scan/events/${id.event}/check`, { code: cancelled.code })).body.result).toBe('cancelled');
    expect((await ctrl.post(`/api/scan/events/${id.event}/check`, { code: 'AAAAAAAAAAAAAAAAAAAAAA' })).body.result).toBe('unknown');
    const pending = await ctrl.post(`/api/scan/events/${id.event}/check`, { code: codes[codes.length - 1] });
    expect(pending.body).toMatchObject({ result: 'ok', ticket: { pending: true } });
    expect((await ctrl.post(`/api/scan/events/${id.showEvent}/check`, { code: valid[1] })).body.result).toBe('wrong_event');
    expect((await ctrl.post(`/api/scan/tickets/${ok.body.ticket.id}/undo`)).status).toBe(403);
    expect((await admin.post(`/api/scan/tickets/${ok.body.ticket.id}/undo`)).status).toBe(200);
    expect((await ctrl.post(`/api/scan/events/${id.event}/check`, { code: valid[0] })).body.result).toBe('ok');
  });

  it('hors connexion : empreintes seulement, rejeu avec l’heure d’origine', async () => {
    const m = (await ctrl.get(`/api/scan/events/${id.event}/manifest`)).body;
    expect(JSON.stringify(m)).not.toContain(valid[1]);
    expect(m.tickets.some((t: { h: string }) => t.h === createHash('sha256').update(valid[1]).digest('hex'))).toBe(true);
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    const s = await ctrl.post(`/api/scan/events/${id.event}/sync`, { device: 'Tél. entrée 2', entries: [{ code: valid[1], at }, { code: valid[1], at }] });
    expect(s.body.results.map((r: { result: string }) => r.result)).toEqual(['ok', 'already']);
    const st = (await ctrl.get(`/api/scan/events/${id.event}`)).body;
    expect(st.scanned).toBe(3);
    expect(st.recent[0].offline).toBe(true);
  });
});

describe('Encaissement, annulation, suppressions', () => {
  it('règle puis annule la réservation en ligne', async () => {
    const orders = (await admin.get(`/api/tickets/events/${id.event}/orders?status=pending`)).body;
    expect(orders).toHaveLength(1);
    await admin.post(`/api/tickets/orders/${orders[0].id}/pay`, { paymentMethod: 'card' });
    expect((await anon.post(`/api/public/orders/${id.token}/cancel`)).body.code).toBe('NOT_CANCELLABLE');
    const c = await admin.post(`/api/tickets/orders/${orders[0].id}/cancel`, { refund: true });
    expect(c.body.refundedAt).toBeTruthy();
    expect((await admin.get(`/api/tickets/events/${id.event}`)).body.byMethod.card).toBeUndefined();
  });

  it('export, puis suppression de tout', async () => {
    const csv = await admin.get(`/api/tickets/events/${id.event}/attendees.csv`);
    expect(csv.text).toContain('Mme Martin');
    expect((await admin.delete(`/api/tickets/rates/${id.plein}`)).body.code).toBe('CONFIRM_REQUIRED');
    expect((await admin.delete(`/api/tickets/rates/${id.plein}?force=1`)).status).toBe(200);
    expect((await admin.delete(`/api/tickets/orders/${id.order}`)).status).toBe(200);
    expect((await admin.delete(`/api/tickets/events/${id.event}`)).body.code).toBe('CONFIRM_REQUIRED');
    expect((await admin.delete(`/api/tickets/events/${id.event}?force=1`)).status).toBe(200);
    expect((await admin.delete(`/api/tickets/events/${id.showEvent}`)).status).toBe(200);
    expect((await admin.get('/api/tickets/events')).body).toHaveLength(0);
  });

  it('purge complète de l’association', async () => {
    const e = await admin.post('/api/tickets/events', { title: 'Bal', startAt: day(5, 20), status: 'on_sale' });
    const d = (await admin.get(`/api/tickets/events/${e.body.id}`)).body;
    await admin.post(`/api/tickets/events/${e.body.id}/orders`, { buyerName: 'A', lines: [{ rateId: d.rates[0].id, quantity: 1 }], paymentMethod: 'cash' });
    const res = await admin.delete(`/api/system/associations/${assoc}?force=1`).send({ confirmName: 'Théâtre du Lavoir' });
    expect(res.status).toBe(200);
  });
});
