import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let cashier: Client;
let assoc: string;
const id: Record<string, string> = {};
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Comité des fêtes' }, modules: ['pos', 'stock', 'tickets'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  const roles = (await admin.get('/api/admin/roles')).body;
  await admin.post('/api/admin/users', { email: 'buvette@x.fr', displayName: 'Bénévole buvette', password: 'Provisoire-123456', roleIds: [roles.find((r: { key: string }) => r.key === 'caissier').id] });
  cashier = new Client(app);
  await cashier.login('buvette@x.fr', 'Provisoire-123456');
  await cashier.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Buvette-Kermesse-2026' });
  cashier.association = assoc;
});

afterAll(async () => {
  await app?.close();
});

describe('Catalogue et caisses', () => {
  it('caisse, catégories, produits liés au stock', async () => {
    id.reg = (await admin.post('/api/pos/registers', { name: 'Buvette', ticketSales: true })).body.id;
    id.drinks = (await admin.post('/api/pos/categories', { name: 'Boissons', color: '#1765AD' })).body.id;
    id.canette = (await admin.post('/api/stock/items', { name: 'Canette de soda', kind: 'consumable', quantity: 3 })).body.id;
    id.soda = (await admin.post('/api/pos/products', { name: 'Soda', priceCents: 200, categoryId: id.drinks, stockItemId: id.canette })).body.id;
    id.crepe = (await admin.post('/api/pos/products', { name: 'Crêpe', priceCents: 250 })).body.id;
    expect((await cashier.post('/api/pos/products', { name: 'X', priceCents: 1 })).status).toBe(403);
    const cat = (await cashier.get('/api/pos/catalog')).body;
    expect(cat.products).toHaveLength(2);
    expect(cat.stockSync).toBe(true);
  });
});

