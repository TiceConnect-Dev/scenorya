import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, deleteWithConfirm, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';
import { MemberPicker } from '../asso/Groups';
import { Attachments } from '../drive/Drive';

/* --------------------------------------------------------------- Types */

type ShowStatus = 'draft' | 'announced' | 'running' | 'archived';
type PerfStatus = 'planned' | 'confirmed' | 'cancelled' | 'done';
interface ShowBase { id: string; title: string; subtitle: string | null; author: string | null; director: string | null; genre: string | null; durationMin: number | null; intermissionMin: number | null; ageMin: number | null; synopsis: string | null; status: ShowStatus }
interface ShowRow extends ShowBase { performances: number; upcoming: number; nextPerformance: string | null }
interface Venue { id: string; name: string; addressLine: string | null; postalCode: string | null; city: string | null; capacity: number | null; accessibility: string | null; notes: string | null }
interface Performance { id: string; startAt: string; endAt: string; doorsAt: string | null; status: PerfStatus; notes: string | null; capacity: number | null; eventId: string | null; venue: { id: string; name: string; city: string | null } | null; answers: Record<string, number> }
interface ShowDetail extends ShowBase {
  performances: Performance[];
  crew: { id: string; job: string; memberId: string; name: string }[];
  productions: { id: string; title: string; status: string; roles: { role: string; leads: string[] }[] }[];
  features: { agenda: boolean; cast: boolean; attachments: boolean };
}

