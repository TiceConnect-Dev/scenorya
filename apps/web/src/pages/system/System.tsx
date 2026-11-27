import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MODULE_PROFILES, MODULES_BY_ID, ModuleId } from '@scenorya/shared';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatBytes, formatDate, Loading, Modal, ModuleLogo, PageHead } from '../../components/ui';

const crumbs = (label?: string) => (label ? [{ label: 'Scenorya System', to: '/system' }, { label }] : [{ label: 'Scenorya System' }]);

interface Health {
  application: { version: string; node: string; env: string; uptimeSeconds: number; edition: string };
  system: { platform: string; totalMemBytes: number; freeMemBytes: number; load: number[] };
  process: { rssBytes: number; heapUsedBytes: number };
  database: { status: string; latencyMs?: number; version?: string; sizeBytes?: number; migrations?: { n: number; last: string }; error?: string };
  disk: { totalBytes: number; freeBytes: number; path: string } | null;
  smtp: { configured: boolean };
  backups: { last: { createdAt: string; status: string; filename: string } | null; pgDumpAvailable: boolean };
  scheduledTasks: { status: string; note: string };
}

export function HealthPage() {
  const q = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/system/health'), refetchInterval: 30_000 });
  const h = q.data;
  const ok = (b: boolean, yes = 'Opérationnel', no = 'Problème') => <Badge tone={b ? 'success' : 'danger'}>{b ? `✓ ${yes}` : `! ${no}`}</Badge>;
  return (
    <>
      <Breadcrumb items={crumbs()} />
      <div className="module-banner">
        <ModuleLogo id="system" />
      </div>
      <PageHead title="Santé technique" description="État de l’instance, actualisé toutes les 30 secondes. Aucun terminal ni commande système n’est exposé." />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {h && (
        <div className="grid-2">
          <section className="card">
            <h2>Application</h2>
            <dl className="props">
              <dt>Version</dt><dd>Scenorya {h.application.edition} {h.application.version}</dd>
              <dt>Environnement</dt><dd>{h.application.env}</dd>
              <dt>Node.js</dt><dd>{h.application.node}</dd>
              <dt>Démarrée depuis</dt><dd>{Math.floor(h.application.uptimeSeconds / 3600)} h {Math.floor((h.application.uptimeSeconds % 3600) / 60)} min</dd>
              <dt>Mémoire du processus</dt><dd>{formatBytes(h.process.rssBytes)}</dd>
            </dl>
          </section>
          <section className="card">
            <h2>Base de données</h2>
            <dl className="props">
              <dt>État</dt><dd>{ok(h.database.status === 'ok')}</dd>
              {h.database.error && (<><dt>Erreur</dt><dd>{h.database.error}</dd></>)}
              <dt>Version</dt><dd>{h.database.version ?? '—'}</dd>
              <dt>Latence</dt><dd>{h.database.latencyMs ?? '—'} ms</dd>
              <dt>Taille</dt><dd>{formatBytes(h.database.sizeBytes)}</dd>
              <dt>Migrations appliquées</dt><dd>{h.database.migrations?.n ?? '—'}</dd>
            </dl>
          </section>
          <section className="card">
            <h2>Serveur</h2>
            <dl className="props">
              <dt>Système</dt><dd>{h.system.platform}</dd>
              <dt>Mémoire</dt><dd>{formatBytes(h.system.totalMemBytes - h.system.freeMemBytes)} utilisés sur {formatBytes(h.system.totalMemBytes)}</dd>
              <dt>Charge</dt><dd>{h.system.load.map((l) => l.toFixed(2)).join(' / ')}</dd>
              {h.disk && (
                <>
                  <dt>Espace disque</dt>
                  <dd>
                    {formatBytes(h.disk.freeBytes)} libres sur {formatBytes(h.disk.totalBytes)}
                    <div className="progress" aria-hidden="true"><span style={{ width: `${Math.round(((h.disk.totalBytes - h.disk.freeBytes) / h.disk.totalBytes) * 100)}%` }} /></div>
                  </dd>
                </>
              )}
            </dl>
          </section>
          <section className="card">
            <h2>Services</h2>
            <dl className="props">
              <dt>Messagerie</dt><dd>{ok(h.smtp.configured, 'Configurée', 'Non configurée')}</dd>
              <dt>pg_dump</dt><dd>{ok(h.backups.pgDumpAvailable, 'Disponible', 'Introuvable')}</dd>
              <dt>Dernière sauvegarde</dt><dd>{h.backups.last ? `${formatDate(h.backups.last.createdAt, true)} (${h.backups.last.status})` : 'Aucune'}</dd>
              <dt>Tâches planifiées</dt><dd className="small">{h.scheduledTasks.note}</dd>
            </dl>
          </section>
        </div>
      )}
    </>
  );
}

