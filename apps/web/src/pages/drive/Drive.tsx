import { DragEvent, FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, BrandLogo, ErrorBox, Field, formatBytes, formatDate, Loading, Modal, PageHead, Pagination } from '../../components/ui';

/* --------------------------------------------------------------- Types */

interface DriveFile {
  id: string; name: string; folderId: string | null; mime: string; size: number; version: number; tags: string[]; description: string | null;
  updatedAt: string; updatedBy: string | null; favorite: boolean; shared: boolean; preview: boolean; path?: string;
}
interface FolderRow { id: string; name: string; restricted: boolean; allowedRoleIds?: string[]; updatedAt: string }
interface Browse { folder: (FolderRow & { parentId: string | null }) | null; breadcrumb: { id: string; name: string; restricted: boolean }[]; folders: FolderRow[]; files: DriveFile[] }
interface Overview {
  used: number; quota: number; maxUploadBytes: number; trashDays: number; roles: { id: string; name: string }[]; hasFolders: boolean;
  can: { admin: boolean; create: boolean; update: boolean; delete: boolean; publish: boolean };
}
interface Detail extends Omit<DriveFile, 'path'> {
  path: { id: string; name: string }[]; restricted: boolean;
  versions: { version: number; size: number; originalName: string; comment: string | null; createdAt: string; by: string | null }[];
  shares: { id: string; expiresAt: string; hasPassword: boolean; maxDownloads: number | null; downloadCount: number; createdAt: string; by: string | null }[];
  links: { module: string; entityType: string; entityId: string }[];
}

const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Drive', to: '/drive' }, ...extra, { label }];
const folderUrl = (id: string | null) => (id ? `/drive/dossier/${id}` : '/drive');

/** Pictogramme textuel du type de document (sans dépendance graphique). */
function kind(mime: string, name: string) {
  if (mime === 'application/pdf') return ['PDF', '#b42318'];
  if (mime.startsWith('image/')) return ['IMG', '#6941c6'];
  if (mime.startsWith('audio/')) return ['SON', '#0e7090'];
  if (mime.startsWith('video/')) return ['VID', '#c11574'];
  if (/sheet|excel|csv/.test(mime)) return ['TAB', '#067647'];
  if (/word|opendocument\.text|rtf/.test(mime)) return ['DOC', '#175cd3'];
  if (/presentation|powerpoint/.test(mime)) return ['PRÉ', '#c4320a'];
  if (/zip|7z|rar|gzip/.test(mime)) return ['ZIP', '#475467'];
  if (mime.startsWith('text/')) return ['TXT', '#475467'];
  return [(name.split('.').pop() ?? '—').slice(0, 3).toUpperCase(), '#475467'];
}
function FileIcon({ f }: { f: Pick<DriveFile, 'mime' | 'name'> }) {
  const [label, color] = kind(f.mime, f.name);
  return <span className="file-icon" style={{ borderColor: color, color }} aria-hidden>{label}</span>;
}
const FolderIcon = ({ restricted }: { restricted?: boolean }) => <span className="file-icon folder" aria-hidden>{restricted ? '🔒' : ''}</span>;

function useOverview() {
  return useQuery({ queryKey: ['drive', 'overview'], queryFn: () => api.get<Overview>('/drive/overview') });
}

function Usage({ o }: { o: Overview }) {
  const ratio = Math.min(1, o.used / o.quota);
  return (
    <div className="drive-usage" title={`${formatBytes(o.used)} utilisés sur ${formatBytes(o.quota)}`}>
      <div className="progress" aria-hidden><span style={{ width: `${Math.max(1, ratio * 100)}%`, background: ratio > 0.9 ? 'var(--danger)' : undefined }} /></div>
      <span className="small muted">{formatBytes(o.used)} sur {formatBytes(o.quota)}</span>
    </div>
  );
}

/* ---------------------------------------------------------- Envoi */

interface UploadState { names: string[]; ratio: number }

function useUploader(onDone: () => void) {
  const { toast } = useApp();
  const [state, setState] = useState<UploadState | null>(null);
  const send = async (files: File[], fields: Record<string, string>, max: number) => {
    if (!files.length) return;
    const tooBig = files.filter((f) => f.size > max);
    if (tooBig.length) {
      toast(`Trop volumineux (maximum ${formatBytes(max)}) : ${tooBig.map((f) => f.name).join(', ')}`, 'error');
      return;
    }
    // Lots de 20 fichiers (limite du serveur par envoi).
    for (let i = 0; i < files.length; i += 20) {
      const batch = files.slice(i, i + 20);
      const form = new FormData();
      Object.entries(fields).forEach(([k, v]) => v && form.append(k, v));
      batch.forEach((f) => form.append('files', f, f.name));
      setState({ names: batch.map((f) => f.name), ratio: 0 });
      try {
        const r = await api.upload<{ files: { name: string; version: number }[] }>('/drive/files', form, (ratio) => setState((s) => s && { ...s, ratio }));
        toast(r.files.length === 1 ? `« ${r.files[0].name} » envoyé${r.files[0].version > 1 ? ` (version ${r.files[0].version})` : ''}.` : `${r.files.length} documents envoyés.`);
      } catch (e) {
        toast(errorMessage(e), 'error');
        break;
      } finally {
        setState(null);
        onDone();
      }
    }
  };
  const panel = state && (
    <div className="upload-panel" role="status">
      <strong>Envoi en cours…</strong>
      <span className="small muted">{state.names.length > 1 ? `${state.names.length} fichiers` : state.names[0]}</span>
      <div className="progress"><span style={{ width: `${Math.round(state.ratio * 100)}%` }} /></div>
    </div>
  );
  return { send, panel, busy: !!state };
}

