import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, deleteWithConfirm, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';
import { MemberPicker } from '../asso/Groups';

/* --------------------------------------------------------------- Types */

type Status = 'preparation' | 'rehearsal' | 'running' | 'closed';
type Category = 'main' | 'secondary' | 'ensemble';
interface ProductionRow { id: string; title: string; author: string | null; season: string | null; status: Status; premiereDate: string | null; description: string | null; roles: number; castRoles: number; scenes: number; nextRehearsal: string | null }
interface Assignment { id: string; kind: 'lead' | 'understudy'; status: 'considered' | 'confirmed'; note: string | null; member: { id: string; name: string; number: number; archived: boolean } }
interface Role { id: string; name: string; description: string | null; category: Category; position: number; assignments: Assignment[]; scenes: number }
interface Scene { id: string; act: number | null; number: number | null; title: string; durationMin: number | null; label: string; roleIds: string[] }
interface RehearsalRow { id: string; title: string | null; startAt: string; endAt: string; location: string | null; sceneIds: string[]; includeUnderstudies: boolean; notes: string | null; eventId: string | null; scenes: string[] }
interface Production extends Omit<ProductionRow, 'roles' | 'castRoles' | 'scenes' | 'nextRehearsal'> { roles: Role[]; scenes: Scene[]; rehearsals: RehearsalRow[]; agendaCalls: boolean }
interface Call { memberId: string; name: string; phone: string | null; roles: string[]; understudy: boolean; conflicts: string[]; response?: string | null; comment?: string | null }

export const CAST_STATUS: Record<Status, [string, 'info' | 'warning' | 'success' | 'neutral']> = {
  preparation: ['En préparation', 'info'], rehearsal: ['En répétition', 'warning'], running: ['À l’affiche', 'success'], closed: ['Terminée', 'neutral'],
};
const CATEGORY: Record<Category, string> = { main: 'Principal', secondary: 'Secondaire', ensemble: 'Ensemble' };
const RESPONSE: Record<string, [string, 'success' | 'danger' | 'warning' | 'neutral']> = { yes: ['Présent', 'success'], no: ['Absent', 'danger'], maybe: ['Incertain', 'warning'], invited: ['Sans réponse', 'neutral'] };
const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Cast', to: '/cast' }, ...extra, { label }];
const hm = (d: string) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(new Date(d));
const ymd = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(d);

/* ---------------------------------------------------------- Accueil : productions */