interface AssocRow { id: string; name: string; slug: string; status: string; createdAt: string; members: number }

export function AssociationsPage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system-associations'], queryFn: () => api.get<AssocRow[]>('/system/associations') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', city: '', profile: 'simple', joinAsAdmin: true });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/system/associations', {
        name: form.name, email: form.email || null, city: form.city || null, joinAsAdmin: form.joinAsAdmin,
        modules: MODULE_PROFILES.find((p) => p.id === form.profile)?.modules ?? [],
      });
      toast('Association créée avec ses rôles prédéfinis.');
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['system-associations'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Associations')} />
      <PageHead title="Associations de l’instance" description="Chaque association dispose de données, utilisateurs, rôles et modules strictement séparés." actions={<button className="btn" type="button" onClick={() => setOpen(true)}>Créer une association</button>} />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Nom</th><th scope="col">Identifiant</th><th scope="col">Utilisateurs</th><th scope="col">État</th><th scope="col">Création</th></tr></thead>
            <tbody>
              {q.data.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong></td>
                  <td className="mono">{a.slug}</td>
                  <td>{a.members}</td>
                  <td>{a.status === 'active' ? <Badge tone="success">✓ Active</Badge> : <Badge>Archivée</Badge>}</td>
                  <td>{formatDate(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={open} title="Créer une association" onClose={() => setOpen(false)}>
        <form className="stack" onSubmit={submit}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <Field label="Nom">{(id) => <input id={id} type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <div className="form-grid">
            <Field label="E-mail (facultatif)">{(id) => <input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
            <Field label="Ville (facultatif)">{(id) => <input id={id} type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />}</Field>
          </div>
          <Field label="Profil de départ" hint="Présélection modifiable ensuite dans Scenorya Admin.">
            {(id, d) => (
              <select id={id} aria-describedby={d} value={form.profile} onChange={(e) => setForm({ ...form, profile: e.target.value })}>
                {MODULE_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            )}
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.joinAsAdmin} onChange={(e) => setForm({ ...form, joinAsAdmin: e.target.checked })} />
            <span>M’ajouter comme administrateur de cette association</span>
          </label>
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={() => setOpen(false)}>Annuler</button>
            <button className="btn" type="submit">Créer</button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function InstanceModulesPage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['instance-modules'], queryFn: () => api.get<{ id: ModuleId; enabled: boolean; core: boolean; associationsUsing: number }[]>('/system/instance-modules') });
  const set = useMutation({
    mutationFn: (v: { id: ModuleId; enabled: boolean }) => api.put(`/system/instance-modules/${v.id}`, { enabled: v.enabled }),
    onSuccess: (_d, v) => {
      toast(`${MODULES_BY_ID[v.id].name} ${v.enabled ? 'disponible' : 'indisponible'} sur l’instance.`);
      qc.invalidateQueries({ queryKey: ['instance-modules'] });
      qc.invalidateQueries({ queryKey: ['context'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <>
      <Breadcrumb items={crumbs("Modules de l'instance")} />
      <PageHead title="Modules disponibles sur l’instance" description="Un module rendu indisponible ne peut plus être utilisé par aucune association ; leurs données et leur configuration sont conservées." />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Module</th><th scope="col">Associations l’utilisant</th><th scope="col">Disponibilité</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {q.data.map((m) => {
                const def = MODULES_BY_ID[m.id];
                return (
                  <tr key={m.id}>
                    <td><div className="row"><img src={def.assets.icon} alt="" width={28} height={28} style={{ borderRadius: 6 }} /> {def.name}</div></td>
                    <td>{m.core ? '—' : m.associationsUsing}</td>
                    <td>{m.core ? <Badge tone="info">● Socle</Badge> : m.enabled ? <Badge tone="success">✓ Disponible</Badge> : <Badge tone="danger">× Indisponible</Badge>}</td>
                    <td className="actions">
                      {!m.core && (
                        <button
                          className="btn secondary sm"
                          type="button"
                          onClick={() => {
                            if (m.enabled && m.associationsUsing > 0 && !window.confirm(`${m.associationsUsing} association(s) utilisent ce module : il leur deviendra inaccessible. Continuer ?`)) return;
                            set.mutate({ id: m.id, enabled: !m.enabled });
                          }}
                        >
                          {m.enabled ? 'Rendre indisponible' : 'Rendre disponible'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface Smtp { host: string; port: number; secure: boolean; user: string | null; from: string; hasPassword: boolean }

export function SmtpPage() {
  const { toast } = useApp();
  const q = useQuery({ queryKey: ['smtp'], queryFn: () => api.get<Smtp | null>('/system/smtp') });
  const [form, setForm] = useState({ host: '', port: 587, secure: false, user: '', password: '', from: '' });
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (q.data) setForm({ host: q.data.host, port: q.data.port, secure: q.data.secure, user: q.data.user ?? '', password: '', from: q.data.from });
  }, [q.data]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.put('/system/smtp', { ...form, user: form.user || null, password: form.password === '' ? undefined : form.password });
      toast('Configuration enregistrée.');
      q.refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      await api.post('/system/smtp/test', { to });
      toast(`E-mail de test envoyé à ${to}.`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Messagerie')} />
      <PageHead title="Messagerie (SMTP)" description="Serveur utilisé pour tous les e-mails de la plateforme. Le mot de passe est chiffré et n’est jamais réaffiché." />
      {q.isLoading && <Loading />}
      <div className="grid-2">
        <form className="card stack" onSubmit={save}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <div className="form-grid">
            <Field label="Serveur">{(id) => <input id={id} type="text" required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />}</Field>
            <Field label="Port">{(id) => <input id={id} type="number" required value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />}</Field>
            <Field label="Utilisateur">{(id) => <input id={id} type="text" autoComplete="off" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />}</Field>
            <Field label="Mot de passe" hint={q.data?.hasPassword ? 'Laisser vide pour conserver le mot de passe enregistré.' : undefined}>
              {(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
            </Field>
            <Field label="Expéditeur" className="full">{(id) => <input id={id} type="text" required value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
            <label className="check full">
              <input type="checkbox" checked={form.secure} onChange={(e) => setForm({ ...form, secure: e.target.checked })} />
              <span>Connexion TLS directe (port 465) ; sinon STARTTLS si proposé par le serveur.</span>
            </label>
          </div>
          <div className="form-actions"><button className="btn" type="submit">Enregistrer</button></div>
        </form>
        <section className="card stack">
          <h2>Tester l’envoi</h2>
          {!q.data && <Alert tone="warning">Enregistrez d’abord une configuration.</Alert>}
          <Field label="Destinataire">{(id) => <input id={id} type="email" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          <div><button className="btn secondary" type="button" disabled={!q.data || !to || testing} onClick={test}>{testing ? 'Envoi…' : 'Envoyer un e-mail de test'}</button></div>
        </section>
      </div>
    </>
  );
}

interface Backup { id: string; filename: string; sizeBytes: number | null; sha256: string | null; status: string; error: string | null; createdAt: string }

export function BackupsPage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => api.get<Backup[]>('/system/backups') });
  const run = useMutation({
    mutationFn: () => api.post<Backup>('/system/backups'),
    onSuccess: () => {
      toast('Sauvegarde terminée.');
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => {
      toast(errorMessage(e), 'error');
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
  });
  const tone: Record<string, 'success' | 'danger' | 'info' | 'neutral'> = { success: 'success', failed: 'danger', running: 'info', expired: 'neutral' };
  const label: Record<string, string> = { success: '✓ Réussie', failed: '! Échec', running: '… En cours', expired: '○ Expirée (rétention)' };
  return (
    <>
      <Breadcrumb items={crumbs('Sauvegardes')} />
      <PageHead
        title="Sauvegardes de la base"
        description="Export complet PostgreSQL (pg_dump, format personnalisé) avec empreinte SHA-256. La restauration s’effectue hors de l’interface, selon la procédure documentée."
        actions={<button className="btn" type="button" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Sauvegarde en cours…' : 'Lancer une sauvegarde'}</button>}
      />
      <Alert tone="info">Les fichiers déposés (Drive, médias) seront inclus dans les sauvegardes lorsque ces modules seront livrés. Les sauvegardes automatiques planifiées et la copie vers un stockage S3 sont prévues en phase 8.</Alert>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead><tr><th scope="col">Date</th><th scope="col">Fichier</th><th scope="col">Taille</th><th scope="col">État</th><th scope="col">SHA-256</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {q.data.length === 0 && <tr><td colSpan={6} className="empty">Aucune sauvegarde.</td></tr>}
              {q.data.map((b) => (
                <tr key={b.id}>
                  <td className="nowrap">{formatDate(b.createdAt, true)}</td>
                  <td className="mono small">{b.filename}</td>
                  <td>{formatBytes(b.sizeBytes)}</td>
                  <td><Badge tone={tone[b.status] ?? 'neutral'}>{label[b.status] ?? b.status}</Badge>{b.error && <div className="small" style={{ color: 'var(--danger)' }}>{b.error}</div>}</td>
                  <td className="mono small" title={b.sha256 ?? ''}>{b.sha256 ? `${b.sha256.slice(0, 12)}…` : '—'}</td>
                  <td className="actions">
                    {b.status === 'success' && (
                      <button className="btn ghost sm" type="button" onClick={() => api.download(`/system/backups/${b.id}/download`, b.filename).catch((e) => toast(errorMessage(e), 'error'))}>Télécharger</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}


/* ----------------------------------------------------------- Stockage Drive */

interface DriveUsage { storedBytes: number; blobs: number; defaultQuota: number; maxUpload: number; associations: { id: string; name: string; used: number; quota: number | null }[] }

export function StoragePage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system', 'drive'], queryFn: () => api.get<DriveUsage>('/system/drive') });
  const [edit, setEdit] = useState<Record<string, string>>({});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const save = async (id: string, value: string | null) => {
    try {
      await api.put(`/system/associations/${id}/drive-quota`, { quotaMb: value === null || value === '' ? null : Number(value) });
      toast('Quota enregistré.');
      setEdit((e) => { const n = { ...e }; delete n[id]; return n; });
      qc.invalidateQueries({ queryKey: ['system', 'drive'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <PageHead title="Stockage des documents" description="Espace occupé par Scenorya Drive et quota de chaque association. Le contenu identique n’est stocké qu’une fois sur le disque." />
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="card"><div className="small muted">Occupé sur le disque</div><div className="value">{formatBytes(d.storedBytes)}</div><div className="small muted">{d.blobs} contenu(s) distinct(s)</div></div>
        <div className="card"><div className="small muted">Quota par défaut</div><div className="value">{formatBytes(d.defaultQuota)}</div><div className="small muted">Variable DRIVE_DEFAULT_QUOTA_MB</div></div>
        <div className="card"><div className="small muted">Taille maximale d’un fichier</div><div className="value">{formatBytes(d.maxUpload)}</div><div className="small muted">Variable DRIVE_MAX_UPLOAD_MB</div></div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Association</th><th>Utilisé</th><th>Quota</th><th className="actions">Modifier le quota</th></tr></thead>
          <tbody>
            {d.associations.map((a) => {
              const quota = a.quota ?? d.defaultQuota;
              return (
                <tr key={a.id}>
                  <td className="strong">{a.name}</td>
                  <td className="small">{formatBytes(a.used)} ({Math.round((a.used / quota) * 100)} %)</td>
                  <td className="small">{formatBytes(quota)}{a.quota === null && <span className="muted"> (défaut)</span>}</td>
                  <td className="actions">
                    {a.id in edit ? (
                      <form className="row" style={{ justifyContent: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void save(a.id, edit[a.id]); }}>
                        <label className="sr-only" htmlFor={`q-${a.id}`}>Quota en Mo</label>
                        <input id={`q-${a.id}`} type="number" min={1} style={{ width: 120 }} value={edit[a.id]} onChange={(e) => setEdit({ ...edit, [a.id]: e.target.value })} placeholder="Mo" required />
                        <span className="small muted">Mo</span>
                        <button className="btn sm" type="submit">Enregistrer</button>
                        <button className="btn ghost sm" type="button" onClick={() => setEdit((x) => { const n = { ...x }; delete n[a.id]; return n; })}>Annuler</button>
                      </form>
                    ) : (
                      <>
                        <button className="btn ghost sm" type="button" onClick={() => setEdit({ ...edit, [a.id]: String(Math.round(quota / 1048576)) })}>Modifier</button>
                        {a.quota !== null && <button className="btn ghost sm" type="button" onClick={() => save(a.id, null)}>Revenir au défaut</button>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Alert tone="warning">Les documents sont stockés dans le volume de données (dossier <code>files</code>), pas dans la base : sauvegardez ce volume en plus des sauvegardes de la base.</Alert>
    </>
  );
}
