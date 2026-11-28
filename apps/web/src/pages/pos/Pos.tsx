import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, deleteWithConfirm, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';

/* --------------------------------------------------------------- Types */

type Method = 'cash' | 'card' | 'cheque' | 'other';
interface Register { id: string; name: string; color: string | null; ticketSales: boolean; archivedAt: string | null; session: { id: string; number: number; openedAt: string; openedBy: string | null; sales: number; totalCents: number } | null }
interface Category { id: string; name: string; color: string | null; position: number }
interface Product { id: string; name: string; priceCents: number; categoryId: string | null; color: string | null; stockItemId: string | null; stockUnits: number; active: boolean; position: number; stock: { name: string; quantity: number; unit: string | null } | null }
interface Catalog { categories: Category[]; products: Product[]; stockSync: boolean; ticketSales: boolean }
interface ScreenData {
  session: { id: string; number: number; status: string; register: string; openedAt: string; sales: number; totalCents: number };
  categories: Category[]; products: Product[];
  events: { id: string; title: string; startAt: string; remaining: number | null; rates: { id: string; name: string; priceCents: number }[] }[];
  recent: Sale[];
}
interface Sale { id: string; number: string; totalCents: number; status: 'completed' | 'voided'; voidReason: string | null; createdAt: string; seller?: string | null; methods?: string[] }
interface Summary {
  salesCount: number; totalCents: number; voidedCount: number; voidedCents: number; averageCents: number; byMethod: Record<string, number>;
  products: { name: string; category: string | null; kind: string; qty: number; cents: number }[];
  moves: { id: number; kind: 'in' | 'out'; amountCents: number; reason: string | null; createdAt: string }[];
  cashIn: number; cashOut: number; expectedCashCents: number;
}
interface SessionDetail {
  id: string; number: number; status: 'open' | 'closed'; register: string; registerId: string; openedAt: string; openedByName: string | null; closedAt: string | null;
  openingFloatCents: number; expectedCashCents: number | null; countedCashCents: number | null; notes: string | null; summary: Summary; sales: Sale[]; denominations: number[];
}
type NewLine = { key: string; name: string; unitPriceCents: number } & ({ productId: string } | { ticketRateId: string; eventId: string } | { custom: string });
type CartLine = NewLine & { quantity: number };

export const METHOD: Record<Method, string> = { cash: 'Espèces', card: 'Carte', cheque: 'Chèque', other: 'Autre' };
const money = (c: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);
const toCents = (v: string) => Math.round(Number(v.replace(/\s/g, '').replace(',', '.')) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const crumbs = (label: string) => [{ label: 'Scenorya POS', to: '/pos' }, { label }];
const hm = (d: string) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/* ---------------------------------------------------------- Accueil : caisses */

export function PosHome() {
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['pos', 'registers'], queryFn: () => api.get<Register[]>('/pos/registers'), refetchInterval: 20_000 });
  const [opening, setOpening] = useState<Register | null>(null);
  const [float, setFloat] = useState('50,00');
  const [error, setError] = useState<string | null>(null);
  const open = async (e: FormEvent) => {
    e.preventDefault();
    if (!opening) return;
    setError(null);
    const c = float.trim() ? toCents(float) : 0;
    if (Number.isNaN(c)) return setError('Montant invalide.');
    try {
      const s = await api.post<{ id: string }>(`/pos/registers/${opening.id}/open`, { openingFloatCents: c });
      toast(`Caisse « ${opening.name} » ouverte.`);
      navigate(`/pos/caisse/${s.id}`);
    } catch (err) { setError(errorMessage(err)); }
  };
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya POS' }]} />
      <PageHead title="Caisses" description="Buvette, bar, accueil : ouvrez une caisse pour vendre, clôturez-la en fin de soirée." actions={can('pos.catalog.update') && <Link className="btn secondary" to="/pos/catalogue">Caisses et produits</Link>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data!.length === 0 ? (
        <div className="card empty">Aucune caisse. {can('pos.catalog.update') ? <Link to="/pos/catalogue">Créez une caisse et vos produits</Link> : 'Demandez à un responsable de créer une caisse.'}</div>
      ) : (
        <div className="grid-3">
          {q.data!.map((r) => (
            <section key={r.id} className="card stack" style={{ gap: 10, borderTop: `4px solid ${r.color ?? 'var(--blue)'}` }}>
              <div className="row between"><h2 style={{ margin: 0 }}>{r.name}</h2>{r.session ? <Badge tone="success">Ouverte</Badge> : <Badge>Fermée</Badge>}</div>
              {r.session ? (
                <>
                  <span className="small">Session n° {r.session.number} · ouverte à {hm(r.session.openedAt)}{r.session.openedBy ? ` par ${r.session.openedBy}` : ''}</span>
                  <strong style={{ fontSize: 22 }}>{money(r.session.totalCents)} <span className="small muted">· {r.session.sales} vente(s)</span></strong>
                  <div className="row" style={{ gap: 8 }}>
                    {can('pos.sales.create') && <Link className="btn" to={`/pos/caisse/${r.session.id}`}>Accéder à la caisse</Link>}
                    {can('pos.sessions.read') && <Link className="btn secondary" to={`/pos/sessions/${r.session.id}`}>Clôturer</Link>}
                  </div>
                </>
              ) : (
                <>
                  <span className="small muted">Prête à ouvrir.</span>
                  {can('pos.sessions.create') && <button className="btn" type="button" onClick={() => { setError(null); setOpening(r); }}>Ouvrir la caisse</button>}
                </>
              )}
            </section>
          ))}
        </div>
      )}
      {can('pos.sessions.read') && <p style={{ marginTop: 16 }}><Link to="/pos/sessions">Historique des sessions et rapports de clôture</Link></p>}
      {opening && (
        <Modal open title={`Ouvrir « ${opening.name} »`} onClose={() => setOpening(null)} footer={<><button className="btn secondary" type="button" onClick={() => setOpening(null)}>Annuler</button><button className="btn" type="submit" form="open-form">Ouvrir</button></>}>
          <form id="open-form" className="stack" onSubmit={open}>
            {error && <div className="alert danger" role="alert">{error}</div>}
            <Field label="Fond de caisse (€)" hint="Espèces présentes dans le tiroir à l’ouverture.">{(id, d) => <input id={id} type="text" inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} aria-describedby={d} autoFocus />}</Field>
          </form>
        </Modal>
      )}
    </>
  );
}

