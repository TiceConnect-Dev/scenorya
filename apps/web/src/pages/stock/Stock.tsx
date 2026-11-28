import { FormEvent, Fragment, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isFeatureEnabled } from '@scenorya/shared';
import { api, deleteWithConfirm, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';
import { TicketForm } from '../maintenance/Maintenance';

/* --------------------------------------------------------------- Types */

type Condition = 'good' | 'worn' | 'broken';
export interface StockItem {
  id: string; name: string; reference: string | null; category: string | null; kind: 'equipment' | 'consumable';
  quantity: number; unit: string | null; minQuantity: number | null; locationId: string | null; location: string | null;
  brand: string | null; model: string | null; serialNumber: string | null; valueCents: number | null; purchasedOn: string | null;
  condition: Condition; loanable: boolean; notes: string | null; archivedAt: string | null; outOfService: number; low: boolean;
}
interface Location { id: string; name: string; description: string | null; items: number }
interface Movement { id: number; kind: 'in' | 'out' | 'adjust' | 'lost'; delta: number; quantityAfter: number; reason: string | null; user: string | null; createdAt: string }
interface ItemDetail extends Omit<StockItem, 'location'> {
  location: { id: string; name: string } | null; availableNow: number;
  movements: Movement[];
  tickets: { id: string; title: string; status: string; priority: string; unitsOut: number; createdAt: string }[];
  loans: { id: string; title: string; startAt: string; endAt: string; status: string; checkedOutAt: string | null; returnedAt: string | null; quantity: number }[];
}

export const CONDITION: Record<Condition, [string, 'success' | 'warning' | 'danger']> = { good: ['Bon état', 'success'], worn: ['Usé', 'warning'], broken: ['Hors d’usage', 'danger'] };
const MOVE: Record<Movement['kind'], string> = { in: 'Entrée', out: 'Sortie', adjust: 'Inventaire', lost: 'Perte' };
const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Stock', to: '/stock' }, ...extra, { label }];
const euros = (c: number | null) => (c == null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100));
const qty = (n: number, unit: string | null) => `${n}${unit ? ` ${unit}` : ''}`;

/* ---------------------------------------------------------- Inventaire */

