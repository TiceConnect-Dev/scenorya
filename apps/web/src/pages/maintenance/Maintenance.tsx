import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, deleteWithConfirm, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';

/* --------------------------------------------------------------- Types */

type Status = 'open' | 'in_progress' | 'waiting_parts' | 'done' | 'cancelled';
type Priority = 'low' | 'normal' | 'high' | 'critical';
interface Ticket {
  id: string; itemId: string | null; item: string | null; reference: string | null; title: string; description: string | null; priority: Priority; status: Status;
  unitsOut: number; assigneeId: string | null; assignee: string | null; reporter: string | null; dueOn: string | null; costCents: number | null; resolution: string | null;
  planId: string | null; closedAt: string | null; createdAt: string; updatedAt: string;
}
interface TicketDetail extends Ticket { logs: { id: number; note: string; user: string | null; createdAt: string }[] }
interface Plan { id: string; itemId: string | null; item: string | null; reference: string | null; title: string; intervalDays: number; lastDoneOn: string | null; nextDueOn: string; notes: string | null; overdue: boolean }
interface ItemOption { id: string; name: string; reference: string | null; quantity: number }

export const STATUS: Record<Status, [string, 'neutral' | 'info' | 'warning' | 'success' | 'danger']> = {
  open: ['Ouverte', 'danger'], in_progress: ['En cours', 'info'], waiting_parts: ['Attente de pièces', 'warning'], done: ['Terminée', 'success'], cancelled: ['Annulée', 'neutral'],
};
export const PRIORITY: Record<Priority, [string, 'neutral' | 'info' | 'warning' | 'danger']> = {
  low: ['Basse', 'neutral'], normal: ['Normale', 'info'], high: ['Haute', 'warning'], critical: ['Critique', 'danger'],
};
const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Maintenance', to: '/maintenance' }, ...extra, { label }];
const euros = (c: number | null) => (c == null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100));
const toCents = (v: string) => (v.trim() ? Math.round(Number(v.replace(/\s/g, '').replace(',', '.')) * 100) : null);

const useItems = () => useQuery({ queryKey: ['stock', 'items', 'options'], queryFn: () => api.get<ItemOption[]>('/stock/items') });

/* ---------------------------------------------------------- Interventions */

export function MaintenanceHome() {
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'active' | 'closed' | 'all'>('active');
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['maintenance', 'tickets', status, mine], queryFn: () => api.get<Ticket[]>(`/maintenance/tickets?status=${status}${mine ? '&mine=true' : ''}`) });
  const sum = useQuery({ queryKey: ['maintenance', 'summary'], queryFn: () => api.get<{ open: number; critical: number; unitsOut: number; overduePlans: number }>('/maintenance/summary') });
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Maintenance' }]} />
      <PageHead title="Interventions" description="Pannes signalées, réparations en cours et historique." actions={can('maintenance.tickets.create') && <button className="btn" type="button" onClick={() => setOpen(true)}>Signaler une panne</button>} />
      {sum.data && (
        <div className="grid-3" style={{ marginBottom: 16 }}>
          <div className="card stack" style={{ gap: 4 }}><span className="small muted">Interventions ouvertes</span><strong style={{ fontSize: 24 }}>{sum.data.open}</strong>{sum.data.critical > 0 && <span className="small">dont {sum.data.critical} urgente(s)</span>}</div>
          <div className="card stack" style={{ gap: 4 }}><span className="small muted">Unités hors service</span><strong style={{ fontSize: 24 }}>{sum.data.unitsOut}</strong><span className="small muted">retirées des prêts</span></div>
          <div className="card stack" style={{ gap: 4 }}><span className="small muted">Entretiens en retard</span><strong style={{ fontSize: 24 }}>{sum.data.overduePlans}</strong><Link to="/maintenance/entretiens" className="small">Voir l’entretien préventif</Link></div>
        </div>
      )}
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="tabs" role="tablist">
          {([['active', 'En cours'], ['closed', 'Closes'], ['all', 'Toutes']] as const).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={status === k} className={`tab${status === k ? ' active' : ''}`} onClick={() => setStatus(k)}>{l}</button>)}
        </div>
        <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Qui me sont assignées</label>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Intervention</th><th>Matériel</th><th>Priorité</th><th>État</th><th>Assignée à</th><th>Échéance</th><th>Signalée</th></tr></thead>
            <tbody>
              {q.data!.map((t) => (
                <tr key={t.id}>
                  <td><Link to={`/maintenance/interventions/${t.id}`}>{t.title}</Link>{t.planId && <span className="small muted"> · préventif</span>}</td>
                  <td className="small">{t.itemId ? <Link to={`/stock/articles/${t.itemId}`}>{t.item}</Link> : '—'}{t.unitsOut > 0 && ` (${t.unitsOut} HS)`}</td>
                  <td><Badge tone={PRIORITY[t.priority][1]}>{PRIORITY[t.priority][0]}</Badge></td>
                  <td><Badge tone={STATUS[t.status][1]}>{STATUS[t.status][0]}</Badge></td>
                  <td className="small">{t.assignee ?? '—'}</td>
                  <td className="small">{t.dueOn ? formatDate(t.dueOn) : '—'}</td>
                  <td className="small">{formatDate(t.createdAt)}{t.reporter ? ` · ${t.reporter}` : ''}</td>
                </tr>
              ))}
              {!q.data!.length && <tr><td colSpan={7} className="empty">Aucune intervention.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {open && <TicketForm onClose={() => setOpen(false)} onSaved={(id) => { toast('Panne signalée.'); navigate(`/maintenance/interventions/${id}`); }} />}
    </>
  );
}

