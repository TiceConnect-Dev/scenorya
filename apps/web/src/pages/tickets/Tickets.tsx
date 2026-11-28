import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, deleteWithConfirm, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';

/* --------------------------------------------------------------- Types */

type EvStatus = 'draft' | 'on_sale' | 'closed' | 'cancelled';
type OrderStatus = 'pending' | 'paid' | 'cancelled';
interface EventRow {
  id: string; title: string; description: string | null; startAt: string; venue: string | null; capacity: number | null; status: EvStatus; publicSale: boolean;
  salesOpenAt: string | null; salesCloseAt: string | null; maxPerOrder: number; performanceId: string | null; show: { id: string; title: string } | null;
  sold: number; scanned: number; revenueCents: number; pendingOrders?: number;
}
interface Rate { id: string; name: string; priceCents: number; quota: number | null; publicVisible: boolean; position: number; sold: number }
interface EventDetail extends EventRow {
  rates: Rate[]; byMethod: Record<string, number>; byChannel: Record<string, number>; pendingCents: number; publicUrl: string; features: { show: boolean; scan: boolean };
}
interface Order {
  id: string; number: string; buyerName: string; buyerEmail: string | null; buyerPhone: string | null; status: OrderStatus; channel: 'box_office' | 'online' | 'invitation';
  paymentMethod: string | null; totalCents: number; paidAt: string | null; refundedAt: string | null; notes: string | null; createdAt: string; tickets: number; scanned: number; emailStatus: string | null;
}
interface Ticket { id: string; rateName: string; priceCents: number; code: string; holderName: string | null; status: 'valid' | 'cancelled'; scannedAt: string | null }

