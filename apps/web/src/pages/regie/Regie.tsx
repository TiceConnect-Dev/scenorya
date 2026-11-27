import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io, Socket } from 'socket.io-client';
import { api, ApiError, deleteWithConfirm, errorMessage, session } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';

/* --------------------------------------------------------------- Types */

type Dept = 'light' | 'sound' | 'video' | 'stage' | 'fly' | 'other';
interface Cue { id: string; position: number; number: string | null; department: Dept; label: string; trigger: string | null; page: string | null; durationSec: number | null; notes: string | null; soundId: string | null }
interface Sound { id: string; label: string; hotkey: string | null; volume: number; loop: boolean; fadeInMs: number; fadeOutMs: number; color: string | null; fileName: string | null; available: boolean; driveFileId: string | null }
interface Run { id: string; cuesheetId: string; mode: 'rehearsal' | 'show'; currentCueId: string | null; standbyCueId: string | null; startedAt: string; endedAt: string | null; report: string | null }
interface Sheet {
  id: string; title: string; notes: string | null; locked: boolean; showId: string | null; show: { id: string; title: string } | null;
  cues: Cue[]; sounds: Sound[]; activeRun: Run | null; performances: { id: string; startAt: string; status: string }[];
  features: { cart: boolean; showLink: boolean }; can: { operate: boolean; edit: boolean };
}
interface LiveState { runId: string; cuesheetId: string; mode?: string; currentCueId: string | null; standbyCueId: string | null; endedAt?: string | null; kind?: string; by?: string }

export const DEPTS: Record<Dept, { label: string; color: string }> = {
  light: { label: 'Lumière', color: '#C77A08' }, sound: { label: 'Son', color: '#1266B2' }, video: { label: 'Vidéo', color: '#7539B2' },
  stage: { label: 'Plateau', color: '#067647' }, fly: { label: 'Cintres', color: '#526C85' }, other: { label: 'Autre', color: '#4f6077' },
};
const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Régie', to: '/regie' }, ...extra, { label }];
const cueName = (q?: Cue | null) => (q ? `${q.number ? `${q.number} — ` : ''}${q.label}` : '—');
const CACHE = (id: string) => `scenorya:regie:${id}`;

/** Conduite avec copie locale : en cas de coupure réseau, la dernière version chargée reste disponible. */
function useSheet(id: string) {
  return useQuery({
    queryKey: ['regie', 'sheet', id],
    queryFn: async () => {
      try {
        const s = await api.get<Sheet>(`/regie/cuesheets/${id}`);
        try {
          localStorage.setItem(CACHE(id), JSON.stringify(s));
        } catch {
          /* stockage plein ou indisponible */
        }
        return { ...s, offline: false };
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NETWORK') {
          try {
            const cached = localStorage.getItem(CACHE(id));
            if (cached) return { ...(JSON.parse(cached) as Sheet), offline: true };
          } catch {
            /* copie illisible */
          }
        }
        throw e;
      }
    },
  });
}

/* ---------------------------------------------------------- Accueil */

