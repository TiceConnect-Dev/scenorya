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
let roles: { id: string; key: string }[];

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
  const res = await admin.post('/api/setup', { setupToken: 'setup-token-for-tests-123', admin: ADMIN, association: { name: 'Compagnie Drive' }, modules: ['drive', 'projects'] });
  assoc = res.body.associationId;
  admin.association = assoc;
  roles = (await admin.get('/api/admin/roles')).body;
  await admin.post('/api/admin/users', { email: 'regie@x.fr', displayName: 'Régis Seur', password: 'Provisoire-123456', roleIds: [roles.find((r) => r.key === 'regisseur')!.id] });
  regie = new Client(app);
  await regie.login('regie@x.fr', 'Provisoire-123456');
  await regie.post('/api/auth/password', { current: 'Provisoire-123456', next: 'Regisseur-Pass-2026' });
  regie.association = assoc;
});

afterAll(async () => {
  await app?.close();
});

describe('Dossiers et envoi', () => {
  let docs: string;
  it('crée les espaces recommandés, avec dossiers restreints par rôle', async () => {
    const r = await admin.post('/api/drive/recommended');
    expect(r.status).toBe(201);
    expect(r.body.created).toContain('Comptabilité');
    const again = await admin.post('/api/drive/recommended');
    expect(again.body.created).toEqual([]);
    const root = (await admin.get('/api/drive/browse')).body;
    expect(root.folders.find((f: { name: string }) => f.name === 'Comptabilité').restricted).toBe(true);
    // Le régisseur ne voit pas les dossiers restreints.
    const seen = (await regie.get('/api/drive/browse')).body.folders.map((f: { name: string }) => f.name);
    expect(seen).toContain('Technique');
    expect(seen).not.toContain('Comptabilité');
    docs = root.folders.find((f: { name: string }) => f.name === 'Technique').id;
  });

  it('envoie des fichiers, déduplique le contenu identique et renomme en cas de doublon', async () => {
    const a = await regie.upload('/api/drive/files', [{ name: 'Fiche technique.pdf', content: '%PDF-1.4 fiche' }, { name: 'Plan de feu.txt', content: 'projecteurs' }], { folderId: docs });
    expect(a.status).toBe(201);
    expect(a.body.files).toHaveLength(2);
    const b = await regie.upload('/api/drive/files', [{ name: 'Fiche technique.pdf', content: '%PDF-1.4 fiche' }], { folderId: docs });
    expect(b.body.files[0].name).toBe('Fiche technique (2).pdf');
    expect(b.body.files[0].deduplicated).toBe(true);
    const sys = (await admin.get('/api/system/drive')).body;
    expect(sys.blobs).toBe(2); // 3 documents, 2 contenus distincts
  });

  it('refuse les exécutables, y compris renommés', async () => {
    const exe = await regie.upload('/api/drive/files', [{ name: 'outil.exe', content: 'x' }]);
    expect(exe.body.code).toBe('DRIVE_BLOCKED_TYPE');
    const disguised = await regie.upload('/api/drive/files', [{ name: 'photo.jpg', content: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]) }]);
    expect(disguised.body.code).toBe('DRIVE_BLOCKED_TYPE');
    const tmp = (await admin.get('/api/system/drive')).body;
    expect(tmp.blobs).toBe(2);
  });

  it('crée de nouvelles versions et restaure une ancienne', async () => {
    const list = (await regie.get(`/api/drive/browse?folderId=${docs}`)).body.files;
    const plan = list.find((f: { name: string }) => f.name === 'Plan de feu.txt');
    const v2 = await regie.upload(`/api/drive/files/${plan.id}/versions`, [{ field: 'file', name: 'plan.txt', content: 'projecteurs v2' }], { comment: 'Ajout des découpes' });
    expect(v2.body.version).toBe(2);
    const same = await regie.upload('/api/drive/files', [{ name: 'plan de feu.TXT', content: 'v3' }], { folderId: docs, conflict: 'version' });
    expect(same.body.files[0].version).toBe(3);
    const r = await regie.post(`/api/drive/files/${plan.id}/versions/1/restore`);
    expect(r.body.version).toBe(4);
    const body = await regie.get(`/api/drive/files/${plan.id}/content`).buffer(true).parse(binary);
    expect(body.body.toString()).toBe('projecteurs');
    const old = await regie.get(`/api/drive/files/${plan.id}/content?version=2`).buffer(true).parse(binary);
    expect(old.body.toString()).toBe('projecteurs v2');
    const d = (await regie.get(`/api/drive/files/${plan.id}`)).body;
    expect(d.versions.map((v: { version: number }) => v.version)).toEqual([4, 3, 2, 1]);
  });

  it('sert les aperçus avec des en-têtes sûrs ; le SVG est toujours téléchargé', async () => {
    const svg = await regie.upload('/api/drive/files', [{ name: 'logo.svg', content: '<svg onload="alert(1)"/>' }], { folderId: docs });
    const id = svg.body.files[0].id;
    const r = await regie.get(`/api/drive/files/${id}/content?inline=1`);
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain('sandbox');
    const pdf = (await regie.get(`/api/drive/browse?folderId=${docs}`)).body.files.find((f: { name: string }) => f.name === 'Fiche technique.pdf');
    const p = await regie.get(`/api/drive/files/${pdf.id}/content?inline=1`);
    expect(p.headers['content-disposition']).toMatch(/^inline/);
    expect(p.headers['content-type']).toBe('application/pdf');
    // Lien ouvert directement par le navigateur : association passée en paramètre (GET uniquement).
    const direct = await request(app.getHttpServer()).get(`/api/drive/files/${pdf.id}/content?inline=1&assoc=${assoc}`).set('Cookie', regie.cookie);
    expect(direct.status).toBe(200);
  });

  it('applique les étiquettes, la recherche et les favoris', async () => {
    const pdf = (await regie.get(`/api/drive/search?q=fiche`)).body[0];
    expect(pdf.path).toBe('Technique');
    await regie.patch(`/api/drive/files/${pdf.id}`, { tags: ['Régie', 'tartuffe'] });
    expect((await regie.get('/api/drive/search?tag=tartuffe')).body).toHaveLength(1);
    expect((await regie.get('/api/drive/search?q=TARTU')).body).toHaveLength(1);
    await regie.post(`/api/drive/files/${pdf.id}/favorite`, { on: true });
    expect((await regie.get('/api/drive/favorites')).body.map((f: { id: string }) => f.id)).toEqual([pdf.id]);
    expect((await admin.get('/api/drive/favorites')).body).toEqual([]);
  });
});