describe('Session de caisse', () => {
  it('ouverture unique avec fond de caisse', async () => {
    const s = await cashier.post(`/api/pos/registers/${id.reg}/open`, { openingFloatCents: 5000 });
    expect(s.status).toBe(201);
    id.session = s.body.id;
    expect((await cashier.post(`/api/pos/registers/${id.reg}/open`, {})).body.code).toBe('ALREADY_OPEN');
  });

  it('vente avec rendu de monnaie, décrément du stock', async () => {
    const bad = await cashier.post(`/api/pos/sessions/${id.session}/sales`, { lines: [{ productId: id.soda, quantity: 2 }], payments: [{ method: 'cash', amountCents: 300 }] });
    expect(bad.body.code).toBe('PAYMENT_MISMATCH');
    const s = await cashier.post(`/api/pos/sessions/${id.session}/sales`, { lines: [{ productId: id.soda, quantity: 2 }, { productId: id.crepe, quantity: 1 }], payments: [{ method: 'cash', amountCents: 650, tenderedCents: 1000 }] });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ totalCents: 650, changeCents: 350, shortages: [] });
    expect(s.body.number).toMatch(/^C\d{4}-00001$/);
    id.sale1 = s.body.id;
    expect((await admin.get(`/api/stock/items/${id.canette}`)).body.quantity).toBe(1);
  });

  it('règlement mixte, montant libre, stock insuffisant non bloquant', async () => {
    const s = await cashier.post(`/api/pos/sessions/${id.session}/sales`, { lines: [{ productId: id.soda, quantity: 2 }, { custom: 'Tombola', priceCents: 500, quantity: 1 }], payments: [{ method: 'card', amountCents: 600 }, { method: 'cash', amountCents: 300 }] });
    expect(s.body.shortages).toEqual(['Canette de soda']);
    id.sale2 = s.body.id;
    expect((await admin.get(`/api/stock/items/${id.canette}`)).body.quantity).toBe(0);
  });

  it('billets vendus en caisse', async () => {
    const e = await admin.post('/api/tickets/events', { title: 'Bal du 14 juillet', startAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), status: 'on_sale', capacity: 100 });
    const scr = (await cashier.get(`/api/pos/sessions/${id.session}/screen`)).body;
    expect(scr.events).toHaveLength(1);
    const rate = scr.events[0].rates[0];
    const s = await cashier.post(`/api/pos/sessions/${id.session}/sales`, { lines: [{ ticketRateId: rate.id, quantity: 2 }], payments: [{ method: 'card', amountCents: rate.priceCents * 2 }] });
    expect(s.status).toBe(201);
    expect(s.body.ticketOrder.url).toContain('/billets/');
    id.sale3 = s.body.id;
    expect((await admin.get(`/api/tickets/events/${e.body.id}`)).body.sold).toBe(2);
    id.event = e.body.id;
  });

  it('annulation : motif obligatoire, stock restitué, billets annulés', async () => {
    expect((await cashier.post(`/api/pos/sales/${id.sale1}/void`, {})).status).toBe(400);
    expect((await cashier.post(`/api/pos/sales/${id.sale1}/void`, { reason: 'Erreur de saisie' })).body.status).toBe('voided');
    expect((await admin.get(`/api/stock/items/${id.canette}`)).body.quantity).toBe(2);
    await cashier.post(`/api/pos/sales/${id.sale3}/void`, { reason: 'Client parti' });
    expect((await admin.get(`/api/tickets/events/${id.event}`)).body.sold).toBe(0);
    const pdf = await cashier.get(`/api/pos/sales/${id.sale2}/receipt.pdf`).buffer(true).parse(binary);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('mouvements d’espèces et clôture avec comptage', async () => {
    await cashier.post(`/api/pos/sessions/${id.session}/moves`, { kind: 'out', amountCents: 2000, reason: 'Dépôt au coffre' });
    const d = (await cashier.get(`/api/pos/sessions/${id.session}`)).body;
    // Fond 50 + espèces 3 (vente 2) − retrait 20 = 33 €
    expect(d.summary).toMatchObject({ salesCount: 1, totalCents: 900, voidedCount: 2, expectedCashCents: 3300, byMethod: { card: 600, cash: 300 } });
    const c = await cashier.post(`/api/pos/sessions/${id.session}/close`, { cashCount: { '2000': 1, '1000': 1, '200': 1, '50': 1 }, notes: 'RAS' });
    expect(c.body).toMatchObject({ status: 'closed', countedCashCents: 3250, differenceCents: -50 });
    expect((await cashier.post(`/api/pos/sessions/${id.session}/sales`, { lines: [{ productId: id.crepe, quantity: 1 }], payments: [{ method: 'cash', amountCents: 250 }] })).body.code).toBe('SESSION_CLOSED');
    expect((await cashier.post(`/api/pos/sales/${id.sale2}/void`, { reason: 'Trop tard' })).body.code).toBe('SESSION_CLOSED');
    const z = await cashier.get(`/api/pos/sessions/${id.session}/report.pdf`).buffer(true).parse(binary);
    expect(z.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await admin.get(`/api/pos/sessions/${id.session}/sales.csv`)).text).toContain('Tombola');
    expect((await cashier.get(`/api/pos/sessions/${id.session}/sales.csv`)).status).toBe(403);
  });
});

describe('Suppressions', () => {
  it('supprime session, produit, catégorie, caisse', async () => {
    expect((await cashier.delete(`/api/pos/sessions/${id.session}`)).status).toBe(403);
    expect((await admin.delete(`/api/pos/sessions/${id.session}`)).body.code).toBe('CONFIRM_REQUIRED');
    expect((await admin.delete(`/api/pos/sessions/${id.session}?force=1`)).status).toBe(200);
    expect((await admin.delete(`/api/pos/products/${id.soda}`)).status).toBe(200);
    expect((await admin.delete(`/api/pos/categories/${id.drinks}`)).status).toBe(200);
    expect((await admin.delete(`/api/pos/registers/${id.reg}`)).status).toBe(200);
    expect((await admin.get('/api/pos/registers')).body).toHaveLength(0);
  });

  it('purge complète de l’association', async () => {
    const r = await admin.post('/api/pos/registers', { name: 'Bar' });
    await admin.post(`/api/pos/registers/${r.body.id}/open`, { openingFloatCents: 1000 });
    const res = await admin.delete(`/api/system/associations/${assoc}?force=1`).send({ confirmName: 'Comité des fêtes' });
    expect(res.status).toBe(200);
  });
});