export const EV_STATUS: Record<EvStatus, [string, 'neutral' | 'success' | 'warning' | 'danger']> = {
  draft: ['En préparation', 'neutral'], on_sale: ['En vente', 'success'], closed: ['Ventes closes', 'warning'], cancelled: ['Annulée', 'danger'],
};
const ORDER_STATUS: Record<OrderStatus, [string, 'warning' | 'success' | 'neutral']> = { pending: ['À régler', 'warning'], paid: ['Réglée', 'success'], cancelled: ['Annulée', 'neutral'] };
const CHANNEL = { box_office: 'Guichet', online: 'En ligne', invitation: 'Invitation' } as const;
export const PAYMENT: Record<string, string> = { cash: 'Espèces', card: 'Carte bancaire', cheque: 'Chèque', transfer: 'Virement', free: 'Gratuit', other: 'Autre' };
export const money = (c: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);
const priceLabel = (c: number) => (c === 0 ? 'Gratuit' : money(c));
const toCents = (v: string) => Math.round(Number(v.replace(/\s/g, '').replace(',', '.')) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const crumbs = (label: string) => [{ label: 'Scenorya Tickets', to: '/tickets' }, { label }];

function Gauge({ sold, capacity }: { sold: number; capacity: number | null }) {
  if (capacity == null) return <span className="small">{sold} billet(s) · jauge libre</span>;
  const pct = capacity ? Math.min(100, Math.round((sold / capacity) * 100)) : 100;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="small">{sold} / {capacity} places{sold >= capacity && <strong> · complet</strong>}</span>
      <div className="gauge" role="meter" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={sold} aria-label="Remplissage"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/* ---------------------------------------------------------- Séances */

export function TicketsHome() {
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const [past, setPast] = useState(false);
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['tickets', 'events', past], queryFn: () => api.get<EventRow[]>(`/tickets/events${past ? '?past=1' : ''}`) });
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Tickets' }]} />
      <PageHead title="Billetterie" description="Séances en vente, guichet, réservations en ligne et billets QR." actions={can('tickets.events.create') && <button className="btn" type="button" onClick={() => setOpen(true)}>Nouvelle séance</button>} />
      <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
        <button type="button" role="tab" aria-selected={!past} className={`tab${!past ? ' active' : ''}`} onClick={() => setPast(false)}>À venir</button>
        <button type="button" role="tab" aria-selected={past} className={`tab${past ? ' active' : ''}`} onClick={() => setPast(true)}>Passées</button>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data!.length === 0 ? <div className="card empty">{past ? 'Aucune séance passée.' : 'Aucune séance à venir. Créez-en une pour ouvrir la vente.'}</div> : (
        <div className="grid-3">
          {q.data!.map((e) => (
            <Link key={e.id} to={`/tickets/seances/${e.id}`} className="card tile-link">
              <div className="stack" style={{ gap: 8 }}>
                <div className="row between" style={{ alignItems: 'flex-start' }}><h2 style={{ margin: 0 }}>{e.title}</h2><Badge tone={EV_STATUS[e.status][1]}>{EV_STATUS[e.status][0]}</Badge></div>
                <span className="small">{formatDate(e.startAt, true)}{e.venue ? ` · ${e.venue}` : ''}</span>
                <Gauge sold={e.sold} capacity={e.capacity} />
                <span className="small muted">{money(e.revenueCents)} encaissés{e.pendingOrders ? ` · ${e.pendingOrders} réservation(s) à régler` : ''}{e.publicSale ? ' · en ligne' : ''}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      {open && <EventForm onClose={() => setOpen(false)} onSaved={(id) => { toast('Séance créée.'); navigate(`/tickets/seances/${id}`); }} />}
    </>
  );
}

function EventForm({ initial, onClose, onSaved }: { initial?: EventDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const perfs = useQuery({ queryKey: ['tickets', 'performances'], queryFn: () => api.get<{ id: string; startAt: string; show: string; venue: string | null; capacity: number | null; venueCapacity: number | null }[]>('/tickets/performances'), enabled: !initial });
  const start = new Date(); start.setDate(start.getDate() + 14); start.setHours(20, 30, 0, 0);
  const [f, setF] = useState({
    performanceId: '', title: initial?.title ?? '', description: initial?.description ?? '', startAt: localInput(initial ? new Date(initial.startAt) : start), venue: initial?.venue ?? '',
    capacity: initial?.capacity == null ? '' : String(initial.capacity), status: initial?.status ?? 'draft', publicSale: initial?.publicSale ?? false,
    salesOpenAt: initial?.salesOpenAt ? localInput(new Date(initial.salesOpenAt)) : '', salesCloseAt: initial?.salesCloseAt ? localInput(new Date(initial.salesCloseAt)) : '', maxPerOrder: String(initial?.maxPerOrder ?? 10),
  });
  const [error, setError] = useState<string | null>(null);
  const linked = !!initial?.performanceId || !!f.performanceId;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const d = (v: string) => (v ? new Date(v).toISOString() : null);
    const body: Record<string, unknown> = { description: f.description.trim() || null, capacity: f.capacity === '' ? null : Number(f.capacity), status: f.status, publicSale: f.publicSale, salesOpenAt: d(f.salesOpenAt), salesCloseAt: d(f.salesCloseAt), maxPerOrder: Number(f.maxPerOrder) };
    if (f.performanceId) body.performanceId = f.performanceId;
    else { body.title = f.title; if (!initial?.performanceId) { body.startAt = d(f.startAt); body.venue = f.venue.trim() || null; } }
    if (f.performanceId && f.capacity === '') delete body.capacity;
    try {
      const r = initial ? await api.patch<{ id: string }>(`/tickets/events/${initial.id}`, body) : await api.post<{ id: string }>('/tickets/events', body);
      qc.invalidateQueries({ queryKey: ['tickets'] });
      onSaved(r.id);
      onClose();
    } catch (err) { setError(errorMessage(err)); }
  };
  return (
    <Modal open title={initial ? 'Réglages de la séance' : 'Nouvelle séance'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="ev-form">Enregistrer</button></>}>
      <form id="ev-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        {!initial && !!perfs.data?.length && (
          <Field label="Représentation de Show" className="full" hint="Facultatif : la date et le lieu suivront alors la représentation.">{(id, dsc) => (
            <select id={id} value={f.performanceId} onChange={set('performanceId')} aria-describedby={dsc}>
              <option value="">— Séance autonome (concert, bal, conférence…)</option>
              {perfs.data.map((p) => <option key={p.id} value={p.id}>{p.show} — {formatDate(p.startAt, true)}{p.venue ? ` · ${p.venue}` : ''}</option>)}
            </select>
          )}</Field>
        )}
        {!f.performanceId && <Field label="Titre" className="full">{(id) => <input id={id} type="text" required maxLength={200} value={f.title} onChange={set('title')} autoFocus />}</Field>}
        {!linked && <>
          <Field label="Date et heure">{(id) => <input id={id} type="datetime-local" required value={f.startAt} onChange={set('startAt')} />}</Field>
          <Field label="Lieu">{(id) => <input id={id} type="text" maxLength={200} value={f.venue} onChange={set('venue')} />}</Field>
        </>}
        {initial?.performanceId && <div className="full"><Alert>Date et lieu suivent la représentation de « {initial.show?.title} » dans Show.</Alert></div>}
        <Field label="Jauge" hint={f.performanceId ? 'Vide : celle de la représentation ou du lieu.' : 'Vide : sans limite.'}>{(id, dsc) => <input id={id} type="number" min={0} value={f.capacity} onChange={set('capacity')} aria-describedby={dsc} />}</Field>
        <Field label="État">{(id) => <select id={id} value={f.status} onChange={set('status')}>{Object.entries(EV_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        <label className="check full"><input type="checkbox" checked={f.publicSale} onChange={(e) => setF({ ...f, publicSale: e.target.checked })} /> Réservation en ligne sur la page publique (règlement sur place)</label>
        {f.publicSale && <>
          <Field label="Ouverture des ventes en ligne" hint="Vide : dès la mise en vente.">{(id, dsc) => <input id={id} type="datetime-local" value={f.salesOpenAt} onChange={set('salesOpenAt')} aria-describedby={dsc} />}</Field>
          <Field label="Clôture des ventes en ligne" hint="Vide : jusqu’au début.">{(id, dsc) => <input id={id} type="datetime-local" value={f.salesCloseAt} onChange={set('salesCloseAt')} aria-describedby={dsc} />}</Field>
          <Field label="Billets par réservation (max.)">{(id) => <input id={id} type="number" min={1} max={100} value={f.maxPerOrder} onChange={set('maxPerOrder')} />}</Field>
        </>}
        <Field label="Présentation" className="full">{(id) => <textarea id={id} rows={3} maxLength={4000} value={f.description} onChange={set('description')} />}</Field>
        {!initial && <p className="small muted full">Tarifs créés d’office : plein (10 €), réduit (7 €) et invitation (guichet uniquement) — modifiables ensuite.</p>}
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Séance */

export function EventPage() {
  const { id } = useParams();
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tickets', 'event', id], queryFn: () => api.get<EventDetail>(`/tickets/events/${id}`) });
  const [tab, setTab] = useState<'guichet' | 'commandes' | 'tarifs'>(can('tickets.orders.create') ? 'guichet' : 'commandes');
  const [edit, setEdit] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const e = q.data!;
  const refresh = () => qc.invalidateQueries({ queryKey: ['tickets'] });
  const setStatus = (status: EvStatus) => api.patch(`/tickets/events/${e.id}`, { status }).then(() => { refresh(); toast(`Séance : ${EV_STATUS[status][0].toLowerCase()}.`); }, (err) => toast(errorMessage(err), 'error'));
  const remaining = e.capacity == null ? null : Math.max(0, e.capacity - e.sold);
  return (
    <>
      <Breadcrumb items={crumbs(e.title)} />
      <PageHead title={e.title} description={`${formatDate(e.startAt, true)}${e.venue ? ` · ${e.venue}` : ''}${e.show ? ` · représentation de « ${e.show.title} »` : ''}`}
        actions={<>
          {can('tickets.events.update') && e.status !== 'on_sale' && e.status !== 'cancelled' && <button className="btn" type="button" onClick={() => setStatus('on_sale')}>Mettre en vente</button>}
          {can('tickets.events.update') && e.status === 'on_sale' && <button className="btn secondary" type="button" onClick={() => setStatus('closed')}>Clore les ventes</button>}
          {e.features.scan && <Link className="btn secondary" to={`/scan/${e.id}`}>Contrôle des entrées</Link>}
          {can('tickets.events.update') && <button className="btn secondary" type="button" onClick={() => setEdit(true)}>Réglages</button>}
          {can('tickets.events.delete') && <button className="btn danger" type="button" onClick={() => deleteWithConfirm(`/tickets/events/${e.id}`, `Supprimer la séance « ${e.title} » ?`).then((r) => { if (r) { refresh(); toast('Séance supprimée.'); navigate('/tickets'); } }, (err) => toast(errorMessage(err), 'error'))}>Supprimer</button>}
        </>} />
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <div className="card stack" style={{ gap: 6 }}><span className="small muted">Remplissage</span><Gauge sold={e.sold} capacity={e.capacity} /></div>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">Encaissé</span><strong style={{ fontSize: 22 }}>{money(e.revenueCents)}</strong><span className="small">{Object.entries(e.byMethod).map(([k, v]) => `${PAYMENT[k]} ${money(v)}`).join(' · ') || '—'}</span></div>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">À régler sur place</span><strong style={{ fontSize: 22 }}>{money(e.pendingCents)}</strong></div>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">Entrées</span><strong style={{ fontSize: 22 }}>{e.scanned} / {e.sold}</strong></div>
      </div>
      {e.publicSale && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone={e.status === 'on_sale' ? 'success' : 'info'}>
            Réservation en ligne {e.status === 'on_sale' ? 'ouverte' : 'active dès la mise en vente'} : <a href={e.publicUrl} target="_blank" rel="noreferrer">{e.publicUrl}</a>{' '}
            <button className="btn ghost sm" type="button" onClick={() => navigator.clipboard?.writeText(e.publicUrl).then(() => toast('Lien copié.'))}>Copier le lien</button>
          </Alert>
        </div>
      )}
      <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
        {can('tickets.orders.create') && <button type="button" role="tab" aria-selected={tab === 'guichet'} className={`tab${tab === 'guichet' ? ' active' : ''}`} onClick={() => setTab('guichet')}>Guichet</button>}
        <button type="button" role="tab" aria-selected={tab === 'commandes'} className={`tab${tab === 'commandes' ? ' active' : ''}`} onClick={() => setTab('commandes')}>Commandes</button>
        <button type="button" role="tab" aria-selected={tab === 'tarifs'} className={`tab${tab === 'tarifs' ? ' active' : ''}`} onClick={() => setTab('tarifs')}>Tarifs ({e.rates.length})</button>
      </div>
      {tab === 'guichet' && <BoxOffice event={e} remaining={remaining} onSold={() => { refresh(); setTab('guichet'); }} />}
      {tab === 'commandes' && <OrdersTab event={e} />}
      {tab === 'tarifs' && <RatesTab event={e} />}
      {edit && <EventForm initial={e} onClose={() => setEdit(false)} onSaved={() => toast('Séance enregistrée.')} />}
    </>
  );
}

function BoxOffice({ event: e, remaining, onSold }: { event: EventDetail; remaining: number | null; onSold: () => void }) {
  const { toast } = useApp();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [buyer, setBuyer] = useState({ name: '', email: '', phone: '', send: false });
  const [pay, setPay] = useState<'cash' | 'card' | 'cheque' | 'transfer' | 'other' | 'pending'>('cash');
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ id: string; number: string; totalCents: number; url: string } | null>(null);
  const total = e.rates.reduce((n, r) => n + (qty[r.id] ?? 0) * r.priceCents, 0);
  const count = Object.values(qty).reduce((a, b) => a + b, 0);
  const onlyInvites = count > 0 && e.rates.every((r) => !(qty[r.id] ?? 0) || r.priceCents === 0);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    try {
      const o = await api.post<{ id: string; number: string; totalCents: number; url: string; emailStatus: string | null }>(`/tickets/events/${e.id}/orders`, {
        lines: Object.entries(qty).filter(([, n]) => n > 0).map(([rateId, quantity]) => ({ rateId, quantity })),
        buyerName: buyer.name.trim() || 'Vente au guichet', buyerEmail: buyer.email.trim() || null, buyerPhone: buyer.phone.trim() || null,
        status: pay === 'pending' ? 'pending' : 'paid', paymentMethod: pay === 'pending' ? null : pay, send: buyer.send && !!buyer.email.trim(),
      });
      setLast(o);
      setQty({});
      setBuyer({ name: '', email: '', phone: '', send: false });
      onSold();
      toast(`Vente ${o.number} enregistrée${o.emailStatus === 'sent' ? ', billets envoyés' : ''}.`);
    } catch (err) { setError(errorMessage(err)); }
  };
  const step = (id: string, d: number) => setQty({ ...qty, [id]: Math.max(0, (qty[id] ?? 0) + d) });
  if (e.status === 'cancelled') return <Alert tone="warning">Séance annulée : la vente est fermée.</Alert>;
  return (
    <form className="grid-2" style={{ alignItems: 'start' }} onSubmit={submit}>
      <section className="card">
        <h2>Billets</h2>
        {remaining != null && <p className="small muted">{remaining} place(s) restante(s).</p>}
        <div className="stack" style={{ gap: 8 }}>
          {e.rates.map((r) => {
            const left = r.quota == null ? null : r.quota - r.sold;
            return (
              <div key={r.id} className="row between box-line">
                <div><strong>{r.name}</strong> <span className="muted">{priceLabel(r.priceCents)}</span>{left != null && <div className="small muted">{left} au quota</div>}</div>
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <button className="btn secondary sm" type="button" aria-label={`Retirer un billet ${r.name}`} onClick={() => step(r.id, -1)}>−</button>
                  <input type="number" min={0} aria-label={`Nombre de billets ${r.name}`} value={qty[r.id] ?? 0} onChange={(x) => setQty({ ...qty, [r.id]: Math.max(0, Number(x.target.value) || 0) })} style={{ width: 64, textAlign: 'center' }} />
                  <button className="btn secondary sm" type="button" aria-label={`Ajouter un billet ${r.name}`} onClick={() => step(r.id, 1)}>+</button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="row between" style={{ marginTop: 16, fontSize: 20 }}><span>{count} billet(s)</span><strong>{money(total)}</strong></div>
      </section>
      <section className="card stack" style={{ gap: 12 }}>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <Field label="Nom de l’acheteur" hint="Facultatif au guichet.">{(id, d) => <input id={id} type="text" maxLength={120} value={buyer.name} onChange={(x) => setBuyer({ ...buyer, name: x.target.value })} aria-describedby={d} />}</Field>
        <div className="form-grid">
          <Field label="E-mail">{(id) => <input id={id} type="email" value={buyer.email} onChange={(x) => setBuyer({ ...buyer, email: x.target.value })} />}</Field>
          <Field label="Téléphone">{(id) => <input id={id} type="tel" maxLength={40} value={buyer.phone} onChange={(x) => setBuyer({ ...buyer, phone: x.target.value })} />}</Field>
        </div>
        {buyer.email.trim() && <label className="check"><input type="checkbox" checked={buyer.send} onChange={(x) => setBuyer({ ...buyer, send: x.target.checked })} /> Envoyer les billets par e-mail</label>}
        {!onlyInvites && total > 0 && (
          <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: 6 }}>Règlement</legend>
            <div className="row" style={{ gap: 6 }}>
              {(['cash', 'card', 'cheque', 'transfer', 'other', 'pending'] as const).map((k) => (
                <button key={k} type="button" className={`btn sm ${pay === k ? '' : 'secondary'}`} aria-pressed={pay === k} onClick={() => setPay(k)}>{k === 'pending' ? 'À régler plus tard' : PAYMENT[k]}</button>
              ))}
            </div>
          </fieldset>
        )}
        <button className="btn" type="submit" disabled={!count} style={{ minHeight: 52, fontSize: 18 }}>{total > 0 && pay !== 'pending' ? `Encaisser ${money(total)}` : 'Émettre les billets'}</button>
        {last && (
          <Alert tone="success">
            Commande {last.number} ({money(last.totalCents)}).{' '}
            <button className="btn ghost sm" type="button" onClick={() => api.download(`/tickets/orders/${last.id}/tickets.pdf`, `billets-${last.number}.pdf`).catch((x) => toast(errorMessage(x), 'error'))}>Imprimer les billets</button>
            <a className="btn ghost sm" href={last.url} target="_blank" rel="noreferrer">Billets à l’écran</a>
          </Alert>
        )}
      </section>
    </form>
  );
}

function OrdersTab({ event: e }: { event: EventDetail }) {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const params = new URLSearchParams();
  if (search.trim()) params.set('q', search.trim());
  if (status) params.set('status', status);
  const q = useQuery({ queryKey: ['tickets', 'orders', e.id, params.toString()], queryFn: () => api.get<Order[]>(`/tickets/events/${e.id}/orders?${params}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tickets'] });
  return (
    <>
      <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
        <Field label="Recherche" className="grow">{(id) => <input id={id} type="search" placeholder="Nom, e-mail, n° de commande, code du billet…" value={search} onChange={(x) => setSearch(x.target.value)} />}</Field>
        <Field label="État">{(id) => <select id={id} value={status} onChange={(x) => setStatus(x.target.value)}><option value="">Toutes</option>{Object.entries(ORDER_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        {can('tickets.orders.export') && <button className="btn secondary" type="button" onClick={() => api.download(`/tickets/events/${e.id}/attendees.csv`, 'spectateurs.csv').catch((x) => toast(errorMessage(x), 'error'))}>Liste des spectateurs (CSV)</button>}
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Commande</th><th>Acheteur</th><th>Billets</th><th>Montant</th><th>Règlement</th><th>Canal</th><th>État</th></tr></thead>
            <tbody>
              {q.data!.map((o) => (
                <tr key={o.id}>
                  <td><button className="linklike" type="button" onClick={() => setOpen(o.id)}>{o.number}</button><div className="small muted">{formatDate(o.createdAt, true)}</div></td>
                  <td>{o.buyerName}{o.buyerEmail && <div className="small muted">{o.buyerEmail}</div>}</td>
                  <td>{o.tickets}{o.scanned > 0 && <span className="small muted"> · {o.scanned} entré(s)</span>}</td>
                  <td>{money(o.totalCents)}</td>
                  <td className="small">{o.paymentMethod ? PAYMENT[o.paymentMethod] : '—'}{o.refundedAt && ' · remboursée'}</td>
                  <td className="small">{CHANNEL[o.channel]}</td>
                  <td><Badge tone={ORDER_STATUS[o.status][1]}>{ORDER_STATUS[o.status][0]}</Badge></td>
                </tr>
              ))}
              {!q.data!.length && <tr><td colSpan={7} className="empty">Aucune commande.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {open && <OrderModal id={open} onClose={() => setOpen(null)} onChanged={refresh} />}
    </>
  );
}

function OrderModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, toast } = useApp();
  const q = useQuery({ queryKey: ['tickets', 'order', id], queryFn: () => api.get<Order & { url: string; tickets: Ticket[] }>(`/tickets/orders/${id}`) });
  const [pay, setPay] = useState('cash');
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { onChanged(); q.refetch(); toast(msg); }, (e) => toast(errorMessage(e), 'error'));
  if (!q.data) return <Modal open title="Commande" onClose={onClose}>{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Modal>;
  const o = q.data;
  const cancel = () => {
    const refund = o.status === 'paid' && o.totalCents > 0 && can('tickets.orders.refund') && window.confirm(`Rembourser ${money(o.totalCents)} à ${o.buyerName} ? (OK = annuler et noter le remboursement, Annuler = annuler sans remboursement)`);
    if (!window.confirm(`Annuler la commande ${o.number} ? Ses billets ne seront plus valides.`)) return;
    act(api.post(`/tickets/orders/${o.id}/cancel`, { refund }), refund ? 'Commande annulée et remboursement noté.' : 'Commande annulée.');
  };
  return (
    <Modal open title={`Commande ${o.number}`} onClose={onClose} footer={<button className="btn secondary" type="button" onClick={onClose}>Fermer</button>}>
      <div className="stack" style={{ gap: 12 }}>
        <dl className="props">
          <dt>Acheteur</dt><dd>{o.buyerName}{o.buyerEmail && ` · ${o.buyerEmail}`}{o.buyerPhone && ` · ${o.buyerPhone}`}</dd>
          <dt>Montant</dt><dd>{money(o.totalCents)} — <Badge tone={ORDER_STATUS[o.status][1]}>{ORDER_STATUS[o.status][0]}</Badge>{o.paymentMethod && ` · ${PAYMENT[o.paymentMethod]}`}{o.refundedAt && ` · remboursée le ${formatDate(o.refundedAt)}`}</dd>
          <dt>Canal</dt><dd>{CHANNEL[o.channel]} · {formatDate(o.createdAt, true)}</dd>
          {o.emailStatus && <><dt>E-mail</dt><dd className="small">{o.emailStatus === 'sent' ? 'Billets envoyés' : o.emailStatus === 'no_email' ? '—' : o.emailStatus}</dd></>}
        </dl>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Tarif</th><th>Prix</th><th>Porteur</th><th>État</th><th className="actions">Actions</th></tr></thead>
            <tbody>{o.tickets.map((t) => (
              <tr key={t.id}>
                <td>{t.rateName}</td><td>{priceLabel(t.priceCents)}</td><td className="small">{t.holderName ?? '—'}</td>
                <td>{t.status === 'cancelled' ? <Badge>Annulé</Badge> : t.scannedAt ? <Badge tone="success">Entré {new Date(t.scannedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</Badge> : <Badge tone="info">Valide</Badge>}</td>
                <td className="actions">{t.status === 'valid' && can('tickets.orders.cancel') && o.tickets.filter((x) => x.status === 'valid').length > 1 && <button className="btn ghost sm" type="button" onClick={() => window.confirm(`Annuler ce billet « ${t.rateName} » ? La place est libérée et le montant recalculé.`) && act(api.post(`/tickets/tickets/${t.id}/cancel`), 'Billet annulé.')}>Annuler</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {o.status === 'pending' && can('tickets.orders.update') && <>
            <select aria-label="Mode de règlement" value={pay} onChange={(x) => setPay(x.target.value)} style={{ width: 'auto' }}>{Object.entries(PAYMENT).filter(([k]) => k !== 'free').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <button className="btn sm" type="button" onClick={() => act(api.post(`/tickets/orders/${o.id}/pay`, { paymentMethod: pay }), 'Règlement enregistré.')}>Encaisser {money(o.totalCents)}</button>
          </>}
          {can('tickets.orders.download') && <button className="btn secondary sm" type="button" onClick={() => api.download(`/tickets/orders/${o.id}/tickets.pdf`, `billets-${o.number}.pdf`).catch((x) => toast(errorMessage(x), 'error'))}>PDF des billets</button>}
          <a className="btn secondary sm" href={o.url} target="_blank" rel="noreferrer">Lien de l’acheteur</a>
          {o.buyerEmail && o.status !== 'cancelled' && can('tickets.orders.update') && <button className="btn secondary sm" type="button" onClick={() => act(api.post(`/tickets/orders/${o.id}/send`), 'Billets envoyés.')}>Envoyer par e-mail</button>}
          {o.status !== 'cancelled' && can('tickets.orders.cancel') && <button className="btn ghost sm" type="button" onClick={cancel}>Annuler la commande</button>}
          {can('tickets.orders.delete') && <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm(`/tickets/orders/${o.id}`, `Supprimer définitivement la commande ${o.number} et ses billets ? (Pour garder une trace, préférez « Annuler la commande ».)`).then((r) => { if (r) { onChanged(); toast('Commande supprimée.'); onClose(); } }, (x) => toast(errorMessage(x), 'error'))}>Supprimer</button>}
        </div>
      </div>
    </Modal>
  );
}

function RatesTab({ event: e }: { event: EventDetail }) {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ id?: string; name: string; price: string; quota: string; publicVisible: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tickets'] });
  const save = async (x: FormEvent) => {
    x.preventDefault();
    if (!form) return;
    setError(null);
    const priceCents = form.price.trim() ? toCents(form.price) : 0;
    if (Number.isNaN(priceCents)) return setError('Prix invalide.');
    const body = { name: form.name, priceCents, quota: form.quota === '' ? null : Number(form.quota), publicVisible: form.publicVisible };
    try {
      if (form.id) await api.patch(`/tickets/rates/${form.id}`, body); else await api.post(`/tickets/events/${e.id}/rates`, body);
      refresh();
      setForm(null);
      toast('Tarif enregistré.');
    } catch (err) { setError(errorMessage(err)); }
  };
  const edit = can('tickets.events.update');
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Tarif</th><th>Prix</th><th>Quota</th><th>Vendus</th><th>En ligne</th><th className="actions">{edit && <button className="btn sm" type="button" onClick={() => setForm({ name: '', price: '', quota: '', publicVisible: true })}>Ajouter un tarif</button>}</th></tr></thead>
          <tbody>
            {e.rates.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td><td>{priceLabel(r.priceCents)}</td><td>{r.quota ?? '—'}</td><td>{r.sold}</td><td>{r.publicVisible ? 'Oui' : <span className="muted">Guichet seul</span>}</td>
                <td className="actions">{edit && <>
                  <button className="btn ghost sm" type="button" onClick={() => setForm({ id: r.id, name: r.name, price: fromCents(r.priceCents), quota: r.quota == null ? '' : String(r.quota), publicVisible: r.publicVisible })}>Modifier</button>{' '}
                  <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm(`/tickets/rates/${r.id}`, `Supprimer le tarif « ${r.name} » ?`).then((x) => { if (x) { refresh(); toast('Tarif supprimé.'); } }, (err) => toast(errorMessage(err), 'error'))}>Supprimer</button>
                </>}</td>
              </tr>
            ))}
            {!e.rates.length && <tr><td colSpan={6} className="empty">Aucun tarif : ajoutez-en un pour vendre.</td></tr>}
          </tbody>
        </table>
      </div>
      {form && (
        <Modal open title={form.id ? 'Modifier le tarif' : 'Nouveau tarif'} onClose={() => setForm(null)} footer={<><button className="btn secondary" type="button" onClick={() => setForm(null)}>Annuler</button><button className="btn" type="submit" form="rate-form">Enregistrer</button></>}>
          <form id="rate-form" className="form-grid" onSubmit={save}>
            {error && <div className="alert danger full" role="alert">{error}</div>}
            <Field label="Nom" className="full">{(id) => <input id={id} type="text" required maxLength={80} value={form.name} onChange={(x) => setForm({ ...form, name: x.target.value })} placeholder="Plein, réduit, adhérent, enfant…" autoFocus />}</Field>
            <Field label="Prix (€)" hint="0 ou vide : gratuit.">{(id, d) => <input id={id} type="text" inputMode="decimal" value={form.price} onChange={(x) => setForm({ ...form, price: x.target.value })} aria-describedby={d} />}</Field>
            <Field label="Quota" hint="Vide : selon la jauge.">{(id, d) => <input id={id} type="number" min={0} value={form.quota} onChange={(x) => setForm({ ...form, quota: x.target.value })} aria-describedby={d} />}</Field>
            <label className="check full"><input type="checkbox" checked={form.publicVisible} onChange={(x) => setForm({ ...form, publicVisible: x.target.checked })} /> Proposé en ligne (sinon guichet uniquement)</label>
            {form.id && <p className="small muted full">Les billets déjà vendus gardent leur prix.</p>}
          </form>
        </Modal>
      )}
    </>
  );
}
