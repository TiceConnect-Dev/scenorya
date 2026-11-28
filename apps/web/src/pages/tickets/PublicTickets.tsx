import { FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { Alert, Badge, BrandLogo, Field, formatDate, Loading } from '../../components/ui';

/* Pages publiques : réservation en ligne, billets de l'acheteur, vérification d'un billet. */

interface PublicRate { id: string; name: string; priceCents: number; remaining: number | null }
interface PublicEvent { id: string; title: string; description: string | null; startAt: string; doorsAt: string | null; venue: string | null; maxPerOrder: number; remaining: number | null; rates: PublicRate[] }
interface PublicPage { association: { name: string; color: string; city: string | null; website: string | null; email: string | null }; events: PublicEvent[] }
interface PublicOrder {
  association: { name: string; color: string; email: string | null; slug: string };
  event: { title: string; startAt: string; doorsAt: string | null; venue: string | null; status: string };
  order: { number: string; buyerName: string; status: 'pending' | 'paid' | 'cancelled'; totalCents: number; channel: string; createdAt: string };
  tickets: { code: string; url: string; rateName: string; priceCents: number; holderName: string | null; status: string; scanned: boolean }[];
  canCancel: boolean;
}

const money = (c: number) => (c === 0 ? 'Gratuit' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100));
const accent = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : 'var(--blue)');
const time = (d: string) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function Frame({ color, children, wide }: { color?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="public-page">
      <div className="stack" style={{ maxWidth: wide ? 760 : 560, margin: '32px auto', gap: 16 }}>
        <div style={{ height: 4, background: accent(color), borderRadius: 2 }} />
        {children}
        <p className="small muted" style={{ textAlign: 'center' }}>Billetterie propulsée par Scenorya · <BrandLogo height={14} /></p>
      </div>
    </main>
  );
}