export function RegieHome() {
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['regie', 'list'], queryFn: () => api.get<(Sheet & { show: string | null; cues: number; live: boolean; lastRun: string | null })[]>('/regie/cuesheets') });
  const shows = useQuery({ queryKey: ['show', 'shows', 'for-regie'], queryFn: () => api.get<{ id: string; title: string }[]>('/show/shows'), enabled: can('show.shows.read') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', showId: '' });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const s = await api.post<{ id: string }>('/regie/cuesheets', { title: f.title, showId: f.showId || null });
      toast('Conduite créée.');
      navigate(`/regie/conduites/${s.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Régie' }]} />
      <PageHead title="Conduites" description="Tops lumière, son, vidéo et plateau ; conduite en direct synchronisée entre les postes." actions={can('regie.cuesheets.create') && <button className="btn" type="button" onClick={() => { setF({ title: '', showId: '' }); setOpen(true); }}>Nouvelle conduite</button>} />
      {q.data!.length === 0 ? <div className="card empty">Aucune conduite.</div> : (
        <div className="grid-3">
          {q.data!.map((s) => (
            <Link key={s.id} to={`/regie/conduites/${s.id}`} className="card stack tile-link" style={{ gap: 8 }}>
              <div className="row between"><h2 style={{ margin: 0 }}>{s.title}</h2>{s.live ? <Badge tone="danger">● En direct</Badge> : s.locked ? <Badge tone="info">Figée</Badge> : null}</div>
              <span className="small muted">{s.show ?? 'Sans spectacle'} · {s.cues} top(s)</span>
              {s.lastRun && <span className="small">Dernière séance : {formatDate(s.lastRun, true)}</span>}
            </Link>
          ))}
        </div>
      )}
      {open && (
        <Modal open title="Nouvelle conduite" onClose={() => setOpen(false)} footer={<><button className="btn secondary" type="button" onClick={() => setOpen(false)}>Annuler</button><button className="btn" type="submit" form="sheet-form">Créer</button></>}>
          <form id="sheet-form" className="stack" onSubmit={create}>
            <Field label="Titre">{(id) => <input id={id} type="text" required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />}</Field>
            {!!shows.data?.length && (
              <Field label="Spectacle (facultatif)">{(id) => <select id={id} value={f.showId} onChange={(e) => setF({ ...f, showId: e.target.value })}><option value="">Aucun</option>{shows.data!.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>}</Field>
            )}
          </form>
        </Modal>
      )}
    </>
  );
}

/* ---------------------------------------------------------- Conduite (édition) */

export function CuesheetPage() {
  const { id = '' } = useParams();
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useSheet(id);
  const [tab, setTab] = useState<'cues' | 'cart' | 'runs'>('cues');
  const [dept, setDept] = useState('');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  const refresh = () => qc.invalidateQueries({ queryKey: ['regie'] });
  const editable = can('regie.cuesheets.update') && !s.locked && !(s.activeRun?.mode === 'show');
  const act = (fn: () => Promise<unknown>, ok?: string) => fn().then(() => { if (ok) toast(ok); refresh(); }, (e) => toast(errorMessage(e), 'error'));
  return (
    <>
      <Breadcrumb items={crumbs(s.title)} />
      <PageHead
        title={s.title}
        description={[s.show && `Spectacle : ${s.show.title}`, `${s.cues.length} top(s)`].filter(Boolean).join(' · ')}
        actions={
          <>
            {s.locked && <Badge tone="info">Figée</Badge>}
            {s.activeRun && <Badge tone="danger">● {s.activeRun.mode === 'show' ? 'Représentation' : 'Répétition'} en cours</Badge>}
            <Link className="btn" to={`/regie/conduites/${s.id}/direct`}>{s.activeRun ? 'Rejoindre le direct' : 'Conduire'}</Link>
            {can('regie.cuesheets.download') && (
              <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                <label className="sr-only" htmlFor="pdf-dept">Service</label>
                <select id="pdf-dept" style={{ width: 'auto' }} value={dept} onChange={(e) => setDept(e.target.value)}><option value="">Tous services</option>{Object.entries(DEPTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                <button className="btn secondary" type="button" onClick={() => api.download(`/regie/cuesheets/${s.id}/cuesheet.pdf${dept ? `?department=${dept}` : ''}`, 'conduite.pdf').catch((e) => toast(errorMessage(e), 'error'))}>PDF</button>
              </span>
            )}
            {can('regie.cuesheets.create') && <button className="btn secondary" type="button" onClick={() => api.post<{ id: string }>(`/regie/cuesheets/${s.id}/duplicate`).then((c) => { toast('Copie créée.'); navigate(`/regie/conduites/${c.id}`); }, (e) => toast(errorMessage(e), 'error'))}>Dupliquer</button>}
            {can('regie.cuesheets.update') && <button className="btn secondary" type="button" onClick={() => act(() => api.patch(`/regie/cuesheets/${s.id}`, { locked: !s.locked }), s.locked ? 'Conduite déverrouillée.' : 'Conduite figée.')}>{s.locked ? 'Déverrouiller' : 'Figer'}</button>}
            {can('regie.cuesheets.delete') && <button className="btn danger" type="button" onClick={() => deleteWithConfirm(`/regie/cuesheets/${s.id}`, `Supprimer la conduite « ${s.title} », ses tops, son cartoucheur et l’historique de ses séances ? (Les sons restent dans Drive.)`).then((r) => { if (r) { toast('Conduite supprimée.'); refresh(); navigate('/regie'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
          </>
        }
      />
      {(s as Sheet & { offline?: boolean }).offline && <Alert tone="warning">Hors connexion : affichage de la dernière version enregistrée sur ce poste.</Alert>}
      {s.activeRun?.mode === 'show' && <Alert tone="warning">Représentation en cours : la conduite est verrouillée jusqu’à la fin de la séance.</Alert>}
      <div className="tabs" role="tablist">
        {([['cues', `Tops (${s.cues.length})`], ...(s.features.cart ? [['cart', `Cartoucheur (${s.sounds.length})`]] : []), ['runs', 'Séances']] as ['cues' | 'cart' | 'runs', string][]).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'cues' && <CuesTab s={s} editable={editable} refresh={refresh} />}
      {tab === 'cart' && <CartTab s={s} editable={editable} refresh={refresh} />}
      {tab === 'runs' && <RunsTab s={s} />}
    </>
  );
}

function CueForm({ s, initial, after, onClose, onSaved }: { s: Sheet; initial: Cue | null; after?: string | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ number: initial?.number ?? '', department: initial?.department ?? 'light' as Dept, label: initial?.label ?? '', trigger: initial?.trigger ?? '', page: initial?.page ?? '', durationSec: initial?.durationSec != null ? String(initial.durationSec) : '', notes: initial?.notes ?? '', soundId: initial?.soundId ?? '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const t = (v: string) => v.trim() || null;
    const body = { number: t(f.number), department: f.department, label: f.label, trigger: t(f.trigger), page: t(f.page), durationSec: f.durationSec === '' ? null : Number(f.durationSec), notes: t(f.notes), soundId: f.soundId || null };
    try {
      if (initial) await api.patch(`/regie/cues/${initial.id}`, body);
      else await api.post(`/regie/cuesheets/${s.id}/cues`, { ...body, ...(after !== undefined ? { afterCueId: after } : {}) });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal open title={initial ? `Modifier le top ${initial.number ?? ''}` : 'Nouveau top'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="cue-form">Enregistrer</button></>}>
      <form id="cue-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Service">{(id) => <select id={id} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value as Dept })}>{Object.entries(DEPTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>}</Field>
        <Field label="Numéro" hint="Vide : utilisez « Renuméroter »">{(id, d) => <input id={id} aria-describedby={d} type="text" maxLength={20} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />}</Field>
        <Field label="Effet" className="full">{(id) => <input id={id} type="text" required maxLength={200} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Ex. : Plein feu chaud, fondu 5 s" autoFocus />}</Field>
        <Field label="Déclenchement" className="full">{(id) => <input id={id} type="text" maxLength={500} value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })} placeholder="Réplique, action, top du régisseur…" />}</Field>
        <Field label="Page du texte">{(id) => <input id={id} type="text" maxLength={20} value={f.page} onChange={(e) => setF({ ...f, page: e.target.value })} />}</Field>
        <Field label="Durée (secondes)">{(id) => <input id={id} type="number" min={0} value={f.durationSec} onChange={(e) => setF({ ...f, durationSec: e.target.value })} />}</Field>
        {s.sounds.length > 0 && <Field label="Son lancé avec ce top" className="full">{(id) => <select id={id} value={f.soundId} onChange={(e) => setF({ ...f, soundId: e.target.value })}><option value="">Aucun</option>{s.sounds.map((so) => <option key={so.id} value={so.id}>{so.label}</option>)}</select>}</Field>}
        <Field label="Notes" className="full">{(id) => <input id={id} type="text" maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
      </form>
    </Modal>
  );
}

function CuesTab({ s, editable, refresh }: { s: Sheet; editable: boolean; refresh: () => void }) {
  const { toast } = useApp();
  const [form, setForm] = useState<{ cue: Cue | null; after?: string | null } | null>(null);
  const move = async (i: number, delta: number) => {
    const ids = s.cues.map((q) => q.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      await api.put(`/regie/cuesheets/${s.id}/order`, { cueIds: ids });
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      {editable && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn" type="button" onClick={() => setForm({ cue: null })}>Ajouter un top</button>
          {s.cues.length > 0 && <button className="btn secondary" type="button" onClick={() => api.post(`/regie/cuesheets/${s.id}/renumber`).then(() => { toast('Tops renumérotés.'); refresh(); }, (e) => toast(errorMessage(e), 'error'))}>Renuméroter (L1, S1…)</button>}
        </div>
      )}
      <div className="table-wrap">
        <table className="table regie-table">
          <thead><tr><th>Top</th><th>Service</th><th>Effet</th><th>Déclenchement</th><th>Page</th><th>Durée</th>{editable && <th className="actions">Actions</th>}</tr></thead>
          <tbody>
            {s.cues.map((q, i) => (
              <tr key={q.id} style={{ boxShadow: `inset 4px 0 0 ${DEPTS[q.department].color}` }}>
                <td className="strong">{q.number ?? '—'}</td>
                <td className="small">{DEPTS[q.department].label}</td>
                <td>{q.label}{q.soundId && <span className="small muted"> ♪ {s.sounds.find((x) => x.id === q.soundId)?.label}</span>}{q.notes && <div className="small muted">{q.notes}</div>}</td>
                <td className="small">{q.trigger ?? '—'}</td>
                <td className="small">{q.page ?? ''}</td>
                <td className="small">{q.durationSec != null ? `${q.durationSec} s` : ''}</td>
                {editable && (
                  <td className="actions nowrap">
                    <button type="button" className="btn ghost sm" aria-label="Monter" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" className="btn ghost sm" aria-label="Descendre" disabled={i === s.cues.length - 1} onClick={() => move(i, 1)}>↓</button>
                    <button type="button" className="btn ghost sm" onClick={() => setForm({ cue: null, after: q.id })}>Insérer après</button>
                    <button type="button" className="btn ghost sm" onClick={() => setForm({ cue: q })}>Modifier</button>
                    <button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm(`/regie/cues/${q.id}`, `Supprimer le top ${cueName(q)} ?`).then((r) => { if (r) refresh(); }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>
                  </td>
                )}
              </tr>
            ))}
            {!s.cues.length && <tr><td colSpan={7} className="empty">Aucun top.</td></tr>}
          </tbody>
        </table>
      </div>
      {form && <CueForm s={s} initial={form.cue} after={form.after} onClose={() => setForm(null)} onSaved={refresh} />}
    </>
  );
}

function CartTab({ s, editable, refresh }: { s: Sheet; editable: boolean; refresh: () => void }) {
  const { toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('linkModule', 'regie');
      form.append('linkEntityType', 'cuesheet');
      form.append('linkEntityId', s.id);
      files.forEach((f) => form.append('files', f, f.name));
      const r = await api.upload<{ files: { id: string; name: string }[] }>('/drive/files', form);
      const used = new Set(s.sounds.map((x) => x.hotkey));
      let key = 1;
      for (const f of r.files) {
        while (used.has(String(key)) && key < 9) key++;
        const hotkey = key <= 9 && !used.has(String(key)) ? String(key) : null;
        if (hotkey) used.add(hotkey);
        await api.post(`/regie/cuesheets/${s.id}/sounds`, { driveFileId: f.id, label: f.name.replace(/\.[^.]+$/, ''), hotkey });
      }
      toast(`${r.files.length} son(s) ajouté(s) (rangés dans Drive).`);
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const patch = (so: Sound, body: Partial<Sound>) => api.patch(`/regie/sounds/${so.id}`, body).then(refresh, (e) => toast(errorMessage(e), 'error'));
  return (
    <>
      {editable && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn" type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Envoi…' : 'Ajouter des sons'}</button>
          <input ref={input} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <span className="small muted">MP3, WAV, OGG ou M4A. Touches 1 à 9 attribuées automatiquement.</span>
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Touche</th><th>Son</th><th>Volume</th><th>Boucle</th><th>Fondus (ms)</th><th>Écoute</th>{editable && <th className="actions">Actions</th>}</tr></thead>
          <tbody>
            {s.sounds.map((so) => (
              <tr key={so.id}>
                <td>{editable ? <input aria-label={`Touche de ${so.label}`} type="text" maxLength={1} style={{ width: 52, textAlign: 'center', textTransform: 'uppercase' }} defaultValue={so.hotkey ?? ''} onBlur={(e) => { const v = e.target.value.toUpperCase() || null; if (v !== so.hotkey) void patch(so, { hotkey: v }); }} /> : <strong>{so.hotkey ?? '—'}</strong>}</td>
                <td><strong>{so.label}</strong>{!so.available && <div className="small" style={{ color: 'var(--danger)' }}>Fichier supprimé de Drive</div>}<div className="small muted">{so.fileName}</div></td>
                <td>{editable ? <input aria-label={`Volume de ${so.label}`} type="range" min={0} max={100} defaultValue={so.volume} onMouseUp={(e) => patch(so, { volume: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => patch(so, { volume: Number((e.target as HTMLInputElement).value) })} /> : `${so.volume} %`}</td>
                <td><input type="checkbox" aria-label={`Boucle pour ${so.label}`} checked={so.loop} disabled={!editable} onChange={(e) => patch(so, { loop: e.target.checked })} /></td>
                <td className="small">{so.fadeInMs} / {so.fadeOutMs}</td>
                <td>{so.available && <audio controls preload="none" src={api.fileUrl(`/regie/sounds/${so.id}/audio`)} style={{ height: 32, width: 200 }} />}</td>
                {editable && <td className="actions"><button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm(`/regie/sounds/${so.id}`, `Retirer « ${so.label} » du cartoucheur ? (Le fichier reste dans Drive.)`).then((r) => { if (r) refresh(); }, (e) => toast(errorMessage(e), 'error'))}>Retirer</button></td>}
              </tr>
            ))}
            {!s.sounds.length && <tr><td colSpan={7} className="empty">Aucun son.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RunsTab({ s }: { s: Sheet }) {
  const { can, toast } = useApp();
  const q = useQuery({ queryKey: ['regie', 'runs', s.id], queryFn: () => api.get<{ id: string; mode: string; startedAt: string; endedAt: string | null; by: string | null; gos: number }[]>(`/regie/cuesheets/${s.id}/runs`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Date</th><th>Type</th><th>Durée</th><th>Tops envoyés</th><th>Menée par</th><th className="actions">Actions</th></tr></thead>
        <tbody>
          {q.data!.map((r) => (
            <tr key={r.id}>
              <td>{formatDate(r.startedAt, true)}</td>
              <td>{r.mode === 'show' ? 'Représentation' : 'Répétition'}{!r.endedAt && <> <Badge tone="danger">En cours</Badge></>}</td>
              <td className="small">{r.endedAt ? `${Math.round((new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) / 60000)} min` : '—'}</td>
              <td>{r.gos}</td>
              <td className="small">{r.by ?? '—'}</td>
              <td className="actions">
                <button type="button" className="btn ghost sm" onClick={() => api.download(`/regie/runs/${r.id}/report.pdf`, 'rapport.pdf').catch((e) => toast(errorMessage(e), 'error'))}>Rapport (PDF)</button>
                {can('regie.runs.operate') && <button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm(`/regie/runs/${r.id}`, 'Supprimer cette séance et son journal ?').then((x) => { if (x) q.refetch(); }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
              </td>
            </tr>
          ))}
          {!q.data!.length && <tr><td colSpan={6} className="empty">Aucune séance.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------- Direct */

interface Pending { kind: 'go' | 'back' | 'jump' | 'standby' | 'note'; cueId?: string | null; note?: string; at: string }

/** Lecteur du cartoucheur : un élément audio par son, fondus par paliers de volume. */
function useCart(sounds: Sound[]) {
  const players = useRef(new Map<string, HTMLAudioElement>());
  const [playing, setPlaying] = useState<Set<string>>(new Set());
  useEffect(() => {
    const map = players.current;
    for (const so of sounds) {
      if (!so.available || map.has(so.id)) continue;
      const a = new Audio(api.fileUrl(`/regie/sounds/${so.id}/audio`));
      a.preload = 'auto';
      a.addEventListener('ended', () => setPlaying((p) => { const n = new Set(p); n.delete(so.id); return n; }));
      map.set(so.id, a);
    }
    return () => undefined;
  }, [sounds]);
  useEffect(() => () => { players.current.forEach((a) => a.pause()); }, []);
  const ramp = (a: HTMLAudioElement, to: number, ms: number, done?: () => void) => {
    if (ms <= 0) { a.volume = to; done?.(); return; }
    const from = a.volume;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      a.volume = from + (to - from) * k;
      if (k < 1) requestAnimationFrame(step); else done?.();
    };
    requestAnimationFrame(step);
  };
  const play = useCallback((so: Sound) => {
    const a = players.current.get(so.id);
    if (!a) return;
    if (!a.paused) {
      ramp(a, 0, so.fadeOutMs, () => { a.pause(); a.currentTime = 0; });
      setPlaying((p) => { const n = new Set(p); n.delete(so.id); return n; });
      return;
    }
    a.loop = so.loop;
    a.currentTime = 0;
    a.volume = so.fadeInMs ? 0 : so.volume / 100;
    void a.play().then(() => {
      ramp(a, so.volume / 100, so.fadeInMs);
      setPlaying((p) => new Set(p).add(so.id));
    }).catch(() => undefined);
  }, []);
  const stopAll = useCallback(() => {
    players.current.forEach((a) => { a.pause(); a.currentTime = 0; });
    setPlaying(new Set());
  }, []);
  return { play, stopAll, playing };
}

export function LivePage() {
  const { id = '' } = useParams();
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useSheet(id);
  const s = q.data;
  const [live, setLive] = useState<LiveState | null>(null);
  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState<Pending[]>([]);
  const [filter, setFilter] = useState<string>(() => localStorage.getItem('scenorya:regie:dept') ?? '');
  const [start, setStart] = useState<{ mode: 'rehearsal' | 'show'; performanceId: string } | null>(null);
  const [ending, setEnding] = useState(false);
  const [report, setReport] = useState('');
  const [note, setNote] = useState('');
  const [flash, setFlash] = useState(false);
  const socket = useRef<Socket | null>(null);
  const cart = useCart(s?.sounds ?? []);
  const run = live && !live.endedAt ? live : null;
  const canOperate = !!s?.can.operate;

  useEffect(() => {
    if (s?.activeRun && !live) setLive({ runId: s.activeRun.id, cuesheetId: s.id, mode: s.activeRun.mode, currentCueId: s.activeRun.currentCueId, standbyCueId: s.activeRun.standbyCueId });
  }, [s, live]);

  // Suivi en direct : tous les postes reçoivent chaque GO.
  useEffect(() => {
    const sock = io({ path: '/api/realtime', transports: ['websocket', 'polling'] });
    socket.current = sock;
    sock.on('connect', () => { setConnected(true); sock.emit('regie:join', { associationId: session.associationId, cuesheetId: id }); });
    sock.on('disconnect', () => setConnected(false));
    sock.on('regie:state', (st: LiveState) => {
      setLive(st);
      if (st.kind === 'go') { setFlash(true); setTimeout(() => setFlash(false), 350); }
      if (st.kind === 'start' || st.kind === 'end') qc.invalidateQueries({ queryKey: ['regie'] });
    });
    sock.on('regie:sheet', () => qc.invalidateQueries({ queryKey: ['regie', 'sheet', id] }));
    return () => { sock.emit('regie:leave'); sock.close(); };
  }, [id, qc]);

  const cues = s?.cues ?? [];
  const index = useMemo(() => new Map(cues.map((c, i) => [c.id, i])), [cues]);
  const current = run?.currentCueId ? cues[index.get(run.currentCueId) ?? -1] : null;
  const standby = run?.standbyCueId ? cues[index.get(run.standbyCueId) ?? -1] : (run && !run.currentCueId ? cues[0] : null);

  /** Envoi d'une action ; sans réseau, elle est appliquée localement et mise en file pour être rejouée. */
  const send = useCallback(async (a: Omit<Pending, 'at'>) => {
    if (!run || !s) return;
    const p: Pending = { ...a, at: new Date().toISOString() };
    if (a.kind === 'go') {
      const target = a.cueId ? cues[index.get(a.cueId) ?? -1] : standby;
      const so = target?.soundId ? s.sounds.find((x) => x.id === target.soundId) : undefined;
      if (so) cart.play(so);
    }
    try {
      const st = await api.post<LiveState>(`/regie/runs/${run.runId}/actions`, { actions: [...queue, p] });
      setQueue([]);
      setLive(st);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NETWORK') {
        setQueue((x) => [...x, p]);
        // Application locale pour continuer la conduite sans réseau.
        setLive((l) => {
          if (!l) return l;
          const i = l.currentCueId ? index.get(l.currentCueId) ?? -1 : -1;
          let cur = l.currentCueId;
          if (a.kind === 'go') cur = a.cueId ?? (l.standbyCueId ?? cues[i + 1]?.id ?? cur);
          if (a.kind === 'back') cur = i > 0 ? cues[i - 1].id : null;
          if (a.kind === 'jump' && a.cueId) cur = a.cueId;
          const ci = cur ? index.get(cur) ?? -1 : -1;
          return { ...l, currentCueId: cur, standbyCueId: a.kind === 'note' ? l.standbyCueId : cues[ci + 1]?.id ?? null };
        });
      } else {
        toast(errorMessage(e), 'error');
      }
    }
  }, [run, s, cues, index, standby, queue, cart, toast]);

  // Rejeu automatique de la file dès que le réseau revient.
  useEffect(() => {
    if (!connected || !queue.length || !run) return;
    api.post<LiveState>(`/regie/runs/${run.runId}/actions`, { actions: queue }).then((st) => { setQueue([]); setLive(st); toast('Actions hors connexion transmises.'); }, () => undefined);
  }, [connected, queue, run, toast]);

  // Raccourcis : Espace = GO, Retour arrière = retour, Échap = couper les sons, 1-9/A-Z = cartoucheur.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || (t as HTMLElement).isContentEditable || document.querySelector('dialog[open]')) return;
      if (e.code === 'Space' && canOperate && run) { e.preventDefault(); void send({ kind: 'go' }); return; }
      if (e.code === 'Backspace' && canOperate && run) { e.preventDefault(); void send({ kind: 'back' }); return; }
      if (e.key === 'Escape') { cart.stopAll(); return; }
      const so = s?.sounds.find((x) => x.hotkey && x.hotkey === e.key.toUpperCase());
      if (so) { e.preventDefault(); cart.play(so); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canOperate, run, send, cart, s]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const sheet = s!;
  const visible = cues.filter((c) => !filter || c.department === filter);
  const begin = async () => {
    if (!start) return;
    try {
      const r = await api.post<Run>(`/regie/cuesheets/${sheet.id}/runs`, { mode: start.mode, performanceId: start.performanceId || null });
      setLive({ runId: r.id, cuesheetId: r.cuesheetId, mode: r.mode, currentCueId: null, standbyCueId: r.standbyCueId });
      setStart(null);
      qc.invalidateQueries({ queryKey: ['regie'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const end = async () => {
    if (!run) return;
    try {
      await api.post(`/regie/runs/${run.runId}/end`, { report: report || null });
      setEnding(false);
      setReport('');
      setLive((l) => (l ? { ...l, endedAt: new Date().toISOString() } : l));
      toast('Séance terminée : rapport disponible dans « Séances ».');
      qc.invalidateQueries({ queryKey: ['regie'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="regie-live">
      <div className="regie-top">
        <Link to={`/regie/conduites/${sheet.id}`} className="regie-back">← {sheet.title}</Link>
        <span className={`regie-net ${connected ? 'on' : 'off'}`} role="status">{connected ? '● Synchronisé' : '○ Hors connexion'}{queue.length ? ` · ${queue.length} action(s) en attente` : ''}</span>
        <label className="sr-only" htmlFor="live-dept">Service affiché</label>
        <select id="live-dept" value={filter} onChange={(e) => { setFilter(e.target.value); localStorage.setItem('scenorya:regie:dept', e.target.value); }}>
          <option value="">Tous les services</option>
          {Object.entries(DEPTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {run ? <Badge tone="danger">● {run.mode === 'show' ? 'Représentation' : 'Répétition'}</Badge> : <Badge>Pas de séance</Badge>}
        {canOperate && !run && <button className="btn sm" type="button" onClick={() => setStart({ mode: 'rehearsal', performanceId: '' })}>Démarrer une séance</button>}
        {canOperate && run && <button className="btn danger sm" type="button" onClick={() => setEnding(true)}>Terminer</button>}
      </div>

      <div className={`regie-board${flash ? ' flash' : ''}`}>
        <section className="regie-now" aria-live="assertive">
          <div className="regie-caption">En cours</div>
          <div className="regie-cue-big" style={{ borderColor: current ? DEPTS[current.department].color : undefined }}>
            {current ? <><span className="regie-num">{current.number ?? ''}</span> {current.label}</> : <span className="muted">Aucun top envoyé</span>}
          </div>
          {current?.trigger && <div className="regie-trigger">{current.trigger}</div>}
        </section>
        <section className="regie-next">
          <div className="regie-caption">Attention — prochain top</div>
          <div className="regie-cue-mid" style={{ borderColor: standby ? DEPTS[standby.department].color : undefined }}>
            {standby ? <><span className="regie-num">{standby.number ?? ''}</span> {standby.label} <span className="small">({DEPTS[standby.department].label})</span></> : <span className="muted">Fin de la conduite</span>}
          </div>
          {standby?.trigger && <div className="regie-trigger">Sur : {standby.trigger}{standby.page ? ` (p. ${standby.page})` : ''}</div>}
        </section>
        {canOperate && run && (
          <div className="regie-controls">
            <button type="button" className="regie-go" disabled={!standby} onClick={() => send({ kind: 'go' })}>GO<span>Espace</span></button>
            <button type="button" className="btn secondary" onClick={() => send({ kind: 'back' })}>← Retour</button>
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (note.trim()) { void send({ kind: 'note', note: note.trim() }); setNote(''); } }}>
              <label className="sr-only" htmlFor="live-note">Note au journal</label>
              <input id="live-note" type="text" placeholder="Note au journal (incident…)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn secondary" type="submit">Noter</button>
            </form>
          </div>
        )}
      </div>

      {sheet.features.cart && sheet.sounds.length > 0 && (
        <section className="regie-cart" aria-label="Cartoucheur">
          {sheet.sounds.map((so) => (
            <button key={so.id} type="button" disabled={!so.available} className={`regie-pad${cart.playing.has(so.id) ? ' playing' : ''}`} style={so.color ? { borderColor: so.color } : undefined} onClick={() => cart.play(so)}>
              <span className="regie-key">{so.hotkey ?? ''}</span>{so.label}{so.loop && <span className="small"> ↻</span>}
            </button>
          ))}
          <button type="button" className="regie-pad stop" onClick={cart.stopAll}>■ Tout couper <span className="regie-key">Échap</span></button>
        </section>
      )}

      <ol className="regie-list">
        {visible.map((c) => {
          const i = index.get(c.id)!;
          const ci = run?.currentCueId ? index.get(run.currentCueId) ?? -1 : -1;
          const state = c.id === run?.currentCueId ? 'current' : c.id === standby?.id ? 'standby' : i < ci ? 'done' : '';
          return (
            <li key={c.id} className={`regie-row ${state}`} style={{ borderLeftColor: DEPTS[c.department].color }}>
              <span className="regie-num">{c.number ?? '—'}</span>
              <span className="regie-label">{c.label}<span className="small"> · {DEPTS[c.department].label}{c.trigger ? ` · ${c.trigger}` : ''}</span></span>
              {canOperate && run && state !== 'current' && <button type="button" className="btn ghost sm" onClick={() => send({ kind: 'jump', cueId: c.id })}>Aller ici</button>}
            </li>
          );
        })}
      </ol>

      {start && (
        <Modal open title="Démarrer une séance" onClose={() => setStart(null)} footer={<><button className="btn secondary" type="button" onClick={() => setStart(null)}>Annuler</button><button className="btn" type="button" onClick={begin}>Démarrer</button></>}>
          <div className="stack">
            <fieldset className="stack" style={{ gap: 4 }}>
              <legend className="small strong">Type</legend>
              <label className="check"><input type="radio" name="mode" checked={start.mode === 'rehearsal'} onChange={() => setStart({ ...start, mode: 'rehearsal' })} /> Répétition (la conduite reste modifiable)</label>
              <label className="check"><input type="radio" name="mode" checked={start.mode === 'show'} onChange={() => setStart({ ...start, mode: 'show' })} /> Représentation (conduite verrouillée pendant la séance)</label>
            </fieldset>
            {sheet.performances.length > 0 && (
              <Field label="Représentation">{(fid) => <select id={fid} value={start.performanceId} onChange={(e) => setStart({ ...start, performanceId: e.target.value })}><option value="">Aucune</option>{sheet.performances.filter((p) => p.status !== 'cancelled').map((p) => <option key={p.id} value={p.id}>{formatDate(p.startAt, true)}</option>)}</select>}</Field>
            )}
            <p className="small muted" style={{ margin: 0 }}>Raccourcis : Espace = GO, Retour arrière = top précédent, 1-9 = sons, Échap = couper les sons. En cas de coupure réseau, continuez : les actions seront transmises au retour du réseau.</p>
          </div>
        </Modal>
      )}
      {ending && (
        <Modal open title="Terminer la séance" onClose={() => setEnding(false)} footer={<><button className="btn secondary" type="button" onClick={() => setEnding(false)}>Annuler</button><button className="btn danger" type="button" onClick={end}>Terminer</button></>}>
          <Field label="Rapport (facultatif)">{(fid) => <textarea id={fid} rows={4} value={report} onChange={(e) => setReport(e.target.value)} placeholder="Déroulé, incidents, matériel à réparer…" />}</Field>
        </Modal>
      )}
    </div>
  );
}

