import { FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, deleteWithConfirm, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';

/* --------------------------------------------------------------- Types */

type Status = 'pending' | 'confirmed' | 'rejected' | 'cancelled';
interface Resource { id: string; name: string; kind: 'room' | 'vehicle' | 'equipment' | 'other'; capacity: number | null; location: string | null; color: string | null; requiresApproval: boolean; notes: string | null }
interface Line { itemId: string; quantity: number; returnedQuantity: number | null; name: string; reference: string | null }
interface Booking {
  id: string; resourceId: string | null; resource: string | null; color: string | null; title: string; startAt: string; endAt: string; status: Status;
  checkedOutAt: string | null; returnedAt: string | null; requester: string | null; mine: boolean; contact: string | null; notes: string | null; decisionNote: string | null; items: Line[];
}
interface Avail { busy: { resourceId: string; title: string; startAt: string; endAt: string }[]; items: { id: string; name: string; reference: string | null; category: string | null; unit: string | null; available: number; quantity: number }[]; loans: boolean }

const STATUS: Record<Status, [string, 'neutral' | 'info' | 'success' | 'danger' | 'warning']> = {
  pending: ['En attente', 'warning'], confirmed: ['Confirmée', 'success'], rejected: ['Refusée', 'danger'], cancelled: ['Annulée', 'neutral'],
};
const KIND: Record<Resource['kind'], string> = { room: 'Salle', vehicle: 'Véhicule', equipment: 'Équipement', other: 'Autre' };
const crumbs = (label: string) => [{ label: 'Scenorya Booking', to: '/booking' }, { label }];
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const period = (a: string, b: string) => {
  const s = new Date(a), e = new Date(b);
  const sameDay = s.toDateString() === e.toDateString();
  const t = (d: Date) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(d);
  return sameDay ? `${formatDate(a)} · ${t(s)} – ${t(e)}` : `${formatDate(a, true)} → ${formatDate(b, true)}`;
};

/* ---------------------------------------------------------- Réservations */

export function BookingHome() {
  const { can, ctx, toast } = useApp();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [view, setView] = useState<'upcoming' | 'pending' | 'out' | 'mine' | 'past'>('upcoming');
  const [form, setForm] = useState<Booking | 'new' | null>(null);
  const [giveBack, setGiveBack] = useState<Booking | null>(null);
  const loans = Boolean(ctx?.modules.stock?.usable && ctx.modules.booking?.features['booking.equipmentLoans']);
  const nowIso = new Date().toISOString();
  const qs = { upcoming: `from=${nowIso}&status=active`, pending: 'status=pending', out: 'loans=out', mine: `mine=true&from=${nowIso}`, past: `to=${nowIso}` }[view];
  const q = useQuery({ queryKey: ['booking', 'list', view], queryFn: () => api.get<Booking[]>(`/booking/bookings?${qs}`) });
  const highlight = params.get('b');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['booking'] }); qc.invalidateQueries({ queryKey: ['stock'] }); };
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { refresh(); toast(msg); }, (e) => toast(errorMessage(e), 'error'));
  const decide = (b: Booking, accept: boolean) => {
    const note = accept ? '' : window.prompt('Motif du refus (facultatif) :', '');
    if (note === null) return;
    act(api.post(`/booking/bookings/${b.id}/decision`, { accept, note: note?.trim() || null }), accept ? 'Réservation acceptée.' : 'Réservation refusée.');
  };
  const rows = view === 'past' ? [...(q.data ?? [])].reverse() : q.data ?? [];
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Booking' }]} />
      <PageHead title="Réservations" description={loans ? 'Salles, ressources et prêts de matériel, sans double réservation.' : 'Salles et ressources, sans double réservation.'}
        actions={can('booking.bookings.create') && <button className="btn" type="button" onClick={() => setForm('new')}>Nouvelle réservation</button>} />
      <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
        {([['upcoming', 'À venir'], ['pending', 'À valider'], ...(loans ? [['out', 'Matériel sorti']] : []), ['mine', 'Mes réservations'], ['past', 'Passées']] as [typeof view, string][]).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={`tab${view === k ? ' active' : ''}`} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Quand</th><th>Objet</th><th>Ressource / matériel</th><th>Demandeur</th><th>État</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {rows.map((b) => {
                const open = b.status === 'pending' || b.status === 'confirmed';
                const out = b.checkedOutAt && !b.returnedAt;
                return (
                  <tr key={b.id} style={highlight === b.id ? { outline: '2px solid var(--blue)' } : undefined}>
                    <td className="small">{period(b.startAt, b.endAt)}</td>
                    <td>{b.title}{b.notes && <div className="small muted">{b.notes}</div>}{b.decisionNote && <div className="small muted">Décision : {b.decisionNote}</div>}</td>
                    <td className="small">
                      {b.resource && <div><span aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: b.color ?? 'var(--blue)', marginRight: 6 }} />{b.resource}</div>}
                      {b.items.map((l) => <div key={l.itemId}>{l.quantity} × {l.name}{l.returnedQuantity != null && l.returnedQuantity < l.quantity ? ` (${l.quantity - l.returnedQuantity} manquant)` : ''}</div>)}
                    </td>
                    <td className="small">{b.requester ?? '—'}{b.contact && <div className="muted">{b.contact}</div>}</td>
                    <td>
                      <Badge tone={STATUS[b.status][1]}>{STATUS[b.status][0]}</Badge>
                      {out && <> <Badge tone="warning">Sorti</Badge></>}
                      {b.returnedAt && <> <Badge tone="success">Rendu</Badge></>}
                    </td>
                    <td className="actions">
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                        {b.status === 'pending' && can('booking.bookings.validate') && <><button className="btn sm" type="button" onClick={() => decide(b, true)}>Accepter</button><button className="btn secondary sm" type="button" onClick={() => decide(b, false)}>Refuser</button></>}
                        {b.status === 'confirmed' && b.items.length > 0 && !b.checkedOutAt && can('booking.bookings.update') && <button className="btn secondary sm" type="button" onClick={() => act(api.post(`/booking/bookings/${b.id}/checkout`), 'Sortie enregistrée.')}>Sortie</button>}
                        {out && can('booking.bookings.update') && <button className="btn secondary sm" type="button" onClick={() => setGiveBack(b)}>Retour</button>}
                        {open && !b.returnedAt && (b.mine || can('booking.bookings.update')) && <button className="btn ghost sm" type="button" onClick={() => setForm(b)}>Modifier</button>}
                        {open && !out && (b.mine || can('booking.bookings.update') || can('booking.bookings.validate')) && <button className="btn ghost sm" type="button" onClick={() => window.confirm(`Annuler « ${b.title} » ?`) && act(api.post(`/booking/bookings/${b.id}/cancel`), 'Réservation annulée.')}>Annuler</button>}
                        {can('booking.bookings.delete') && !out && <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm(`/booking/bookings/${b.id}`, `Supprimer définitivement la réservation « ${b.title} » ?`).then((r) => { if (r) { refresh(); toast('Réservation supprimée.'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={6} className="empty">Aucune réservation.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {form && <BookingForm initial={form === 'new' ? undefined : form} loans={loans} onClose={() => setForm(null)} onSaved={(s) => { refresh(); toast(s === 'pending' ? 'Demande envoyée : elle doit être validée.' : 'Réservation enregistrée.'); }} />}
      {giveBack && <ReturnForm booking={giveBack} onClose={() => setGiveBack(null)} onSaved={(losses) => { refresh(); toast(losses.length ? `Retour enregistré ; manquant : ${losses.join(', ')}.` : 'Retour complet enregistré.'); }} />}
    </>
  );
}

function BookingForm({ initial, loans, onClose, onSaved }: { initial?: Booking; loans: boolean; onClose: () => void; onSaved: (status: Status) => void }) {
  const resources = useQuery({ queryKey: ['booking', 'resources'], queryFn: () => api.get<Resource[]>('/booking/resources') });
  const start = new Date(); start.setHours(start.getHours() + 1, 0, 0, 0);
  const end = new Date(start); end.setHours(end.getHours() + 2);
  const [f, setF] = useState({
    resourceId: initial?.resourceId ?? '', title: initial?.title ?? '', startAt: localInput(initial ? new Date(initial.startAt) : start), endAt: localInput(initial ? new Date(initial.endAt) : end),
    contact: initial?.contact ?? '', notes: initial?.notes ?? '',
  });
  const [lines, setLines] = useState<Record<string, number>>(Object.fromEntries((initial?.items ?? []).map((l) => [l.itemId, l.quantity])));
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const s = new Date(f.startAt), e = new Date(f.endAt);
      setRange(!Number.isNaN(+s) && !Number.isNaN(+e) && e > s ? { from: s.toISOString(), to: e.toISOString() } : null);
    }, 300);
    return () => clearTimeout(t);
  }, [f.startAt, f.endAt]);
  const av = useQuery({ queryKey: ['booking', 'availability', range, initial?.id], queryFn: () => api.get<Avail>(`/booking/availability?from=${range!.from}&to=${range!.to}${initial ? `&excludeBookingId=${initial.id}` : ''}`), enabled: !!range });
  const busy = av.data?.busy.filter((b) => b.resourceId === f.resourceId) ?? [];
  const locked = !!initial?.checkedOutAt;
  const res = resources.data?.find((r) => r.id === f.resourceId);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const items = Object.entries(lines).filter(([, n]) => n > 0).map(([itemId, quantity]) => ({ itemId, quantity }));
    const body: Record<string, unknown> = { resourceId: f.resourceId || null, title: f.title, startAt: new Date(f.startAt).toISOString(), endAt: new Date(f.endAt).toISOString(), contact: f.contact.trim() || null, notes: f.notes.trim() || null };
    if (!locked && loans) body.items = items;
    try {
      const b = initial ? await api.patch<{ status: Status }>(`/booking/bookings/${initial.id}`, body) : await api.post<{ status: Status }>('/booking/bookings', body);
      onSaved(b.status);
      onClose();
    } catch (err) { setError(errorMessage(err)); }
  };
  return (
    <Modal open title={initial ? 'Modifier la réservation' : 'Nouvelle réservation'} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="booking-form">Enregistrer</button></>}>
      <form id="booking-form" className="form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Objet" className="full">{(id) => <input id={id} type="text" required maxLength={160} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Répétition, prêt au théâtre voisin…" autoFocus />}</Field>
        <Field label="Ressource" className="full" hint={res?.requiresApproval ? 'Cette ressource exige une validation.' : loans ? 'Facultatif pour un simple prêt de matériel.' : undefined}>{(id, d) => (
          <select id={id} value={f.resourceId} onChange={(e) => setF({ ...f, resourceId: e.target.value })} aria-describedby={d}>
            <option value="">{loans ? '— (matériel seul)' : '—'}</option>
            {resources.data?.map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` (${r.capacity} pl.)` : ''}</option>)}
          </select>
        )}</Field>
        <Field label="Début">{(id) => <input id={id} type="datetime-local" required value={f.startAt} onChange={(e) => setF({ ...f, startAt: e.target.value })} />}</Field>
        <Field label="Fin">{(id) => <input id={id} type="datetime-local" required value={f.endAt} onChange={(e) => setF({ ...f, endAt: e.target.value })} />}</Field>
        {busy.length > 0 && <div className="full"><Alert tone="warning">Déjà réservée sur ce créneau : {busy.map((b) => `« ${b.title} » (${period(b.startAt, b.endAt)})`).join(', ')}.</Alert></div>}
        <Field label="Contact">{(id) => <input id={id} type="text" maxLength={200} value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} placeholder="Emprunteur, téléphone…" />}</Field>
        <Field label="Notes">{(id) => <input id={id} type="text" maxLength={2000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        {loans && (
          <fieldset className="full" style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
            <legend className="small" style={{ fontWeight: 600 }}>Matériel</legend>
            {locked ? <p className="small muted">Le matériel est sorti : sa liste ne peut plus changer.</p> : !range ? <p className="small muted">Choisissez un créneau valide.</p> : av.isLoading ? <Loading /> : (
              <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                <table className="table">
                  <thead><tr><th>Article</th><th>Disponible</th><th style={{ width: 110 }}>Quantité</th></tr></thead>
                  <tbody>
                    {av.data?.items.map((i) => {
                      const v = lines[i.id] ?? 0;
                      return (
                        <tr key={i.id}>
                          <td className="small">{i.reference ? `${i.reference} — ` : ''}{i.name}{i.category && <span className="muted"> · {i.category}</span>}</td>
                          <td className="small">{i.available} / {i.quantity}</td>
                          <td><input type="number" aria-label={`Quantité de ${i.name}`} min={0} max={Math.max(i.available, v)} value={v || ''} placeholder="0" onChange={(e) => setLines({ ...lines, [i.id]: Math.max(0, Number(e.target.value) || 0) })} style={v > i.available ? { borderColor: 'var(--danger)' } : undefined} /></td>
                        </tr>
                      );
                    })}
                    {!av.data?.items.length && <tr><td colSpan={3} className="empty">Aucun matériel prêtable. <Link to="/stock">Gérer le stock</Link></td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </fieldset>
        )}
      </form>
    </Modal>
  );
}

function ReturnForm({ booking, onClose, onSaved }: { booking: Booking; onClose: () => void; onSaved: (losses: string[]) => void }) {
  const [back, setBack] = useState<Record<string, number>>(Object.fromEntries(booking.items.map((l) => [l.itemId, l.quantity])));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ losses: string[] }>(`/booking/bookings/${booking.id}/return`, { items: Object.entries(back).map(([itemId, returned]) => ({ itemId, returned })), note: note.trim() || null });
      onSaved(r.losses);
      onClose();
    } catch (err) { setError(errorMessage(err)); }
  };
  const missing = booking.items.some((l) => (back[l.itemId] ?? 0) < l.quantity);
  return (
    <Modal open title={`Retour — ${booking.title}`} onClose={onClose} footer={<><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit" form="return-form">Enregistrer le retour</button></>}>
      <form id="return-form" className="stack" onSubmit={submit}>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Article</th><th>Prêté</th><th style={{ width: 110 }}>Rendu</th></tr></thead>
            <tbody>{booking.items.map((l) => (
              <tr key={l.itemId}><td>{l.name}</td><td>{l.quantity}</td><td><input type="number" aria-label={`Quantité rendue de ${l.name}`} min={0} max={l.quantity} value={back[l.itemId] ?? 0} onChange={(e) => setBack({ ...back, [l.itemId]: Math.min(l.quantity, Math.max(0, Number(e.target.value) || 0)) })} /></td></tr>
            ))}</tbody>
          </table>
        </div>
        {missing && <Alert tone="warning">Le matériel manquant sera sorti du stock comme perte.</Alert>}
        <Field label="Observation">{(id) => <input id={id} type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- Ressources */

export function ResourcesPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['booking', 'resources'], queryFn: () => api.get<Resource[]>('/booking/resources') });
  const [form, setForm] = useState<{ id?: string; name: string; kind: Resource['kind']; capacity: string; location: string; color: string; requiresApproval: boolean; notes: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['booking'] });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    const body = { name: form.name, kind: form.kind, capacity: form.capacity === '' ? null : Number(form.capacity), location: form.location.trim() || null, color: form.color || null, requiresApproval: form.requiresApproval, notes: form.notes.trim() || null };
    try {
      if (form.id) await api.patch(`/booking/resources/${form.id}`, body); else await api.post('/booking/resources', body);
      refresh();
      setForm(null);
      toast('Ressource enregistrée.');
    } catch (err) { setError(errorMessage(err)); }
  };
  const blank = { name: '', kind: 'room' as const, capacity: '', location: '', color: '#783CA7', requiresApproval: false, notes: '' };
  return (
    <>
      <Breadcrumb items={crumbs('Ressources')} />
      <PageHead title="Ressources" description="Salles, véhicules et équipements réservables." actions={can('booking.resources.update') && <button className="btn" type="button" onClick={() => setForm(blank)}>Nouvelle ressource</button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Ressource</th><th>Type</th><th>Capacité</th><th>Lieu</th><th>Validation</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {q.data!.map((r) => (
                <tr key={r.id}>
                  <td><span aria-hidden style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: r.color ?? 'var(--blue)', marginRight: 8 }} />{r.name}{r.notes && <div className="small muted">{r.notes}</div>}</td>
                  <td className="small">{KIND[r.kind]}</td><td>{r.capacity ?? '—'}</td><td className="small">{r.location ?? '—'}</td>
                  <td>{r.requiresApproval ? <Badge tone="warning">Requise</Badge> : <span className="small muted">Non</span>}</td>
                  <td className="actions">{can('booking.resources.update') && <>
                    <button className="btn ghost sm" type="button" onClick={() => setForm({ id: r.id, name: r.name, kind: r.kind, capacity: r.capacity == null ? '' : String(r.capacity), location: r.location ?? '', color: r.color ?? '', requiresApproval: r.requiresApproval, notes: r.notes ?? '' })}>Modifier</button>{' '}
                    <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm(`/booking/resources/${r.id}`, `Supprimer la ressource « ${r.name} » et tout son historique de réservations ?`).then((x) => { if (x) { refresh(); toast('Ressource supprimée.'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>
                  </>}</td>
                </tr>
              ))}
              {!q.data!.length && <tr><td colSpan={6} className="empty">Aucune ressource. Ajoutez vos salles pour pouvoir les réserver.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <Modal open title={form.id ? 'Modifier la ressource' : 'Nouvelle ressource'} onClose={() => setForm(null)} footer={<><button className="btn secondary" type="button" onClick={() => setForm(null)}>Annuler</button><button className="btn" type="submit" form="res-form">Enregistrer</button></>}>
          <form id="res-form" className="form-grid" onSubmit={save}>
            {error && <div className="alert danger full" role="alert">{error}</div>}
            <Field label="Nom" className="full">{(id) => <input id={id} type="text" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />}</Field>
            <Field label="Type">{(id) => <select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Resource['kind'] })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
            <Field label="Capacité">{(id) => <input id={id} type="number" min={0} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />}</Field>
            <Field label="Lieu">{(id) => <input id={id} type="text" maxLength={200} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />}</Field>
            <Field label="Couleur">{(id) => <input id={id} type="color" value={form.color || '#783CA7'} onChange={(e) => setForm({ ...form, color: e.target.value })} />}</Field>
            <label className="check full"><input type="checkbox" checked={form.requiresApproval} onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })} /> Les demandes doivent être validées par une personne habilitée</label>
            <Field label="Notes" className="full">{(id) => <textarea id={id} rows={2} maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field>
          </form>
        </Modal>
      )}
    </>
  );
}