describe('Dossiers restreints', () => {
  it('cache le contenu restreint, refuse l’accès direct et la sortie du dossier', async () => {
    const compta = (await admin.get('/api/drive/browse')).body.folders.find((f: { name: string }) => f.name === 'Comptabilité');
    const up = await admin.upload('/api/drive/files', [{ name: 'Bilan 2026.xlsx', content: 'bilan' }], { folderId: compta.id });
    const id = up.body.files[0].id;
    expect((await regie.get(`/api/drive/files/${id}`)).status).toBe(404);
    expect((await regie.get(`/api/drive/files/${id}/content`)).status).toBe(404);
    expect((await regie.get(`/api/drive/browse?folderId=${compta.id}`)).status).toBe(404);
    expect((await regie.get('/api/drive/search?q=bilan')).body).toEqual([]);
    // Ouverture au rôle régisseur, puis tentative de sortir le document du dossier.
    const reg = roles.find((r) => r.key === 'regisseur')!.id;
    expect((await admin.put(`/api/drive/folders/${compta.id}/access`, { restricted: true, allowedRoleIds: [reg] })).status).toBe(200);
    expect((await regie.get(`/api/drive/files/${id}`)).status).toBe(200);
    const move = await regie.patch(`/api/drive/files/${id}`, { folderId: null });
    expect(move.body.code).toBe('DRIVE_RESTRICTED_MOVE');
    const share = await regie.post(`/api/drive/files/${id}/shares`, {});
    expect(share.status).toBe(403);
    // Le régisseur n'a pas le droit de gérer les accès.
    expect((await regie.put(`/api/drive/folders/${compta.id}/access`, { restricted: false })).status).toBe(403);
  });
});