export function StockHome() {
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ q: '', category: '', locationId: '', low: false, archived: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.category) params.set('category', filters.category);
  if (filters.locationId) params.set('locationId', filters.locationId);
  if (filters.low) params.set('low', 'true');
  if (filters.archived) params.set('archived', 'true');
  const q = useQuery({ queryKey: ['stock', 'items', params.toString()], queryFn: () => api.get<StockItem[]>(`/stock/items?${params}`) });
  const cats = useQuery({ queryKey: ['stock', 'categories'], queryFn: () => api.get<string[]>('/stock/categories') });
  const locs = useQuery({ queryKey: ['stock', 'locations'], queryFn: () => api.get<Location[]>('/stock/locations') });
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const rows = q.data ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const download = (url: string, name: string) => api.download(url, name).catch((e) => toast(errorMessage(e), 'error'));
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Stock' }]} />
      <PageHead title="Inventaire" description="Matériel et consommables de l’association, quantités, emplacements et état."
        actions={<>
          {can('stock.items.export') && <button className="btn secondary" type="button" onClick={() => download('/stock/items.csv', 'inventaire.csv')}>Exporter (CSV)</button>}
          {can('stock.items.create') && <button className="btn" type="button" onClick={() => setOpen(true)}>Nouvel article</button>}
        </>} />
      <div className="card row wrap" style={{ gap: 12, marginBottom: 12, alignItems: 'flex-end' }}>
        <Field label="Recherche">{(id) => <input id={id} type="search" placeholder="Nom, référence, n° de série…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />}</Field>
        <Field label="Catégorie">{(id) => <select id={id} value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">Toutes</option>{cats.data?.map((c) => <option key={c}>{c}</option>)}</select>}</Field>
        <Field label="Emplacement">{(id) => <select id={id} value={filters.locationId} onChange={(e) => setFilters({ ...filters, locationId: e.target.value })}><option value="">Tous</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}</Field>
        <label className="check"><input type="checkbox" checked={filters.low} onChange={(e) => setFilters({ ...filters, low: e.target.checked })} /> Stock bas</label>
        <label className="check"><input type="checkbox" checked={filters.archived} onChange={(e) => setFilters({ ...filters, archived: e.target.checked })} /> Archivés</label>
      </div>
      {selected.size > 0 && can('stock.items.download') && (
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <span className="small">{selected.size} article(s) sélectionné(s)</span>
          <button className="btn secondary sm" type="button" onClick={() => download(`/stock/labels.pdf?ids=${[...selected].join(',')}`, 'etiquettes.pdf')}>Imprimer les étiquettes QR</button>
          <button className="btn ghost sm" type="button" onClick={() => setSelected(new Set())}>Désélectionner</button>
        </div>
      )}
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th style={{ width: 32 }}><input type="checkbox" aria-label="Tout sélectionner" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
              <th>Référence</th><th>Article</th><th>Catégorie</th><th>Emplacement</th><th>Quantité</th><th>État</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label={`Sélectionner ${r.name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td className="small">{r.reference ?? '—'}</td>
                  <td><Link to={`/stock/articles/${r.id}`}>{r.name}</Link>{r.kind === 'consumable' && <span className="small muted"> · consommable</span>}</td>
                  <td className="small">{r.category ?? '—'}</td>
                  <td className="small">{r.location ?? '—'}</td>
                  <td>{qty(r.quantity, r.unit)} {r.low && <Badge tone="warning">Stock bas</Badge>} {r.outOfService > 0 && <Badge tone="danger">{r.outOfService} en panne</Badge>}</td>
                  <td><Badge tone={CONDITION[r.condition][1]}>{CONDITION[r.condition][0]}</Badge></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className="empty">Aucun article.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {open && <ItemForm locations={locs.data ?? []} categories={cats.data ?? []} onClose={() => setOpen(false)} onSaved={(id) => { toast('Article créé.'); navigate(`/stock/articles/${id}`); }} />}
    </>
  );
}

function ItemForm({ initial, locations, categories, onClose, onSaved }: { initial?: ItemDetail; locations: { id: string; name: string }[]; categories: string[]; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const n = (v: number | null | undefined) => (v == null ? '' : String(v));
  const [f, setF] = useState({
    name: initial?.name ?? '', reference: initial?.reference ?? '', category: initial?.category ?? '', kind: initial?.kind ?? 'equipment',
    quantity: initial ? String(initial.quantity) : '1', unit: initial?.unit ?? '', minQuantity: n(initial?.minQuantity), locationId: initial?.location?.id ?? '',
    brand: initial?.brand ?? '', model: initial?.model ?? '', serialNumber: initial?.serialNumber ?? '', value: initial?.valueCents != null ? (initial.valueCents / 100).toFixed(2).replace('.', ',') : '',
    purchasedOn: initial?.purchasedOn ?? '', condition: initial?.condition ?? 'good', loanable: initial?.loanable ?? true, notes: initial?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const t = (v: string) => v.trim() || null;
    const value = f.value.trim() ? Math.round(Number(f.value.replace(/\s/g, '').replace(',', '.')) * 100) : null;
    if (value != null && Number.isNaN(value)) return setError('Valeur invalide.');
    const body: Record<string, unknown> = {
      name: f.name, reference: t(f.reference), category: t(f.category), kind: f.kind, unit: t(f.unit), minQuantity: f.minQuantity === '' ? null : Number(f.minQuantity),
      locationId: f.locationId || null, brand: t(f.brand), model: t(f.model), serialNumber: t(f.serialNumber), valueCents: value, purchasedOn: f.purchasedOn || null,
      condition: f.condition, loanable: f.loanable, notes: t(f.notes),
    };
    if (!initial) body.quantity = Number(f.quantity || 0);
    try {
      const r = initial ? await api.patch<{ id: string }>(`/stock/items/${initial.id}`, body) : await api.post<{ id: string }>('/stock/items', body);
      qc.invalidateQueries({ queryKey: ['stock'] });
      onSaved(r.id);
      onClose();
    } catch (err) { setError(errorMessage(err)); }
  };
  return (
    <Modal open title={initial ? 'Modifier l’article' : 'Nouvel article'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="item-form">Enregistrer</button></>}>
      <form id="item-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Nom" className="full">{(id) => <input id={id} type="text" required maxLength={160} value={f.name} onChange={set('name')} autoFocus />}</Field>
        <Field label="Référence" hint="Code inventaire, unique.">{(id, d) => <input id={id} type="text" maxLength={40} value={f.reference} onChange={set('reference')} aria-describedby={d} />}</Field>
        <Field label="Catégorie">{(id) => <><input id={id} type="text" list="stock-cats" maxLength={60} value={f.category} onChange={set('category')} /><datalist id="stock-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></>}</Field>
        <Field label="Type">{(id) => <select id={id} value={f.kind} onChange={set('kind')}><option value="equipment">Matériel</option><option value="consumable">Consommable</option></select>}</Field>
        <Field label="Emplacement">{(id) => <select id={id} value={f.locationId} onChange={set('locationId')}><option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}</Field>
        {!initial && <Field label="Quantité initiale">{(id) => <input id={id} type="number" min={0} value={f.quantity} onChange={set('quantity')} />}</Field>}
        <Field label="Unité" hint="Pièces, rouleaux, mètres…">{(id, d) => <input id={id} type="text" maxLength={20} value={f.unit} onChange={set('unit')} aria-describedby={d} />}</Field>
        <Field label="Seuil d’alerte" hint="Stock bas à partir de cette quantité.">{(id, d) => <input id={id} type="number" min={0} value={f.minQuantity} onChange={set('minQuantity')} aria-describedby={d} />}</Field>
        <Field label="État">{(id) => <select id={id} value={f.condition} onChange={set('condition')}>{Object.entries(CONDITION).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        <Field label="Marque">{(id) => <input id={id} type="text" maxLength={80} value={f.brand} onChange={set('brand')} />}</Field>
        <Field label="Modèle">{(id) => <input id={id} type="text" maxLength={80} value={f.model} onChange={set('model')} />}</Field>
        <Field label="N° de série">{(id) => <input id={id} type="text" maxLength={80} value={f.serialNumber} onChange={set('serialNumber')} />}</Field>
        <Field label="Valeur unitaire (€)">{(id) => <input id={id} type="text" inputMode="decimal" value={f.value} onChange={set('value')} />}</Field>
        <Field label="Date d’achat">{(id) => <input id={id} type="date" value={f.purchasedOn} onChange={set('purchasedOn')} />}</Field>
        <label className="check full"><input type="checkbox" checked={f.loanable} onChange={(e) => setF({ ...f, loanable: e.target.checked })} /> Peut être prêté ou réservé</label>
        <Field label="Notes" className="full">{(id) => <textarea id={id} rows={3} maxLength={2000} value={f.notes} onChange={set('notes')} />}</Field>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Fiche article */

export function StockItemPage() {
  const { id } = useParams();
  const { can, ctx, toast } = useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock', 'item', id], queryFn: () => api.get<ItemDetail>(`/stock/items/${id}`) });
  const locs = useQuery({ queryKey: ['stock', 'locations'], queryFn: () => api.get<Location[]>('/stock/locations') });
  const cats = useQuery({ queryKey: ['stock', 'categories'], queryFn: () => api.get<string[]>('/stock/categories') });
  const [edit, setEdit] = useState(false);
  const [move, setMove] = useState(false);
  const [ticket, setTicket] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const i = q.data!;
  const maintenance = Boolean(ctx?.modules.maintenance?.usable);
  const loans = Boolean(ctx && isFeatureEnabled(ctx.modules, 'booking.equipmentLoans'));
  const refresh = () => qc.invalidateQueries({ queryKey: ['stock'] });
  const archive = async () => {
    try { await api.post(`/stock/items/${i.id}/archive`, { restore: !!i.archivedAt }); refresh(); toast(i.archivedAt ? 'Article restauré.' : 'Article archivé.'); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const remove = async () => {
    try {
      if (await deleteWithConfirm(`/stock/items/${i.id}`, `Supprimer définitivement « ${i.name} », son historique et ses interventions ?`)) { refresh(); toast('Article supprimé.'); navigate('/stock'); }
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const dl = [
    ['Référence', i.reference], ['Catégorie', i.category], ['Type', i.kind === 'equipment' ? 'Matériel' : 'Consommable'], ['Emplacement', i.location?.name],
    ['Marque / modèle', [i.brand, i.model].filter(Boolean).join(' ')], ['N° de série', i.serialNumber], ['Valeur unitaire', i.valueCents != null ? euros(i.valueCents) : null],
    ['Achat', i.purchasedOn && formatDate(i.purchasedOn)], ['Prêtable', i.loanable ? 'Oui' : 'Non'], ['Seuil d’alerte', i.minQuantity != null ? qty(i.minQuantity, i.unit) : null],
  ] as const;
  return (
    <>
      <Breadcrumb items={crumbs(i.name)} />
      <PageHead title={i.name} description={i.archivedAt ? `Archivé le ${formatDate(i.archivedAt)}` : undefined}
        actions={<>
          {maintenance && can('maintenance.tickets.create') && <button className="btn secondary" type="button" onClick={() => setTicket(true)}>Signaler une panne</button>}
          {can('stock.items.update') && <button className="btn secondary" type="button" onClick={() => setMove(true)}>Mouvement de stock</button>}
          {can('stock.items.update') && <button className="btn secondary" type="button" onClick={() => setEdit(true)}>Modifier</button>}
          {can('stock.items.update') && <button className="btn ghost" type="button" onClick={archive}>{i.archivedAt ? 'Restaurer' : 'Archiver'}</button>}
          {can('stock.items.delete') && <button className="btn danger" type="button" onClick={remove}>Supprimer</button>}
        </>} />
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">En stock</span><strong style={{ fontSize: 24 }}>{qty(i.quantity, i.unit)}</strong>{i.low && <div><Badge tone="warning">Stock bas</Badge></div>}</div>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">Disponible maintenant</span><strong style={{ fontSize: 24 }}>{i.availableNow}</strong>{i.outOfService > 0 && <span className="small">{i.outOfService} hors service</span>}</div>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">État</span><div><Badge tone={CONDITION[i.condition][1]}>{CONDITION[i.condition][0]}</Badge></div></div>
      </div>
      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Fiche</h2>
        <dl className="props">{dl.filter(([, v]) => v).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        {i.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{i.notes}</p>}
      </section>
      {loans && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>Prêts en cours et à venir</h2>
          {i.loans.length ? (
            <div className="table-wrap"><table className="table"><thead><tr><th>Réservation</th><th>Du</th><th>Au</th><th>Quantité</th><th>État</th></tr></thead>
              <tbody>{i.loans.map((l) => <tr key={l.id}><td><Link to={`/booking?b=${l.id}`}>{l.title}</Link></td><td className="small">{formatDate(l.startAt, true)}</td><td className="small">{formatDate(l.endAt, true)}</td><td>{l.quantity}</td><td>{l.checkedOutAt ? <Badge tone="warning">Sorti</Badge> : l.status === 'pending' ? <Badge>En attente</Badge> : <Badge tone="info">Réservé</Badge>}</td></tr>)}</tbody></table></div>
          ) : <p className="muted">Aucun prêt prévu.</p>}
        </section>
      )}
      {maintenance && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>Interventions</h2>
          {i.tickets.length ? (
            <ul className="stack" style={{ gap: 4, paddingLeft: 18 }}>{i.tickets.map((t) => <li key={t.id}><Link to={`/maintenance/interventions/${t.id}`}>{t.title}</Link> <span className="small muted">· {formatDate(t.createdAt)} · {t.status === 'done' ? 'terminée' : t.status === 'cancelled' ? 'annulée' : 'ouverte'}{t.unitsOut ? ` · ${t.unitsOut} hors service` : ''}</span></li>)}</ul>
          ) : <p className="muted">Aucune intervention.</p>}
        </section>
      )}
      <section className="card">
        <h2>Historique des mouvements</h2>
        <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Mouvement</th><th>Variation</th><th>Stock après</th><th>Motif</th><th>Par</th></tr></thead>
          <tbody>
            {i.movements.map((m) => <tr key={m.id}><td className="small">{formatDate(m.createdAt, true)}</td><td>{MOVE[m.kind]}</td><td>{m.delta > 0 ? `+${m.delta}` : m.delta}</td><td>{m.quantityAfter}</td><td className="small">{m.reason ?? '—'}</td><td className="small">{m.user ?? '—'}</td></tr>)}
            {!i.movements.length && <tr><td colSpan={6} className="empty">Aucun mouvement.</td></tr>}
          </tbody></table></div>
      </section>
      {edit && <ItemForm initial={i} locations={locs.data ?? []} categories={cats.data ?? []} onClose={() => setEdit(false)} onSaved={() => toast('Article enregistré.')} />}
      {move && <MovementForm item={i} onClose={() => setMove(false)} onSaved={() => { refresh(); toast('Mouvement enregistré.'); }} />}
      {ticket && <TicketForm itemId={i.id} onClose={() => setTicket(false)} onSaved={() => { refresh(); toast('Panne signalée.'); }} />}
    </>
  );
}

function MovementForm({ item, onClose, onSaved }: { item: ItemDetail; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ kind: 'in' as Movement['kind'], quantity: '1', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/stock/items/${item.id}/movements`, { kind: f.kind, quantity: Number(f.quantity), reason: f.reason.trim() || null });
      onSaved();
      onClose();
    } catch (err) { setError(errorMessage(err)); }
  };
  return (
    <Modal open title={`Mouvement — ${item.name}`} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="move-form">Enregistrer</button></>}>
      <form id="move-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Mouvement">{(id) => <select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Movement['kind'] })}><option value="in">Entrée (achat, don)</option><option value="out">Sortie (consommation)</option><option value="lost">Perte ou casse</option><option value="adjust">Inventaire (quantité constatée)</option></select>}</Field>
        <Field label={f.kind === 'adjust' ? 'Quantité constatée' : 'Quantité'} hint={`Actuellement : ${qty(item.quantity, item.unit)}`}>{(id, d) => <input id={id} type="number" min={f.kind === 'adjust' ? 0 : 1} required value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} aria-describedby={d} />}</Field>
        <Field label="Motif" className="full">{(id) => <input id={id} type="text" maxLength={300} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Emplacements */

export function LocationsPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock', 'locations'], queryFn: () => api.get<Location[]>('/stock/locations') });
  const [form, setForm] = useState<{ id?: string; name: string; description: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    const body = { name: form.name, description: form.description.trim() || null };
    try {
      if (form.id) await api.patch(`/stock/locations/${form.id}`, body); else await api.post('/stock/locations', body);
      qc.invalidateQueries({ queryKey: ['stock'] });
      setForm(null);
      toast('Emplacement enregistré.');
    } catch (err) { setError(errorMessage(err)); }
  };
  const remove = async (l: Location) => {
    try {
      if (await deleteWithConfirm(`/stock/locations/${l.id}`, `Supprimer l’emplacement « ${l.name} » ? Ses ${l.items} article(s) n’auront plus d’emplacement.`)) { qc.invalidateQueries({ queryKey: ['stock'] }); toast('Emplacement supprimé.'); }
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Emplacements')} />
      <PageHead title="Emplacements" description="Locaux, réserves, camions : où se trouve le matériel." actions={can('stock.locations.update') && <button className="btn" type="button" onClick={() => setForm({ name: '', description: '' })}>Nouvel emplacement</button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Emplacement</th><th>Description</th><th>Articles</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {q.data!.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td><td className="small">{l.description ?? '—'}</td><td>{l.items}</td>
                  <td className="actions">{can('stock.locations.update') && <><button className="btn ghost sm" type="button" onClick={() => setForm({ id: l.id, name: l.name, description: l.description ?? '' })}>Modifier</button> <button className="btn ghost sm" type="button" onClick={() => remove(l)}>Supprimer</button></>}</td>
                </tr>
              ))}
              {!q.data!.length && <tr><td colSpan={4} className="empty">Aucun emplacement.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <Modal open title={form.id ? 'Modifier l’emplacement' : 'Nouvel emplacement'} onClose={() => setForm(null)} footer={<><button className="btn secondary" type="button" onClick={() => setForm(null)}>Annuler</button><button className="btn" type="submit" form="loc-form">Enregistrer</button></>}>
          <form id="loc-form" className="form-grid" onSubmit={save}>
            {error && <div className="alert danger full" role="alert">{error}</div>}
            <Field label="Nom" className="full">{(id) => <input id={id} type="text" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />}</Field>
            <Field label="Description" className="full">{(id) => <textarea id={id} rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
          </form>
        </Modal>
      )}
    </>
  );
}

