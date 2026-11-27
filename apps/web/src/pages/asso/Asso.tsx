import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import type { AuditEntry, Member, Paged } from '../../api/types';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, ModuleLogo, PageHead, Pagination } from '../../components/ui';

export const CATEGORIES: Record<string, string> = {
  actif: 'Membre actif', benevole: 'Bénévole', responsable: 'Responsable', bienfaiteur: 'Membre bienfaiteur', honneur: "Membre d'honneur", ancien: 'Ancien membre',
};
const STATUSES: Record<string, [string, 'success' | 'warning' | 'neutral' | 'info']> = {
  active: ['✓ Adhésion active', 'success'], pending: ['… En attente', 'info'], expired: ['! Expirée', 'warning'], archived: ['○ Archivé', 'neutral'],
};
const crumbs = (label?: string, extra: { label: string; to?: string }[] = []) =>
  label ? [{ label: 'Scenorya Asso', to: '/asso' }, ...extra, { label }] : [{ label: 'Scenorya Asso' }];

export function AssoHome() {
  const { can } = useApp();
  const stats = useQuery({ queryKey: ['asso-stats'], queryFn: () => api.get<{ byStatus: Record<string, number>; byCategory: Record<string, number>; active: number }>('/asso/members/stats'), enabled: can('asso.members.read') });
  return (
    <>
      <Breadcrumb items={crumbs()} />
      <div className="module-banner">
        <ModuleLogo id="asso" />
      </div>
      <PageHead
        title="Vie associative"
        description="Fichier des adhérents. Cotisations, groupes, gouvernance et cartes d’adhérent arrivent dans la suite de la phase 2."
        actions={can('asso.members.create') && <Link className="btn" to="/asso/adherents/nouveau">Nouvel adhérent</Link>}
      />
      {!can('asso.members.read') && <Alert>Vous avez accès au module mais à aucune donnée des adhérents.</Alert>}
      {stats.data && (
        <div className="stack">
          <div className="grid-3">
            {Object.entries(STATUSES).map(([k, [label]]) => (
              <div key={k} className="card kpi">
                <span className="label">{label.replace(/^\S+ /, '')}</span>
                <span className="value">{stats.data.byStatus[k] ?? 0}</span>
              </div>
            ))}
          </div>
          <section className="card">
            <h2>Répartition par catégorie (hors archives)</h2>
            {Object.keys(stats.data.byCategory).length === 0 ? (
              <p className="muted">Aucun adhérent pour le moment.</p>
            ) : (
              <dl className="props">
                {Object.entries(stats.data.byCategory).map(([k, n]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{CATEGORIES[k] ?? k}</dt>
                    <dd>{n}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        </div>
      )}
    </>
  );
}

type SortKey = 'number' | 'lastName' | 'joinedAt';

export function MembersList() {
  const { can, toast } = useApp();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('all');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'lastName', dir: 'asc' });
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams({ page: String(page), pageSize: '25', status, sort: sort.key, dir: sort.dir });
  if (debounced) params.set('q', debounced);
  if (category) params.set('category', category);
  const list = useQuery({ queryKey: ['members', params.toString()], queryFn: () => api.get<Paged<Member>>(`/asso/members?${params}`), placeholderData: (prev) => prev });

  const header = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))}>
        {label} <span aria-hidden="true">{sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );

  return (
    <>
      <Breadcrumb items={crumbs('Adhérents')} />
      <PageHead
        title="Adhérents"
        actions={
          <>
            {can('asso.members.export') && (
              <button className="btn secondary" type="button" onClick={() => api.download(`/asso/members/export.csv?${params}`, 'adherents.csv').catch((e) => toast(errorMessage(e), 'error'))}>
                Exporter (CSV)
              </button>
            )}
            {can('asso.members.create') && <Link className="btn" to="/asso/adherents/nouveau">Nouvel adhérent</Link>}
          </>
        }
      />
      <div className="toolbar">
        <Field label="Rechercher">{(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, prénom, e-mail ou numéro" />}</Field>
        <Field label="Statut">
          {(id) => (
            <select id={id} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="all">Tous</option>
              {Object.entries(STATUSES).map(([k, [l]]) => <option key={k} value={k}>{l.replace(/^\S+ /, '')}</option>)}
            </select>
          )}
        </Field>
        <Field label="Catégorie">
          {(id) => (
            <select id={id} value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
              <option value="">Toutes</option>
              {Object.entries(CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
        </Field>
      </div>
      {list.isLoading && <Loading />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data && (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Liste des adhérents</caption>
              <thead>
                <tr>
                  {header('number', 'N°')}
                  {header('lastName', 'Nom')}
                  <th scope="col">Contact</th>
                  <th scope="col">Catégorie</th>
                  <th scope="col">Statut</th>
                  {header('joinedAt', 'Adhésion')}
                </tr>
              </thead>
              <tbody>
                {list.data.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">Aucun adhérent ne correspond à ces critères.</td>
                  </tr>
                )}
                {list.data.items.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.number}</td>
                    <td>
                      <Link to={`/asso/adherents/${m.id}`}>
                        <strong>{m.lastName.toUpperCase()}</strong> {m.firstName}
                      </Link>
                      {m.isMinor && <> <Badge tone="info">Mineur</Badge></>}
                    </td>
                    <td className="small">
                      {m.email ?? '—'}
                      <div className="muted">{m.phone}</div>
                    </td>
                    <td>{CATEGORIES[m.category] ?? m.category}</td>
                    <td><Badge tone={STATUSES[m.status]?.[1]}>{STATUSES[m.status]?.[0] ?? m.status}</Badge></td>
                    <td>{formatDate(m.joinedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}

const EMPTY = {
  firstName: '', lastName: '', email: '', phone: '', birthDate: '', addressLine: '', postalCode: '', city: '', category: 'actif', status: 'active',
  joinedAt: new Date().toISOString().slice(0, 10), isMinor: false, guardianName: '', guardianPhone: '', guardianEmail: '', imageRights: false, skills: '', notes: '',
};

export function MemberForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const existing = useQuery({ queryKey: ['member', id], queryFn: () => api.get<Member>(`/asso/members/${id}`), enabled: editing });
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sensitive = can('asso.members.sensitive');

  useEffect(() => {
    const m = existing.data;
    if (!m) return;
    setForm({
      firstName: m.firstName, lastName: m.lastName, email: m.email ?? '', phone: m.phone ?? '', birthDate: m.birthDate ?? '', addressLine: m.addressLine ?? '',
      postalCode: m.postalCode ?? '', city: m.city ?? '', category: m.category, status: m.status === 'archived' ? 'active' : m.status, joinedAt: m.joinedAt,
      isMinor: m.isMinor, guardianName: m.guardianName ?? '', guardianPhone: m.guardianPhone ?? '', guardianEmail: m.guardianEmail ?? '', imageRights: m.imageRights,
      skills: m.skills.join(', '), notes: m.notes ?? '',
    });
  }, [existing.data]);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload: Record<string, unknown> = { ...form, skills: form.skills.split(',').map((s) => s.trim()).filter(Boolean) };
    if (!sensitive) for (const k of ['birthDate', 'addressLine', 'postalCode', 'city', 'guardianName', 'guardianPhone', 'guardianEmail', 'notes']) delete payload[k];
    try {
      const m = editing ? await api.patch<Member>(`/asso/members/${id}`, payload) : await api.post<Member>('/asso/members', payload);
      toast(editing ? 'Fiche mise à jour.' : `Adhérent n° ${m.number} créé.`);
      qc.invalidateQueries({ queryKey: ['members'] });
      qc.invalidateQueries({ queryKey: ['member', m.id] });
      qc.invalidateQueries({ queryKey: ['asso-stats'] });
      navigate(`/asso/adherents/${m.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (editing && existing.isLoading) return <Loading />;
  if (existing.error) return <ErrorBox error={existing.error} />;
  const text = (k: keyof typeof EMPTY, label: string, type = 'text', opts: { required?: boolean; full?: boolean; autoComplete?: string } = {}) => (
    <Field label={label + (opts.required ? ' *' : '')} className={opts.full ? 'full' : ''}>
      {(fid) => <input id={fid} type={type} required={opts.required} autoComplete={opts.autoComplete} value={form[k] as string} onChange={set(k)} />}
    </Field>
  );

  return (
    <>
      <Breadcrumb items={crumbs(editing ? 'Modifier' : 'Nouvel adhérent', [{ label: 'Adhérents', to: '/asso/adherents' }])} />
      <PageHead title={editing ? `Modifier la fiche n° ${existing.data?.number}` : 'Nouvel adhérent'} description="Les champs marqués d’un astérisque sont obligatoires. Le numéro d’adhérent est attribué automatiquement." />
      <form className="stack" onSubmit={submit}>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <fieldset>
          <legend>Identité et contact</legend>
          <div className="form-grid">
            {text('lastName', 'Nom', 'text', { required: true, autoComplete: 'off' })}
            {text('firstName', 'Prénom', 'text', { required: true, autoComplete: 'off' })}
            {text('email', 'E-mail', 'email')}
            {text('phone', 'Téléphone', 'tel')}
          </div>
        </fieldset>
        <fieldset>
          <legend>Adhésion</legend>
          <div className="form-grid">
            <Field label="Catégorie">{(fid) => <select id={fid} value={form.category} onChange={set('category')}>{Object.entries(CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
            <Field label="Statut">{(fid) => <select id={fid} value={form.status} onChange={set('status')}><option value="active">Adhésion active</option><option value="pending">En attente de validation</option><option value="expired">Expirée</option></select>}</Field>
            {text('joinedAt', "Date d'adhésion", 'date')}
            {text('skills', 'Compétences (séparées par des virgules)')}
            <label className="check full">
              <input type="checkbox" checked={form.imageRights} onChange={set('imageRights')} />
              <span>Autorisation de droit à l’image recueillie</span>
            </label>
          </div>
        </fieldset>
        {sensitive ? (
          <fieldset>
            <legend>Informations personnelles (données sensibles)</legend>
            <div className="form-grid">
              {text('birthDate', 'Date de naissance', 'date')}
              {text('addressLine', 'Adresse', 'text', { full: true })}
              {text('postalCode', 'Code postal')}
              {text('city', 'Ville')}
              <label className="check full">
                <input type="checkbox" checked={form.isMinor} onChange={set('isMinor')} />
                <span>Adhérent mineur (représentant légal requis)</span>
              </label>
              {form.isMinor && (
                <>
                  {text('guardianName', 'Représentant légal')}
                  {text('guardianPhone', 'Téléphone du représentant', 'tel')}
                  {text('guardianEmail', 'E-mail du représentant', 'email', { full: true })}
                </>
              )}
              <Field label="Notes internes" className="full">{(fid) => <textarea id={fid} value={form.notes} onChange={set('notes')} />}</Field>
            </div>
          </fieldset>
        ) : (
          <Alert>Les informations personnelles (naissance, adresse, représentant légal) requièrent le droit « données sensibles ».</Alert>
        )}
        <div className="form-actions">
          <Link className="btn secondary" to={editing ? `/asso/adherents/${id}` : '/asso/adherents'}>Annuler</Link>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
      </form>
    </>
  );
}

export function MemberDetail() {
  const { id } = useParams();
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['member', id], queryFn: () => api.get<Member>(`/asso/members/${id}`) });
  const history = useQuery({ queryKey: ['member-history', id], queryFn: () => api.get<AuditEntry[]>(`/asso/members/${id}/history`), enabled: can('asso.members.history') });
  const act = useMutation({
    mutationFn: (action: 'archive' | 'restore') => api.post(`/asso/members/${id}/${action}`),
    onSuccess: (_d, action) => {
      toast(action === 'archive' ? 'Fiche archivée.' : 'Fiche restaurée.');
      qc.invalidateQueries({ queryKey: ['member', id] });
      qc.invalidateQueries({ queryKey: ['member-history', id] });
      qc.invalidateQueries({ queryKey: ['members'] });
      qc.invalidateQueries({ queryKey: ['asso-stats'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const m = q.data;
  const archived = m.status === 'archived';
  return (
    <>
      <Breadcrumb items={crumbs(`${m.firstName} ${m.lastName}`, [{ label: 'Adhérents', to: '/asso/adherents' }])} />
      <PageHead
        title={`${m.firstName} ${m.lastName}`}
        description={`Adhérent n° ${m.number} · ${CATEGORIES[m.category] ?? m.category}`}
        actions={
          <>
            {!archived && can('asso.members.update') && <Link className="btn secondary" to={`/asso/adherents/${m.id}/modifier`}>Modifier</Link>}
            {!archived && can('asso.members.archive') && (
              <button className="btn secondary" type="button" onClick={() => window.confirm('Archiver cette fiche ? Elle restera consultable et restaurable.') && act.mutate('archive')}>Archiver</button>
            )}
            {archived && can('asso.members.restore') && <button className="btn" type="button" onClick={() => act.mutate('restore')}>Restaurer</button>}
          </>
        }
      />
      {archived && <div style={{ marginBottom: 12 }}><Alert tone="warning">Fiche archivée le {formatDate(m.archivedAt)}.</Alert></div>}
      <div className="grid-2">
        <section className="card">
          <h2>Adhésion</h2>
          <dl className="props">
            <dt>Statut</dt><dd><Badge tone={STATUSES[m.status]?.[1]}>{STATUSES[m.status]?.[0]}</Badge></dd>
            <dt>Date d’adhésion</dt><dd>{formatDate(m.joinedAt)}</dd>
            <dt>E-mail</dt><dd>{m.email ?? '—'}</dd>
            <dt>Téléphone</dt><dd>{m.phone ?? '—'}</dd>
            <dt>Droit à l’image</dt><dd>{m.imageRights ? 'Autorisé' : 'Non recueilli'}</dd>
            <dt>Compétences</dt><dd>{m.skills.join(', ') || '—'}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>Informations personnelles</h2>
          {m.sensitiveHidden ? (
            <p className="muted">Masquées : droit « données sensibles » requis.</p>
          ) : (
            <dl className="props">
              <dt>Naissance</dt><dd>{formatDate(m.birthDate)}</dd>
              <dt>Adresse</dt><dd>{[m.addressLine, [m.postalCode, m.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'}</dd>
              <dt>Mineur</dt><dd>{m.isMinor ? 'Oui' : 'Non'}</dd>
              {m.isMinor && (<><dt>Représentant</dt><dd>{m.guardianName ?? '—'} {m.guardianPhone && `· ${m.guardianPhone}`} {m.guardianEmail && `· ${m.guardianEmail}`}</dd></>)}
              <dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{m.notes ?? '—'}</dd>
            </dl>
          )}
        </section>
      </div>
      {history.data && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Historique de la fiche</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {history.data.map((h) => (
              <li key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                {h.summary}
                <div className="small muted">{h.actorLabel} · {formatDate(h.createdAt, true)}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function MembersImport() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<{ dryRun: boolean; valid?: number; imported?: number; errors: { line: number; errors: string[] }[]; recognizedColumns?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (dryRun: boolean) => {
    setError(null);
    try {
      const r = await api.post<typeof result>('/asso/members/import', { csv, dryRun });
      setResult(r);
      if (!dryRun && r) {
        toast(`${r.imported} adhérent(s) importé(s).`);
        qc.invalidateQueries({ queryKey: ['members'] });
        qc.invalidateQueries({ queryKey: ['asso-stats'] });
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Import CSV', [{ label: 'Adhérents', to: '/asso/adherents' }])} />
      <PageHead title="Importer des adhérents" description="Fichier CSV (séparateur « ; » ou « , », encodage UTF-8). Colonnes reconnues : Nom, Prénom, E-mail, Téléphone, Date de naissance, Adresse, Code postal, Ville, Catégorie, Date d’adhésion." />
      <div className="card stack">
        {error && <div className="alert danger" role="alert">{error}</div>}
        <Field label="Fichier CSV" hint="Une simulation est effectuée avant tout enregistrement. Pour un fichier Excel, enregistrez-le d’abord au format CSV UTF-8.">
          {(id, d) => (
            <input
              id={id}
              aria-describedby={d}
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 2_000_000) return setError('Fichier trop volumineux (2 Mo maximum).');
                setFileName(f.name);
                setCsv(await f.text());
                setResult(null);
              }}
            />
          )}
        </Field>
        <div className="row">
          <button className="btn secondary" type="button" disabled={!csv} onClick={() => run(true)}>Vérifier {fileName}</button>
          <button className="btn" type="button" disabled={!result?.dryRun || !result.valid} onClick={() => run(false)}>Importer {result?.valid ?? 0} ligne(s) valide(s)</button>
        </div>
        {result && (
          <Alert tone={result.errors.length ? 'warning' : 'success'}>
            {result.dryRun ? <p>{result.valid} ligne(s) valide(s), {result.errors.length} ligne(s) en erreur. Colonnes reconnues : {result.recognizedColumns?.join(', ')}.</p> : <p>{result.imported} adhérent(s) importé(s).</p>}
            {result.errors.length > 0 && (
              <ul>
                {result.errors.slice(0, 50).map((er) => <li key={er.line}>Ligne {er.line} : {er.errors.join(' ; ')}</li>)}
              </ul>
            )}
          </Alert>
        )}
      </div>
    </>
  );
}