describe('Corbeille', () => {
  it('supprime un dossier avec son contenu, le restaure, puis le supprime définitivement en libérant le stockage', async () => {
    const f = await admin.post('/api/drive/folders', { name: 'Archives' });
    const sub = await admin.post('/api/drive/folders', { name: '2025', parentId: f.body.id });
    await admin.upload('/api/drive/files', [{ name: 'unique.txt', content: 'contenu unique à purger' }], { folderId: sub.body.id });
    const sha = (await admin.get('/api/drive/search?q=unique')).body[0];
    const detail = (await admin.get(`/api/drive/files/${sha.id}`)).body;
    expect(detail.versions).toHaveLength(1);
    const cycle = await admin.patch(`/api/drive/folders/${f.body.id}`, { parentId: sub.body.id });
    expect(cycle.body.code).toBe('DRIVE_CYCLE');

    expect((await admin.delete(`/api/drive/folders/${f.body.id}`)).body.files).toBe(1);
    const trash = (await admin.get('/api/drive/trash')).body;
    expect(trash).toHaveLength(1); // seul le dossier racine du lot apparaît
    expect(trash[0]).toMatchObject({ kind: 'folder', name: 'Archives', contains: 1 });
    expect((await admin.get('/api/drive/search?q=unique')).body).toEqual([]);

    // Un nouveau dossier « Archives » a été créé entre-temps : la restauration renomme.
    await admin.post('/api/drive/folders', { name: 'Archives' });
    const r = await admin.post(`/api/drive/trash/folder/${f.body.id}/restore`);
    expect(r.body).toMatchObject({ name: 'Archives (2)' });
    expect((await admin.get('/api/drive/search?q=unique')).body).toHaveLength(1);

    await admin.delete(`/api/drive/folders/${f.body.id}`);
    const before = (await admin.get('/api/system/drive')).body.blobs;
    const file = (await admin.get('/api/drive/trash')).body[0];
    const p = await admin.delete(`/api/drive/trash/folder/${file.id}`);
    expect(p.body.files).toBe(1);
    expect((await admin.get('/api/system/drive')).body.blobs).toBe(before - 1);
  });

  it('conserve un contenu partagé par un autre document lors de la purge', async () => {
    const list = (await regie.get('/api/drive/search?q=fiche')).body;
    const copy = list.find((f: { name: string }) => f.name === 'Fiche technique (2).pdf');
    expect((await regie.delete(`/api/drive/files/${copy.id}`)).status).toBe(403);
    await admin.delete(`/api/drive/files/${copy.id}`).expect(200);
    await admin.delete(`/api/drive/trash/file/${copy.id}`).expect(200);
    const original = list.find((f: { name: string }) => f.name === 'Fiche technique.pdf');
    const res = await regie.get(`/api/drive/files/${original.id}/content`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('%PDF-1.4 fiche');
  });
});

describe('Liens de partage', () => {
  let fileId: string;
  let token: string;
  it('crée un lien protégé, vérifie le mot de passe et la limite de téléchargements', async () => {
    const up = await admin.upload('/api/drive/files', [{ name: 'Dossier de presse.pdf', content: '%PDF presse' }]);
    fileId = up.body.files[0].id;
    expect((await regie.post(`/api/drive/files/${fileId}/shares`, {})).status).toBe(403); // pas de droit de publication
    const s = await admin.post(`/api/drive/files/${fileId}/shares`, { expiresInDays: 3, password: 'presse-2026', maxDownloads: 1 });
    expect(s.status).toBe(201);
    token = s.body.url.split('/partage/')[1];
    const pub = request(app.getHttpServer());
    const info = await pub.get(`/api/public/shares/${token}`);
    expect(info.body).toMatchObject({ name: 'Dossier de presse.pdf', needsPassword: true, remaining: 1, association: 'Compagnie Drive' });
    expect((await pub.post(`/api/public/shares/${token}/download`).send({ password: 'faux' })).status).toBe(401);
    const ok = await pub.post(`/api/public/shares/${token}/download`).send({ password: 'presse-2026' }).buffer(true).parse(binary);
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe('%PDF presse');
    expect((await pub.post(`/api/public/shares/${token}/download`).send({ password: 'presse-2026' })).status).toBe(404);
    const journal = (await admin.get('/api/drive/access-log')).body.items.map((i: { action: string }) => i.action);
    expect(journal).toEqual(expect.arrayContaining(['share_download', 'share_denied', 'download', 'preview']));
  });

  it('verrouille après 10 mauvais mots de passe et coupe les liens quand le module est désactivé', async () => {
    const s = await admin.post(`/api/drive/files/${fileId}/shares`, { password: 'secret-123' });
    const t = s.body.url.split('/partage/')[1];
    const pub = request(app.getHttpServer());
    for (let i = 0; i < 10; i++) await pub.post(`/api/public/shares/${t}/download`).send({ password: 'mauvais' });
    expect((await pub.post(`/api/public/shares/${t}/download`).send({ password: 'secret-123' })).status).toBe(429);

    const open = await admin.post(`/api/drive/files/${fileId}/shares`, {});
    const t2 = open.body.url.split('/partage/')[1];
    expect((await pub.get(`/api/public/shares/${t2}`)).status).toBe(200);
    const preview = await admin.post('/api/admin/modules/drive/preview-deactivation', { mode: 'inactive' });
    expect(JSON.stringify(preview.body)).toMatch(/lien\(s\) de partage/);
    expect((await admin.post('/api/admin/modules/drive/deactivate', { mode: 'inactive' })).body.code).toBe('WARNINGS_ACKNOWLEDGEMENT_REQUIRED');
    expect((await admin.post('/api/admin/modules/drive/deactivate', { mode: 'inactive', acknowledgeWarnings: true, confirmDependents: true })).status).toBe(200);
    expect((await pub.get(`/api/public/shares/${t2}`)).status).toBe(404);
    expect((await admin.post('/api/admin/modules/drive/activate', { confirmDependencies: true })).status).toBe(200);
    expect((await pub.get(`/api/public/shares/${t2}`)).status).toBe(200);
    // La révocation est immédiate.
    await admin.delete(`/api/drive/shares/${open.body.id}`).expect(200);
    expect((await pub.get(`/api/public/shares/${t2}`)).status).toBe(404);
  });
});

describe('Quota et pièces jointes', () => {
  it('refuse un envoi qui dépasse le quota de l’association', async () => {
    const r = await admin.put(`/api/system/associations/${assoc}/drive-quota`, { quotaMb: 1 });
    expect(r.status).toBe(200);
    const big = await admin.upload('/api/drive/files', [{ name: 'gros.bin.txt', content: Buffer.alloc(1024 * 1024 + 10, 1) }]);
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('DRIVE_QUOTA_EXCEEDED');
    await admin.put(`/api/system/associations/${assoc}/drive-quota`, { quotaMb: null });
    expect((await regie.put(`/api/system/associations/${assoc}/drive-quota`, { quotaMb: 99999 })).status).toBe(403);
  });

  it('rattache des pièces jointes à une tâche (fonctionnalité conditionnelle)', async () => {
    const p = await admin.post('/api/projects', { name: 'Tournée' });
    const t = await admin.post(`/api/projects/${p.body.id}/tasks`, { title: 'Réserver le camion' });
    const up = await admin.upload('/api/drive/files', [{ name: 'Devis camion.pdf', content: '%PDF devis' }], { linkModule: 'projects', linkEntityType: 'task', linkEntityId: t.body.id });
    expect(up.status).toBe(201);
    const links = (await admin.get(`/api/drive/links?module=projects&entityType=task&entityId=${t.body.id}`)).body;
    expect(links.map((f: { name: string }) => f.name)).toEqual(['Devis camion.pdf']);
    expect((await admin.get(`/api/drive/files/${links[0].id}`)).body.path.map((b: { name: string }) => b.name)).toEqual(['Pièces jointes']);
    const bad = await admin.upload('/api/drive/files', [{ name: 'x.txt', content: 'x' }], { linkModule: 'projects', linkEntityType: 'task', linkEntityId: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(404);
  });
});