/** Formulaire d'intervention (utilisé aussi depuis la fiche d'un article de Stock). */
export function TicketForm({ initial, itemId, onClose, onSaved }: { initial?: Ticket; itemId?: string; onClose: () => void; onSaved: (id: string) => void }) {
  const { can } = useApp();
  const qc = useQueryClient();
  const items = useItems();
  const manage = can('maintenance.tickets.update');
  const people = useQuery({ queryKey: ['maintenance', 'assignees'], queryFn: () => api.get<{ id: string; displayName: string }[]>('/maintenance/assignees'), enabled: manage });
  const [f, setF] = useState({
    itemId: initial?.itemId ?? itemId ?? '', title: initial?.title ?? '', description: initial?.description ?? '', priority: initial?.priority ?? 'normal', status: initial?.status ?? 'open',
    unitsOut: String(initial?.unitsOut ?? 0), assigneeId: initial?.assigneeId ?? '', dueOn: initial?.dueOn ?? '',
    cost: initial?.costCents != null ? (initial.costCents / 100).toFixed(2).replace('.', ',') : '', resolution: initial?.resolution ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const t = (v: string) => v.trim() || null;
    const body: Record<string, unknown> = { itemId: f.itemId || null, title: f.title, description: t(f.description), priority: f.priority, unitsOut: Number(f.unitsOut || 0) };
    if (manage) Object.assign(body, { status: f.status, assigneeId: f.assigneeId || null, dueOn: f.dueOn || null, costCents: toCents(f.cost), resolution: t(f.resolution) });
    try {
      const r = initial ? await api.patch<{ id: string }>(`/maintenance/tickets/${initial.id}`, body) : await api.post<{ id: string }>('/maintenance/tickets', body);
      qc.invalidateQueries({ queryKey: ['maintenance'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      onSaved(r.id);
      onClose();
    } catch (err) { setError(errorMessage(err)); }
  };
  const selected = items.data?.find((i) => i.id === f.itemId);
  return (
    <Modal open title={initial ? 'Modifier l’intervention' : 'Signaler une panne'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="ticket-form">Enregistrer</button></>}>
      <form id="ticket-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Objet" className="full">{(id) => <input id={id} type="text" required maxLength={160} value={f.title} onChange={set('title')} placeholder="Lampe grillée, câble coupé…" autoFocus />}</Field>
        <Field label="Matériel concerné">{(id) => <select id={id} value={f.itemId} onChange={set('itemId')}><option value="">— (bâtiment, autre)</option>{items.data?.map((i) => <option key={i.id} value={i.id}>{i.reference ? `${i.reference} — ` : ''}{i.name}</option>)}</select>}</Field>
        <Field label="Unités hors service" hint={selected ? `Retirées des prêts (sur ${selected.quantity}).` : 'Retirées des prêts tant que l’intervention est ouverte.'}>{(id, d) => <input id={id} type="number" min={0} max={selected?.quantity} disabled={!f.itemId} value={f.unitsOut} onChange={set('unitsOut')} aria-describedby={d} />}</Field>
        <Field label="Priorité">{(id) => <select id={id} value={f.priority} onChange={set('priority')}>{Object.entries(PRIORITY).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        {manage && <Field label="État">{(id) => <select id={id} value={f.status} onChange={set('status')}>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>}
        <Field label="Description" className="full">{(id) => <textarea id={id} rows={3} maxLength={4000} value={f.description} onChange={set('description')} />}</Field>
        {manage && <>
          <Field label="Assignée à">{(id) => <select id={id} value={f.assigneeId} onChange={set('assigneeId')}><option value="">—</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select>}</Field>
          <Field label="Échéance">{(id) => <input id={id} type="date" value={f.dueOn} onChange={set('dueOn')} />}</Field>
          <Field label="Coût (€)">{(id) => <input id={id} type="text" inputMode="decimal" value={f.cost} onChange={set('cost')} />}</Field>
          <Field label="Résolution" className="full">{(id) => <textarea id={id} rows={2} maxLength={4000} value={f.resolution} onChange={set('resolution')} />}</Field>
        </>}
      </form>
    </Modal>
  );
}

export function TicketPage() {
  const { id } = useParams();
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['maintenance', 'ticket', id], queryFn: () => api.get<TicketDetail>(`/maintenance/tickets/${id}`) });
  const [edit, setEdit] = useState(false);
  const [note, setNote] = useState('');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const t = q.data!;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['maintenance'] }); qc.invalidateQueries({ queryKey: ['stock'] }); };
  const setStatus = async (status: Status) => { try { await api.patch(`/maintenance/tickets/${t.id}`, { status }); refresh(); toast('État mis à jour.'); } catch (e) { toast(errorMessage(e), 'error'); } };
  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    try { await api.post(`/maintenance/tickets/${t.id}/logs`, { note }); setNote(''); refresh(); } catch (err) { toast(errorMessage(err), 'error'); }
  };
  return (
    <>
      <Breadcrumb items={crumbs(t.title)} />
      <PageHead title={t.title} description={`Signalée le ${formatDate(t.createdAt, true)}${t.reporter ? ` par ${t.reporter}` : ''}`}
        actions={<>
          {can('maintenance.tickets.update') && t.status !== 'done' && <button className="btn" type="button" onClick={() => setStatus('done')}>Marquer terminée</button>}
          {can('maintenance.tickets.update') && t.status === 'done' && <button className="btn secondary" type="button" onClick={() => setStatus('open')}>Rouvrir</button>}
          {can('maintenance.tickets.update') && <button className="btn secondary" type="button" onClick={() => setEdit(true)}>Modifier</button>}
          {can('maintenance.tickets.delete') && <button className="btn danger" type="button" onClick={() => deleteWithConfirm(`/maintenance/tickets/${t.id}`, `Supprimer l’intervention « ${t.title} » et son journal ?`).then((r) => { if (r) { refresh(); toast('Intervention supprimée.'); navigate('/maintenance'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
        </>} />
      <section className="card" style={{ marginBottom: 16 }}>
        <dl className="props">
          <dt>État</dt><dd><Badge tone={STATUS[t.status][1]}>{STATUS[t.status][0]}</Badge>{t.closedAt && <span className="small muted"> le {formatDate(t.closedAt)}</span>}</dd>
          <dt>Priorité</dt><dd><Badge tone={PRIORITY[t.priority][1]}>{PRIORITY[t.priority][0]}</Badge></dd>
          <dt>Matériel</dt><dd>{t.itemId ? <Link to={`/stock/articles/${t.itemId}`}>{t.item}</Link> : '—'}{t.unitsOut > 0 && ` · ${t.unitsOut} unité(s) hors service`}</dd>
          <dt>Assignée à</dt><dd>{t.assignee ?? '—'}</dd>
          <dt>Échéance</dt><dd>{t.dueOn ? formatDate(t.dueOn) : '—'}</dd>
          <dt>Coût</dt><dd>{euros(t.costCents)}</dd>
        </dl>
        {t.description && <><h3>Description</h3><p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p></>}
        {t.resolution && <><h3>Résolution</h3><p style={{ whiteSpace: 'pre-wrap' }}>{t.resolution}</p></>}
      </section>
      <section className="card">
        <h2>Journal</h2>
        <ul className="stack" style={{ gap: 8, listStyle: 'none', padding: 0 }}>
          {t.logs.map((l) => (
            <li key={l.id} className="row between" style={{ alignItems: 'flex-start' }}>
              <div><span className="small muted">{formatDate(l.createdAt, true)}{l.user ? ` · ${l.user}` : ''}</span><div style={{ whiteSpace: 'pre-wrap' }}>{l.note}</div></div>
              {can('maintenance.tickets.update') && <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm(`/maintenance/tickets/${t.id}/logs/${l.id}`, 'Supprimer cette note ?').then((r) => { if (r) refresh(); }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
            </li>
          ))}
          {!t.logs.length && <li className="muted">Aucune note.</li>}
        </ul>
        {can('maintenance.tickets.create') && (
          <form className="row" style={{ marginTop: 12, alignItems: 'flex-end' }} onSubmit={addNote}>
            <Field label="Ajouter une note" className="grow">{(id) => <input id={id} type="text" maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <button className="btn secondary" type="submit">Ajouter</button>
          </form>
        )}
      </section>
      {edit && <TicketForm initial={t} onClose={() => setEdit(false)} onSaved={() => toast('Intervention enregistrée.')} />}
    </>
  );
}

/* ---------------------------------------------------------- Entretien préventif */

export function PlansPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['maintenance', 'plans'], queryFn: () => api.get<Plan[]>('/maintenance/plans') });
  const items = useItems();
  const [form, setForm] = useState<{ id?: string; itemId: string; title: string; intervalDays: string; nextDueOn: string; notes: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['maintenance'] });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    const body = { itemId: form.itemId || null, title: form.title, intervalDays: Number(form.intervalDays), nextDueOn: form.nextDueOn, notes: form.notes.trim() || null };
    try {
      if (form.id) await api.patch(`/maintenance/plans/${form.id}`, body); else await api.post('/maintenance/plans', body);
      refresh();
      setForm(null);
      toast('Entretien enregistré.');
    } catch (err) { setError(errorMessage(err)); }
  };
  const done = async (p: Plan) => {
    const note = window.prompt(`Entretien « ${p.title} » effectué. Observation (facultatif) :`, '');
    if (note === null) return;
    try { const r = await api.post<{ plan: Plan }>(`/maintenance/plans/${p.id}/done`, { note: note.trim() || null }); refresh(); toast(`Entretien noté ; prochain le ${formatDate(r.plan.nextDueOn)}.`); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Breadcrumb items={crumbs('Entretien préventif')} />
      <PageHead title="Entretien préventif" description="Vérifications périodiques : contrôle électrique, nettoyage, révision…" actions={can('maintenance.plans.update') && <button className="btn" type="button" onClick={() => setForm({ itemId: '', title: '', intervalDays: '365', nextDueOn: today, notes: '' })}>Nouvel entretien</button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Entretien</th><th>Matériel</th><th>Périodicité</th><th>Dernier</th><th>Prochain</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {q.data!.map((p) => (
                <tr key={p.id}>
                  <td>{p.title}{p.notes && <div className="small muted">{p.notes}</div>}</td>
                  <td className="small">{p.itemId ? <Link to={`/stock/articles/${p.itemId}`}>{p.item}</Link> : '—'}</td>
                  <td className="small">tous les {p.intervalDays} j</td>
                  <td className="small">{p.lastDoneOn ? formatDate(p.lastDoneOn) : '—'}</td>
                  <td>{formatDate(p.nextDueOn)} {p.overdue && <Badge tone="danger">À faire</Badge>}</td>
                  <td className="actions">{can('maintenance.plans.update') && <>
                    <button className="btn secondary sm" type="button" onClick={() => done(p)}>Effectué</button>{' '}
                    <button className="btn ghost sm" type="button" onClick={() => setForm({ id: p.id, itemId: p.itemId ?? '', title: p.title, intervalDays: String(p.intervalDays), nextDueOn: p.nextDueOn, notes: p.notes ?? '' })}>Modifier</button>{' '}
                    <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm(`/maintenance/plans/${p.id}`, `Supprimer l’entretien « ${p.title} » ? Les interventions déjà notées restent dans l’historique.`).then((r) => { if (r) { refresh(); toast('Entretien supprimé.'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>
                  </>}</td>
                </tr>
              ))}
              {!q.data!.length && <tr><td colSpan={6} className="empty">Aucun entretien planifié.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <Modal open title={form.id ? 'Modifier l’entretien' : 'Nouvel entretien'} onClose={() => setForm(null)} footer={<><button className="btn secondary" type="button" onClick={() => setForm(null)}>Annuler</button><button className="btn" type="submit" form="plan-form">Enregistrer</button></>}>
          <form id="plan-form" className="form-grid" onSubmit={save}>
            {error && <div className="alert danger full" role="alert">{error}</div>}
            <Field label="Entretien" className="full">{(id) => <input id={id} type="text" required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />}</Field>
            <Field label="Matériel" className="full">{(id) => <select id={id} value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value })}><option value="">— (général)</option>{items.data?.map((i) => <option key={i.id} value={i.id}>{i.reference ? `${i.reference} — ` : ''}{i.name}</option>)}</select>}</Field>
            <Field label="Tous les (jours)">{(id) => <input id={id} type="number" min={1} max={3650} required value={form.intervalDays} onChange={(e) => setForm({ ...form, intervalDays: e.target.value })} />}</Field>
            <Field label="Prochaine échéance">{(id) => <input id={id} type="date" required value={form.nextDueOn} onChange={(e) => setForm({ ...form, nextDueOn: e.target.value })} />}</Field>
            <Field label="Notes" className="full">{(id) => <textarea id={id} rows={2} maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field>
          </form>
        </Modal>
      )}
    </>
  );
}