export function PublicTicketing() {
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['public-tickets', slug], queryFn: () => api.get<PublicPage>(`/public/tickets/${slug}`), retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  if (q.isLoading) return <Frame><Loading /></Frame>;
  if (q.error) return <Frame><div className="card"><Alert tone="warning">{errorMessage(q.error)}</Alert></div></Frame>;
  const p = q.data!;
  const ev = p.events.find((e) => e.id === selected);
  return (
    <Frame color={p.association.color} wide>
      <header className="card">
        <p className="small muted" style={{ margin: 0 }}>Billetterie</p>
        <h1 style={{ margin: '4px 0' }}>{p.association.name}</h1>
        {p.association.city && <p className="small muted" style={{ margin: 0 }}>{p.association.city}</p>}
      </header>
      {ev ? <ReserveForm slug={slug} event={ev} onBack={() => setSelected(null)} color={p.association.color} /> : p.events.length === 0 ? (
        <div className="card empty">Aucune séance ouverte à la réservation en ligne pour le moment.{p.association.email && <> Contact : <a href={`mailto:${p.association.email}`}>{p.association.email}</a></>}</div>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 12 }}>
          {p.events.map((e) => {
            const full = e.remaining === 0;
            const from = e.rates.length ? Math.min(...e.rates.map((r) => r.priceCents)) : null;
            return (
              <li key={e.id} className="card public-event">
                <div className="stack" style={{ gap: 4 }}>
                  <h2 style={{ margin: 0 }}>{e.title}</h2>
                  <span>{formatDate(e.startAt, true)}{e.venue ? ` · ${e.venue}` : ''}</span>
                  {e.doorsAt && <span className="small muted">Ouverture des portes à {time(e.doorsAt)}</span>}
                  {e.description && <p className="small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{e.description}</p>}
                </div>
                <div className="stack" style={{ gap: 6, alignItems: 'flex-end' }}>
                  {from != null && <span className="small">{from === 0 ? 'Entrée libre' : `À partir de ${money(from)}`}</span>}
                  {e.remaining != null && !full && e.remaining <= 20 && <Badge tone="warning">Plus que {e.remaining} place(s)</Badge>}
                  <button className="btn" type="button" disabled={full} onClick={() => setSelected(e.id)}>{full ? 'Complet' : 'Réserver'}</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Frame>
  );
}

function ReserveForm({ slug, event: e, onBack }: { slug: string; event: PublicEvent; onBack: () => void; color: string }) {
  const navigate = useNavigate();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [f, setF] = useState({ name: '', email: '', phone: '', website: '' });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const count = Object.values(qty).reduce((a, b) => a + b, 0);
  const total = e.rates.reduce((n, r) => n + (qty[r.id] ?? 0) * r.priceCents, 0);
  const max = Math.min(e.maxPerOrder, e.remaining ?? Infinity);
  const step = (r: PublicRate, d: number) => {
    const next = Math.max(0, (qty[r.id] ?? 0) + d);
    if (d > 0 && (count >= max || (r.remaining != null && next > r.remaining))) return;
    setQty({ ...qty, [r.id]: next });
  };
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setSending(true);
    try {
      const r = await api.post<{ token: string }>(`/public/tickets/${slug}/events/${e.id}/orders`, {
        buyerName: f.name, buyerEmail: f.email, buyerPhone: f.phone.trim() || null, website: f.website || undefined,
        lines: Object.entries(qty).filter(([, n]) => n > 0).map(([rateId, quantity]) => ({ rateId, quantity })),
      });
      navigate(`/billets/${r.token}?nouveau=1`);
    } catch (err) { setError(errorMessage(err)); setSending(false); }
  };
  return (
    <form className="card stack" style={{ gap: 14 }} onSubmit={submit}>
      <button className="btn ghost sm" type="button" onClick={onBack} style={{ alignSelf: 'flex-start' }}>← Toutes les séances</button>
      <div>
        <h2 style={{ margin: 0 }}>{e.title}</h2>
        <span>{formatDate(e.startAt, true)}{e.venue ? ` · ${e.venue}` : ''}</span>
      </div>
      {error && <div className="alert danger" role="alert">{error}</div>}
      <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>Billets <span className="small muted">({e.maxPerOrder} au maximum)</span></legend>
        {e.rates.map((r) => (
          <div key={r.id} className="row between box-line">
            <div><strong>{r.name}</strong> <span className="muted">{money(r.priceCents)}</span>{r.remaining === 0 && <span className="small muted"> · épuisé</span>}</div>
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'center' }}>
              <button className="btn secondary sm" type="button" aria-label={`Retirer un billet ${r.name}`} onClick={() => step(r, -1)} disabled={!qty[r.id]}>−</button>
              <span aria-live="polite" style={{ minWidth: 24, textAlign: 'center', fontWeight: 600 }}>{qty[r.id] ?? 0}</span>
              <button className="btn secondary sm" type="button" aria-label={`Ajouter un billet ${r.name}`} onClick={() => step(r, 1)} disabled={r.remaining === 0 || count >= max}>+</button>
            </div>
          </div>
        ))}
      </fieldset>
      <div className="row between" style={{ fontSize: 18 }}><span>{count} billet(s)</span><strong>{money(total)}</strong></div>
      <Field label="Nom et prénom">{(id) => <input id={id} type="text" required minLength={2} maxLength={120} autoComplete="name" value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} />}</Field>
      <Field label="Adresse e-mail" hint="Vos billets y sont envoyés.">{(id, d) => <input id={id} type="email" required autoComplete="email" value={f.email} onChange={(x) => setF({ ...f, email: x.target.value })} aria-describedby={d} />}</Field>
      <Field label="Téléphone (facultatif)">{(id) => <input id={id} type="tel" maxLength={40} autoComplete="tel" value={f.phone} onChange={(x) => setF({ ...f, phone: x.target.value })} />}</Field>
      <div aria-hidden style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
        <label>Site web<input type="text" tabIndex={-1} autoComplete="off" value={f.website} onChange={(x) => setF({ ...f, website: x.target.value })} /></label>
      </div>
      {total > 0 && <Alert>Réservation sans paiement en ligne : le montant est à régler à l’accueil, le jour de la séance.</Alert>}
      <p className="small muted" style={{ margin: 0 }}>Vos coordonnées servent uniquement à gérer cette réservation et à vous joindre en cas de changement.</p>
      <button className="btn" type="submit" disabled={!count || sending} style={{ minHeight: 48 }}>{sending ? 'Réservation…' : total > 0 ? `Réserver (${money(total)} à régler sur place)` : 'Réserver'}</button>
    </form>
  );
}

export function PublicOrderPage() {
  const { token = '' } = useParams();
  const fresh = new URLSearchParams(window.location.search).has('nouveau');
  const q = useQuery({ queryKey: ['public-order', token], queryFn: () => api.get<PublicOrder>(`/public/orders/${token}`), retry: false });
  const [error, setError] = useState<string | null>(null);
  if (q.isLoading) return <Frame><Loading /></Frame>;
  if (q.error) return <Frame><div className="card"><Alert tone="warning">{errorMessage(q.error)}</Alert></div></Frame>;
  const d = q.data!;
  const cancel = async () => {
    if (!window.confirm('Annuler votre réservation ? Les places seront remises en vente.')) return;
    try { await api.post(`/public/orders/${token}/cancel`); q.refetch(); } catch (e) { setError(errorMessage(e)); }
  };
  const valid = d.tickets.filter((t) => t.status === 'valid');
  return (
    <Frame color={d.association.color}>
      {fresh && d.order.status !== 'cancelled' && <Alert tone="success">Réservation enregistrée. Vos billets sont aussi envoyés par e-mail.</Alert>}
      <section className="card stack" style={{ gap: 6 }}>
        <p className="small muted" style={{ margin: 0 }}>{d.association.name} · commande {d.order.number}</p>
        <h1 style={{ margin: 0 }}>{d.event.title}</h1>
        <span>{formatDate(d.event.startAt, true)}{d.event.venue ? ` · ${d.event.venue}` : ''}</span>
        {d.event.doorsAt && <span className="small muted">Ouverture des portes à {time(d.event.doorsAt)}</span>}
        {d.event.status === 'cancelled' && <Alert tone="warning">Cette séance est annulée. L’association vous contactera.</Alert>}
        {d.order.status === 'cancelled' && <Alert tone="warning">Cette commande est annulée : les billets ne sont plus valables.</Alert>}
        {d.order.status === 'pending' && <Alert tone="info">À régler à l’accueil : <strong>{money(d.order.totalCents)}</strong>.</Alert>}
        {error && <div className="alert danger" role="alert">{error}</div>}
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          {d.order.status !== 'cancelled' && <a className="btn secondary" href={`/api/public/orders/${token}/tickets.pdf`}>Télécharger les billets (PDF)</a>}
          {d.canCancel && <button className="btn ghost" type="button" onClick={cancel}>Annuler ma réservation</button>}
        </div>
      </section>
      {d.order.status !== 'cancelled' && valid.map((t, i) => (
        <section key={t.code} className="card public-ticket">
          <img src={`/api/public/ticket/${t.code}/qr.png`} alt={`QR code du billet ${i + 1}`} width={180} height={180} />
          <div className="stack" style={{ gap: 4 }}>
            <span className="small muted">Billet {i + 1} / {valid.length}</span>
            <strong style={{ fontSize: 18 }}>{t.rateName}</strong>
            <span>{money(t.priceCents)}</span>
            <span className="small">{t.holderName ?? d.order.buyerName}</span>
            {t.scanned && <Badge tone="success">Déjà utilisé</Badge>}
            <code className="small muted" style={{ wordBreak: 'break-all' }}>{t.code}</code>
          </div>
        </section>
      ))}
      <p className="small muted" style={{ textAlign: 'center' }}>Présentez chaque QR code à l’entrée, sur votre téléphone ou imprimé. Chaque billet ne passe qu’une fois.{d.association.email && <> Une question : <a href={`mailto:${d.association.email}`}>{d.association.email}</a>.</>}</p>
    </Frame>
  );
}

/** Ce que voit une personne qui lit un QR code avec l'appareil photo de son téléphone. */
export function PublicTicketCheck() {
  const { code = '' } = useParams();
  const q = useQuery({ queryKey: ['public-ticket', code], queryFn: () => api.get<{ association: string; title: string; startAt: string; venue: string | null; rateName: string; valid: boolean; used: boolean; pending: boolean }>(`/public/ticket/${code}`), retry: false });
  return (
    <Frame>
      <section className="card stack" style={{ gap: 8 }}>
        {q.isLoading ? <Loading /> : q.error ? <Alert tone="warning">{errorMessage(q.error)}</Alert> : (
          <>
            <p className="small muted" style={{ margin: 0 }}>Billet · {q.data!.association}</p>
            <h1 style={{ margin: 0 }}>{q.data!.title}</h1>
            <span>{formatDate(q.data!.startAt, true)}{q.data!.venue ? ` · ${q.data!.venue}` : ''}</span>
            <span>{q.data!.rateName}</span>
            {!q.data!.valid ? <Alert tone="warning">Billet non valable (annulé).</Alert> : q.data!.used ? <Alert tone="info">Billet valable, déjà présenté à l’entrée.</Alert> : <Alert tone="success">Billet valable{q.data!.pending ? ' — à régler à l’accueil' : ''}.</Alert>}
            <p className="small muted" style={{ margin: 0 }}>Le contrôle se fait à l’entrée avec l’application de l’organisateur.</p>
          </>
        )}
      </section>
    </Frame>
  );
}