/* ---------------------------------------------------------- Explorateur */

export function DrivePage() {
  const { id } = useParams();
  const folderId = id ?? null;
  const { toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const o = useOverview();
  const q = useQuery({ queryKey: ['drive', 'browse', folderId], queryFn: () => api.get<Browse>(`/drive/browse${folderId ? `?folderId=${folderId}` : ''}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['drive'] });
  const up = useUploader(refresh);
  const input = useRef<HTMLInputElement>(null);
  const [conflict, setConflict] = useState<'rename' | 'version'>('rename');
  const [drag, setDrag] = useState(false);
  const [folderModal, setFolderModal] = useState<{ mode: 'create' } | { mode: 'rename' | 'access'; folder: FolderRow } | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  if (q.isLoading || o.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (o.error) return <ErrorBox error={o.error} />;
  const b = q.data!;
  const ov = o.data!;
  const upload = (files: File[]) => up.send(files, { folderId: folderId ?? '', conflict }, ov.maxUploadBytes);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (ov.can.create) void upload([...e.dataTransfer.files]);
  };
  const recommended = async () => {
    try {
      const r = await api.post<{ created: string[] }>('/drive/recommended');
      toast(r.created.length ? `Espaces créés : ${r.created.join(', ')}.` : 'Les espaces recommandés existent déjà.');
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const removeFolder = async (f: FolderRow) => {
    if (!confirm(`Placer le dossier « ${f.name} » et tout son contenu dans la corbeille ?`)) return;
    try {
      const r = await api.delete<{ files: number }>(`/drive/folders/${f.id}`);
      toast(`Dossier placé dans la corbeille (${r.files} document(s)).`);
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const favorite = async (f: DriveFile) => {
    await api.post(`/drive/files/${f.id}/favorite`, { on: !f.favorite }).catch((e) => toast(errorMessage(e), 'error'));
    refresh();
  };
  const title = b.folder?.name ?? 'Documents';

  return (
    <div onDragOver={(e) => { if (ov.can.create) { e.preventDefault(); setDrag(true); } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={onDrop}>
      <Breadcrumb items={[{ label: 'Scenorya Drive', to: b.breadcrumb.length ? '/drive' : undefined }, ...b.breadcrumb.map((c, i) => ({ label: c.name, to: i < b.breadcrumb.length - 1 ? folderUrl(c.id) : undefined }))]} />
      <PageHead
        title={title}
        description={b.folder?.restricted ? 'Dossier restreint : seuls les rôles autorisés et les administrateurs de Drive y ont accès.' : 'Documents partagés de l’association.'}
        actions={<Usage o={ov} />}
      />
      <div className="toolbar">
        <form className="drive-search" onSubmit={(e) => { e.preventDefault(); if (search.trim()) navigate(`/drive/recherche?q=${encodeURIComponent(search.trim())}`); }}>
          <label className="sr-only" htmlFor="drive-search">Rechercher un document</label>
          <input id="drive-search" type="search" placeholder="Rechercher (nom, description, étiquette)…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn secondary" type="submit">Rechercher</button>
        </form>
        {ov.can.create && (
          <>
            <button className="btn secondary" type="button" onClick={() => setFolderModal({ mode: 'create' })}>Nouveau dossier</button>
            <button className="btn" type="button" disabled={up.busy} onClick={() => input.current?.click()}>Envoyer des fichiers</button>
            <input ref={input} type="file" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </>
        )}
      </div>
      {ov.can.create && ov.can.update && (
        <div className="row small muted" style={{ marginBottom: 12 }}>
          <label htmlFor="drive-conflict">Si un document du même nom existe :</label>
          <select id="drive-conflict" style={{ width: 'auto' }} value={conflict} onChange={(e) => setConflict(e.target.value as 'rename' | 'version')}>
            <option value="rename">garder les deux (copie numérotée)</option>
            <option value="version">ajouter une nouvelle version</option>
          </select>
        </div>
      )}
      {up.panel}

      {!folderId && !ov.hasFolders && ov.can.admin && (
        <Alert>
          Drive est vide. Créez les espaces recommandés : Administratif et Comptabilité (restreints au bureau), Assemblées générales, Communication, Spectacles,
          Technique, Photos et vidéos, Pièces jointes.{' '}
          <button className="btn sm" type="button" onClick={recommended}>Créer les espaces recommandés</button>
        </Alert>
      )}

      <div className={`table-wrap drop-zone${drag ? ' dragging' : ''}`}>
        {drag && <div className="drop-hint">Déposez les fichiers pour les envoyer dans « {title} »</div>}
        <table className="table">
          <thead>
            <tr><th style={{ width: 44 }} aria-label="Type" /><th>Nom</th><th>Taille</th><th>Modifié</th><th className="actions">Actions</th></tr>
          </thead>
          <tbody>
            {b.folder && (
              <tr>
                <td><FolderIcon /></td>
                <td colSpan={4}><Link to={folderUrl(b.folder.parentId)}>… Dossier parent</Link></td>
              </tr>
            )}
            {b.folders.map((f) => (
              <tr key={f.id}>
                <td><FolderIcon restricted={f.restricted} /></td>
                <td>
                  <Link to={folderUrl(f.id)} className="strong">{f.name}</Link>
                  {f.restricted && <> <Badge tone="warning">Restreint</Badge></>}
                </td>
                <td className="muted">—</td>
                <td className="small muted">{formatDate(f.updatedAt)}</td>
                <td className="actions">
                  {ov.can.update && <button className="btn ghost sm" type="button" onClick={() => setFolderModal({ mode: 'rename', folder: f })}>Renommer</button>}
                  {ov.can.admin && <button className="btn ghost sm" type="button" onClick={() => setFolderModal({ mode: 'access', folder: f })}>Accès</button>}
                  {ov.can.delete && <button className="btn ghost sm" type="button" onClick={() => removeFolder(f)}>Supprimer</button>}
                </td>
              </tr>
            ))}
            {b.files.map((f) => <FileRowView key={f.id} f={f} onOpen={() => setDetail(f.id)} onFavorite={() => favorite(f)} />)}
            {!b.folders.length && !b.files.length && (
              <tr><td colSpan={5} className="empty">{ov.can.create ? 'Ce dossier est vide. Glissez-déposez des fichiers ici ou utilisez « Envoyer des fichiers ».' : 'Ce dossier est vide.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted">Taille maximale par fichier : {formatBytes(ov.maxUploadBytes)}. Les programmes et scripts exécutables sont refusés.</p>

      {folderModal && <FolderModal state={folderModal} parentId={folderId} roles={ov.roles} onClose={() => setFolderModal(null)} onSaved={refresh} />}
      {detail && <FileDetail id={detail} ov={ov} onClose={() => setDetail(null)} />}
    </div>
  );
}

function FileRowView({ f, onOpen, onFavorite, showPath = false }: { f: DriveFile; onOpen: () => void; onFavorite: () => void; showPath?: boolean }) {
  return (
    <tr>
      <td><FileIcon f={f} /></td>
      <td>
        <button type="button" className="link-btn strong" onClick={onOpen}>{f.name}</button>
        {f.version > 1 && <span className="small muted"> · v{f.version}</span>}
        {f.shared && <> <Badge tone="info">Partagé</Badge></>}
        {showPath && <div className="small muted">{f.path || 'Racine'}</div>}
        {f.tags.length > 0 && <div className="chips" style={{ marginTop: 4 }}>{f.tags.map((t) => <Link key={t} className="tag" to={`/drive/recherche?tag=${encodeURIComponent(t)}`}>#{t}</Link>)}</div>}
      </td>
      <td className="small">{formatBytes(f.size)}</td>
      <td className="small muted">{formatDate(f.updatedAt)}{f.updatedBy ? <><br />{f.updatedBy}</> : null}</td>
      <td className="actions">
        <button type="button" className={`btn ghost sm star${f.favorite ? ' on' : ''}`} aria-pressed={f.favorite} aria-label={f.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'} onClick={onFavorite}>{f.favorite ? '★' : '☆'}</button>
        <button type="button" className="btn ghost sm" onClick={() => api.download(`/drive/files/${f.id}/content`, f.name)}>Télécharger</button>
        <button type="button" className="btn ghost sm" onClick={onOpen}>Détails</button>
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------- Dossiers */

function FolderModal({ state, parentId, roles, onClose, onSaved }: {
  state: { mode: 'create' } | { mode: 'rename' | 'access'; folder: FolderRow }; parentId: string | null; roles: { id: string; name: string }[]; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useApp();
  const folder = state.mode === 'create' ? null : state.folder;
  const [name, setName] = useState(folder?.name ?? '');
  const [restricted, setRestricted] = useState(folder?.restricted ?? false);
  const [allowed, setAllowed] = useState<string[]>(folder?.allowedRoleIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (state.mode === 'create') await api.post('/drive/folders', { name, parentId });
      else if (state.mode === 'rename') await api.patch(`/drive/folders/${folder!.id}`, { name });
      else await api.put(`/drive/folders/${folder!.id}/access`, { restricted, allowedRoleIds: allowed });
      toast(state.mode === 'access' ? 'Accès mis à jour.' : 'Dossier enregistré.');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const title = state.mode === 'create' ? 'Nouveau dossier' : state.mode === 'rename' ? `Renommer « ${folder!.name} »` : `Accès au dossier « ${folder!.name} »`;
  return (
    <Modal open title={title} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="folder-form">Enregistrer</button></>}>
      <form id="folder-form" className="stack" onSubmit={submit}>
        {error && <div className="alert danger">{error}</div>}
        {state.mode !== 'access' ? (
          <Field label="Nom du dossier">{(id) => <input id={id} required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        ) : (
          <>
            <label className="check"><input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /> Restreindre ce dossier (et ses sous-dossiers)</label>
            {restricted && (
              <fieldset className="stack">
                <legend className="small">Rôles autorisés</legend>
                {roles.map((r) => (
                  <label key={r.id} className="check">
                    <input type="checkbox" checked={allowed.includes(r.id)} onChange={(e) => setAllowed((a) => (e.target.checked ? [...a, r.id] : a.filter((x) => x !== r.id)))} /> {r.name}
                  </label>
                ))}
                <p className="small muted">Les administrateurs de Drive voient toujours tous les dossiers. Sans rôle coché, le dossier leur est réservé.</p>
              </fieldset>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Détail d'un document */

function FileDetail({ id, ov, onClose }: { id: string; ov: Overview; onClose: () => void }) {
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['drive', 'file', id], queryFn: () => api.get<Detail>(`/drive/files/${id}`) });
  const tree = useQuery({ queryKey: ['drive', 'tree'], queryFn: () => api.get<{ id: string; path: string }[]>('/drive/tree'), enabled: ov.can.update });
  const [form, setForm] = useState<{ name: string; description: string; tags: string; folderId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareForm, setShareForm] = useState({ days: '7', password: '', max: '' });
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const [versionComment, setVersionComment] = useState('');
  const [busy, setBusy] = useState(false);
  const d = q.data;
  useEffect(() => {
    if (d && !form) setForm({ name: d.name, description: d.description ?? '', tags: d.tags.join(', '), folderId: d.folderId ?? '' });
  }, [d, form]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['drive'] });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    try {
      await fn();
      toast(ok);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (!d || !form) return <Modal open title="Document" onClose={onClose}>{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Modal>;

  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.patch(`/drive/files/${d.id}`, {
      name: form.name, description: form.description || null, folderId: form.folderId || null,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    }), 'Document enregistré.');
  };
  const sendVersion = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('file', file, file.name);
    if (versionComment) fd.append('comment', versionComment);
    await act(() => api.upload(`/drive/files/${d.id}/versions`, fd), 'Nouvelle version envoyée.');
    setVersionComment('');
    setBusy(false);
  };
  const share = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ url: string }>(`/drive/files/${d.id}/shares`, {
        expiresInDays: Number(shareForm.days), password: shareForm.password || undefined, maxDownloads: shareForm.max ? Number(shareForm.max) : null,
      });
      setNewUrl(r.url);
      setShareForm({ days: '7', password: '', max: '' });
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const trash = async () => {
    if (!confirm(`Placer « ${d.name} » dans la corbeille ? Les liens de partage seront révoqués.`)) return;
    await act(() => api.delete(`/drive/files/${d.id}`), 'Document placé dans la corbeille.');
    onClose();
  };
  const content = `/drive/files/${d.id}/content`;

  return (
    <Modal open title={d.name} onClose={onClose} footer={<button className="btn secondary" type="button" onClick={onClose}>Fermer</button>}>
      <div className="stack">
        {error && <div className="alert danger" role="alert">{error}</div>}
        <div className="row between">
          <span className="small muted">{d.path.map((p) => p.name).join(' / ') || 'Racine'} · {formatBytes(d.size)} · version {d.version}{d.restricted ? ' · dossier restreint' : ''}</span>
          <span className="row">
            {d.preview && <a className="btn secondary sm" href={api.fileUrl(`${content}?inline=1`)} target="_blank" rel="noopener">Aperçu</a>}
            <button className="btn sm" type="button" onClick={() => api.download(content, d.name)}>Télécharger</button>
          </span>
        </div>
        {d.mime.startsWith('image/') && d.preview && <img className="drive-preview" src={api.fileUrl(`${content}?inline=1`)} alt={`Aperçu de ${d.name}`} />}
        {d.mime.startsWith('audio/') && d.preview && <audio controls src={api.fileUrl(`${content}?inline=1`)} style={{ width: '100%' }} />}
        {d.mime.startsWith('video/') && d.preview && <video controls src={api.fileUrl(`${content}?inline=1`)} className="drive-preview" />}

        {ov.can.update ? (
          <form className="form-grid" onSubmit={save}>
            <Field label="Nom">{(fid) => <input id={fid} required maxLength={255} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Dossier">{(fid) => (
              <select id={fid} value={form.folderId} onChange={(e) => setForm({ ...form, folderId: e.target.value })}>
                <option value="">Racine</option>
                {tree.data?.map((t) => <option key={t.id} value={t.id}>{t.path}</option>)}
              </select>
            )}</Field>
            <Field label="Étiquettes" hint="Séparées par des virgules" className="full">{(fid, db) => <input id={fid} aria-describedby={db} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />}</Field>
            <Field label="Description" className="full">{(fid) => <textarea id={fid} rows={2} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <div className="form-actions full"><button className="btn" type="submit">Enregistrer</button></div>
          </form>
        ) : (
          d.description && <p>{d.description}</p>
        )}

        <h3>Versions</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Version</th><th>Date</th><th>Par</th><th>Taille</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {d.versions.map((v) => (
                <tr key={v.version}>
                  <td>v{v.version}{v.version === d.version && <> <Badge tone="success">En cours</Badge></>}{v.comment && <div className="small muted">{v.comment}</div>}</td>
                  <td className="small">{formatDate(v.createdAt, true)}</td>
                  <td className="small">{v.by ?? '—'}</td>
                  <td className="small">{formatBytes(v.size)}</td>
                  <td className="actions">
                    <button className="btn ghost sm" type="button" onClick={() => api.download(`${content}?version=${v.version}`, v.originalName)}>Télécharger</button>
                    {ov.can.update && v.version !== d.version && (
                      <button className="btn ghost sm" type="button" onClick={() => act(() => api.post(`/drive/files/${d.id}/versions/${v.version}/restore`), `Version ${v.version} restaurée.`)}>Restaurer</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ov.can.update && (
          <div className="form-grid">
            <Field label="Commentaire de la nouvelle version">{(fid) => <input id={fid} maxLength={500} value={versionComment} onChange={(e) => setVersionComment(e.target.value)} placeholder="Ex. : corrections après relecture" />}</Field>
            <div className="field">
              <span className="label-spacer" aria-hidden>&nbsp;</span>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => versionInput.current?.click()}>{busy ? 'Envoi…' : 'Envoyer une nouvelle version'}</button>
              <input ref={versionInput} type="file" hidden onChange={(e) => { void sendVersion(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          </div>
        )}

        {ov.can.publish && (
          <>
            <h3>Liens de partage public</h3>
            {newUrl && (
              <Alert tone="success">
                Lien créé — copiez-le maintenant, il ne sera plus affiché :<br />
                <code className="mono" style={{ wordBreak: 'break-all' }}>{newUrl}</code>{' '}
                <button className="btn sm" type="button" onClick={() => navigator.clipboard?.writeText(newUrl).then(() => toast('Lien copié.'))}>Copier</button>
              </Alert>
            )}
            {d.shares.length > 0 && (
              <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {d.shares.map((s) => (
                  <li key={s.id} className="row between small">
                    <span>Expire le {formatDate(s.expiresAt, true)}{s.hasPassword ? ' · mot de passe' : ''} · {s.downloadCount}{s.maxDownloads ? `/${s.maxDownloads}` : ''} téléchargement(s){s.by ? ` · créé par ${s.by}` : ''}</span>
                    <button className="btn ghost sm" type="button" onClick={() => act(() => api.delete(`/drive/shares/${s.id}`), 'Lien révoqué.')}>Révoquer</button>
                  </li>
                ))}
              </ul>
            )}
            {d.restricted && !ov.can.admin ? (
              <p className="small muted">Ce document est dans un dossier restreint : seul un administrateur de Drive peut le partager publiquement.</p>
            ) : (
              <form className="form-grid" onSubmit={share}>
                <Field label="Validité">{(fid) => (
                  <select id={fid} value={shareForm.days} onChange={(e) => setShareForm({ ...shareForm, days: e.target.value })}>
                    {[1, 3, 7, 14, 30, 90].map((n) => <option key={n} value={n}>{n} jour{n > 1 ? 's' : ''}</option>)}
                  </select>
                )}</Field>
                <Field label="Nombre maximal de téléchargements">{(fid) => <input id={fid} type="number" min={1} max={10000} placeholder="Illimité" value={shareForm.max} onChange={(e) => setShareForm({ ...shareForm, max: e.target.value })} />}</Field>
                <Field label="Mot de passe (facultatif)" hint="6 caractères minimum" className="full">{(fid, db) => <input id={fid} aria-describedby={db} type="password" autoComplete="new-password" minLength={6} value={shareForm.password} onChange={(e) => setShareForm({ ...shareForm, password: e.target.value })} />}</Field>
                <div className="form-actions full"><button className="btn secondary" type="submit">Créer un lien de partage</button></div>
              </form>
            )}
          </>
        )}

        {d.links.length > 0 && <p className="small muted">Rattaché à : {d.links.map((l) => (l.module === 'projects' ? 'une tâche de Scenorya Projects' : `${l.module}/${l.entityType}`)).join(', ')}.</p>}
        {ov.can.delete && <div><button className="btn danger sm" type="button" onClick={trash}>Placer dans la corbeille</button></div>}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- Listes (favoris, récents, recherche) */

function FileList({ title, description, rows, loading, error, empty, before }: { title: string; description?: string; rows?: DriveFile[]; loading: boolean; error: unknown; empty: string; before?: ReactNode }) {
  const o = useOverview();
  const qc = useQueryClient();
  const [detail, setDetail] = useState<string | null>(null);
  if (o.isLoading) return <Loading />;
  const favorite = async (f: DriveFile) => {
    await api.post(`/drive/files/${f.id}/favorite`, { on: !f.favorite });
    qc.invalidateQueries({ queryKey: ['drive'] });
  };
  return (
    <>
      <Breadcrumb items={crumbs(title)} />
      <PageHead title={title} description={description} actions={o.data && <Usage o={o.data} />} />
      {before}
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : (
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th style={{ width: 44 }} aria-label="Type" /><th>Nom</th><th>Taille</th><th>Modifié</th><th className="actions">Actions</th></tr></thead>
          <tbody>
            {rows?.map((f) => <FileRowView key={f.id} f={f} showPath onOpen={() => setDetail(f.id)} onFavorite={() => favorite(f)} />)}
            {!rows?.length && <tr><td colSpan={5} className="empty">{empty}</td></tr>}
          </tbody>
        </table>
      </div>
      )}
      {detail && o.data && <FileDetail id={detail} ov={o.data} onClose={() => setDetail(null)} />}
    </>
  );
}

export function DriveFavoritesPage() {
  const q = useQuery({ queryKey: ['drive', 'favorites'], queryFn: () => api.get<DriveFile[]>('/drive/favorites') });
  return <FileList title="Favoris" description="Vos documents marqués d’une étoile." rows={q.data} loading={q.isLoading} error={q.error} empty="Aucun favori : cliquez sur ☆ à côté d’un document." />;
}

export function DriveRecentPage() {
  const q = useQuery({ queryKey: ['drive', 'recent'], queryFn: () => api.get<DriveFile[]>('/drive/recent') });
  return <FileList title="Récents" description="Les 20 derniers documents modifiés." rows={q.data} loading={q.isLoading} error={q.error} empty="Aucun document pour le moment." />;
}

export function DriveSearchPage() {
  const [params, setParams] = useSearchParams();
  const qs = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const [term, setTerm] = useState(qs);
  const tags = useQuery({ queryKey: ['drive', 'tags'], queryFn: () => api.get<{ tag: string; n: number }[]>('/drive/tags') });
  const q = useQuery({ queryKey: ['drive', 'search', qs, tag], queryFn: () => api.get<DriveFile[]>(`/drive/search?q=${encodeURIComponent(qs)}&tag=${encodeURIComponent(tag)}`), enabled: !!(qs || tag) });
  const controls = (
    <>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setParams(term ? { q: term, ...(tag ? { tag } : {}) } : tag ? { tag } : {}); }}>
        <div className="drive-search">
          <label className="sr-only" htmlFor="drive-q">Rechercher</label>
          <input id="drive-q" type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Nom, description ou étiquette" />
          <button className="btn" type="submit">Rechercher</button>
        </div>
      </form>
      {!!tags.data?.length && (
        <div className="chips" style={{ marginBottom: 12 }} aria-label="Étiquettes">
          {tags.data.map((t) => (
            <button key={t.tag} type="button" className="chip" aria-pressed={tag === t.tag} onClick={() => setParams(tag === t.tag ? (qs ? { q: qs } : {}) : { ...(qs ? { q: qs } : {}), tag: t.tag })}>#{t.tag} <span className="chip-count">{t.n}</span></button>
          ))}
        </div>
      )}
    </>
  );
  return (
    <FileList title={qs || tag ? `Résultats${qs ? ` pour « ${qs} »` : ''}${tag ? ` · #${tag}` : ''}` : 'Recherche'} rows={qs || tag ? q.data : []} loading={q.isLoading && !!(qs || tag)} error={q.error}
      before={controls} empty={qs || tag ? 'Aucun document ne correspond.' : 'Saisissez un terme ou choisissez une étiquette.'} />
  );
}

/* ---------------------------------------------------------- Corbeille */

interface TrashItem { kind: 'folder' | 'file'; id: string; name: string; deletedAt: string; purgeAt: string; by: string | null; size: number | null; contains: number | null; origin: string }

export function DriveTrashPage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const o = useOverview();
  const q = useQuery({ queryKey: ['drive', 'trash'], queryFn: () => api.get<TrashItem[]>('/drive/trash') });
  if (q.isLoading || o.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const can = o.data!.can;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['drive'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Corbeille')} />
      <PageHead
        title="Corbeille"
        description={`Les éléments supprimés sont conservés ${o.data!.trashDays} jours, puis effacés définitivement.`}
        actions={can.admin && !!q.data!.length && (
          <button className="btn danger" type="button" onClick={() => confirm('Vider la corbeille ? Les documents seront effacés définitivement.') && run(() => api.post('/drive/trash/empty'), 'Corbeille vidée.')}>Vider la corbeille</button>
        )}
      />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th style={{ width: 44 }} aria-label="Type" /><th>Nom</th><th>Emplacement d’origine</th><th>Supprimé</th><th>Effacement</th><th className="actions">Actions</th></tr></thead>
          <tbody>
            {q.data!.map((t) => (
              <tr key={`${t.kind}-${t.id}`}>
                <td>{t.kind === 'folder' ? <FolderIcon /> : <FileIcon f={{ mime: '', name: t.name }} />}</td>
                <td className="strong">{t.name}{t.kind === 'folder' && <div className="small muted">{t.contains} document(s)</div>}{t.size !== null && <div className="small muted">{formatBytes(t.size)}</div>}</td>
                <td className="small">{t.origin || 'Racine'}</td>
                <td className="small">{formatDate(t.deletedAt, true)}{t.by && <><br />{t.by}</>}</td>
                <td className="small">{formatDate(t.purgeAt)}</td>
                <td className="actions">
                  {can.delete && <button className="btn ghost sm" type="button" onClick={() => run(() => api.post(`/drive/trash/${t.kind}/${t.id}/restore`), `« ${t.name} » restauré.`)}>Restaurer</button>}
                  {can.delete && <button className="btn ghost sm" type="button" onClick={() => confirm(`Effacer définitivement « ${t.name} » ?`) && run(() => api.delete(`/drive/trash/${t.kind}/${t.id}`), 'Effacé définitivement.')}>Effacer</button>}
                </td>
              </tr>
            ))}
            {!q.data!.length && <tr><td colSpan={6} className="empty">La corbeille est vide.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------------------------------------------------- Partages et journal */

export function DriveSharesPage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['drive', 'shares'], queryFn: () => api.get<{ id: string; fileName: string; expiresAt: string; hasPassword: boolean; maxDownloads: number | null; downloadCount: number; by: string | null }[]>('/drive/shares') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <Breadcrumb items={crumbs('Liens de partage')} />
      <PageHead title="Liens de partage" description="Liens publics actifs. Un lien révoqué cesse immédiatement de fonctionner." />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Document</th><th>Expire le</th><th>Protection</th><th>Téléchargements</th><th>Créé par</th><th className="actions">Actions</th></tr></thead>
          <tbody>
            {q.data!.map((s) => (
              <tr key={s.id}>
                <td className="strong">{s.fileName}</td>
                <td className="small">{formatDate(s.expiresAt, true)}</td>
                <td className="small">{s.hasPassword ? 'Mot de passe' : 'Aucune'}</td>
                <td className="small">{s.downloadCount}{s.maxDownloads ? ` / ${s.maxDownloads}` : ''}</td>
                <td className="small">{s.by ?? '—'}</td>
                <td className="actions">
                  <button className="btn ghost sm" type="button" onClick={() => api.delete(`/drive/shares/${s.id}`).then(() => { toast('Lien révoqué.'); qc.invalidateQueries({ queryKey: ['drive'] }); }, (e) => toast(errorMessage(e), 'error'))}>Révoquer</button>
                </td>
              </tr>
            ))}
            {!q.data!.length && <tr><td colSpan={6} className="empty">Aucun lien de partage actif.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

const ACTION: Record<string, [string, 'info' | 'neutral' | 'warning' | 'danger']> = {
  download: ['Téléchargement', 'neutral'], preview: ['Aperçu', 'neutral'], share_download: ['Lien public', 'info'], share_denied: ['Mot de passe refusé', 'danger'],
};

export function DriveAccessLogPage() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['drive', 'log', page], queryFn: () => api.get<{ total: number; page: number; pageSize: number; items: { id: number; at: string; action: string; fileName: string; version: number | null; user: string | null; viaShare: boolean; ip: string | null }[] }>(`/drive/access-log?page=${page}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  return (
    <>
      <Breadcrumb items={crumbs('Journal des accès')} />
      <PageHead title="Journal des accès" description="Qui a consulté ou téléchargé quoi, y compris par lien public. Les modifications sont dans le journal d’audit." />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>Action</th><th>Document</th><th>Personne</th><th>Adresse IP</th></tr></thead>
          <tbody>
            {d.items.map((i) => (
              <tr key={i.id}>
                <td className="small">{formatDate(i.at, true)}</td>
                <td><Badge tone={ACTION[i.action]?.[1] ?? 'neutral'}>{ACTION[i.action]?.[0] ?? i.action}</Badge></td>
                <td>{i.fileName}{i.version ? <span className="small muted"> · v{i.version}</span> : null}</td>
                <td className="small">{i.user ?? (i.viaShare ? 'Visiteur (lien public)' : '—')}</td>
                <td className="small mono">{i.ip ?? '—'}</td>
              </tr>
            ))}
            {!d.items.length && <tr><td colSpan={5} className="empty">Aucun accès enregistré.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
    </>
  );
}

/* ---------------------------------------------------------- Pièces jointes (utilisé par Projects) */

export function Attachments({ module, entityType, entityId }: { module: string; entityType: string; entityId: string }) {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const key = ['drive', 'links', module, entityType, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<DriveFile[]>(`/drive/links?module=${module}&entityType=${entityType}&entityId=${entityId}`) });
  const input = useRef<HTMLInputElement>(null);
  const up = useUploader(() => qc.invalidateQueries({ queryKey: ['drive'] }));
  const detach = async (f: DriveFile) => {
    try {
      await api.delete(`/drive/links/${f.id}/${module}/${entityType}/${entityId}`);
      qc.invalidateQueries({ queryKey: key });
      toast('Pièce jointe détachée (le document reste dans Drive).');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="stack">
      {q.data?.length ? (
        <ul className="attachments">
          {q.data.map((f) => (
            <li key={f.id}>
              <FileIcon f={f} />
              <button type="button" className="link-btn" onClick={() => api.download(`/drive/files/${f.id}/content`, f.name)}>{f.name}</button>
              <span className="small muted">{formatBytes(f.size)}</span>
              {can('drive.files.update') && <button type="button" className="btn ghost sm" onClick={() => detach(f)} aria-label={`Détacher ${f.name}`}>Détacher</button>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">Aucune pièce jointe.</p>
      )}
      {up.panel}
      {can('drive.files.create') && (
        <div>
          <button type="button" className="btn secondary sm" disabled={up.busy} onClick={() => input.current?.click()}>Joindre des fichiers</button>
          <input ref={input} type="file" multiple hidden onChange={(e) => { void up.send([...(e.target.files ?? [])], { linkModule: module, linkEntityType: entityType, linkEntityId: entityId }, 2 ** 40); e.target.value = ''; }} />
          <span className="small muted"> Rangés dans le dossier Drive « Pièces jointes ».</span>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- Page publique d'un lien de partage */

export function PublicSharePage() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['share', token], queryFn: () => api.get<{ association: string; name: string; size: number; mime: string; expiresAt: string; needsPassword: boolean; remaining: number | null; locked: boolean }>(`/public/shares/${token}`), retry: false });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const download = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.download(`/public/shares/${token}/download`, q.data!.name, { method: 'POST', body: { password: password || undefined } });
      setDone(true);
      q.refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <main className="public-page">
      <div className="card stack" style={{ maxWidth: 520, margin: '48px auto' }}>
        <BrandLogo height={40} />
        {q.isLoading && <Loading />}
        {q.error && <Alert tone="warning">{errorMessage(q.error)}</Alert>}
        {q.data && (
          <>
            <div>
              <p className="small muted" style={{ margin: 0 }}>{q.data.association} vous partage un document</p>
              <h1 style={{ fontSize: '1.4rem', margin: '4px 0', wordBreak: 'break-word' }}>{q.data.name}</h1>
              <p className="small muted" style={{ margin: 0 }}>
                {formatBytes(q.data.size)} · disponible jusqu’au {formatDate(q.data.expiresAt, true)}
                {q.data.remaining !== null && ` · ${q.data.remaining} téléchargement(s) restant(s)`}
              </p>
            </div>
            {error && <div className="alert danger" role="alert">{error}</div>}
            {done && <Alert tone="success">Téléchargement lancé.</Alert>}
            <form className="stack" onSubmit={download}>
              {q.data.needsPassword && (
                <Field label="Mot de passe">{(id) => <input id={id} type="password" required autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
              )}
              <button className="btn" type="submit" disabled={q.data.locked}>Télécharger</button>
            </form>
          </>
        )}
        <p className="small muted" style={{ margin: 0 }}>Partage sécurisé par Scenorya. N’ouvrez que les documents provenant de personnes de confiance.</p>
      </div>
    </main>
  );
}
