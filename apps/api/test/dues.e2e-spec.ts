import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { ADMIN, Client, configureTestEnv, resetDatabase, TEST_DB } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let assoc: string;
let memberId: string;
let planId: string;
const year = new Date().getFullYear();
const todayIso = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Compagnie des Cotisations' }, modules: ['asso'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  const m = await admin.post('/api/asso/members', { firstName: 'Sarah', lastName: 'Bernhardt', status: 'pending' });
  memberId = m.body.id;
});

afterAll(async () => {
  await app?.close();
});

describe('Formules', () => {
  it('crée une formule et refuse un montant non entier (centimes)', async () => {
    const bad = await admin.post('/api/asso/plans', { name: 'Plein tarif', amountCents: 25.5, periodType: 'calendar_year' });
    expect(bad.status).toBe(400);
    const ok = await admin.post('/api/asso/plans', { name: 'Plein tarif', amountCents: 2500, periodType: 'calendar_year', memberCategory: 'actif' });
    expect(ok.status).toBe(201);
    planId = ok.body.id;
    expect((await admin.post('/api/asso/plans', { name: 'Plein tarif', amountCents: 100, periodType: 'one_time' })).status).toBe(409);
  });
});

describe('Cotisations et règlements', () => {
  let dueId: string;

  it('appelle une cotisation sur l’année civile et refuse le doublon', async () => {
    const res = await admin.post('/api/asso/dues', { memberId, planId, periodStart: todayIso });
    expect(res.status).toBe(201);
    expect(res.body.periodStart).toBe(`${year}-01-01`);
    expect(res.body.periodEnd).toBe(`${year}-12-31`);
    expect(res.body.amountCents).toBe(2500);
    expect(res.body.status).toBe('due');
    dueId = res.body.id;
    const dupe = await admin.post('/api/asso/dues', { memberId, planId, periodStart: todayIso });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('DUE_EXISTS');
  });

  it('pas de reçu tant que la cotisation n’est pas intégralement réglée', async () => {
    const r = await admin.post(`/api/asso/dues/${dueId}/payments`, { amountCents: 1000, method: 'cash' });
    expect(r.status).toBe(201);
    expect(r.body.due.status).toBe('partial');
    expect(r.body.due.receiptNumber).toBeNull();
    expect((await admin.get(`/api/asso/dues/${dueId}/receipt.pdf`)).status).toBe(409);
  });

  it('refuse un trop-perçu, y compris lors de règlements simultanés', async () => {
    const over = await admin.post(`/api/asso/dues/${dueId}/payments`, { amountCents: 1501, method: 'cheque' });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('OVERPAYMENT');
    const results = await Promise.all([
      admin.post(`/api/asso/dues/${dueId}/payments`, { amountCents: 1500, method: 'cheque', reference: 'Chèque 1' }),
      admin.post(`/api/asso/dues/${dueId}/payments`, { amountCents: 1500, method: 'transfer', reference: 'Virement' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const detail = await admin.get(`/api/asso/dues/${dueId}`);
    expect(detail.body.paidCents).toBe(2500);
    expect(detail.body.status).toBe('paid');
    expect(detail.body.receiptNumber).toBe(`${year}-0001`);
  });

  it('active l’adhérent et attribue la catégorie de la formule', async () => {
    const m = await admin.get(`/api/asso/members/${memberId}`);
    expect(m.body.status).toBe('active');
    expect(m.body.category).toBe('actif');
  });

  it('génère un reçu PDF', async () => {
    const res = await admin.get(`/api/asso/dues/${dueId}/receipt.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('annuler un règlement annule le reçu ; un nouveau règlement émet le numéro suivant', async () => {
    const detail = await admin.get(`/api/asso/dues/${dueId}`);
    const last = detail.body.payments.find((p: { cancelledAt: string | null; amountCents: number }) => !p.cancelledAt && p.amountCents === 1500);
    expect((await admin.post(`/api/asso/dues/${dueId}/payments/${last.id}/cancel`, {})).status).toBe(400); // motif obligatoire
    const c = await admin.post(`/api/asso/dues/${dueId}/payments/${last.id}/cancel`, { reason: 'Chèque rejeté' });
    expect(c.status).toBe(200);
    expect(c.body.due.status).toBe('partial');
    expect(c.body.due.receiptCancelledAt).not.toBeNull();
    const again = await admin.post(`/api/asso/dues/${dueId}/payments`, { amountCents: 1500, method: 'transfer' });
    expect(again.body.due.receiptNumber).toBe(`${year}-0002`);
  });

  it('un règlement enregistré est inaltérable en base', async () => {
    const pool = new Pool({ connectionString: TEST_DB });
    await expect(pool.query('UPDATE membership_payments SET amount_cents = 1')).rejects.toThrow(/ne peut pas être modifié/);
    await expect(pool.query('DELETE FROM membership_payments')).rejects.toThrow(/suppression interdite/);
    await pool.end();
  });

  it('refuse une date de règlement future', async () => {
    const m2 = await admin.post('/api/asso/members', { firstName: 'Jean', lastName: 'Vilar' });
    const d = await admin.post('/api/asso/dues', { memberId: m2.body.id, amountCents: 1000, periodType: 'one_time' });
    const r = await admin.post(`/api/asso/dues/${d.body.id}/payments`, { amountCents: 1000, method: 'cash', paidAt: `${year + 1}-01-01` });
    expect(r.status).toBe(400);
  });
});

describe('Renouvellements, exonération, annulation', () => {
  it('liste les adhérents sans cotisation réglée et appelle les cotisations en lot', async () => {
    const m3 = await admin.post('/api/asso/members', { firstName: 'Ariane', lastName: 'Mnouchkine' });
    const ren = await admin.get('/api/asso/dues/renewals?days=0');
    const ids = ren.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(m3.body.id);
    expect(ids).not.toContain(memberId); // couvert jusqu'au 31/12
    const bulk = await admin.post('/api/asso/dues/bulk', { memberIds: [m3.body.id, memberId], planId, periodStart: todayIso });
    expect(bulk.body.created).toBe(1);
    expect(bulk.body.skipped).toHaveLength(1); // doublon pour Sarah
  });

  it('exonère et annule avec motif', async () => {
    const list = await admin.get('/api/asso/dues?status=open&q=Mnouchkine');
    const id = list.body.items[0].id;
    expect((await admin.post(`/api/asso/dues/${id}/waive`, { reason: 'Bénévole' })).body.status).toBe('waived');
    const m = await admin.post('/api/asso/members', { firstName: 'Louis', lastName: 'Jouvet' });
    const d = await admin.post('/api/asso/dues', { memberId: m.body.id, planId });
    expect((await admin.post(`/api/asso/dues/${d.body.id}/cancel`, { reason: 'Erreur de saisie' })).body.status).toBe('cancelled');
    // Après annulation, la cotisation peut être rappelée.
    expect((await admin.post('/api/asso/dues', { memberId: m.body.id, planId })).status).toBe(201);
  });

  it('totaux exacts et export CSV', async () => {
    const all = await admin.get(`/api/asso/dues?year=${year}`);
    expect(all.body.totals.paidCents + all.body.totals.outstandingCents).toBe(all.body.totals.amountCents);
    const csv = await admin.get(`/api/asso/dues/export.csv?year=${year}`);
    expect(csv.text).toContain('25,00');
    const hub = await admin.get('/api/hub/summary');
    expect(hub.body.widgets.dues.open).toBeGreaterThanOrEqual(1);
  });
});

describe('Contrôles d’accès des cotisations', () => {
  it('lecture seule : consultation possible, encaissement refusé', async () => {
    expect((await admin.post('/api/admin/modules/asso/deactivate', { mode: 'readonly' })).status).toBe(200);
    const list = await admin.get('/api/asso/dues?status=open');
    expect(list.status).toBe(200);
    const pay = await admin.post(`/api/asso/dues/${list.body.items[0].id}/payments`, { amountCents: 100, method: 'cash' });
    expect(pay.body.code).toBe('MODULE_READONLY');
    expect((await admin.post('/api/admin/modules/asso/activate', {})).status).toBe(200);
  });

  it('la désactivation signale les cotisations en attente', async () => {
    const preview = await admin.post('/api/admin/modules/asso/preview-deactivation', { mode: 'inactive' });
    expect(preview.body.impacts.some((i: { message: string }) => /en attente de règlement/.test(i.message))).toBe(true);
  });

  it('le rôle Trésorier encaisse ; un lecteur des adhérents ne voit pas les cotisations', async () => {
    const roles = (await admin.get('/api/admin/roles')).body as { id: string; key: string }[];
    await admin.post('/api/admin/users', { email: 'tresorier@x.fr', displayName: 'Trésorière', password: 'Provisoire-123456', roleIds: [roles.find((r) => r.key === 'tresorier')!.id] });
    const lecteurRole = await admin.post('/api/admin/roles', { name: 'Lecteur', permissions: ['asso.read', 'asso.members.read'] });
    await admin.post('/api/admin/users', { email: 'lecteur@x.fr', displayName: 'Lecteur', password: 'Provisoire-123456', roleIds: [lecteurRole.body.id] });
    for (const [email, next] of [['tresorier@x.fr', 'Tresorier-Pass-2026'], ['lecteur@x.fr', 'Lecteur-Pass-2026']]) {
      const u = new Client(app);
      await u.login(email, 'Provisoire-123456');
      await u.post('/api/auth/password', { current: 'Provisoire-123456', next });
    }
    const t = new Client(app);
    await t.login('tresorier@x.fr', 'Tresorier-Pass-2026');
    t.association = assoc;
    const open = await t.get('/api/asso/dues?status=open');
    expect(open.status).toBe(200);
    const due = open.body.items[0];
    const pay = await t.post(`/api/asso/dues/${due.id}/payments`, { amountCents: due.amountCents - due.paidCents, method: 'cheque' });
    expect(pay.status).toBe(201);
    const l = new Client(app);
    await l.login('lecteur@x.fr', 'Lecteur-Pass-2026');
    l.association = assoc;
    expect((await l.get('/api/asso/dues')).body.code).toBe('PERMISSION_DENIED');
  });

  it('isolation : une cotisation d’une autre association est introuvable', async () => {
    const b = await admin.post('/api/system/associations', { name: 'Autre asso', modules: ['asso'] });
    const other = new Client(app);
    other.cookie = admin.cookie;
    other.csrf = admin.csrf;
    other.association = b.body.association.id;
    const list = await admin.get('/api/asso/dues');
    const id = list.body.items[0].id;
    expect((await other.get(`/api/asso/dues/${id}`)).status).toBe(404);
    expect((await other.post(`/api/asso/dues/${id}/payments`, { amountCents: 1, method: 'cash' })).status).toBe(404);
    expect((await other.get('/api/asso/dues')).body.total).toBe(0);
  });
});
