import { INestApplication } from '@nestjs/common';
import { ADMIN, Client, configureTestEnv, resetDatabase } from './helpers';

configureTestEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp, migrateIfNeeded } = require('../src/bootstrap') as typeof import('../src/bootstrap');

let app: INestApplication;
let admin: Client;
let volunteer: Client;
let assoc: string;
let volunteerMembership: string;
let projectId: string;

beforeAll(async () => {
  await resetDatabase();
  await migrateIfNeeded();
  app = await createApp({ logger: false });
  await app.init();
  admin = new Client(app);
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Compagnie Projets' }, modules: ['projects'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  const roles = (await admin.get('/api/admin/roles')).body as { id: string; key: string }[];
  const u = await admin.post('/api/admin/users', { email: 'benevole@x.fr', displayName: 'Bénévole Bob', password: 'Provisoire-123456', roleIds: [roles.find((r) => r.key === 'benevole')!.id] });
  volunteerMembership = u.body.id;
  volunteer = new Client(app);
  await volunteer.login('benevole@x.fr', 'Provisoire-123456');
  await volunteer.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Benevole-Pass-2026' });
  volunteer.association = assoc;
});

afterAll(async () => {
  await app?.close();
});

describe('Modèles', () => {
  it('installe le modèle « Organisation d’un spectacle » et crée un projet daté à partir de lui', async () => {
    const tpl = await admin.post('/api/projects/templates/spectacle');
    expect(tpl.status).toBe(201);
    expect(tpl.body.isTemplate).toBe(true);
    expect((await admin.get('/api/projects?templates=true')).body).toHaveLength(1);
    const p = await admin.post('/api/projects', { name: 'Tartuffe — printemps', referenceDate: '2027-05-15', templateId: tpl.body.id });
    expect(p.status).toBe(201);
    projectId = p.body.id;
    const list = (await admin.get(`/api/projects/${projectId}/tasks`)).body as { title: string; dueDate: string | null; parentId: string | null; checklist: { done: boolean }[] }[];
    expect(list.length).toBeGreaterThan(20);
    const rights = list.find((t) => t.title.startsWith('Choisir le texte'))!;
    expect(rights.dueDate).toBe('2026-11-16'); // J-180
    expect(rights.checklist.every((i) => !i.done)).toBe(true);
    const general = list.find((t) => t.title === 'Répétition générale')!;
    expect(general.dueDate).toBe('2027-05-13');
    expect(list.some((t) => t.parentId)).toBe(true);
    // Les projets du modèle ne polluent pas la liste des projets actifs.
    expect((await admin.get('/api/projects')).body.map((x: { id: string }) => x.id)).toEqual([projectId]);
  });

  it('refuse d’utiliser un projet ordinaire comme modèle', async () => {
    expect((await admin.post('/api/projects', { name: 'Copie interdite', templateId: projectId })).body.code).toBe('NOT_TEMPLATE');
  });
});

