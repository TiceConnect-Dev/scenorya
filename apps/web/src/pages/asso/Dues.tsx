import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { centsToInput, formatCents, parseEuros, PAYMENT_METHODS, PaymentMethod, PERIOD_TYPES, PeriodType } from '@scenorya/shared';
import { api, errorMessage, deleteWithConfirm } from '../../api/client';
import type { Member, Paged } from '../../api/types';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead, Pagination } from '../../components/ui';
import { CATEGORIES } from './Asso';

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  amountCents: number;
  periodType: PeriodType;
  memberCategory: string | null;
  active: boolean;
  dues: number;
}
export interface Due {
  id: string;
  memberId: string;
  planId: string | null;
  label: string;
  amountCents: number;
  paidCents: number;
  periodStart: string;
  periodEnd: string | null;
  status: 'due' | 'partial' | 'paid' | 'waived' | 'cancelled';
  receiptNumber: string | null;
  receiptCancelledAt: string | null;
  cancelReason: string | null;
  member: { id: string; number: number; firstName: string; lastName: string };
}
interface Payment {
  id: string;
  amountCents: number;
  method: PaymentMethod;
  paidAt: string;
  reference: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
}
type DueDetail = Due & { payments: Payment[]; remainingCents: number; member: Due['member'] & { email: string | null } };

const DUE_STATUS: Record<Due['status'], [string, 'success' | 'warning' | 'neutral' | 'info' | 'danger']> = {
  due: ['! À régler', 'warning'],
  partial: ['◐ Partiellement réglée', 'info'],
  paid: ['✓ Réglée', 'success'],
  waived: ['○ Exonérée', 'neutral'],
  cancelled: ['× Annulée', 'neutral'],
};
export const DueBadge = ({ status }: { status: Due['status'] }) => <Badge tone={DUE_STATUS[status][1]}>{DUE_STATUS[status][0]}</Badge>;
const today = () => new Date().toISOString().slice(0, 10);
const period = (d: { periodStart: string; periodEnd: string | null }) => (d.periodEnd ? `${formatDate(d.periodStart)} → ${formatDate(d.periodEnd)}` : `dès le ${formatDate(d.periodStart)}`);
const crumbs = (label: string) => [{ label: 'Scenorya Asso', to: '/asso' }, { label }];

function useInvalidateDues() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['dues', 'due', 'dues-summary', 'renewals', 'member', 'members', 'asso-stats', 'hub', 'plans']) qc.invalidateQueries({ queryKey: [k] });
  };
}

/** Saisie d'un montant en euros, convertie en centimes sans flottant. */
function MoneyInput({ id, value, onChange, describedBy }: { id: string; value: string; onChange: (v: string) => void; describedBy?: string }) {
  const invalid = value !== '' && parseEuros(value) === null;
  return (
    <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
      <input id={id} type="text" inputMode="decimal" aria-describedby={describedBy} aria-invalid={invalid} value={value} onChange={(e) => onChange(e.target.value)} placeholder="0,00" style={{ maxWidth: 160 }} />
      <span aria-hidden="true">€</span>
    </div>
  );
}

/* ---------------------------------------------------------- Détail */