export function CastHome() {
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['cast', 'productions'], queryFn: () => api.get<ProductionRow[]>('/cast/productions') });
  const next = useQuery({ queryKey: ['cast', 'planning'], queryFn: () => api.get<{ id: string; productionId: string; production: string; title: string | null; startAt: string; endAt: string; location: string | null; calls: number }[]>('/cast/rehearsals'), enabled: can('cast.rehearsals.read') });
  const [open, setOpen] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Cast' }]} />
      <PageHead title="Productions" description="Pièces en préparation : rôles, distribution, scènes et répétitions." actions={can('cast.productions.create') && <button className="btn" type="button" onClick={() => setOpen(true)}>Nouvelle production</button>} />
      {q.data!.length === 0 ? <div className="card empty">Aucune production. Créez la première pour distribuer les rôles.</div> : (
        <div className="grid-3">
          {q.data!.map((p) => (
            <Link key={p.id} to={`/cast/productions/${p.id}`} className="card stack tile-link" style={{ gap: 8 }}>
              <div className="row between"><h2 style={{ margin: 0 }}>{p.title}</h2><Badge tone={CAST_STATUS[p.status][1]}>{CAST_STATUS[p.status][0]}</Badge></div>
              <span className="small muted">{[p.author, p.season].filter(Boolean).join(' · ') || '—'}</span>
              <span className="small">{p.castRoles}/{p.roles} rôle(s) distribué(s) · {p.scenes} scène(s)</span>
              {p.nextRehearsal && <span className="small">Prochaine répétition : {formatDate(p.nextRehearsal, true)}</span>}
            </Link>
          ))}
        </div>
      )}
      {!!next.data?.length && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Prochaines répétitions</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Production</th><th>Lieu</th><th>Convoqués</th></tr></thead>
              <tbody>
                {next.data.slice(0, 10).map((r) => (
                  <tr key={r.id}>
                    <td className="small">{formatDate(r.startAt, true)} → {hm(r.endAt)}</td>
                    <td><Link to={`/cast/productions/${r.productionId}?onglet=repetitions`}>{r.title || r.production}</Link></td>
                    <td className="small">{r.location ?? '—'}</td>
                    <td>{r.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {open && <ProductionForm onClose={() => setOpen(false)} onSaved={(id) => { toast('Production créée.'); navigate(`/cast/productions/${id}`); }} />}
    </>
  );
}

function ProductionForm({ initial, onClose, onSaved }: { initial?: Production; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ title: initial?.title ?? '', author: initial?.author ?? '', season: initial?.season ?? '', status: initial?.status ?? 'preparation', premiereDate: initial?.premiereDate ?? '', description: initial?.description ?? '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = { ...f, author: f.author || null, season: f.season || null, description: f.description || null, premiereDate: f.premiereDate || null };
    try {
      const p = initial ? await api.patch<{ id: string }>(`/cast/productions/${initial.id}`, body) : await api.post<{ id: string }>('/cast/productions', body);
      qc.invalidateQueries({ queryKey: ['cast'] });
      onSaved(p.id);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal open title={initial ? 'Modifier la production' : 'Nouvelle production'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="prod-form">Enregistrer</button></>}>
      <form id="prod-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Titre" className="full">{(id) => <input id={id} type="text" required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />}</Field>
        <Field label="Auteur">{(id) => <input id={id} type="text" value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} />}</Field>
        <Field label="Saison">{(id) => <input id={id} type="text" placeholder="2026-2027" value={f.season} onChange={(e) => setF({ ...f, season: e.target.value })} />}</Field>
        <Field label="État">{(id) => <select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Status })}>{Object.entries(CAST_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        <Field label="Première">{(id) => <input id={id} type="date" value={f.premiereDate} onChange={(e) => setF({ ...f, premiereDate: e.target.value })} />}</Field>
        <Field label="Notes" className="full">{(id) => <textarea id={id} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Production */

export function ProductionPage() {
  const { id = '' } = useParams();
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['cast', 'production', id], queryFn: () => api.get<Production>(`/cast/productions/${id}`) });
  const [tab, setTab] = useState<'distribution' | 'scenes' | 'repetitions'>(() => (new URLSearchParams(location.search).get('onglet') === 'repetitions' ? 'repetitions' : 'distribution'));
  const [editing, setEditing] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const p = q.data!;
  const refresh = () => qc.invalidateQueries({ queryKey: ['cast'] });
  const remove = () => deleteWithConfirm<{ roles: number; rehearsals: number }>(`/cast/productions/${p.id}`, `Supprimer définitivement « ${p.title} » : rôles, distribution, scènes et répétitions (avec leurs événements d’agenda) ?`)
    .then((r) => { if (r) { toast('Production supprimée.'); refresh(); navigate('/cast'); } }, (e) => toast(errorMessage(e), 'error'));
  return (
    <>
      <Breadcrumb items={crumbs(p.title)} />
      <PageHead
        title={p.title}
        description={[p.author, p.season, p.premiereDate && `première le ${formatDate(p.premiereDate)}`].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            <Badge tone={CAST_STATUS[p.status][1]}>{CAST_STATUS[p.status][0]}</Badge>
            {can('cast.productions.download') && <button className="btn secondary" type="button" onClick={() => api.download(`/cast/productions/${p.id}/distribution.pdf`, `distribution-${p.title}.pdf`).catch((e) => toast(errorMessage(e), 'error'))}>Distribution (PDF)</button>}
            {can('cast.productions.update') && <button className="btn secondary" type="button" onClick={() => setEditing(true)}>Modifier</button>}
            {can('cast.productions.delete') && <button className="btn danger" type="button" onClick={remove}>Supprimer</button>}
          </>
        }
      />
      <div className="tabs" role="tablist">
        {([['distribution', `Distribution (${p.roles.length})`], ['scenes', `Scènes (${p.scenes.length})`], ['repetitions', `Répétitions (${p.rehearsals.length})`]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'distribution' && <DistributionTab p={p} refresh={refresh} />}
      {tab === 'scenes' && <ScenesTab p={p} refresh={refresh} />}
      {tab === 'repetitions' && <RehearsalsTab p={p} refresh={refresh} />}
      {editing && <ProductionForm initial={p} onClose={() => setEditing(false)} onSaved={() => toast('Production enregistrée.')} />}
    </>
  );
}

function DistributionTab({ p, refresh }: { p: Production; refresh: () => void }) {
  const { can, toast } = useApp();
  const edit = can('cast.productions.update');
  const [role, setRole] = useState({ name: '', category: 'main' as Category });
  const [assign, setAssign] = useState<{ role: Role; kind: 'lead' | 'understudy' } | null>(null);
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([]);
  const [considered, setConsidered] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const addRole = (e: FormEvent) => {
    e.preventDefault();
    if (!role.name.trim()) return;
    void run(() => api.post(`/cast/productions/${p.id}/roles`, role), 'Rôle ajouté.').then(() => setRole({ name: '', category: role.category }));
  };
  const saveAssign = async () => {
    if (!assign) return;
    for (const m of picked) await run(() => api.post(`/cast/roles/${assign.role.id}/assignments`, { memberId: m.id, kind: assign.kind, status: considered ? 'considered' : 'confirmed' }));
    toast('Distribution enregistrée.');
    setAssign(null);
  };
  const chip = (a: Assignment) => (
    <span key={a.id} className={`cast-chip${a.status === 'considered' ? ' considered' : ''}`}>
      <Link to={`/asso/adherents/${a.member.id}`}>{a.member.name}</Link>
      {a.status === 'considered' && <span className="small"> (pressenti)</span>}
      {edit && a.status === 'considered' && <button type="button" className="link-btn small" onClick={() => run(() => api.patch(`/cast/assignments/${a.id}`, { status: 'confirmed' }), 'Confirmé.')}>confirmer</button>}
      {edit && <button type="button" className="cast-chip-x" aria-label={`Retirer ${a.member.name}`} onClick={() => run(() => api.delete(`/cast/assignments/${a.id}`), 'Retiré de la distribution.')}>✕</button>}
    </span>
  );
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Rôle</th><th>Titulaire(s)</th><th>Doublure(s)</th><th>Scènes</th>{edit && <th className="actions">Actions</th>}</tr></thead>
          <tbody>
            {p.roles.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.name}</strong><div className="small muted">{CATEGORY[r.category]}</div></td>
                <td><div className="cast-chips">{r.assignments.filter((a) => a.kind === 'lead').map(chip)}{edit && <button type="button" className="btn ghost sm" onClick={() => { setPicked([]); setConsidered(false); setAssign({ role: r, kind: 'lead' }); }}>+ Titulaire</button>}</div></td>
                <td><div className="cast-chips">{r.assignments.filter((a) => a.kind === 'understudy').map(chip)}{edit && <button type="button" className="btn ghost sm" onClick={() => { setPicked([]); setConsidered(false); setAssign({ role: r, kind: 'understudy' }); }}>+ Doublure</button>}</div></td>
                <td>{r.scenes}</td>
                {edit && (
                  <td className="actions">
                    <button type="button" className="btn ghost sm" onClick={() => { const n = window.prompt('Nom du rôle :', r.name); if (n && n.trim() && n !== r.name) void run(() => api.patch(`/cast/roles/${r.id}`, { name: n.trim() }), 'Rôle renommé.'); }}>Renommer</button>
                    <button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm(`/cast/roles/${r.id}`, `Supprimer le rôle « ${r.name} » et sa distribution ?`).then((x) => { if (x) { toast('Rôle supprimé.'); refresh(); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>
                  </td>
                )}
              </tr>
            ))}
            {!p.roles.length && <tr><td colSpan={5} className="empty">Aucun rôle. Ajoutez les personnages de la pièce.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <form className="toolbar" style={{ marginTop: 12 }} onSubmit={addRole}>
          <Field label="Nouveau rôle">{(id) => <input id={id} type="text" maxLength={120} value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} placeholder="Ex. : Dorine" />}</Field>
          <Field label="Catégorie">{(id) => <select id={id} value={role.category} onChange={(e) => setRole({ ...role, category: e.target.value as Category })}>{Object.entries(CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
          <button className="btn secondary" type="submit">Ajouter le rôle</button>
        </form>
      )}
      {assign && (
        <Modal open title={`${assign.kind === 'lead' ? 'Titulaire' : 'Doublure'} — ${assign.role.name}`} onClose={() => setAssign(null)} footer={<><button className="btn secondary" type="button" onClick={() => setAssign(null)}>Annuler</button><button className="btn" type="button" disabled={!picked.length} onClick={saveAssign}>Distribuer</button></>}>
          <div className="stack">
            <MemberPicker value={picked} onChange={setPicked} />
            <label className="check"><input type="checkbox" checked={considered} onChange={(e) => setConsidered(e.target.checked)} /> Pressenti(e) seulement (pas encore confirmé : non convoqué aux répétitions)</label>
          </div>
        </Modal>
      )}
    </>
  );
}

function ScenesTab({ p, refresh }: { p: Production; refresh: () => void }) {
  const { can, toast } = useApp();
  const edit = can('cast.productions.update');
  const [f, setF] = useState({ act: '', number: '', title: '' });
  const toggle = async (s: Scene, roleId: string, present: boolean) => {
    try {
      await api.put(`/cast/scenes/${s.id}/roles/${roleId}`, { present });
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    try {
      await api.post(`/cast/productions/${p.id}/scenes`, { title: f.title, act: f.act ? Number(f.act) : null, number: f.number ? Number(f.number) : null });
      setF({ act: f.act, number: f.number ? String(Number(f.number) + 1) : '', title: '' });
      refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <>
      <p className="small muted">Cochez les personnages présents dans chaque scène : les convocations de répétition en découlent.</p>
      <div className="table-wrap">
        <table className="table cast-matrix">
          <thead>
            <tr><th>Scène</th>{p.roles.map((r) => <th key={r.id} className="center"><span className="vertical">{r.name}</span></th>)}{edit && <th className="actions">Actions</th>}</tr>
          </thead>
          <tbody>
            {p.scenes.map((s) => (
              <tr key={s.id}>
                <td>{s.label}</td>
                {p.roles.map((r) => (
                  <td key={r.id} className="center">
                    <input type="checkbox" aria-label={`${r.name} dans ${s.label}`} checked={s.roleIds.includes(r.id)} disabled={!edit} onChange={(e) => toggle(s, r.id, e.target.checked)} />
                  </td>
                ))}
                {edit && <td className="actions"><button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm(`/cast/scenes/${s.id}`, `Supprimer la scène « ${s.label} » ? Elle sera retirée des répétitions prévues.`).then((x) => { if (x) { toast('Scène supprimée.'); refresh(); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button></td>}
              </tr>
            ))}
            {!p.scenes.length && <tr><td colSpan={p.roles.length + 2} className="empty">Aucune scène. Découpez la pièce pour planifier les répétitions par scène.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <form className="toolbar" style={{ marginTop: 12 }} onSubmit={add}>
          <Field label="Acte">{(id) => <input id={id} type="number" min={0} max={99} style={{ width: 90 }} value={f.act} onChange={(e) => setF({ ...f, act: e.target.value })} />}</Field>
          <Field label="Scène n°">{(id) => <input id={id} type="number" min={0} max={999} style={{ width: 90 }} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />}</Field>
          <Field label="Titre de la scène">{(id) => <input id={id} type="text" maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex. : La déclaration" />}</Field>
          <button className="btn secondary" type="submit">Ajouter la scène</button>
        </form>
      )}
    </>
  );
}

function RehearsalsTab({ p, refresh }: { p: Production; refresh: () => void }) {
  const { can } = useApp();
  const [form, setForm] = useState<RehearsalRow | 'new' | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const now = Date.now();
  const upcoming = p.rehearsals.filter((r) => new Date(r.endAt).getTime() >= now);
  const past = p.rehearsals.filter((r) => new Date(r.endAt).getTime() < now).reverse();
  const row = (r: RehearsalRow) => (
    <tr key={r.id}>
      <td><button type="button" className="link-btn strong" onClick={() => setDetail(r.id)}>{formatDate(r.startAt, true)} → {hm(r.endAt)}</button>{r.title && <div className="small muted">{r.title}</div>}</td>
      <td className="small">{r.scenes.length ? r.scenes.join(' ; ') : <em>Filage</em>}</td>
      <td className="small">{r.location ?? '—'}</td>
    </tr>
  );
  return (
    <>
      {!p.agendaCalls && <Alert>Activez Scenorya Agenda pour que chaque répétition apparaisse dans l’agenda des comédiens convoqués, qui pourront y répondre.</Alert>}
      <div className="row between" style={{ margin: '8px 0' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>À venir</h2>
        {can('cast.rehearsals.create') && <button className="btn" type="button" onClick={() => setForm('new')}>Planifier une répétition</button>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>Travail</th><th>Lieu</th></tr></thead>
          <tbody>{upcoming.map(row)}{!upcoming.length && <tr><td colSpan={3} className="empty">Aucune répétition prévue.</td></tr>}</tbody>
        </table>
      </div>
      {past.length > 0 && (
        <>
          <h2 style={{ fontSize: '1.1rem', marginTop: 20 }}>Passées</h2>
          <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Travail</th><th>Lieu</th></tr></thead><tbody>{past.map(row)}</tbody></table></div>
        </>
      )}
      {form && <RehearsalForm p={p} initial={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={refresh} />}
      {detail && <RehearsalDetail id={detail} onClose={() => setDetail(null)} onEdit={(r) => { setDetail(null); setForm(r); }} onChanged={refresh} />}
    </>
  );
}

function RehearsalForm({ p, initial, onClose, onSaved }: { p: Production; initial: RehearsalRow | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));
  const [f, setF] = useState({
    date: initial ? ymd(new Date(initial.startAt)) : tomorrow, start: initial ? hm(initial.startAt) : '19:00', end: initial ? hm(initial.endAt) : '22:00',
    title: initial?.title ?? '', location: initial?.location ?? '', sceneIds: initial?.sceneIds ?? [], includeUnderstudies: initial?.includeUnderstudies ?? false, notes: initial?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  // Heure de Paris : on laisse le navigateur convertir (même fuseau attendu pour une troupe française).
  const iso = (d: string, t: string) => new Date(`${d}T${t}:00`).toISOString();
  const body = useMemo(() => ({
    title: f.title || null, location: f.location || null, notes: f.notes || null, sceneIds: f.sceneIds, includeUnderstudies: f.includeUnderstudies,
    startAt: iso(f.date, f.start), endAt: iso(f.date, f.end),
  }), [f]);
  const preview = useQuery({
    queryKey: ['cast', 'preview', p.id, body, initial?.id],
    queryFn: () => api.post<{ calls: Call[] }>(`/cast/productions/${p.id}/rehearsals/preview`, { ...body, rehearsalId: initial?.id }),
    enabled: f.end > f.start,
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (initial) await api.patch(`/cast/rehearsals/${initial.id}`, body);
      else await api.post(`/cast/productions/${p.id}/rehearsals`, body);
      toast(initial ? 'Répétition modifiée.' : 'Répétition planifiée.');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const allScenes = f.sceneIds.length === 0;
  return (
    <Modal open title={initial ? 'Modifier la répétition' : 'Planifier une répétition'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="reh-form">Enregistrer</button></>}>
      <form id="reh-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Date">{(id) => <input id={id} type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        <Field label="Lieu">{(id) => <input id={id} type="text" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />}</Field>
        <Field label="Début">{(id) => <input id={id} type="time" required value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />}</Field>
        <Field label="Fin">{(id) => <input id={id} type="time" required value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />}</Field>
        <fieldset className="full stack" style={{ gap: 4 }}>
          <legend className="small strong">Travail prévu</legend>
          <label className="check"><input type="checkbox" checked={allScenes} onChange={() => setF({ ...f, sceneIds: allScenes ? p.scenes.slice(0, 1).map((s) => s.id) : [] })} /> Filage (toute la pièce)</label>
          {!allScenes && p.scenes.map((s) => (
            <label key={s.id} className="check"><input type="checkbox" checked={f.sceneIds.includes(s.id)} onChange={(e) => setF({ ...f, sceneIds: e.target.checked ? [...f.sceneIds, s.id] : f.sceneIds.filter((x) => x !== s.id) })} /> {s.label}</label>
          ))}
        </fieldset>
        <label className="check full"><input type="checkbox" checked={f.includeUnderstudies} onChange={(e) => setF({ ...f, includeUnderstudies: e.target.checked })} /> Convoquer aussi les doublures</label>
        <Field label="Consignes (facultatif)" className="full">{(id) => <textarea id={id} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Texte su, costumes…" />}</Field>
        <div className="full">
          <h3 style={{ fontSize: '1rem', margin: '4px 0' }}>Convoqués ({preview.data?.calls.length ?? '…'})</h3>
          {preview.data && <CallList calls={preview.data.calls} />}
        </div>
      </form>
    </Modal>
  );
}

function CallList({ calls, responses = false }: { calls: Call[]; responses?: boolean }) {
  if (!calls.length) return <p className="small muted">Personne : aucun titulaire confirmé dans les scènes choisies.</p>;
  return (
    <ul className="call-list">
      {calls.map((k) => (
        <li key={k.memberId} className={k.conflicts.length ? 'conflict' : ''}>
          <div>
            <strong>{k.name}</strong> <span className="small muted">— {k.roles.join(', ')}{k.understudy ? ' (doublure)' : ''}</span>
            {k.conflicts.map((c, i) => <div key={i} className="small" style={{ color: 'var(--danger)' }}>⚠ {c}</div>)}
            {responses && k.comment && <div className="small muted">« {k.comment} »</div>}
          </div>
          {responses && k.response !== undefined && <Badge tone={RESPONSE[k.response ?? 'invited'][1]}>{RESPONSE[k.response ?? 'invited'][0]}</Badge>}
        </li>
      ))}
    </ul>
  );
}

function RehearsalDetail({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (r: RehearsalRow) => void; onChanged: () => void }) {
  const { can, toast } = useApp();
  const q = useQuery({ queryKey: ['cast', 'rehearsal', id], queryFn: () => api.get<Omit<RehearsalRow, 'scenes'> & { production: { title: string }; scenes: { id: string; label: string }[]; calls: Call[] }>(`/cast/rehearsals/${id}`) });
  const d = q.data;
  return (
    <Modal open title={d ? `${d.title || `Répétition — ${d.production.title}`}` : 'Répétition'} onClose={onClose} footer={d && (
      <>
        {can('cast.rehearsals.delete') && <button className="btn danger" type="button" onClick={() => deleteWithConfirm(`/cast/rehearsals/${d.id}`, 'Supprimer cette répétition et son événement d’agenda (avec les réponses des comédiens) ?').then((r) => { if (r) { toast('Répétition supprimée.'); onChanged(); onClose(); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
        <button className="btn secondary" type="button" onClick={() => api.download(`/cast/rehearsals/${d.id}/call-sheet.pdf`, 'feuille-de-service.pdf').catch((e) => toast(errorMessage(e), 'error'))}>Feuille de service (PDF)</button>
        {can('cast.rehearsals.update') && <button className="btn" type="button" onClick={() => onEdit({ ...d, scenes: d.scenes.map((s) => s.label) })}>Modifier</button>}
      </>
    )}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {d && (
        <div className="stack">
          <p style={{ margin: 0 }}>{formatDate(d.startAt, true)} → {hm(d.endAt)}{d.location ? ` · ${d.location}` : ''}</p>
          <p className="small" style={{ margin: 0 }}>{d.scenes.length ? d.scenes.map((s) => s.label).join(' ; ') : 'Filage : toute la pièce.'}</p>
          {d.notes && <p className="small muted" style={{ margin: 0 }}>{d.notes}</p>}
          <h3 style={{ fontSize: '1rem', margin: '8px 0 0' }}>Convoqués ({d.calls.length})</h3>
          <CallList calls={d.calls} responses={!!d.eventId} />
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------- Indisponibilités */

interface Unav { id: string; memberId: string; name: string; startsOn: string; endsOn: string; reason: string | null }

export function UnavailabilityPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const [past, setPast] = useState(false);
  const q = useQuery({ queryKey: ['cast', 'unav', past], queryFn: () => api.get<Unav[]>(`/cast/unavailabilities${past ? '?past=1' : ''}`) });
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([]);
  const today = ymd(new Date());
  const [f, setF] = useState({ startsOn: today, endsOn: today, reason: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!picked.length) return setError('Choisissez au moins un adhérent.');
    try {
      for (const m of picked) await api.post('/cast/unavailabilities', { memberId: m.id, ...f, reason: f.reason || null });
      toast('Indisponibilité enregistrée.');
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['cast'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Indisponibilités')} />
      <PageHead title="Indisponibilités" description="Absences prévues des comédiens. Elles sont signalées lors de la planification des répétitions. Chacun peut aussi déclarer les siennes depuis son espace." actions={can('cast.availability.update') && <button className="btn" type="button" onClick={() => { setPicked([]); setError(null); setOpen(true); }}>Ajouter</button>} />
      <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={past} onChange={(e) => setPast(e.target.checked)} /> Afficher les indisponibilités passées</label>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Comédien</th><th>Période</th><th>Motif</th>{can('cast.availability.update') && <th className="actions">Actions</th>}</tr></thead>
            <tbody>
              {q.data!.map((u) => (
                <tr key={u.id}>
                  <td><Link to={`/asso/adherents/${u.memberId}`}>{u.name}</Link></td>
                  <td>{u.startsOn === u.endsOn ? formatDate(u.startsOn) : `${formatDate(u.startsOn)} → ${formatDate(u.endsOn)}`}</td>
                  <td className="small">{u.reason ?? '—'}</td>
                  {can('cast.availability.update') && <td className="actions"><button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm(`/cast/unavailabilities/${u.id}`, 'Supprimer cette indisponibilité ?').then((r) => { if (r) { toast('Supprimée.'); q.refetch(); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button></td>}
                </tr>
              ))}
              {!q.data!.length && <tr><td colSpan={4} className="empty">Aucune indisponibilité.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <Modal open title="Nouvelle indisponibilité" onClose={() => setOpen(false)} footer={<><button className="btn secondary" type="button" onClick={() => setOpen(false)}>Annuler</button><button className="btn" type="submit" form="unav-form">Enregistrer</button></>}>
          <form id="unav-form" className="stack" onSubmit={submit}>
            {error && <div className="alert danger" role="alert">{error}</div>}
            <MemberPicker value={picked} onChange={setPicked} />
            <div className="form-grid">
              <Field label="Du">{(id) => <input id={id} type="date" required value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value, endsOn: e.target.value > f.endsOn ? e.target.value : f.endsOn })} />}</Field>
              <Field label="Au (inclus)">{(id) => <input id={id} type="date" required min={f.startsOn} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} />}</Field>
            </div>
            <Field label="Motif (facultatif)">{(id) => <input id={id} type="text" maxLength={200} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
          </form>
        </Modal>
      )}
    </>
  );
}

/* ---------------------------------------------------------- Espace du comédien */

interface MyCast {
  roles: { role: string; kind: string; status: string; production: string; premiere: string | null }[];
  rehearsals: { id: string; production: string; title: string | null; startAt: string; endAt: string; location: string | null; roles: string[]; understudy: boolean; scenes: string[]; notes: string | null }[];
  unavailabilities: { id: string; startsOn: string; endsOn: string; reason: string | null }[];
}

export function EspaceCast() {
  const { toast } = useApp();
  const q = useQuery({ queryKey: ['espace', 'cast'], queryFn: () => api.get<MyCast>('/espace/cast') });
  const today = ymd(new Date());
  const [f, setF] = useState({ startsOn: today, endsOn: today, reason: '' });
  useEffect(() => { if (f.endsOn < f.startsOn) setF((x) => ({ ...x, endsOn: x.startsOn })); }, [f.startsOn, f.endsOn]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/espace/cast/unavailabilities', { ...f, reason: f.reason || null });
      toast('Indisponibilité déclarée : la mise en scène en sera avertie.');
      setF({ startsOn: today, endsOn: today, reason: '' });
      q.refetch();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <>
      <Breadcrumb items={[{ label: 'Mon espace', to: '/espace' }, { label: 'Mes rôles et répétitions' }]} />
      <PageHead title="Mes rôles et répétitions" />
      <div className="grid-2">
        <section className="card">
          <h2>Mes rôles</h2>
          {d.roles.length === 0 ? <p className="muted">Aucun rôle pour le moment.</p> : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {d.roles.map((r, i) => <li key={i}><strong>{r.role}</strong> dans <em>{r.production}</em>{r.kind === 'understudy' ? ' (doublure)' : ''}{r.status === 'considered' ? ' — pressenti(e)' : ''}{r.premiere ? ` · première le ${formatDate(r.premiere)}` : ''}</li>)}
            </ul>
          )}
        </section>
        <section className="card stack">
          <h2>Mes indisponibilités</h2>
          {d.unavailabilities.map((u) => (
            <div key={u.id} className="row between small">
              <span>{u.startsOn === u.endsOn ? formatDate(u.startsOn) : `${formatDate(u.startsOn)} → ${formatDate(u.endsOn)}`}{u.reason ? ` — ${u.reason}` : ''}</span>
              <button type="button" className="btn ghost sm" onClick={() => deleteWithConfirm(`/espace/cast/unavailabilities/${u.id}`, 'Retirer cette indisponibilité ?').then((r) => { if (r) q.refetch(); }, (e) => toast(errorMessage(e), 'error'))}>Retirer</button>
            </div>
          ))}
          <form className="form-grid" onSubmit={add}>
            <Field label="Du">{(id) => <input id={id} type="date" required min={today} value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} />}</Field>
            <Field label="Au (inclus)">{(id) => <input id={id} type="date" required min={f.startsOn} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} />}</Field>
            <Field label="Motif (facultatif)" className="full">{(id) => <input id={id} type="text" maxLength={200} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
            <div className="form-actions full"><button className="btn secondary" type="submit">Déclarer une indisponibilité</button></div>
          </form>
        </section>
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Mes prochaines répétitions</h2>
        {d.rehearsals.length === 0 ? <p className="muted">Aucune répétition prévue pour vous.</p> : (
          <div className="stack">
            {d.rehearsals.map((r) => (
              <article key={r.id} className="cast-reh">
                <div className="small muted">{formatDate(r.startAt, true)} → {hm(r.endAt)}{r.location ? ` · ${r.location}` : ''}</div>
                <div className="strong">{r.title || r.production}</div>
                <div className="small">{r.scenes.length ? r.scenes.join(' ; ') : 'Filage'} — {r.roles.join(', ')}{r.understudy ? ' (doublure)' : ''}</div>
                {r.notes && <div className="small muted">{r.notes}</div>}
              </article>
            ))}
            <p className="small muted" style={{ margin: 0 }}>Indiquez votre présence depuis <Link to="/espace/agenda">Mon agenda</Link>.</p>
          </div>
        )}
      </section>
    </>
  );
}