export const SHOW_STATUS: Record<ShowStatus, [string, 'neutral' | 'info' | 'success' | 'warning']> = {
  draft: ['En création', 'neutral'], announced: ['Annoncé', 'info'], running: ['En tournée / à l’affiche', 'success'], archived: ['Archivé', 'warning'],
};
const PERF_STATUS: Record<PerfStatus, [string, 'neutral' | 'info' | 'success' | 'danger']> = {
  planned: ['Prévue', 'neutral'], confirmed: ['Confirmée', 'info'], done: ['Jouée', 'success'], cancelled: ['Annulée', 'danger'],
};
const JOBS = ['Régie générale', 'Régie lumière', 'Régie son', 'Régie plateau', 'Costumes', 'Maquillage', 'Accueil du public', 'Billetterie', 'Communication', 'Administration', 'Assistanat à la mise en scène'];
const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Show', to: '/show' }, ...extra, { label }];
const hm = (d: string) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(new Date(d));
const duration = (min: number | null) => (min == null ? '—' : min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`);
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ---------------------------------------------------------- Accueil */

export function ShowHome() {
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['show', 'shows'], queryFn: () => api.get<ShowRow[]>('/show/shows') });
  const cal = useQuery({ queryKey: ['show', 'calendar', false], queryFn: () => api.get<{ id: string; showId: string; show: string; startAt: string; status: PerfStatus; venue: string | null; capacity: number | null }[]>('/show/performances'), enabled: can('show.performances.read') });
  const [open, setOpen] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Show' }]} />
      <PageHead title="Spectacles" description="Répertoire de l’association, représentations, lieux et équipes." actions={can('show.shows.create') && <button className="btn" type="button" onClick={() => setOpen(true)}>Nouveau spectacle</button>} />
      {q.data!.length === 0 ? <div className="card empty">Aucun spectacle. Créez le premier pour programmer ses représentations.</div> : (
        <div className="grid-3">
          {q.data!.map((s) => (
            <Link key={s.id} to={`/show/spectacles/${s.id}`} className="card stack tile-link" style={{ gap: 8 }}>
              <div className="row between"><h2 style={{ margin: 0 }}>{s.title}</h2><Badge tone={SHOW_STATUS[s.status][1]}>{SHOW_STATUS[s.status][0]}</Badge></div>
              <span className="small muted">{[s.author, s.genre, s.durationMin && duration(s.durationMin)].filter(Boolean).join(' · ') || '—'}</span>
              <span className="small">{s.upcoming} représentation(s) à venir · {s.performances} au total</span>
              {s.nextPerformance && <span className="small">Prochaine : {formatDate(s.nextPerformance, true)}</span>}
            </Link>
          ))}
        </div>
      )}
      {!!cal.data?.length && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="row between"><h2 style={{ margin: 0 }}>Prochaines représentations</h2><Link to="/show/representations" className="small">Tout le calendrier</Link></div>
          <PerformanceTable rows={cal.data.slice(0, 8)} />
        </section>
      )}
      {open && <ShowForm onClose={() => setOpen(false)} onSaved={(id) => { toast('Spectacle créé.'); navigate(`/show/spectacles/${id}`); }} />}
    </>
  );
}

function PerformanceTable({ rows }: { rows: { id: string; showId: string; show: string; startAt: string; status: PerfStatus; venue: string | null; capacity: number | null }[] }) {
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table className="table">
        <thead><tr><th>Date</th><th>Spectacle</th><th>Lieu</th><th>Jauge</th><th>État</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small">{formatDate(r.startAt, true)}</td>
              <td><Link to={`/show/spectacles/${r.showId}`}>{r.show}</Link></td>
              <td className="small">{r.venue ?? '—'}</td>
              <td>{r.capacity ?? '—'}</td>
              <td><Badge tone={PERF_STATUS[r.status][1]}>{PERF_STATUS[r.status][0]}</Badge></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="empty">Aucune représentation.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function PerformancesPage() {
  const [past, setPast] = useState(false);
  const q = useQuery({ queryKey: ['show', 'calendar', past], queryFn: () => api.get<{ id: string; showId: string; show: string; startAt: string; status: PerfStatus; venue: string | null; capacity: number | null }[]>(`/show/performances${past ? '?past=1' : ''}`) });
  return (
    <>
      <Breadcrumb items={crumbs('Représentations')} />
      <PageHead title="Représentations" description="Toutes les dates, tous spectacles confondus." />
      <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={past} onChange={(e) => setPast(e.target.checked)} /> Afficher les représentations passées</label>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : <PerformanceTable rows={q.data!} />}
    </>
  );
}

function ShowForm({ initial, onClose, onSaved }: { initial?: ShowBase; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const n = (v: number | null | undefined) => (v == null ? '' : String(v));
  const [f, setF] = useState({
    title: initial?.title ?? '', subtitle: initial?.subtitle ?? '', author: initial?.author ?? '', director: initial?.director ?? '', genre: initial?.genre ?? '',
    durationMin: n(initial?.durationMin), intermissionMin: n(initial?.intermissionMin), ageMin: n(initial?.ageMin), synopsis: initial?.synopsis ?? '', status: initial?.status ?? 'draft',
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const t = (v: string) => v.trim() || null;
    const i = (v: string) => (v === '' ? null : Number(v));
    const body = { title: f.title, subtitle: t(f.subtitle), author: t(f.author), director: t(f.director), genre: t(f.genre), durationMin: i(f.durationMin), intermissionMin: i(f.intermissionMin), ageMin: i(f.ageMin), synopsis: t(f.synopsis), status: f.status };
    try {
      const s = initial ? await api.patch<{ id: string }>(`/show/shows/${initial.id}`, body) : await api.post<{ id: string }>('/show/shows', body);
      qc.invalidateQueries({ queryKey: ['show'] });
      onSaved(s.id);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal open title={initial ? 'Modifier le spectacle' : 'Nouveau spectacle'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="show-form">Enregistrer</button></>}>
      <form id="show-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Titre" className="full">{(id) => <input id={id} type="text" required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />}</Field>
        <Field label="Sous-titre" className="full">{(id) => <input id={id} type="text" value={f.subtitle} onChange={(e) => setF({ ...f, subtitle: e.target.value })} />}</Field>
        <Field label="Auteur">{(id) => <input id={id} type="text" value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} />}</Field>
        <Field label="Mise en scène">{(id) => <input id={id} type="text" value={f.director} onChange={(e) => setF({ ...f, director: e.target.value })} />}</Field>
        <Field label="Genre">{(id) => <input id={id} type="text" placeholder="Comédie, théâtre musical…" value={f.genre} onChange={(e) => setF({ ...f, genre: e.target.value })} />}</Field>
        <Field label="État">{(id) => <select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as ShowStatus })}>{Object.entries(SHOW_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        <Field label="Durée (minutes)">{(id) => <input id={id} type="number" min={0} max={1000} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} />}</Field>
        <Field label="Entracte (minutes)">{(id) => <input id={id} type="number" min={0} max={120} value={f.intermissionMin} onChange={(e) => setF({ ...f, intermissionMin: e.target.value })} />}</Field>
        <Field label="Âge minimum conseillé">{(id) => <input id={id} type="number" min={0} max={99} value={f.ageMin} onChange={(e) => setF({ ...f, ageMin: e.target.value })} />}</Field>
        <div />
        <Field label="Présentation" className="full">{(id) => <textarea id={id} rows={4} maxLength={8000} value={f.synopsis} onChange={(e) => setF({ ...f, synopsis: e.target.value })} />}</Field>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Spectacle */

export function ShowPage() {
  const { id = '' } = useParams();
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['show', 'show', id], queryFn: () => api.get<ShowDetail>(`/show/shows/${id}`) });
  const [tab, setTab] = useState<'dates' | 'equipe' | 'distribution' | 'documents' | 'presentation'>('dates');
  const [editing, setEditing] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  const refresh = () => qc.invalidateQueries({ queryKey: ['show'] });
  const tabs = [
    ['dates', `Représentations (${s.performances.length})`], ['equipe', `Équipe (${s.crew.length})`],
    ...(s.features.cast ? [['distribution', 'Distribution']] : []), ...(s.features.attachments && can('drive.files.read') ? [['documents', 'Documents']] : []), ['presentation', 'Présentation'],
  ] as [typeof tab, string][];
  return (
    <>
      <Breadcrumb items={crumbs(s.title)} />
      <PageHead
        title={s.title}
        description={[s.subtitle, s.author && `de ${s.author}`, s.director && `mise en scène ${s.director}`].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            <Badge tone={SHOW_STATUS[s.status][1]}>{SHOW_STATUS[s.status][0]}</Badge>
            {can('show.shows.download') && <button className="btn secondary" type="button" onClick={() => api.download(`/show/shows/${s.id}/sheet.pdf`, `fiche-${s.title}.pdf`).catch((e) => toast(errorMessage(e), 'error'))}>Fiche spectacle (PDF)</button>}
            {can('show.shows.update') && <button className="btn secondary" type="button" onClick={() => setEditing(true)}>Modifier</button>}
            {can('show.shows.delete') && <button className="btn danger" type="button" onClick={() => deleteWithConfirm(`/show/shows/${s.id}`, `Supprimer définitivement « ${s.title} », ses représentations (et leurs événements d’agenda) et son équipe ? Les distributions de Cast sont seulement détachées.`).then((r) => { if (r) { toast('Spectacle supprimé.'); refresh(); navigate('/show'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
          </>
        }
      />
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'dates' && <DatesTab s={s} refresh={refresh} />}
      {tab === 'equipe' && <CrewTab s={s} refresh={refresh} />}
      {tab === 'distribution' && <CastTab s={s} refresh={refresh} />}
      {tab === 'documents' && <Attachments module="show" entityType="show" entityId={s.id} />}
      {tab === 'presentation' && (
        <section className="card stack">
          <dl className="props">
            <dt>Durée</dt><dd>{duration(s.durationMin)}{s.intermissionMin ? ` (entracte de ${s.intermissionMin} min)` : ''}</dd>
            <dt>Genre</dt><dd>{s.genre ?? '—'}</dd>
            <dt>Public</dt><dd>{s.ageMin != null ? `à partir de ${s.ageMin} ans` : '—'}</dd>
          </dl>
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.synopsis || <span className="muted">Aucune présentation.</span>}</p>
        </section>
      )}
      {editing && <ShowForm initial={s} onClose={() => setEditing(false)} onSaved={() => toast('Spectacle enregistré.')} />}
    </>
  );
}

function DatesTab({ s, refresh }: { s: ShowDetail; refresh: () => void }) {
  const { can, toast } = useApp();
  const [form, setForm] = useState<Performance | 'new' | null>(null);
  const now = Date.now();
  return (
    <>
      {!s.features.agenda && <Alert>Activez Scenorya Agenda pour inscrire les représentations dans l’agenda de l’équipe et de la distribution.</Alert>}
      <div className="row between" style={{ margin: '8px 0' }}>
        <span className="small muted">La fin se calcule à partir de la durée du spectacle et de l’entracte.</span>
        {can('show.performances.create') && <button className="btn" type="button" onClick={() => setForm('new')}>Ajouter des dates</button>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>Lieu</th><th>Jauge</th><th>État</th>{s.features.agenda && <th>Réponses</th>}<th className="actions">Actions</th></tr></thead>
          <tbody>
            {s.performances.map((p) => (
              <tr key={p.id} style={new Date(p.endAt).getTime() < now ? { opacity: 0.7 } : undefined}>
                <td><strong>{formatDate(p.startAt, true)}</strong> → {hm(p.endAt)}{p.doorsAt && <div className="small muted">Accueil {hm(p.doorsAt)}</div>}{p.notes && <div className="small muted">{p.notes}</div>}</td>
                <td className="small">{p.venue ? [p.venue.name, p.venue.city].filter(Boolean).join(', ') : <em>À préciser</em>}</td>
                <td>{p.capacity ?? '—'}</td>
                <td><Badge tone={PERF_STATUS[p.status][1]}>{PERF_STATUS[p.status][0]}</Badge></td>
                {s.features.agenda && <td className="small">{p.answers.yes ?? 0} présent(s){p.answers.no ? `, ${p.answers.no} absent(s)` : ''}{p.answers.invited ? `, ${p.answers.invited} sans réponse` : ''}</td>}
                <td className="actions">
                  {can('show.performances.update') && <button type="button" className="btn ghost sm" onClick={() => setForm(p)}>Modifier</button>}
                  {can('show.performances.delete') && <button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm(`/show/performances/${p.id}`, `Supprimer la représentation du ${formatDate(p.startAt, true)} ? (Pour garder une trace, préférez l’état « Annulée ».)`).then((r) => { if (r) { toast('Représentation supprimée.'); refresh(); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
                </td>
              </tr>
            ))}
            {!s.performances.length && <tr><td colSpan={6} className="empty">Aucune représentation programmée.</td></tr>}
          </tbody>
        </table>
      </div>
      {form && <PerformanceForm s={s} initial={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={refresh} />}
    </>
  );
}

function PerformanceForm({ s, initial, onClose, onSaved }: { s: ShowDetail; initial: Performance | null; onClose: () => void; onSaved: () => void }) {
  const { can, toast } = useApp();
  const venues = useQuery({ queryKey: ['show', 'venues'], queryFn: () => api.get<Venue[]>('/show/venues') });
  const next = new Date(Date.now() + 7 * 86_400_000);
  next.setHours(20, 30, 0, 0);
  const [dates, setDates] = useState<string[]>(initial ? [localInput(new Date(initial.startAt))] : [localInput(next)]);
  const [f, setF] = useState({
    venueId: initial?.venue?.id ?? '', status: initial?.status ?? 'planned' as PerfStatus, notes: initial?.notes ?? '',
    capacity: initial?.capacity != null ? String(initial.capacity) : '', doors: initial?.doorsAt ? hm(initial.doorsAt) : '',
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const starts = dates.filter(Boolean).map((d) => new Date(d));
    const doorsFor = (start: Date) => {
      if (!f.doors) return null;
      const [h, m] = f.doors.split(':').map(Number);
      const d = new Date(start);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    const common = { venueId: f.venueId || null, status: f.status, notes: f.notes || null, capacity: f.capacity === '' ? null : Number(f.capacity) };
    try {
      if (initial) await api.patch(`/show/performances/${initial.id}`, { ...common, startAt: starts[0].toISOString(), doorsAt: doorsFor(starts[0]) });
      else await api.post(`/show/shows/${s.id}/performances`, { ...common, startAts: starts.map((d) => d.toISOString()), doorsAt: starts.length === 1 ? doorsFor(starts[0]) : null });
      toast(initial ? 'Représentation modifiée.' : `${starts.length} représentation(s) ajoutée(s).`);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal open title={initial ? 'Modifier la représentation' : 'Ajouter des dates'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="perf-form">Enregistrer</button></>}>
      <form id="perf-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <fieldset className="full stack" style={{ gap: 6 }}>
          <legend className="small strong">{initial ? 'Date et heure' : 'Dates et heures (une ligne par représentation)'}</legend>
          {dates.map((d, i) => (
            <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
              <label className="sr-only" htmlFor={`perf-date-${i}`}>Représentation {i + 1}</label>
              <input id={`perf-date-${i}`} style={{ flex: 1, minWidth: 0 }} type="datetime-local" required value={d} onChange={(e) => setDates(dates.map((x, j) => (j === i ? e.target.value : x)))} />
              {dates.length > 1 && <button type="button" className="btn ghost sm" aria-label="Retirer cette date" onClick={() => setDates(dates.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {!initial && <div><button type="button" className="btn ghost sm" onClick={() => { const last = new Date(dates[dates.length - 1] || Date.now()); last.setDate(last.getDate() + 1); setDates([...dates, localInput(last)]); }}>+ Ajouter une date (lendemain)</button></div>}
        </fieldset>
        <Field label="Lieu" hint={can('show.venues.update') ? 'Gérez la liste dans « Lieux ».' : undefined}>{(id, db) => (
          <select id={id} aria-describedby={db} value={f.venueId} onChange={(e) => setF({ ...f, venueId: e.target.value })}>
            <option value="">À préciser</option>
            {venues.data?.map((v) => <option key={v.id} value={v.id}>{[v.name, v.city].filter(Boolean).join(', ')}</option>)}
          </select>
        )}</Field>
        <Field label="État">{(id) => <select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as PerfStatus })}>{Object.entries(PERF_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        <Field label="Jauge" hint="Vide : celle du lieu">{(id, db) => <input id={id} aria-describedby={db} type="number" min={0} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />}</Field>
        <Field label="Accueil du public" hint="Ouverture des portes (facultatif)">{(id, db) => <input id={id} aria-describedby={db} type="time" value={f.doors} onChange={(e) => setF({ ...f, doors: e.target.value })} />}</Field>
        <Field label="Notes" className="full">{(id) => <input id={id} type="text" maxLength={2000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Ex. : séance scolaire" />}</Field>
      </form>
    </Modal>
  );
}

function CrewTab({ s, refresh }: { s: ShowDetail; refresh: () => void }) {
  const { can, toast } = useApp();
  const edit = can('show.shows.update');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([]);
  const [job, setJob] = useState('');
  const byJob = new Map<string, ShowDetail['crew']>();
  for (const m of s.crew) byJob.set(m.job, [...(byJob.get(m.job) ?? []), m]);
  const add = async () => {
    try {
      await api.post(`/show/shows/${s.id}/crew`, { memberIds: picked.map((p) => p.id), job });
      toast('Équipe mise à jour.');
      setOpen(false);
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <div className="row between" style={{ margin: '8px 0' }}>
        <span className="small muted">L’équipe est convoquée à chaque représentation{s.features.agenda ? ' dans l’agenda' : ''}.</span>
        {edit && <button className="btn" type="button" onClick={() => { setPicked([]); setJob(''); setOpen(true); }}>Ajouter à l’équipe</button>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Fonction</th><th>Personnes</th></tr></thead>
          <tbody>
            {[...byJob.entries()].map(([j, list]) => (
              <tr key={j}>
                <td><strong>{j}</strong></td>
                <td><div className="cast-chips">{list.map((m) => (
                  <span key={m.id} className="cast-chip">
                    <Link to={`/asso/adherents/${m.memberId}`}>{m.name}</Link>
                    {edit && <button type="button" className="cast-chip-x" aria-label={`Retirer ${m.name}`} onClick={() => deleteWithConfirm(`/show/crew/${m.id}`, `Retirer ${m.name} (${j}) de l’équipe ?`).then((r) => { if (r) refresh(); }, (e) => toast(errorMessage(e), 'error'))}>✕</button>}
                  </span>
                ))}</div></td>
              </tr>
            ))}
            {!s.crew.length && <tr><td colSpan={2} className="empty">Aucun membre d’équipe.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && (
        <Modal open title="Ajouter à l’équipe" onClose={() => setOpen(false)} footer={<><button className="btn secondary" type="button" onClick={() => setOpen(false)}>Annuler</button><button className="btn" type="button" disabled={!picked.length || !job.trim()} onClick={add}>Ajouter</button></>}>
          <div className="stack">
            <Field label="Fonction">{(id) => <><input id={id} type="text" list="show-jobs" maxLength={80} value={job} onChange={(e) => setJob(e.target.value)} /><datalist id="show-jobs">{JOBS.map((j) => <option key={j} value={j} />)}</datalist></>}</Field>
            <MemberPicker value={picked} onChange={setPicked} />
          </div>
        </Modal>
      )}
    </>
  );
}

function CastTab({ s, refresh }: { s: ShowDetail; refresh: () => void }) {
  const { can, toast } = useApp();
  const edit = can('show.shows.update');
  const linkable = useQuery({ queryKey: ['show', 'linkable'], queryFn: () => api.get<{ id: string; title: string; showId: string | null }[]>('/show/linkable-productions'), enabled: edit });
  const [pick, setPick] = useState('');
  const free = (linkable.data ?? []).filter((p) => p.showId !== s.id);
  const run = (fn: () => Promise<unknown>, ok: string) => fn().then(() => { toast(ok); refresh(); setPick(''); }, (e) => toast(errorMessage(e), 'error'));
  return (
    <>
      <p className="small muted">Les titulaires confirmés des distributions rattachées sont convoqués aux représentations. La distribution se gère dans Scenorya Cast.</p>
      {s.productions.map((p) => (
        <section key={p.id} className="card" style={{ marginBottom: 12 }}>
          <div className="row between">
            <h2 style={{ margin: 0, fontSize: '1.05rem' }}><Link to={`/cast/productions/${p.id}`}>{p.title}</Link></h2>
            {edit && <button type="button" className="btn ghost sm" onClick={() => run(() => api.delete(`/show/shows/${s.id}/productions/${p.id}`), 'Distribution détachée.')}>Détacher</button>}
          </div>
          <dl className="props" style={{ marginTop: 8 }}>
            {p.roles.map((r, i) => <div key={i} style={{ display: 'contents' }}><dt>{r.role}</dt><dd>{r.leads.join(', ') || <span className="muted">non distribué</span>}</dd></div>)}
          </dl>
        </section>
      ))}
      {!s.productions.length && <div className="card empty">Aucune distribution rattachée.</div>}
      {edit && free.length > 0 && (
        <div className="toolbar" style={{ marginTop: 12 }}>
          <Field label="Rattacher une distribution de Cast">{(id) => (
            <select id={id} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choisir…</option>
              {free.map((p) => <option key={p.id} value={p.id}>{p.title}{p.showId ? ' (déjà rattachée à un autre spectacle)' : ''}</option>)}
            </select>
          )}</Field>
          <button className="btn secondary" type="button" disabled={!pick} onClick={() => run(() => api.post(`/show/shows/${s.id}/productions/${pick}`), 'Distribution rattachée.')}>Rattacher</button>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- Lieux */

export function VenuesPage() {
  const { can, toast } = useApp();
  const q = useQuery({ queryKey: ['show', 'venues'], queryFn: () => api.get<Venue[]>('/show/venues') });
  const [form, setForm] = useState<Venue | 'new' | null>(null);
  const edit = can('show.venues.update');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <Breadcrumb items={crumbs('Lieux')} />
      <PageHead title="Lieux de représentation" description="Salles et lieux où se jouent les spectacles." actions={edit && <button className="btn" type="button" onClick={() => setForm('new')}>Nouveau lieu</button>} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Lieu</th><th>Adresse</th><th>Jauge</th><th>Accessibilité</th>{edit && <th className="actions">Actions</th>}</tr></thead>
          <tbody>
            {q.data!.map((v) => (
              <tr key={v.id}>
                <td><strong>{v.name}</strong>{v.notes && <div className="small muted">{v.notes}</div>}</td>
                <td className="small">{[v.addressLine, [v.postalCode, v.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'}</td>
                <td>{v.capacity ?? '—'}</td>
                <td className="small">{v.accessibility ?? '—'}</td>
                {edit && (
                  <td className="actions">
                    <button type="button" className="btn ghost sm" onClick={() => setForm(v)}>Modifier</button>
                    <button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm<{ performances: number }>(`/show/venues/${v.id}`, `Supprimer le lieu « ${v.name} » ? Les représentations prévues là passeront en lieu « à préciser ».`).then((r) => { if (r) { toast(`Lieu supprimé${r.performances ? ` (${r.performances} représentation(s) à préciser)` : ''}.`); q.refetch(); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>
                  </td>
                )}
              </tr>
            ))}
            {!q.data!.length && <tr><td colSpan={5} className="empty">Aucun lieu.</td></tr>}
          </tbody>
        </table>
      </div>
      {form && <VenueForm initial={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={() => { toast('Lieu enregistré.'); q.refetch(); }} />}
    </>
  );
}

function VenueForm({ initial, onClose, onSaved }: { initial: Venue | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: initial?.name ?? '', addressLine: initial?.addressLine ?? '', postalCode: initial?.postalCode ?? '', city: initial?.city ?? '', capacity: initial?.capacity != null ? String(initial.capacity) : '', accessibility: initial?.accessibility ?? '', notes: initial?.notes ?? '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const t = (v: string) => v.trim() || null;
    const body = { name: f.name, addressLine: t(f.addressLine), postalCode: t(f.postalCode), city: t(f.city), capacity: f.capacity === '' ? null : Number(f.capacity), accessibility: t(f.accessibility), notes: t(f.notes) };
    try {
      if (initial) await api.patch(`/show/venues/${initial.id}`, body);
      else await api.post('/show/venues', body);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal open title={initial ? 'Modifier le lieu' : 'Nouveau lieu'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="venue-form">Enregistrer</button></>}>
      <form id="venue-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Nom" className="full">{(id) => <input id={id} type="text" required maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />}</Field>
        <Field label="Adresse" className="full">{(id) => <input id={id} type="text" value={f.addressLine} onChange={(e) => setF({ ...f, addressLine: e.target.value })} />}</Field>
        <Field label="Code postal">{(id) => <input id={id} type="text" maxLength={12} value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} />}</Field>
        <Field label="Ville">{(id) => <input id={id} type="text" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
        <Field label="Jauge">{(id) => <input id={id} type="number" min={0} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />}</Field>
        <Field label="Accessibilité">{(id) => <input id={id} type="text" placeholder="PMR, boucle magnétique…" value={f.accessibility} onChange={(e) => setF({ ...f, accessibility: e.target.value })} />}</Field>
        <Field label="Notes" className="full">{(id) => <textarea id={id} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Espace */

export function EspaceShows() {
  const q = useQuery({ queryKey: ['espace', 'show'], queryFn: () => api.get<{ id: string; show: string; startAt: string; endAt: string; doorsAt: string | null; venue: string | null; jobs: string[] }[]>('/espace/show') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <Breadcrumb items={[{ label: 'Mon espace', to: '/espace' }, { label: 'Mes représentations' }]} />
      <PageHead title="Mes représentations" description="Les dates où vous êtes attendu(e), comme comédien(ne) ou dans l’équipe." />
      <div className="stack">
        {q.data!.map((p) => (
          <article key={p.id} className="card">
            <div className="small muted">{formatDate(p.startAt, true)} → {hm(p.endAt)}{p.doorsAt ? ` · accueil ${hm(p.doorsAt)}` : ''}</div>
            <div className="strong" style={{ fontSize: '1.05rem' }}>{p.show}</div>
            <div className="small">{p.venue ?? 'Lieu à préciser'} — {p.jobs.join(', ')}</div>
          </article>
        ))}
        {!q.data!.length && <div className="card empty">Aucune représentation prévue pour vous.</div>}
        <p className="small muted" style={{ margin: 0 }}>Indiquez votre présence depuis <Link to="/espace/agenda">Mon agenda</Link>.</p>
      </div>
    </>
  );
}