export function DueModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, toast } = useApp();
  const invalidate = useInvalidateDues();
  const q = useQuery({ queryKey: ['due', id], queryFn: () => api.get<DueDetail>(`/asso/dues/${id}`), enabled: Boolean(id) });
  const [pay, setPay] = useState({ amount: '', method: 'cheque' as PaymentMethod, paidAt: today(), reference: '' });
  const [error, setError] = useState<string | null>(null);
  const d = q.data;

  useEffect(() => {
    if (d) setPay((p) => ({ ...p, amount: d.remainingCents > 0 ? centsToInput(d.remainingCents) : '', paidAt: today() }));
    setError(null);
  }, [d?.id, d?.remainingCents]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    try {
      await fn();
      toast(ok);
      invalidate();
      q.refetch();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const ask = (label: string) => {
    const r = window.prompt(label);
    return r && r.trim().length >= 3 ? r.trim() : null;
  };
  const submitPayment = (e: FormEvent) => {
    e.preventDefault();
    const cents = parseEuros(pay.amount);
    if (!cents) return setError('Montant invalide.');
    run(() => api.post(`/asso/dues/${id}/payments`, { amountCents: cents, method: pay.method, paidAt: pay.paidAt, reference: pay.reference || null }), 'Règlement enregistré.');
  };
  const open = d && (d.status === 'due' || d.status === 'partial');

  return (
    <Modal open={Boolean(id)} title={d ? d.label : 'Cotisation'} onClose={onClose}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {d && (
        <div className="stack">
          {error && <div className="alert danger" role="alert">{error}</div>}
          <dl className="props">
            <dt>Adhérent</dt>
            <dd><Link to={`/asso/adherents/${d.member.id}`} onClick={onClose}>{d.member.firstName} {d.member.lastName}</Link> (n° {d.member.number})</dd>
            <dt>Période</dt><dd>{period(d)}</dd>
            <dt>Montant</dt><dd>{formatCents(d.amountCents)}</dd>
            <dt>Réglé</dt><dd>{formatCents(d.paidCents)} {d.remainingCents > 0 && d.status !== 'cancelled' && d.status !== 'waived' && <span className="muted">· reste {formatCents(d.remainingCents)}</span>}</dd>
            <dt>Statut</dt><dd><DueBadge status={d.status} />{d.cancelReason && <span className="small muted"> — {d.cancelReason}</span>}</dd>
            {d.receiptNumber && (<><dt>Reçu</dt><dd>n° {d.receiptNumber}{d.receiptCancelledAt && <Badge tone="danger">annulé</Badge>}</dd></>)}
          </dl>

          {d.payments.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Règlements</caption>
                <thead><tr><th scope="col">Date</th><th scope="col">Mode</th><th scope="col">Référence</th><th scope="col">Montant</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
                <tbody>
                  {d.payments.map((p) => (
                    <tr key={p.id} style={p.cancelledAt ? { textDecoration: 'line-through', opacity: 0.65 } : undefined}>
                      <td>{formatDate(p.paidAt)}</td>
                      <td>{PAYMENT_METHODS[p.method]}</td>
                      <td>{p.reference ?? '—'}{p.cancelledAt && <div className="small" style={{ textDecoration: 'none' }}>Annulé : {p.cancelReason}</div>}</td>
                      <td className="nowrap">{formatCents(p.amountCents)}</td>
                      <td className="actions">
                        {!p.cancelledAt && can('asso.dues.cancel') && (
                          <button className="btn ghost sm" type="button" onClick={() => {
                            const reason = ask('Motif de l’annulation du règlement (chèque rejeté, erreur de saisie…) :');
                            if (reason) run(() => api.post(`/asso/dues/${d.id}/payments/${p.id}/cancel`, { reason }), 'Règlement annulé.');
                          }}>Annuler</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {open && can('asso.dues.validate') && (
            <form className="card stack" onSubmit={submitPayment} style={{ padding: 16 }}>
              <h3>Enregistrer un règlement</h3>
              <div className="form-grid">
                <Field label="Montant">{(fid) => <MoneyInput id={fid} value={pay.amount} onChange={(v) => setPay({ ...pay, amount: v })} />}</Field>
                <Field label="Mode">
                  {(fid) => (
                    <select id={fid} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as PaymentMethod })}>
                      {Object.entries(PAYMENT_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Date">{(fid) => <input id={fid} type="date" max={today()} value={pay.paidAt} onChange={(e) => setPay({ ...pay, paidAt: e.target.value })} />}</Field>
                <Field label="Référence (n° de chèque…)">{(fid) => <input id={fid} type="text" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />}</Field>
              </div>
              <div className="form-actions"><button className="btn" type="submit">Enregistrer</button></div>
            </form>
          )}

          <div className="row">
            {d.status === 'paid' && d.receiptNumber && !d.receiptCancelledAt && can('asso.dues.download') && (
              <button className="btn secondary" type="button" onClick={() => api.download(`/asso/dues/${d.id}/receipt.pdf`, `recu-${d.receiptNumber}.pdf`).catch((e) => toast(errorMessage(e), 'error'))}>
                Télécharger le reçu (PDF)
              </button>
            )}
            {d.status === 'due' && can('asso.dues.validate') && (
              <button className="btn ghost" type="button" onClick={() => {
                const reason = ask('Motif de l’exonération :');
                if (reason) run(() => api.post(`/asso/dues/${d.id}/waive`, { reason }), 'Cotisation exonérée.');
              }}>Exonérer</button>
            )}
            {d.status === 'due' && can('asso.dues.cancel') && (
              <button className="btn ghost" type="button" onClick={() => {
                const reason = ask('Motif de l’annulation de la cotisation :');
                if (reason) run(() => api.post(`/asso/dues/${d.id}/cancel`, { reason }), 'Cotisation annulée.');
              }}>Annuler la cotisation</button>
            )}
            {can('asso.dues.delete') && (
              <button className="btn danger" type="button" onClick={() => deleteWithConfirm(`/asso/dues/${d.id}`, `Supprimer définitivement la cotisation « ${d.label} » ?`)
                .then((r) => { if (r) { toast('Cotisation supprimée.'); invalidate(); onClose(); } }, (e) => setError(errorMessage(e)))}>Supprimer</button>
            )}
          </div>
          <p className="small muted">Un règlement enregistré ne se modifie pas : une erreur se corrige par annulation motivée, conservée dans l’historique. La suppression définitive d’une cotisation (et de ses règlements) reste possible, après confirmation ; elle est tracée dans le journal d’audit.</p>
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------- Nouvelle cotisation */

export function NewDueModal({ open, member, onClose, onCreated }: { open: boolean; member?: { id: string; label: string }; onClose: () => void; onCreated: (id: string) => void }) {
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<Plan[]>('/asso/plans'), enabled: open });
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(member ?? null);
  const [planId, setPlanId] = useState('');
  const [amount, setAmount] = useState('');
  const [periodType, setPeriodType] = useState<PeriodType>('calendar_year');
  const [start, setStart] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidateDues();
  const found = useQuery({
    queryKey: ['members', 'pick', search],
    queryFn: () => api.get<Paged<Member>>(`/asso/members?pageSize=8&status=all&q=${encodeURIComponent(search)}`),
    enabled: open && !member && search.trim().length >= 2,
  });
  useEffect(() => {
    if (open) {
      setPicked(member ?? null);
      setError(null);
      setSearch('');
    }
  }, [open, member]);
  const activePlans = (plans.data ?? []).filter((p) => p.active);
  useEffect(() => {
    if (!planId && activePlans[0]) setPlanId(activePlans[0].id);
  }, [activePlans, planId]);
  const plan = activePlans.find((p) => p.id === planId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!picked) return setError('Choisissez un adhérent.');
    const cents = amount ? parseEuros(amount) : undefined;
    if (amount && cents === null) return setError('Montant invalide.');
    if (!plan && cents === undefined) return setError('Choisissez une formule ou indiquez un montant.');
    try {
      const d = await api.post<{ id: string }>('/asso/dues', { memberId: picked.id, planId: plan?.id ?? null, amountCents: cents ?? undefined, periodStart: start, periodType: plan ? undefined : periodType });
      invalidate();
      onCreated(d.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal open={open} title="Appeler une cotisation" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <div className="alert danger" role="alert">{error}</div>}
        {picked ? (
          <div className="row between">
            <span>Adhérent : <strong>{picked.label}</strong></span>
            {!member && <button type="button" className="btn ghost sm" onClick={() => setPicked(null)}>Changer</button>}
          </div>
        ) : (
          <div>
            <Field label="Adhérent" hint="Saisissez au moins deux lettres du nom, du prénom ou le numéro.">
              {(fid, d) => <input id={fid} aria-describedby={d} type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />}
            </Field>
            <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
              {found.data?.items.filter((m) => m.status !== 'archived').map((m) => (
                <li key={m.id}>
                  <button type="button" className="btn ghost sm" onClick={() => setPicked({ id: m.id, label: `${m.firstName} ${m.lastName} (n° ${m.number})` })}>
                    {m.lastName.toUpperCase()} {m.firstName} — n° {m.number}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="form-grid">
          <Field label="Formule">
            {(fid) => (
              <select id={fid} value={planId} onChange={(e) => setPlanId(e.target.value)}>
                {activePlans.map((p) => <option key={p.id} value={p.id}>{p.name} — {formatCents(p.amountCents)}</option>)}
                <option value="">Montant libre</option>
              </select>
            )}
          </Field>
          <Field label="Date de référence" hint="Détermine la période couverte.">{(fid, d) => <input id={fid} aria-describedby={d} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label={plan ? 'Montant (facultatif, remplace celui de la formule)' : 'Montant'}>{(fid) => <MoneyInput id={fid} value={amount} onChange={setAmount} />}</Field>
          {!plan && (
            <Field label="Période">
              {(fid) => (
                <select id={fid} value={periodType} onChange={(e) => setPeriodType(e.target.value as PeriodType)}>
                  {Object.entries(PERIOD_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              )}
            </Field>
          )}
        </div>
        {plan && <p className="small muted">{PERIOD_TYPES[plan.periodType]}{plan.memberCategory ? ` · catégorie attribuée au règlement : ${CATEGORIES[plan.memberCategory]}` : ''}</p>}
        {plans.data && activePlans.length === 0 && <Alert>Aucune formule active : créez-en une dans « Formules » ou saisissez un montant libre.</Alert>}
        <div className="form-actions">
          <button className="btn secondary" type="button" onClick={onClose}>Annuler</button>
          <button className="btn" type="submit">Créer la cotisation</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------ Liste */

export function DuesPage() {
  const { can, toast } = useApp();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('open');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams({ page: String(page), pageSize: '25', status });
  if (year) params.set('year', year);
  if (debounced) params.set('q', debounced);
  const list = useQuery({ queryKey: ['dues', params.toString()], queryFn: () => api.get<Paged<Due> & { totals: { amountCents: number; paidCents: number; outstandingCents: number } }>(`/asso/dues?${params}`), placeholderData: (p) => p });
  const summary = useQuery({ queryKey: ['dues-summary'], queryFn: () => api.get<{ open: number; openCents: number; paidThisYear: number }>('/asso/dues/summary') });
  const years = Array.from({ length: 6 }, (_, i) => String(new Date().getFullYear() + 1 - i));

  return (
    <>
      <Breadcrumb items={crumbs('Cotisations')} />
      <PageHead
        title="Cotisations"
        description="Appels de cotisation, règlements et reçus. Montants exacts au centime."
        actions={
          <>
            {can('asso.dues.export') && <button className="btn secondary" type="button" onClick={() => api.download(`/asso/dues/export.csv?${params}`, 'cotisations.csv').catch((e) => toast(errorMessage(e), 'error'))}>Exporter (CSV)</button>}
            {can('asso.dues.create') && <button className="btn" type="button" onClick={() => setCreating(true)}>Appeler une cotisation</button>}
          </>
        }
      />
      {summary.data && (
        <div className="grid-3" style={{ marginBottom: 16 }}>
          <div className="card kpi"><span className="label">Cotisations en attente</span><span className="value">{summary.data.open}</span></div>
          <div className="card kpi"><span className="label">Reste à encaisser</span><span className="value">{formatCents(summary.data.openCents)}</span></div>
          <div className="card kpi"><span className="label">Encaissé ({new Date().getFullYear()})</span><span className="value">{formatCents(summary.data.paidThisYear)}</span></div>
        </div>
      )}
      <div className="toolbar">
        <Field label="Rechercher">{(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Adhérent, libellé, n° de reçu" />}</Field>
        <Field label="Statut">
          {(id) => (
            <select id={id} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="open">En attente (à régler ou partiel)</option>
              <option value="all">Tous</option>
              <option value="paid">Réglées</option>
              <option value="waived">Exonérées</option>
              <option value="cancelled">Annulées</option>
            </select>
          )}
        </Field>
        <Field label="Année">
          {(id) => (
            <select id={id} value={year} onChange={(e) => { setYear(e.target.value); setPage(1); }}>
              <option value="">Toutes</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
        </Field>
      </div>
      {list.isLoading && <Loading />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data && (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Cotisations</caption>
              <thead><tr><th scope="col">Adhérent</th><th scope="col">Cotisation</th><th scope="col">Période</th><th scope="col">Montant</th><th scope="col">Réglé</th><th scope="col">Statut</th><th scope="col">Reçu</th></tr></thead>
              <tbody>
                {list.data.items.length === 0 && <tr><td colSpan={7} className="empty">Aucune cotisation.</td></tr>}
                {list.data.items.map((d) => (
                  <tr key={d.id}>
                    <td><button type="button" className="btn ghost sm" style={{ padding: 0, minHeight: 0 }} onClick={() => setOpenId(d.id)}><strong>{d.member.lastName.toUpperCase()}</strong>&nbsp;{d.member.firstName}</button></td>
                    <td>{d.label}</td>
                    <td className="small">{period(d)}</td>
                    <td className="nowrap">{formatCents(d.amountCents)}</td>
                    <td className="nowrap">{formatCents(d.paidCents)}</td>
                    <td><DueBadge status={d.status} /></td>
                    <td className="mono small">{d.receiptNumber && !d.receiptCancelledAt ? d.receiptNumber : '—'}</td>
                  </tr>
                ))}
              </tbody>
              {list.data.total > 0 && (
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={3}>Total de la sélection</th>
                    <td className="nowrap"><strong>{formatCents(list.data.totals.amountCents)}</strong></td>
                    <td className="nowrap"><strong>{formatCents(list.data.totals.paidCents)}</strong></td>
                    <td colSpan={2} className="small">Reste : {formatCents(list.data.totals.outstandingCents)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
        </>
      )}
      <DueModal id={openId} onClose={() => setOpenId(null)} />
      <NewDueModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />
    </>
  );
}

/* --------------------------------------------------- Formules */

export function PlansPage() {
  const { can, toast } = useApp();
  const invalidate = useInvalidateDues();
  const q = useQuery({ queryKey: ['plans'], queryFn: () => api.get<Plan[]>('/asso/plans') });
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', description: '', amount: '', periodType: 'calendar_year' as PeriodType, memberCategory: '', active: true });
  const [error, setError] = useState<string | null>(null);
  const openForm = (p: Plan | 'new') => {
    setError(null);
    setForm(p === 'new'
      ? { name: '', description: '', amount: '', periodType: 'calendar_year', memberCategory: '', active: true }
      : { name: p.name, description: p.description ?? '', amount: centsToInput(p.amountCents), periodType: p.periodType, memberCategory: p.memberCategory ?? '', active: p.active });
    setEditing(p);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = parseEuros(form.amount);
    if (cents === null) return setError('Montant invalide.');
    const body = { name: form.name, description: form.description || null, amountCents: cents, periodType: form.periodType, memberCategory: form.memberCategory || null, active: form.active };
    try {
      if (editing === 'new') await api.post('/asso/plans', body);
      else if (editing) await api.patch(`/asso/plans/${editing.id}`, body);
      toast('Formule enregistrée.');
      setEditing(null);
      invalidate();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Formules')} />
      <PageHead title="Formules de cotisation" description="Tarifs proposés aux adhérents. Modifier un montant n’affecte pas les cotisations déjà appelées." actions={can('asso.plans.create') && <button className="btn" type="button" onClick={() => openForm('new')}>Nouvelle formule</button>} />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Formule</th><th scope="col">Montant</th><th scope="col">Période</th><th scope="col">Catégorie attribuée</th><th scope="col">Cotisations</th><th scope="col">État</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {q.data.length === 0 && <tr><td colSpan={7} className="empty">Aucune formule. Créez par exemple « Plein tarif », « Tarif réduit », « Famille ».</td></tr>}
              {q.data.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong>{p.description && <div className="small muted">{p.description}</div>}</td>
                  <td className="nowrap">{formatCents(p.amountCents)}</td>
                  <td>{PERIOD_TYPES[p.periodType]}</td>
                  <td>{p.memberCategory ? CATEGORIES[p.memberCategory] : '—'}</td>
                  <td>{p.dues}</td>
                  <td>{p.active ? <Badge tone="success">✓ Proposée</Badge> : <Badge>○ Retirée</Badge>}</td>
                  <td className="actions">
                    {can('asso.plans.update') && <button className="btn ghost sm" type="button" onClick={() => openForm(p)}>Modifier</button>}
                    {can('asso.plans.delete') && <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm<{ detachedDues: number }>(`/asso/plans/${p.id}`, `Supprimer la formule « ${p.name} » ? Les cotisations déjà appelées gardent leur libellé et leur montant.`)
                      .then((r) => { if (r) { toast('Formule supprimée.'); invalidate(); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={Boolean(editing)} title={editing === 'new' ? 'Nouvelle formule' : 'Modifier la formule'} onClose={() => setEditing(null)}>
        <form className="stack" onSubmit={submit}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <div className="form-grid">
            <Field label="Nom">{(id) => <input id={id} type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Montant">{(id) => <MoneyInput id={id} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} />}</Field>
            <Field label="Période couverte">
              {(id) => (
                <select id={id} value={form.periodType} onChange={(e) => setForm({ ...form, periodType: e.target.value as PeriodType })}>
                  {Object.entries(PERIOD_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              )}
            </Field>
            <Field label="Catégorie attribuée au règlement">
              {(id) => (
                <select id={id} value={form.memberCategory} onChange={(e) => setForm({ ...form, memberCategory: e.target.value })}>
                  <option value="">Ne pas modifier</option>
                  {Object.entries(CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              )}
            </Field>
            <Field label="Description" className="full">{(id) => <input id={id} type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span>Formule proposée (décochez pour la retirer sans perdre l’historique)</span></label>
          </div>
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={() => setEditing(null)}>Annuler</button>
            <button className="btn" type="submit">Enregistrer</button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/* --------------------------------------------- Renouvellements */

interface Renewal { id: string; number: number; firstName: string; lastName: string; email: string | null; status: string; category: string; coveredUntil: string | null; openDues: number }

export function RenewalsPage() {
  const { can, toast } = useApp();
  const invalidate = useInvalidateDues();
  const [days, setDays] = useState(30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [planId, setPlanId] = useState('');
  const [start, setStart] = useState(today());
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['renewals', days], queryFn: () => api.get<Renewal[]>(`/asso/dues/renewals?days=${days}`) });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<Plan[]>('/asso/plans') });
  const active = (plans.data ?? []).filter((p) => p.active);
  useEffect(() => {
    if (!planId && active[0]) setPlanId(active[0].id);
  }, [active, planId]);
  const rows = q.data ?? [];
  const eligible = rows.filter((r) => r.openDues === 0);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const bulk = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ created: number; skipped: { reason: string }[] }>('/asso/dues/bulk', { memberIds: [...selected], planId, periodStart: start });
      toast(`${r.created} cotisation(s) appelée(s)${r.skipped.length ? `, ${r.skipped.length} ignorée(s) : ${r.skipped[0].reason}` : ''}.`, r.skipped.length ? 'error' : 'success');
      setSelected(new Set());
      invalidate();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Breadcrumb items={crumbs('Renouvellements')} />
      <PageHead title="Renouvellements" description="Adhérents sans cotisation réglée couvrant la période à venir." />
      <div className="toolbar">
        <Field label="Couverture nécessaire">
          {(id) => (
            <select id={id} value={days} onChange={(e) => { setDays(Number(e.target.value)); setSelected(new Set()); }}>
              <option value={0}>Aujourd’hui</option>
              <option value={30}>30 prochains jours</option>
              <option value={60}>60 prochains jours</option>
              <option value={90}>90 prochains jours</option>
            </select>
          )}
        </Field>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="stack">
          {can('asso.dues.create') && (
            <div className="card row" style={{ alignItems: 'flex-end' }}>
              <Field label="Formule">{(id) => <select id={id} value={planId} onChange={(e) => setPlanId(e.target.value)}>{active.map((p) => <option key={p.id} value={p.id}>{p.name} — {formatCents(p.amountCents)}</option>)}</select>}</Field>
              <Field label="Date de référence">{(id) => <input id={id} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
              <button className="btn" type="button" disabled={selected.size === 0 || !planId || busy} onClick={bulk}>Appeler la cotisation ({selected.size})</button>
              {active.length === 0 && <span className="small muted">Créez d’abord une formule.</span>}
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">
                    <input type="checkbox" aria-label="Tout sélectionner" checked={eligible.length > 0 && eligible.every((r) => selected.has(r.id))} onChange={(e) => setSelected(e.target.checked ? new Set(eligible.map((r) => r.id)) : new Set())} />
                  </th>
                  <th scope="col">Adhérent</th><th scope="col">E-mail</th><th scope="col">Catégorie</th><th scope="col">Couvert jusqu’au</th><th scope="col">Cotisation en attente</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={6} className="empty">Tous les adhérents sont à jour.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><input type="checkbox" aria-label={`Sélectionner ${r.firstName} ${r.lastName}`} disabled={r.openDues > 0} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                    <td><Link to={`/asso/adherents/${r.id}`}><strong>{r.lastName.toUpperCase()}</strong> {r.firstName}</Link> <span className="small muted">n° {r.number}</span></td>
                    <td className="small">{r.email ?? '—'}</td>
                    <td>{CATEGORIES[r.category] ?? r.category}</td>
                    <td>{r.coveredUntil ? formatDate(r.coveredUntil) : <span className="muted">Jamais</span>}</td>
                    <td>{r.openDues > 0 ? <Badge tone="warning">Déjà appelée</Badge> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------- Section de la fiche adhérent */

export function MemberDues({ member }: { member: Member }) {
  const { can } = useApp();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['dues', 'member', member.id], queryFn: () => api.get<Paged<Due>>(`/asso/dues?memberId=${member.id}&pageSize=50`) });
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>Cotisations</h2>
        {can('asso.dues.create') && member.status !== 'archived' && <button className="btn secondary sm" type="button" onClick={() => setCreating(true)}>Appeler une cotisation</button>}
      </div>
      {q.isLoading && <Loading />}
      {q.data && q.data.items.length === 0 && <p className="muted" style={{ marginTop: 12 }}>Aucune cotisation.</p>}
      {q.data && q.data.items.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
          {q.data.items.map((d) => (
            <li key={d.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <button type="button" className="btn ghost sm" style={{ padding: 0 }} onClick={() => setOpenId(d.id)}>{d.label}</button>
              <span className="small muted">{period(d)}</span>
              <span className="nowrap">{formatCents(d.paidCents)} / {formatCents(d.amountCents)}</span>
              <DueBadge status={d.status} />
            </li>
          ))}
        </ul>
      )}
      <DueModal id={openId} onClose={() => setOpenId(null)} />
      <NewDueModal open={creating} member={{ id: member.id, label: `${member.firstName} ${member.lastName} (n° ${member.number})` }} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />
    </section>
  );
}