describe('Tâches et Kanban', () => {
  let taskId: string;
  it('crée une tâche attribuée, une sous-tâche, et refuse un parent invalide', async () => {
    const t = await admin.post(`/api/projects/${projectId}/tasks`, { title: 'Imprimer les affiches', priority: 'high', assigneeId: volunteerMembership, dueDate: '2027-04-01', labels: ['Communication'], checklist: [{ text: 'BAT validé' }, { text: 'Commande passée' }] });
    expect(t.status).toBe(201);
    taskId = t.body.id;
    const sub = await admin.post(`/api/projects/${projectId}/tasks`, { title: 'Choisir l’imprimeur', parentId: taskId });
    expect(sub.status).toBe(201);
    expect((await admin.post(`/api/projects/${projectId}/tasks`, { title: 'Trop profond', parentId: sub.body.id })).body.code).toBe('INVALID_PARENT');
    expect((await admin.post(`/api/projects/${projectId}/tasks`, { title: 'Inconnu', assigneeId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('INVALID_ASSIGNEE');
    const detail = await admin.get(`/api/tasks/${taskId}`);
    expect(detail.body.subtasks).toHaveLength(1);
    expect(detail.body.assigneeName).toBe('Bénévole Bob');
  });

  it('réorganise une colonne et horodate l’achèvement', async () => {
    const all = (await admin.get(`/api/projects/${projectId}/tasks`)).body as { id: string; status: string; parentId: string | null }[];
    const two = all.filter((t) => !t.parentId).slice(0, 2).map((t) => t.id);
    expect((await admin.post(`/api/projects/${projectId}/board`, { status: 'done', orderedIds: [two[1], two[0]] })).status).toBe(200);
    const after = (await admin.get(`/api/projects/${projectId}/tasks`)).body as { id: string; status: string; completedAt: string | null; position: number }[];
    const a = after.find((t) => t.id === two[1])!;
    const b = after.find((t) => t.id === two[0])!;
    expect(a.status).toBe('done');
    expect(a.completedAt).not.toBeNull();
    expect(a.position).toBeLessThan(b.position);
  });

  it('modification partielle sans réinitialiser étiquettes ni checklist', async () => {
    const u = await admin.patch(`/api/tasks/${taskId}`, { title: 'Imprimer les affiches A3' });
    expect(u.body).toMatchObject({ title: 'Imprimer les affiches A3', priority: 'high', labels: ['Communication'], dueDate: '2027-04-01' });
    expect(u.body.checklist).toHaveLength(2);
  });
});

describe('Droits : la personne responsable', () => {
  it('voit ses tâches, change leur état et commente, mais ne peut rien d’autre', async () => {
    const mine = await volunteer.get('/api/tasks/mine');
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].projectName).toBe('Tartuffe — printemps');
    const id = mine.body[0].id;
    expect((await volunteer.patch(`/api/tasks/${id}`, { status: 'doing', checklist: [{ text: 'BAT validé', done: true }, { text: 'Commande passée', done: false }] })).status).toBe(200);
    expect((await volunteer.post(`/api/tasks/${id}/comments`, { body: 'BAT reçu, en attente du devis.' })).status).toBe(201);
    const refused = await volunteer.patch(`/api/tasks/${id}`, { title: 'Renommée' });
    expect(refused.status).toBe(403);
    expect(refused.body.details.fields).toEqual(['title']);
    const others = (await volunteer.get(`/api/projects/${projectId}/tasks`)).body as { id: string; assigneeId: string | null }[];
    const notMine = others.find((t) => t.assigneeId !== volunteerMembership)!;
    expect((await volunteer.patch(`/api/tasks/${notMine.id}`, { status: 'done' })).status).toBe(403);
    expect((await volunteer.post(`/api/tasks/${notMine.id}/comments`, { body: 'x' })).status).toBe(403);
    expect((await volunteer.post(`/api/projects/${projectId}/tasks`, { title: 'Nouvelle' })).body.code).toBe('PERMISSION_DENIED');
    expect((await volunteer.post(`/api/projects/${projectId}/board`, { status: 'done', orderedIds: [notMine.id] })).body.code).toBe('PERMISSION_DENIED');
    const detail = await admin.get(`/api/tasks/${id}`);
    expect(detail.body.status).toBe('doing');
    expect(detail.body.comments[0].author).toBe('Bénévole Bob');
  });

  it('widget Hub : tâches de l’utilisateur', async () => {
    const roles = (await admin.get('/api/admin/roles')).body as { id: string; key: string; permissions: string[] }[];
    const ben = roles.find((r) => r.key === 'benevole')!;
    await admin.patch(`/api/admin/roles/${ben.id}`, { permissions: [...ben.permissions, 'hub.read'] });
    const hub = await volunteer.get('/api/hub/summary');
    expect(hub.body.widgets.tasks).toMatchObject({ mine: 1, overdue: 0 });
  });
});

describe('Archivage et désactivation', () => {
  it('un projet archivé est en lecture seule', async () => {
    await admin.post(`/api/projects/${projectId}/archive`, {});
    expect((await admin.post(`/api/projects/${projectId}/tasks`, { title: 'X' })).body.code).toBe('PROJECT_ARCHIVED');
    expect((await volunteer.get('/api/tasks/mine')).body).toHaveLength(0);
    await admin.post(`/api/projects/${projectId}/archive`, { restore: true });
    expect((await volunteer.get('/api/tasks/mine')).body).toHaveLength(1);
  });

  it('la désactivation du module signale les tâches en cours', async () => {
    const preview = await admin.post('/api/admin/modules/projects/preview-deactivation', { mode: 'inactive' });
    expect(preview.body.impacts[0].message).toMatch(/tâche\(s\) en cours/);
  });
});