/* ---------------------------------------------------------- Écran de caisse */

export function PosScreen() {
  const { id = '' } = useParams();
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pos', 'screen', id], queryFn: () => api.get<ScreenData>(`/pos/sessions/${id}/screen`) });
  const [tab, setTab] = useState<string>('all');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [pay, setPay] = useState(false);
  const [custom, setCustom] = useState(false);
  const [done, setDone] = useState<{ id: string; number: string; totalCents: number; changeCents: number; shortages: string[]; ticketOrder: { url: string; number: string } | null } | null>(null);
  const total = cart.reduce((a, l) => a + l.unitPriceCents * l.quantity, 0);
  const add = (line: NewLine) => setCart((c) => {
    if ('ticketRateId' in line && c.some((x) => 'eventId' in x && x.eventId !== line.eventId)) { toast('Une vente ne porte que sur les billets d’une seule séance.', 'error'); return c; }
    const i = c.findIndex((x) => x.key === line.key);
    if (i >= 0) return c.map((x, j) => (j === i ? { ...x, quantity: x.quantity + 1 } : x));
    return [...c, { ...line, quantity: 1 }];
  });
  const setQty = (key: string, qn: number) => setCart((c) => (qn <= 0 ? c.filter((x) => x.key !== key) : c.map((x) => (x.key === key ? { ...x, quantity: qn } : x))));
  const products = useMemo(() => (q.data?.products ?? []).filter((p) => tab === 'all' || p.categoryId === tab), [q.data, tab]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  if (d.session.status !== 'open') return <><Breadcrumb items={crumbs(d.session.register)} /><Alert tone="warning">Cette session est close. <Link to="/pos">Retour aux caisses</Link></Alert></>;
  const cats = d.categories.filter((c) => d.products.some((p) => p.categoryId === c.id));
  const color = (p: Product) => p.color ?? d.categories.find((c) => c.id === p.categoryId)?.color ?? null;
  const voidSale = (s: Sale) => {
    const reason = window.prompt(`Annuler la vente ${s.number} (${money(s.totalCents)}) ? Motif :`, '');
    if (!reason?.trim()) return;
    api.post(`/pos/sales/${s.id}/void`, { reason }).then(() => { qc.invalidateQueries({ queryKey: ['pos'] }); qc.invalidateQueries({ queryKey: ['stock'] }); toast(`Vente ${s.number} annulée : rendez ${money(s.totalCents)} au client.`); }, (e) => toast(errorMessage(e), 'error'));
  };
  return (
    <div className="pos-screen">
      <div className="row between" style={{ marginBottom: 10 }}>
        <div><Breadcrumb items={crumbs(d.session.register)} /><h1 style={{ margin: 0 }}>{d.session.register} <span className="small muted">· session n° {d.session.number}</span></h1></div>
        <div className="row" style={{ gap: 8 }}>
          <span className="small">{d.session.sales} vente(s) · <strong>{money(d.session.totalCents)}</strong></span>
          {can('pos.sessions.read') && <Link className="btn secondary sm" to={`/pos/sessions/${d.session.id}`}>Session et clôture</Link>}
        </div>
      </div>
      <div className="pos-grid">
        <section className="stack" style={{ gap: 10 }}>
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'all'} className={`tab${tab === 'all' ? ' active' : ''}`} onClick={() => setTab('all')}>Tout</button>
            {cats.map((c) => <button key={c.id} type="button" role="tab" aria-selected={tab === c.id} className={`tab${tab === c.id ? ' active' : ''}`} onClick={() => setTab(c.id)}>{c.name}</button>)}
            {d.events.length > 0 && <button type="button" role="tab" aria-selected={tab === 'tickets'} className={`tab${tab === 'tickets' ? ' active' : ''}`} onClick={() => setTab('tickets')}>Billets</button>}
          </div>
          {tab === 'tickets' ? (
            <div className="stack" style={{ gap: 12 }}>
              {d.events.map((e) => (
                <div key={e.id}>
                  <h3 style={{ margin: '0 0 6px' }}>{e.title} <span className="small muted">· {formatDate(e.startAt, true)}{e.remaining != null ? ` · ${e.remaining} place(s)` : ''}</span></h3>
                  <div className="pos-keys">
                    {e.rates.map((r) => <button key={r.id} type="button" className="pos-key" disabled={e.remaining === 0} onClick={() => add({ key: `t:${r.id}`, name: `${r.name} — ${e.title}`, unitPriceCents: r.priceCents, ticketRateId: r.id, eventId: e.id })}><span>{r.name}</span><strong>{money(r.priceCents)}</strong></button>)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="pos-keys">
              {products.map((p) => (
                <button key={p.id} type="button" className="pos-key" style={color(p) ? { borderTopColor: color(p)! } : undefined} onClick={() => add({ key: `p:${p.id}`, name: p.name, unitPriceCents: p.priceCents, productId: p.id })}>
                  <span>{p.name}</span><strong>{money(p.priceCents)}</strong>
                  {p.stock && <small className={p.stock.quantity <= 0 ? 'out' : ''}>{p.stock.quantity <= 0 ? 'Rupture' : `${p.stock.quantity} en stock`}</small>}
                </button>
              ))}
              <button type="button" className="pos-key ghost" onClick={() => setCustom(true)}><span>Montant libre</span><strong>…</strong></button>
              {!products.length && <p className="muted">Aucun produit actif{can('pos.catalog.update') ? <> — <Link to="/pos/catalogue">ajoutez-en</Link></> : ''}.</p>}
            </div>
          )}
        </section>
        <aside className="card pos-cart">
          <h2 style={{ margin: 0 }}>Vente en cours</h2>
          <ul>
            {cart.map((l) => (
              <li key={l.key}>
                <span className="grow">{l.name}<br /><small className="muted">{money(l.unitPriceCents)}</small></span>
                <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  <button className="btn secondary sm" type="button" aria-label={`Retirer un ${l.name}`} onClick={() => setQty(l.key, l.quantity - 1)}>−</button>
                  <strong style={{ minWidth: 24, textAlign: 'center' }}>{l.quantity}</strong>
                  <button className="btn secondary sm" type="button" aria-label={`Ajouter un ${l.name}`} onClick={() => setQty(l.key, l.quantity + 1)}>+</button>
                </span>
                <strong style={{ minWidth: 72, textAlign: 'right' }}>{money(l.unitPriceCents * l.quantity)}</strong>
              </li>
            ))}
            {!cart.length && <li className="muted">Touchez un produit pour l’ajouter.</li>}
          </ul>
          <div className="pos-total"><span>Total</span><strong>{money(total)}</strong></div>
          <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <button className="btn secondary" type="button" disabled={!cart.length} onClick={() => setCart([])}>Vider</button>
            <button className="btn grow pos-pay" type="button" disabled={!cart.length} onClick={() => setPay(true)}>Encaisser</button>
          </div>
          {d.recent.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="small">Dernières ventes</summary>
              <ul className="pos-recent">
                {d.recent.map((s) => (
                  <li key={s.id} className={s.status === 'voided' ? 'muted' : ''}>
                    <span className="small">{hm(s.createdAt)} · {s.number}</span>
                    <span>{s.status === 'voided' ? <s>{money(s.totalCents)}</s> : money(s.totalCents)}</span>
                    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      <button className="btn ghost sm" type="button" onClick={() => api.download(`/pos/sales/${s.id}/receipt.pdf`, `ticket-${s.number}.pdf`).catch((e) => toast(errorMessage(e), 'error'))}>Ticket</button>
                      {s.status === 'completed' && can('pos.sales.cancel') && <button className="btn ghost sm" type="button" onClick={() => voidSale(s)}>Annuler</button>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </aside>
      </div>
      {custom && <CustomAmount onClose={() => setCustom(false)} onAdd={(name, cents) => add({ key: `c:${name}:${cents}:${Date.now()}`, name, unitPriceCents: cents, custom: name })} />}
      {pay && <PaymentModal total={total} cart={cart} sessionId={d.session.id} onClose={() => setPay(false)} onDone={(r) => { setPay(false); setCart([]); setDone(r); qc.invalidateQueries({ queryKey: ['pos'] }); qc.invalidateQueries({ queryKey: ['stock'] }); }} />}
      {done && (
        <Modal open title={`Vente ${done.number}`} onClose={() => setDone(null)} footer={<><button className="btn secondary" type="button" onClick={() => api.download(`/pos/sales/${done.id}/receipt.pdf`, `ticket-${done.number}.pdf`).catch((e) => toast(errorMessage(e), 'error'))}>Imprimer le ticket</button><button className="btn" type="button" autoFocus onClick={() => setDone(null)}>Vente suivante</button></>}>
          <div className="stack" style={{ gap: 12, textAlign: 'center' }}>
            <span>Total encaissé : <strong>{money(done.totalCents)}</strong></span>
            {done.changeCents > 0 && <div className="pos-change">Rendu : <strong>{money(done.changeCents)}</strong></div>}
            {done.shortages.length > 0 && <Alert tone="warning">Stock épuisé selon l’inventaire : {done.shortages.join(', ')}. Pensez à faire un comptage.</Alert>}
            {done.ticketOrder && <Alert tone="success">Billets émis (commande {done.ticketOrder.number}). <a href={done.ticketOrder.url} target="_blank" rel="noreferrer">Afficher les billets</a></Alert>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function CustomAmount({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string, cents: number) => void }) {
  const [name, setName] = useState('Divers');
  const [amount, setAmount] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = toCents(amount);
    if (Number.isNaN(c) || c < 0) return;
    onAdd(name.trim() || 'Divers', c);
    onClose();
  };
  return (
    <Modal open title="Montant libre" onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="custom-form">Ajouter</button></>}>
      <form id="custom-form" className="form-grid" onSubmit={submit}>
        <Field label="Libellé">{(id) => <input id={id} type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Montant (€)">{(id) => <input id={id} type="text" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />}</Field>
      </form>
    </Modal>
  );
}

function PaymentModal({ total, cart, sessionId, onClose, onDone }: { total: number; cart: CartLine[]; sessionId: string; onClose: () => void; onDone: (r: { id: string; number: string; totalCents: number; changeCents: number; shortages: string[]; ticketOrder: { url: string; number: string } | null }) => void }) {
  const [payments, setPayments] = useState<{ method: Method; amountCents: number; tenderedCents: number | null }[]>([]);
  const [tendered, setTendered] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const paid = payments.reduce((a, p) => a + p.amountCents, 0);
  const remaining = total - paid;
  const tenderedCents = tendered.trim() ? toCents(tendered) : null;
  const addPayment = (method: Method, given?: number) => {
    if (remaining <= 0) return;
    if (method === 'cash') {
      const t = given ?? (tenderedCents != null && !Number.isNaN(tenderedCents) ? tenderedCents : remaining);
      const amount = Math.min(t, remaining);
      setPayments([...payments, { method, amountCents: amount, tenderedCents: t }]);
      setTendered('');
    } else setPayments([...payments, { method, amountCents: remaining, tenderedCents: null }]);
  };
  const change = payments.reduce((a, p) => a + (p.method === 'cash' && p.tenderedCents != null ? p.tenderedCents - p.amountCents : 0), 0);
  const quick = [...new Set([remaining, Math.ceil(remaining / 500) * 500, Math.ceil(remaining / 1000) * 1000, Math.ceil(remaining / 2000) * 2000, 5000].filter((v) => v >= remaining && v > 0))].slice(0, 5);
  const submit = async () => {
    setError(null);
    setSending(true);
    try {
      const lines = cart.map((l) => ('productId' in l ? { productId: l.productId, quantity: l.quantity } : 'ticketRateId' in l ? { ticketRateId: l.ticketRateId, quantity: l.quantity } : { custom: l.custom, priceCents: l.unitPriceCents, quantity: l.quantity }));
      const r = await api.post<{ id: string; number: string; totalCents: number; changeCents: number; shortages: string[]; ticketOrder: { url: string; number: string } | null }>(`/pos/sessions/${sessionId}/sales`, { lines, payments: payments.filter((p) => p.amountCents > 0) });
      onDone(r);
    } catch (e) { setError(errorMessage(e)); setSending(false); }
  };
  return (
    <Modal open title={`Encaisser ${money(total)}`} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Retour</button><button className="btn" type="button" disabled={remaining !== 0 || sending} onClick={submit} style={{ minWidth: 160 }}>{sending ? 'Validation…' : 'Valider la vente'}</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <div className="pos-total"><span>{remaining > 0 ? 'Reste à payer' : 'Réglé'}</span><strong>{money(Math.max(0, remaining))}</strong></div>
        {total === 0 && <Alert>Vente gratuite : validez directement.</Alert>}
        {remaining > 0 && (
          <>
            <div className="stack" style={{ gap: 6 }}>
              <span className="small" style={{ fontWeight: 600 }}>Espèces remises</span>
              <div className="row" style={{ gap: 6 }}>
                {quick.map((v) => <button key={v} className="btn secondary pos-quick" type="button" onClick={() => addPayment('cash', v)}>{v === remaining ? 'Compte juste' : money(v)}</button>)}
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <input type="text" inputMode="decimal" aria-label="Autre montant remis en espèces" placeholder="Autre montant" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                <button className="btn secondary" type="button" disabled={tenderedCents == null || Number.isNaN(tenderedCents) || tenderedCents <= 0} onClick={() => addPayment('cash')}>Espèces</button>
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              {(['card', 'cheque', 'other'] as Method[]).map((m) => <button key={m} className="btn secondary pos-quick" type="button" onClick={() => addPayment(m)}>{METHOD[m]} {money(remaining)}</button>)}
            </div>
            <p className="small muted" style={{ margin: 0 }}>Règlement en plusieurs fois : saisissez d’abord les espèces remises (moins que le total), puis complétez par carte ou chèque.</p>
          </>
        )}
        {payments.length > 0 && (
          <ul className="stack" style={{ gap: 4, listStyle: 'none', padding: 0, margin: 0 }}>
            {payments.map((p, i) => (
              <li key={i} className="row between box-line">
                <span>{METHOD[p.method]} {money(p.amountCents)}{p.method === 'cash' && p.tenderedCents != null && p.tenderedCents !== p.amountCents ? <span className="small muted"> (remis {money(p.tenderedCents)})</span> : ''}</span>
                <button className="btn ghost sm" type="button" onClick={() => setPayments(payments.filter((_, j) => j !== i))}>Retirer</button>
              </li>
            ))}
          </ul>
        )}
        {change > 0 && <div className="pos-change">Rendu : <strong>{money(change)}</strong></div>}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- Sessions */

export function SessionsPage() {
  const q = useQuery({ queryKey: ['pos', 'sessions'], queryFn: () => api.get<(SessionDetail & { sales: number; totalCents: number; openedByName: string | null; closedByName: string | null; differenceCents: number | null })[]>('/pos/sessions') });
  return (
    <>
      <Breadcrumb items={crumbs('Historique')} />
      <PageHead title="Historique des caisses" description="Sessions ouvertes et clôturées, écarts de caisse et rapports de clôture." />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>N°</th><th>Caisse</th><th>Ouverture</th><th>Clôture</th><th>Ventes</th><th>Chiffre d’affaires</th><th>Écart d’espèces</th></tr></thead>
            <tbody>
              {q.data!.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/pos/sessions/${s.id}`}>{s.number}</Link></td>
                  <td>{s.register}</td>
                  <td className="small">{formatDate(s.openedAt, true)}{s.openedByName ? ` · ${s.openedByName}` : ''}</td>
                  <td className="small">{s.closedAt ? `${formatDate(s.closedAt, true)}${s.closedByName ? ` · ${s.closedByName}` : ''}` : <Badge tone="success">Ouverte</Badge>}</td>
                  <td>{s.sales}</td>
                  <td>{money(s.totalCents)}</td>
                  <td>{s.differenceCents == null ? '—' : s.differenceCents === 0 ? <Badge tone="success">Aucun</Badge> : <Badge tone="warning">{s.differenceCents > 0 ? '+' : '−'}{money(Math.abs(s.differenceCents))}</Badge>}</td>
                </tr>
              ))}
              {!q.data!.length && <tr><td colSpan={7} className="empty">Aucune session.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function SessionPage() {
  const { id = '' } = useParams();
  const { can, toast } = useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pos', 'session', id], queryFn: () => api.get<SessionDetail>(`/pos/sessions/${id}`), refetchInterval: 15_000 });
  const [closing, setClosing] = useState(false);
  const [move, setMove] = useState<{ kind: 'in' | 'out'; amount: string; reason: string } | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  const sum = s.summary;
  const refresh = () => qc.invalidateQueries({ queryKey: ['pos'] });
  const open = s.status === 'open';
  const diff = s.countedCashCents != null && s.expectedCashCents != null ? s.countedCashCents - s.expectedCashCents : null;
  const saveMove = async (e: FormEvent) => {
    e.preventDefault();
    if (!move) return;
    try { await api.post(`/pos/sessions/${id}/moves`, { kind: move.kind, amountCents: toCents(move.amount), reason: move.reason.trim() || null }); setMove(null); refresh(); toast('Mouvement enregistré.'); } catch (err) { toast(errorMessage(err), 'error'); }
  };
  return (
    <>
      <Breadcrumb items={crumbs(`Session n° ${s.number}`)} />
      <PageHead title={`${s.register} — session n° ${s.number}`} description={`Ouverte le ${formatDate(s.openedAt, true)}${s.openedByName ? ` par ${s.openedByName}` : ''}${s.closedAt ? ` · close le ${formatDate(s.closedAt, true)}` : ''}`}
        actions={<>
          {open && can('pos.sales.create') && <Link className="btn secondary" to={`/pos/caisse/${s.id}`}>Écran de caisse</Link>}
          {open && can('pos.sessions.update') && <button className="btn" type="button" onClick={() => setClosing(true)}>Clôturer la caisse</button>}
          {can('pos.sessions.download') && <button className="btn secondary" type="button" onClick={() => api.download(`/pos/sessions/${s.id}/report.pdf`, `cloture-caisse-${s.number}.pdf`).catch((e) => toast(errorMessage(e), 'error'))}>{open ? 'Rapport X (PDF)' : 'Rapport de clôture (PDF)'}</button>}
          {can('pos.sessions.export') && <button className="btn secondary" type="button" onClick={() => api.download(`/pos/sessions/${s.id}/sales.csv`, `ventes-caisse-${s.number}.csv`).catch((e) => toast(errorMessage(e), 'error'))}>Ventes (CSV)</button>}
          {!open && can('pos.sessions.delete') && <button className="btn danger" type="button" onClick={() => deleteWithConfirm(`/pos/sessions/${s.id}`, `Supprimer la session n° ${s.number} ?`).then((r) => { if (r) { refresh(); toast('Session supprimée.'); navigate('/pos/sessions'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
        </>} />
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">Chiffre d’affaires</span><strong style={{ fontSize: 22 }}>{money(sum.totalCents)}</strong><span className="small">{sum.salesCount} vente(s) · panier moyen {money(sum.averageCents)}</span></div>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">Règlements</span>{Object.entries(sum.byMethod).map(([m, c]) => <span key={m}>{METHOD[m as Method]} : <strong>{money(c)}</strong></span>)}{!Object.keys(sum.byMethod).length && <span>—</span>}</div>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">Espèces attendues</span><strong style={{ fontSize: 22 }}>{money(s.expectedCashCents ?? sum.expectedCashCents)}</strong><span className="small">fond {money(s.openingFloatCents)}{sum.cashIn ? ` + apports ${money(sum.cashIn)}` : ''}{sum.cashOut ? ` − retraits ${money(sum.cashOut)}` : ''}</span></div>
        <div className="card stack" style={{ gap: 4 }}><span className="small muted">{open ? 'Annulations' : 'Écart de caisse'}</span>{open ? <strong style={{ fontSize: 22 }}>{sum.voidedCount}</strong> : diff == null ? <span>Non compté</span> : <strong style={{ fontSize: 22, color: diff === 0 ? 'var(--success, #1a7f37)' : 'var(--danger)' }}>{diff === 0 ? 'Aucun' : `${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}`}</strong>}{!open && <span className="small">{sum.voidedCount} vente(s) annulée(s)</span>}</div>
      </div>
      {s.notes && <Alert>{s.notes}</Alert>}
      <div className="grid-2" style={{ alignItems: 'start', marginTop: 16 }}>
        <section className="card">
          <h2>Ventes par produit</h2>
          <div className="table-wrap"><table className="table"><thead><tr><th>Produit</th><th>Qté</th><th>Montant</th></tr></thead>
            <tbody>{sum.products.map((p) => <tr key={`${p.name}${p.category}`}><td>{p.name}{p.category && <span className="small muted"> · {p.category}</span>}</td><td>{p.qty}</td><td>{money(p.cents)}</td></tr>)}{!sum.products.length && <tr><td colSpan={3} className="empty">Aucune vente.</td></tr>}</tbody></table></div>
        </section>
        <section className="card">
          <div className="row between"><h2 style={{ margin: 0 }}>Mouvements d’espèces</h2>{open && can('pos.sessions.update') && <div className="row" style={{ gap: 6 }}><button className="btn secondary sm" type="button" onClick={() => setMove({ kind: 'out', amount: '', reason: 'Dépôt au coffre' })}>Retrait</button><button className="btn secondary sm" type="button" onClick={() => setMove({ kind: 'in', amount: '', reason: 'Monnaie' })}>Apport</button></div>}</div>
          <ul className="stack" style={{ gap: 4, listStyle: 'none', padding: 0, marginTop: 8 }}>
            {sum.moves.map((m) => (
              <li key={m.id} className="row between box-line">
                <span>{m.kind === 'in' ? 'Apport' : 'Retrait'} {money(m.amountCents)} <span className="small muted">· {hm(m.createdAt)}{m.reason ? ` · ${m.reason}` : ''}</span></span>
                {open && can('pos.sessions.update') && <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm(`/pos/sessions/${s.id}/moves/${m.id}`, 'Supprimer ce mouvement d’espèces ?').then((r) => { if (r) refresh(); }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
              </li>
            ))}
            {!sum.moves.length && <li className="muted">Aucun.</li>}
          </ul>
        </section>
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Journal des ventes</h2>
        <div className="table-wrap"><table className="table"><thead><tr><th>Heure</th><th>Ticket</th><th>Montant</th><th>Règlement</th><th>Vendeur</th><th>État</th><th className="actions">Actions</th></tr></thead>
          <tbody>
            {s.sales.map((x) => (
              <tr key={x.id}>
                <td className="small">{hm(x.createdAt)}</td><td>{x.number}</td><td>{money(x.totalCents)}</td>
                <td className="small">{x.methods?.map((m) => METHOD[m as Method]).join(' + ') || '—'}</td><td className="small">{x.seller ?? '—'}</td>
                <td>{x.status === 'voided' ? <Badge tone="warning">Annulée</Badge> : <Badge tone="success">Validée</Badge>}{x.voidReason && <div className="small muted">{x.voidReason}</div>}</td>
                <td className="actions"><button className="btn ghost sm" type="button" onClick={() => api.download(`/pos/sales/${x.id}/receipt.pdf`, `ticket-${x.number}.pdf`).catch((e) => toast(errorMessage(e), 'error'))}>Ticket</button>{open && x.status === 'completed' && can('pos.sales.cancel') && <button className="btn ghost sm" type="button" onClick={() => { const r = window.prompt(`Motif d’annulation de ${x.number} :`, ''); if (r?.trim()) api.post(`/pos/sales/${x.id}/void`, { reason: r }).then(() => { refresh(); toast('Vente annulée.'); }, (e) => toast(errorMessage(e), 'error')); }}>Annuler</button>}</td>
              </tr>
            ))}
            {!s.sales.length && <tr><td colSpan={7} className="empty">Aucune vente.</td></tr>}
          </tbody></table></div>
      </section>
      {move && (
        <Modal open title={move.kind === 'in' ? 'Apport d’espèces' : 'Retrait d’espèces'} onClose={() => setMove(null)} footer={<><button className="btn secondary" type="button" onClick={() => setMove(null)}>Annuler</button><button className="btn" type="submit" form="move-form">Enregistrer</button></>}>
          <form id="move-form" className="form-grid" onSubmit={saveMove}>
            <Field label="Montant (€)">{(fid) => <input id={fid} type="text" inputMode="decimal" required value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} autoFocus />}</Field>
            <Field label="Motif">{(fid) => <input id={fid} type="text" maxLength={200} value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} />}</Field>
          </form>
        </Modal>
      )}
      {closing && <CloseModal session={s} onClose={() => setClosing(false)} onDone={() => { setClosing(false); refresh(); toast('Caisse clôturée.'); }} />}
    </>
  );
}

function CloseModal({ session: s, onClose, onDone }: { session: SessionDetail; onClose: () => void; onDone: () => void }) {
  const [count, setCount] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const counted = s.denominations.reduce((a, v) => a + v * (Number(count[v]) || 0), 0);
  const expected = s.summary.expectedCashCents;
  const diff = counted - expected;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const cashCount = Object.fromEntries(s.denominations.filter((v) => Number(count[v]) > 0).map((v) => [String(v), Number(count[v])]));
    try { await api.post(`/pos/sessions/${s.id}/close`, { cashCount, notes: notes.trim() || null }); onDone(); } catch (err) { setError(errorMessage(err)); }
  };
  return (
    <Modal open title={`Clôturer « ${s.register} »`} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="close-form">Clôturer définitivement</button></>}>
      <form id="close-form" className="stack" style={{ gap: 12 }} onSubmit={submit}>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <p className="small" style={{ margin: 0 }}>Comptez les espèces du tiroir, coupure par coupure. Après clôture, les ventes ne peuvent plus être modifiées ni annulées.</p>
        <div className="cash-count">
          {s.denominations.map((v) => (
            <label key={v}><span>{v >= 500 ? `Billet ${v / 100} €` : v >= 100 ? `${v / 100} €` : `${v} c`}</span><input type="number" min={0} inputMode="numeric" value={count[v] ?? ''} placeholder="0" onChange={(e) => setCount({ ...count, [v]: e.target.value })} /></label>
          ))}
        </div>
        <div className="row between box-line"><span>Espèces attendues</span><strong>{money(expected)}</strong></div>
        <div className="row between box-line"><span>Espèces comptées</span><strong>{money(counted)}</strong></div>
        <div className="row between box-line"><span>Écart</span><strong style={{ color: diff === 0 ? 'var(--success, #1a7f37)' : 'var(--danger)' }}>{diff === 0 ? 'Aucun' : `${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}`}</strong></div>
        <Field label="Observations">{(id) => <textarea id={id} rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={diff !== 0 ? 'Expliquez l’écart si possible.' : ''} />}</Field>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Catalogue */

export function CatalogPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const regs = useQuery({ queryKey: ['pos', 'registers', 'all'], queryFn: () => api.get<Register[]>('/pos/registers?archived=1') });
  const cat = useQuery({ queryKey: ['pos', 'catalog'], queryFn: () => api.get<Catalog>('/pos/catalog') });
  const stock = useQuery({ queryKey: ['stock', 'items', 'pos'], queryFn: () => api.get<{ id: string; name: string; unit: string | null; quantity: number }[]>('/stock/items'), enabled: !!cat.data?.stockSync });
  const [reg, setReg] = useState<{ id?: string; name: string; color: string; ticketSales: boolean } | null>(null);
  const [categ, setCateg] = useState<{ id?: string; name: string; color: string; position: string } | null>(null);
  const [prod, setProd] = useState<{ id?: string; name: string; price: string; categoryId: string; color: string; stockItemId: string; stockUnits: string; active: boolean; position: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edit = can('pos.catalog.update');
  const refresh = () => qc.invalidateQueries({ queryKey: ['pos'] });
  const run = async (e: FormEvent, fn: () => Promise<unknown>, close: () => void) => {
    e.preventDefault();
    setError(null);
    try { await fn(); refresh(); close(); toast('Enregistré.'); } catch (err) { setError(errorMessage(err)); }
  };
  const del = (url: string, q: string) => deleteWithConfirm(url, q).then((r) => { if (r) { refresh(); toast('Supprimé.'); } }, (e) => toast(errorMessage(e), 'error'));
  if (cat.isLoading || regs.isLoading) return <Loading />;
  if (cat.error) return <ErrorBox error={cat.error} />;
  const c = cat.data!;
  const catName = (id: string | null) => c.categories.find((x) => x.id === id)?.name ?? '—';
  return (
    <>
      <Breadcrumb items={crumbs('Caisses et produits')} />
      <PageHead title="Caisses et produits" description="Les postes de vente et ce qu’on y vend." />
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="row between"><h2 style={{ margin: 0 }}>Caisses</h2>{edit && <button className="btn sm" type="button" onClick={() => { setError(null); setReg({ name: '', color: '#B52668', ticketSales: false }); }}>Nouvelle caisse</button>}</div>
        <div className="table-wrap" style={{ marginTop: 8 }}><table className="table"><thead><tr><th>Caisse</th><th>Billets</th><th>État</th><th className="actions">Actions</th></tr></thead>
          <tbody>
            {regs.data?.map((r) => (
              <tr key={r.id}>
                <td><span aria-hidden style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: r.color ?? 'var(--blue)', marginRight: 8 }} />{r.name}</td>
                <td className="small">{r.ticketSales ? (c.ticketSales ? 'Oui' : 'Oui (Tickets inactif)') : 'Non'}</td>
                <td>{r.archivedAt ? <Badge>Archivée</Badge> : r.session ? <Badge tone="success">Ouverte</Badge> : <Badge tone="info">Fermée</Badge>}</td>
                <td className="actions">{edit && <>
                  <button className="btn ghost sm" type="button" onClick={() => { setError(null); setReg({ id: r.id, name: r.name, color: r.color ?? '#B52668', ticketSales: r.ticketSales }); }}>Modifier</button>
                  <button className="btn ghost sm" type="button" onClick={() => api.patch(`/pos/registers/${r.id}`, { archived: !r.archivedAt }).then(refresh, (e) => toast(errorMessage(e), 'error'))}>{r.archivedAt ? 'Restaurer' : 'Archiver'}</button>
                  <button className="btn ghost sm" type="button" onClick={() => del(`/pos/registers/${r.id}`, `Supprimer la caisse « ${r.name} » ?`)}>Supprimer</button>
                </>}</td>
              </tr>
            ))}
            {!regs.data?.length && <tr><td colSpan={4} className="empty">Aucune caisse.</td></tr>}
          </tbody></table></div>
      </section>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="row between"><h2 style={{ margin: 0 }}>Catégories</h2>{edit && <button className="btn sm" type="button" onClick={() => { setError(null); setCateg({ name: '', color: '#1765AD', position: String(c.categories.length) }); }}>Nouvelle catégorie</button>}</div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          {c.categories.map((x) => (
            <span key={x.id} className="chip" style={{ borderColor: x.color ?? undefined }}>
              {x.name}
              {edit && <><button className="linklike small" type="button" onClick={() => { setError(null); setCateg({ id: x.id, name: x.name, color: x.color ?? '#1765AD', position: String(x.position) }); }}>modifier</button> <button className="linklike small" type="button" onClick={() => del(`/pos/categories/${x.id}`, `Supprimer la catégorie « ${x.name} » ? Ses produits restent, sans catégorie.`)}>supprimer</button></>}
            </span>
          ))}
          {!c.categories.length && <span className="muted">Aucune : Boissons, Restauration, Confiseries…</span>}
        </div>
      </section>
      <section className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>Produits</h2>{edit && <button className="btn sm" type="button" onClick={() => { setError(null); setProd({ name: '', price: '', categoryId: '', color: '', stockItemId: '', stockUnits: '1', active: true, position: '0' }); }}>Nouveau produit</button>}</div>
        <div className="table-wrap" style={{ marginTop: 8 }}><table className="table"><thead><tr><th>Produit</th><th>Prix</th><th>Catégorie</th>{c.stockSync && <th>Stock lié</th>}<th>En vente</th><th className="actions">Actions</th></tr></thead>
          <tbody>
            {c.products.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td>{money(p.priceCents)}</td><td className="small">{catName(p.categoryId)}</td>
                {c.stockSync && <td className="small">{p.stock ? `${p.stock.name} (${p.stock.quantity}${p.stock.unit ? ` ${p.stock.unit}` : ''})${p.stockUnits !== 1 ? ` × ${p.stockUnits}` : ''}` : '—'}</td>}
                <td>{p.active ? 'Oui' : <span className="muted">Non</span>}</td>
                <td className="actions">{edit && <>
                  <button className="btn ghost sm" type="button" onClick={() => { setError(null); setProd({ id: p.id, name: p.name, price: fromCents(p.priceCents), categoryId: p.categoryId ?? '', color: p.color ?? '', stockItemId: p.stockItemId ?? '', stockUnits: String(p.stockUnits), active: p.active, position: String(p.position) }); }}>Modifier</button>
                  <button className="btn ghost sm" type="button" onClick={() => del(`/pos/products/${p.id}`, `Supprimer « ${p.name} » ? Les ventes passées gardent son nom et son prix.`)}>Supprimer</button>
                </>}</td>
              </tr>
            ))}
            {!c.products.length && <tr><td colSpan={6} className="empty">Aucun produit.</td></tr>}
          </tbody></table></div>
      </section>
      {reg && (
        <Modal open title={reg.id ? 'Modifier la caisse' : 'Nouvelle caisse'} onClose={() => setReg(null)} footer={<><button className="btn secondary" type="button" onClick={() => setReg(null)}>Annuler</button><button className="btn" type="submit" form="reg-form">Enregistrer</button></>}>
          <form id="reg-form" className="form-grid" onSubmit={(e) => run(e, () => (reg.id ? api.patch(`/pos/registers/${reg.id}`, { name: reg.name, color: reg.color, ticketSales: reg.ticketSales }) : api.post('/pos/registers', { name: reg.name, color: reg.color, ticketSales: reg.ticketSales })), () => setReg(null))}>
            {error && <div className="alert danger full" role="alert">{error}</div>}
            <Field label="Nom">{(id) => <input id={id} type="text" required maxLength={60} value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} placeholder="Buvette, bar, accueil…" autoFocus />}</Field>
            <Field label="Couleur">{(id) => <input id={id} type="color" value={reg.color} onChange={(e) => setReg({ ...reg, color: e.target.value })} />}</Field>
            <label className="check full"><input type="checkbox" checked={reg.ticketSales} onChange={(e) => setReg({ ...reg, ticketSales: e.target.checked })} /> Vendre aussi des billets (séances en vente de Scenorya Tickets)</label>
          </form>
        </Modal>
      )}
      {categ && (
        <Modal open title={categ.id ? 'Modifier la catégorie' : 'Nouvelle catégorie'} onClose={() => setCateg(null)} footer={<><button className="btn secondary" type="button" onClick={() => setCateg(null)}>Annuler</button><button className="btn" type="submit" form="cat-form">Enregistrer</button></>}>
          <form id="cat-form" className="form-grid" onSubmit={(e) => run(e, () => { const b = { name: categ.name, color: categ.color, position: Number(categ.position) || 0 }; return categ.id ? api.patch(`/pos/categories/${categ.id}`, b) : api.post('/pos/categories', b); }, () => setCateg(null))}>
            {error && <div className="alert danger full" role="alert">{error}</div>}
            <Field label="Nom">{(id) => <input id={id} type="text" required maxLength={40} value={categ.name} onChange={(e) => setCateg({ ...categ, name: e.target.value })} autoFocus />}</Field>
            <Field label="Couleur">{(id) => <input id={id} type="color" value={categ.color} onChange={(e) => setCateg({ ...categ, color: e.target.value })} />}</Field>
            <Field label="Ordre" hint="Plus petit = plus à gauche.">{(id, d) => <input id={id} type="number" min={0} value={categ.position} onChange={(e) => setCateg({ ...categ, position: e.target.value })} aria-describedby={d} />}</Field>
          </form>
        </Modal>
      )}
      {prod && (
        <Modal open title={prod.id ? 'Modifier le produit' : 'Nouveau produit'} onClose={() => setProd(null)} footer={<><button className="btn secondary" type="button" onClick={() => setProd(null)}>Annuler</button><button className="btn" type="submit" form="prod-form">Enregistrer</button></>}>
          <form id="prod-form" className="form-grid" onSubmit={(e) => run(e, () => {
            const price = toCents(prod.price || '0');
            if (Number.isNaN(price)) throw new Error('Prix invalide.');
            const b = { name: prod.name, priceCents: price, categoryId: prod.categoryId || null, color: prod.color || null, stockItemId: prod.stockItemId || null, stockUnits: Number(prod.stockUnits) || 0, active: prod.active, position: Number(prod.position) || 0 };
            return prod.id ? api.patch(`/pos/products/${prod.id}`, b) : api.post('/pos/products', b);
          }, () => setProd(null))}>
            {error && <div className="alert danger full" role="alert">{error}</div>}
            <Field label="Nom" hint="Court : il s’affiche sur la touche.">{(id, d) => <input id={id} type="text" required maxLength={60} value={prod.name} onChange={(e) => setProd({ ...prod, name: e.target.value })} aria-describedby={d} autoFocus />}</Field>
            <Field label="Prix (€)">{(id) => <input id={id} type="text" inputMode="decimal" required value={prod.price} onChange={(e) => setProd({ ...prod, price: e.target.value })} />}</Field>
            <Field label="Catégorie">{(id) => <select id={id} value={prod.categoryId} onChange={(e) => setProd({ ...prod, categoryId: e.target.value })}><option value="">—</option>{c.categories.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>
            <Field label="Ordre">{(id) => <input id={id} type="number" min={0} value={prod.position} onChange={(e) => setProd({ ...prod, position: e.target.value })} />}</Field>
            {c.stockSync && <>
              <Field label="Article de stock" hint="Décrémenté à chaque vente.">{(id, d) => <select id={id} value={prod.stockItemId} onChange={(e) => setProd({ ...prod, stockItemId: e.target.value })} aria-describedby={d}><option value="">— (non suivi)</option>{stock.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>
              {prod.stockItemId && <Field label="Unités de stock par vente">{(id) => <input id={id} type="number" min={0} value={prod.stockUnits} onChange={(e) => setProd({ ...prod, stockUnits: e.target.value })} />}</Field>}
            </>}
            <label className="check full"><input type="checkbox" checked={prod.active} onChange={(e) => setProd({ ...prod, active: e.target.checked })} /> En vente (visible à l’écran de caisse)</label>
          </form>
        </Modal>
      )}
    </>
  );
}
