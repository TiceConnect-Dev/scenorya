import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EVENT_CATEGORIES, EventCategory, isFeatureEnabled } from '@scenorya/shared';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, Loading, Modal, ModuleLogo, PageHead } from '../../components/ui';
import { MemberPicker, Group } from '../asso/Groups';

const TZ = 'Europe/Paris';
const DAY = 86_400_000;

interface Occ {
  id: string;
  occurrence: string;
  title: string;
  category: EventCategory;
  location: string | null;
  allDay: boolean;
  start: string;
  end: string;
  recurring: boolean;
  participants: { invited: number; yes: number; no: number; maybe: number };
}
interface Participant { memberId: string; status: 'invited' | 'yes' | 'no' | 'maybe'; comment: string | null; firstName: string; lastName: string; number: number }
interface EventDetail {
  id: string; title: string; description: string | null; location: string | null; category: EventCategory; startAt: string; endAt: string; allDay: boolean;
  rule: { freq: 'daily' | 'weekly' | 'monthly'; interval: number; byWeekday?: number[]; until?: string | null; count?: number | null } | null;
  visibility: 'internal' | 'public'; nextOccurrences: { start: string; end: string; key: string }[];
  participants: Participant[]; participantCounts: Record<string, number>; canSeeParticipants: boolean;
}
interface Conflict { eventId: string; title: string; start: string; end: string; reasons: string[] }

const RESPONSES: Record<Participant['status'], string> = { invited: 'Sans réponse', yes: 'Présent', no: 'Excusé', maybe: 'Peut-être' };
const WEEKDAYS = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];

const fmt = (d: string | Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, ...o }).format(new Date(d));
const keyOf = (d: Date) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
const timeRange = (o: { start: string; end: string; allDay: boolean }) => (o.allDay ? 'Journée' : `${fmt(o.start, { hour: '2-digit', minute: '2-digit' })} – ${fmt(o.end, { hour: '2-digit', minute: '2-digit' })}`);
/** Minuit (heure de Paris) d'une date AAAA-MM-JJ, approximé en heure locale du navigateur. */
const atLocal = (k: string, time = '00:00') => new Date(`${k}T${time}`);
const pad = (n: number) => String(n).padStart(2, '0');
const toInputDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toInputTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function CategoryDot({ c }: { c: EventCategory }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: EVENT_CATEGORIES[c]?.color ?? '#999', marginRight: 6, flex: 'none' }} />;
}

/* -------------------------------------------------- Formulaire */

interface FormState {
  title: string; category: EventCategory; location: string; description: string; allDay: boolean;
  date: string; startTime: string; endDate: string; endTime: string;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly'; interval: number; weekdays: number[]; until: string;
  visibility: 'internal' | 'public'; members: { id: string; label: string }[]; groupIds: string[];
}

const emptyForm = (day?: string): FormState => {
  const d = day ?? toInputDate(new Date());
  return { title: '', category: 'rehearsal', location: '', description: '', allDay: false, date: d, startTime: '19:00', endDate: d, endTime: '22:00', repeat: 'none', interval: 1, weekdays: [], until: '', visibility: 'internal', members: [], groupIds: [] };
};

function payload(f: FormState) {
  const start = f.allDay ? atLocal(f.date) : atLocal(f.date, f.startTime);
  const end = f.allDay ? atLocal(f.endDate) : atLocal(f.endDate, f.endTime);
  return {
    title: f.title, category: f.category, location: f.location || null, description: f.description || null, allDay: f.allDay,
    start: start.toISOString(), end: end.toISOString(), visibility: f.visibility,
    rule: f.repeat === 'none' ? null : { freq: f.repeat, interval: f.interval, byWeekday: f.repeat === 'weekly' && f.weekdays.length ? f.weekdays : undefined, until: f.until || null },
  };
}

function EventForm({ open, initial, editId, onClose, onSaved }: { open: boolean; initial: FormState; editId?: string; onClose: () => void; onSaved: () => void }) {
  const { ctx, can, toast } = useApp();
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const invitations = Boolean(ctx && isFeatureEnabled(ctx.modules, 'agenda.memberInvitations') && can('asso.members.read'));
  const groups = useQuery({ queryKey: ['groups', false], queryFn: () => api.get<Group[]>('/asso/groups?archived=false'), enabled: open && invitations && can('asso.groups.read') });
  useEffect(() => {
    if (open) {
      setF(initial);
      setError(null);
      setConflicts([]);
    }
  }, [open, initial]);

  // Aperçu des conflits en direct (participants et lieu).
  useEffect(() => {
    if (!open || !f.title || !f.date) return;
    const t = setTimeout(() => {
      api
        .post<{ conflicts: Conflict[] }>('/agenda/conflicts', { ...payload(f), title: f.title || 'x', memberIds: f.members.map((m) => m.id), groupIds: f.groupIds, excludeId: editId })
        .then((r) => setConflicts(r.conflicts))
        .catch(() => setConflicts([]));
    }, 500);
    return () => clearTimeout(t);
  }, [open, f, editId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (f.repeat !== 'none' && !f.until) return setError('Indiquez la date de fin de la récurrence.');
    try {
      if (editId) await api.patch(`/agenda/events/${editId}`, payload(f));
      else await api.post('/agenda/events', { ...payload(f), memberIds: f.members.map((m) => m.id), groupIds: f.groupIds });
      toast(editId ? 'Événement modifié.' : 'Événement créé.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal open={open} title={editId ? 'Modifier l’événement' : 'Nouvel événement'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <div className="form-grid">
          <Field label="Titre" className="full">{(id) => <input id={id} type="text" required value={f.title} onChange={(e) => set('title', e.target.value)} />}</Field>
          <Field label="Type">{(id) => <select id={id} value={f.category} onChange={(e) => set('category', e.target.value as EventCategory)}>{Object.entries(EVENT_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>}</Field>
          <Field label="Lieu">{(id) => <input id={id} type="text" value={f.location} onChange={(e) => set('location', e.target.value)} />}</Field>
          <label className="check full"><input type="checkbox" checked={f.allDay} onChange={(e) => set('allDay', e.target.checked)} /><span>Journée entière</span></label>
          <Field label="Début">{(id) => <input id={id} type="date" required value={f.date} onChange={(e) => setF((x) => ({ ...x, date: e.target.value, endDate: x.endDate < e.target.value ? e.target.value : x.endDate }))} />}</Field>
          {!f.allDay && <Field label="Heure de début">{(id) => <input id={id} type="time" required value={f.startTime} onChange={(e) => set('startTime', e.target.value)} />}</Field>}
          <Field label="Fin">{(id) => <input id={id} type="date" required min={f.date} value={f.endDate} onChange={(e) => set('endDate', e.target.value)} />}</Field>
          {!f.allDay && <Field label="Heure de fin">{(id) => <input id={id} type="time" required value={f.endTime} onChange={(e) => set('endTime', e.target.value)} />}</Field>}
          <Field label="Répétition">
            {(id) => (
              <select id={id} value={f.repeat} onChange={(e) => set('repeat', e.target.value as FormState['repeat'])}>
                <option value="none">Aucune</option>
                <option value="daily">Tous les jours</option>
                <option value="weekly">Toutes les semaines</option>
                <option value="monthly">Tous les mois</option>
              </select>
            )}
          </Field>
          {f.repeat !== 'none' && (
            <>
              <Field label={`Intervalle (${f.repeat === 'daily' ? 'jours' : f.repeat === 'weekly' ? 'semaines' : 'mois'})`}>{(id) => <input id={id} type="number" min={1} max={52} value={f.interval} onChange={(e) => set('interval', Math.max(1, Number(e.target.value)))} />}</Field>
              <Field label="Jusqu’au">{(id) => <input id={id} type="date" required min={f.date} value={f.until} onChange={(e) => set('until', e.target.value)} />}</Field>
              {f.repeat === 'weekly' && (
                <fieldset className="full">
                  <legend>Jours (par défaut : le jour du début)</legend>
                  <div className="chips">
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <button key={d} type="button" className="chip" aria-pressed={f.weekdays.includes(d)} onClick={() => set('weekdays', f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d])}>{WEEKDAYS[d]}</button>
                    ))}
                  </div>
                </fieldset>
              )}
            </>
          )}
          <Field label="Description" className="full">{(id) => <textarea id={id} value={f.description} onChange={(e) => set('description', e.target.value)} />}</Field>
          <Field label="Visibilité" hint="« Public » rendra l’événement publiable sur le site (Scenorya Web, phase 7).">
            {(id, d) => <select id={id} aria-describedby={d} value={f.visibility} onChange={(e) => set('visibility', e.target.value as FormState['visibility'])}><option value="internal">Interne</option><option value="public">Public</option></select>}
          </Field>
        </div>
        {!editId && invitations && (
          <fieldset>
            <legend>Participants</legend>
            {groups.data && groups.data.length > 0 && (
              <div className="chips" style={{ marginBottom: 10 }}>
                {groups.data.map((g) => (
                  <button key={g.id} type="button" className="chip" aria-pressed={f.groupIds.includes(g.id)} onClick={() => set('groupIds', f.groupIds.includes(g.id) ? f.groupIds.filter((x) => x !== g.id) : [...f.groupIds, g.id])}>
                    {g.name} ({g.members})
                  </button>
                ))}
              </div>
            )}
            <MemberPicker value={f.members} onChange={(v) => set('members', v)} />
          </fieldset>
        )}
        {conflicts.length > 0 && (
          <Alert tone="warning">
            <strong>Conflits détectés</strong> (l’enregistrement reste possible) :
            <ul>
              {conflicts.map((c) => <li key={c.eventId}>{c.title} — {fmt(c.start, { dateStyle: 'short', timeStyle: 'short' })} : {c.reasons.join(' ; ')}</li>)}
            </ul>
          </Alert>
        )}
        <div className="form-actions">
          <button className="btn secondary" type="button" onClick={onClose}>Annuler</button>
          <button className="btn" type="submit">{editId ? 'Enregistrer' : 'Créer'}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------- Détail */

function EventModal({ sel, onClose, onEdit, onChanged }: { sel: { id: string; occurrence: string } | null; onClose: () => void; onEdit: (d: EventDetail) => void; onChanged: () => void }) {
  const { can, toast, ctx } = useApp();
  const q = useQuery({ queryKey: ['event', sel?.id], queryFn: () => api.get<EventDetail>(`/agenda/events/${sel!.id}`), enabled: Boolean(sel) });
  const [adding, setAdding] = useState<{ id: string; label: string }[]>([]);
  const d = q.data;
  const canEdit = can('agenda.events.update');
  const invitations = Boolean(ctx && isFeatureEnabled(ctx.modules, 'agenda.memberInvitations') && can('asso.members.read'));
  const act = async (fn: () => Promise<unknown>, ok: string, close = false) => {
    try {
      await fn();
      toast(ok);
      onChanged();
      if (close) onClose();
      else q.refetch();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Modal open={Boolean(sel)} title={d?.title ?? 'Événement'} onClose={onClose}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {d && sel && (
        <div className="stack">
          <dl className="props">
            <dt>Type</dt><dd><CategoryDot c={d.category} />{EVENT_CATEGORIES[d.category].label}{d.visibility === 'public' && <> <Badge tone="info">Public</Badge></>}</dd>
            <dt>Date</dt><dd>{fmt(atLocal(sel.occurrence, '12:00'), { dateStyle: 'full' })}{!d.allDay && ` · ${fmt(d.startAt, { hour: '2-digit', minute: '2-digit' })} – ${fmt(d.endAt, { hour: '2-digit', minute: '2-digit' })}`}</dd>
            {d.rule && (<><dt>Répétition</dt><dd>{{ daily: 'Quotidienne', weekly: 'Hebdomadaire', monthly: 'Mensuelle' }[d.rule.freq]}{d.rule.interval > 1 ? ` (tous les ${d.rule.interval})` : ''}{d.rule.until ? ` jusqu’au ${fmt(atLocal(d.rule.until, '12:00'), { dateStyle: 'short' })}` : ''}</dd></>)}
            {d.location && (<><dt>Lieu</dt><dd>{d.location}</dd></>)}
            {d.description && (<><dt>Description</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.description}</dd></>)}
          </dl>
          <section>
            <h3>Participants</h3>
            {!d.canSeeParticipants ? (
              <p className="muted small">{Object.values(d.participantCounts).reduce((a, b) => a + b, 0)} participant(s) — noms visibles avec l’accès aux adhérents.</p>
            ) : d.participants.length === 0 ? (
              <p className="muted small">Aucun participant.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {d.participants.map((p) => (
                  <li key={p.memberId} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>{p.firstName} {p.lastName}{p.comment && <span className="small muted"> — {p.comment}</span>}</span>
                    {canEdit ? (
                      <span className="row" style={{ gap: 6 }}>
                        <label className="sr-only" htmlFor={`rsp-${p.memberId}`}>Réponse de {p.firstName}</label>
                        <select id={`rsp-${p.memberId}`} value={p.status} style={{ minHeight: 32, width: 'auto' }} onChange={(e) => act(() => api.patch(`/agenda/events/${d.id}/participants/${p.memberId}`, { status: e.target.value }), 'Réponse enregistrée.')}>
                          {Object.entries(RESPONSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                        <button type="button" className="btn ghost sm" aria-label={`Retirer ${p.firstName}`} onClick={() => act(() => api.delete(`/agenda/events/${d.id}/participants/${p.memberId}`), 'Participant retiré.')}>✕</button>
                      </span>
                    ) : <Badge tone={p.status === 'yes' ? 'success' : p.status === 'no' ? 'neutral' : 'info'}>{RESPONSES[p.status]}</Badge>}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && invitations && (
              <div style={{ marginTop: 10 }}>
                <MemberPicker value={adding} onChange={setAdding} />
                {adding.length > 0 && <button className="btn sm" type="button" style={{ marginTop: 8 }} onClick={async () => { await act(() => api.put(`/agenda/events/${d.id}/participants`, { memberIds: adding.map((a) => a.id) }), 'Participants invités.'); setAdding([]); }}>Inviter {adding.length}</button>}
              </div>
            )}
          </section>
          {canEdit && (
            <div className="row">
              <button className="btn secondary" type="button" onClick={() => onEdit(d)}>Modifier {d.rule ? 'la série' : ''}</button>
              {d.rule && <button className="btn ghost" type="button" onClick={() => window.confirm('Annuler uniquement cette date ?') && act(() => api.post(`/agenda/events/${d.id}/cancel-occurrence`, { occurrence: sel.occurrence }), 'Date annulée.', true)}>Annuler cette date</button>}
              {can('agenda.events.delete') && <button className="btn ghost" type="button" onClick={() => window.confirm(d.rule ? 'Annuler toute la série ?' : 'Annuler cet événement ?') && act(() => api.delete(`/agenda/events/${d.id}`), 'Événement annulé.', true)}>Annuler {d.rule ? 'la série' : 'l’événement'}</button>}
              {can('agenda.events.delete') && <button className="btn danger" type="button" onClick={() => window.confirm(`Supprimer définitivement « ${d.title} »${d.rule ? ' et toutes ses dates' : ''}, avec les réponses des participants ?`) && act(() => api.delete(`/agenda/events/${d.id}?purge=1`), 'Événement supprimé.', true)}>Supprimer</button>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------- Abonnement */

function Subscription() {
  const { toast } = useApp();
  const status = useQuery({ queryKey: ['agenda-feed'], queryFn: () => api.get<{ active: boolean; lastUsedAt: string | null }>('/agenda/feed') });
  const [link, setLink] = useState<{ url: string; webcal: string } | null>(null);
  return (
    <section className="card stack">
      <h2>Agenda sur mon téléphone</h2>
      <p className="small muted">Abonnez votre application d’agenda (iPhone, Android, Outlook, Thunderbird) : les événements se mettent à jour automatiquement. Le lien est personnel ; il cesse de fonctionner si vous perdez vos droits ou si vous le révoquez.</p>
      {link ? (
        <Alert tone="success">
          <p>Lien créé (il ne sera plus affiché) :</p>
          <p className="mono small" style={{ wordBreak: 'break-all' }}>{link.url}</p>
          <div className="row">
            <button className="btn sm" type="button" onClick={() => navigator.clipboard?.writeText(link.url).then(() => toast('Lien copié.'))}>Copier</button>
            <a className="btn secondary sm" href={link.webcal}>Ouvrir dans l’agenda</a>
          </div>
        </Alert>
      ) : (
        <p className="small">{status.data?.active ? `Un abonnement est actif${status.data.lastUsedAt ? ` (dernière synchronisation : ${fmt(status.data.lastUsedAt, { dateStyle: 'short', timeStyle: 'short' })})` : ''}.` : 'Aucun abonnement actif.'}</p>
      )}
      <div className="row">
        <button className="btn secondary sm" type="button" onClick={async () => { try { setLink(await api.post('/agenda/feed')); status.refetch(); } catch (e) { toast(errorMessage(e), 'error'); } }}>{status.data?.active ? 'Générer un nouveau lien' : 'Créer mon lien d’abonnement'}</button>
        {status.data?.active && <button className="btn ghost sm" type="button" onClick={async () => { await api.delete('/agenda/feed'); setLink(null); status.refetch(); toast('Abonnement révoqué.'); }}>Révoquer</button>}
      </div>
    </section>
  );
}

/* ------------------------------------------------------ Page */

export function AgendaPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const [view, setView] = useState<'month' | 'week' | 'list'>(() => (window.matchMedia('(max-width: 700px)').matches ? 'list' : 'month'));
  const [cursor, setCursor] = useState(() => new Date());
  const [category, setCategory] = useState('');
  const [sel, setSel] = useState<{ id: string; occurrence: string } | null>(null);
  const [form, setForm] = useState<{ initial: FormState; editId?: string } | null>(null);

  const range = useMemo(() => {
    if (view === 'month') {
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const start = startOfWeek(first);
      return { start, end: new Date(start.getTime() + 42 * DAY) };
    }
    if (view === 'week') {
      const start = startOfWeek(cursor);
      return { start, end: new Date(start.getTime() + 7 * DAY) };
    }
    const start = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
    return { start, end: new Date(start.getTime() + 31 * DAY) };
  }, [view, cursor]);

  const q = useQuery({
    queryKey: ['agenda', range.start.toISOString(), range.end.toISOString(), category],
    queryFn: () => api.get<{ items: Occ[] }>(`/agenda/events?from=${range.start.toISOString()}&to=${range.end.toISOString()}${category ? `&category=${category}` : ''}`),
    placeholderData: (p) => p,
  });
  const byDay = useMemo(() => {
    const map = new Map<string, Occ[]>();
    for (const o of q.data?.items ?? []) {
      // Un événement sur plusieurs jours apparaît chaque jour.
      for (let t = new Date(o.start).getTime(); t < new Date(o.end).getTime(); t += DAY) {
        const k = keyOf(new Date(t));
        map.set(k, [...(map.get(k) ?? []), o]);
        if (!o.allDay) break;
      }
    }
    return map;
  }, [q.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['agenda'] });
    qc.invalidateQueries({ queryKey: ['event'] });
    qc.invalidateQueries({ queryKey: ['hub'] });
  };
  const move = (dir: number) => {
    const d = new Date(cursor);
    if (view === 'month') d.setMonth(d.getMonth() + dir);
    else if (view === 'week') d.setDate(d.getDate() + 7 * dir);
    else d.setDate(d.getDate() + 31 * dir);
    setCursor(d);
  };
  const title = view === 'month' ? fmt(cursor, { month: 'long', year: 'numeric' }) : view === 'week' ? `Semaine du ${fmt(range.start, { day: 'numeric', month: 'long' })}` : `À partir du ${fmt(range.start, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const days = Array.from({ length: Math.round((range.end.getTime() - range.start.getTime()) / DAY) }, (_, i) => new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + i));
  const today = keyOf(new Date());
  const openNew = (day?: string) => can('agenda.events.create') && setForm({ initial: emptyForm(day) });
  const chip = (o: Occ) => (
    <button key={o.id + o.occurrence} type="button" className="agenda-chip" style={{ ['--c' as string]: EVENT_CATEGORIES[o.category]?.color }} onClick={(e) => { e.stopPropagation(); setSel({ id: o.id, occurrence: o.occurrence }); }} title={`${o.title} — ${timeRange(o)}`}>
      {!o.allDay && <span className="small">{fmt(o.start, { hour: '2-digit', minute: '2-digit' })}</span>} {o.title}
    </button>
  );

  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Agenda' }]} />
      <div className="module-banner"><ModuleLogo id="agenda" /></div>
      <PageHead
        title="Agenda"
        description="Répétitions, réunions, assemblées, représentations et échéances."
        actions={
          <>
            {can('agenda.events.export') && <button className="btn secondary" type="button" onClick={() => api.download(`/agenda/events.ics?from=${range.start.toISOString()}&to=${new Date(range.start.getTime() + 365 * DAY).toISOString()}`, 'agenda.ics').catch((e) => toast(errorMessage(e), 'error'))}>Exporter (.ics)</button>}
            {can('agenda.events.create') && <button className="btn" type="button" onClick={() => openNew()}>Nouvel événement</button>}
          </>
        }
      />
      <div className="toolbar" style={{ alignItems: 'center' }}>
        <div className="row">
          <button className="btn secondary sm" type="button" onClick={() => move(-1)} aria-label="Période précédente">‹</button>
          <button className="btn secondary sm" type="button" onClick={() => setCursor(new Date())}>Aujourd’hui</button>
          <button className="btn secondary sm" type="button" onClick={() => move(1)} aria-label="Période suivante">›</button>
          <h2 className="cap-first" style={{ margin: 0 }} aria-live="polite">{title}</h2>
        </div>
        <div className="row grow" style={{ justifyContent: 'flex-end' }}>
          <label className="sr-only" htmlFor="cat-filter">Type</label>
          <select id="cat-filter" style={{ width: 'auto' }} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Tous les types</option>
            {Object.entries(EVENT_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <div className="chips" role="group" aria-label="Vue">
            {(['month', 'week', 'list'] as const).map((v) => <button key={v} type="button" className="chip" aria-pressed={view === v} onClick={() => setView(v)}>{{ month: 'Mois', week: 'Semaine', list: 'Liste' }[v]}</button>)}
          </div>
        </div>
      </div>
      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <Loading />}
      {q.data && view === 'month' && (
        <div className="agenda-month" role="grid" aria-label={title}>
          {['Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.', 'Dim.'].map((d) => <div key={d} className="agenda-head" role="columnheader">{d}</div>)}
          {days.map((d) => {
            const k = toInputDate(d);
            const items = byDay.get(k) ?? [];
            return (
              <div key={k} role="gridcell" className={`agenda-cell${d.getMonth() !== cursor.getMonth() ? ' other' : ''}${k === today ? ' today' : ''}`} onDoubleClick={() => openNew(k)}>
                <div className="agenda-daynum">{d.getDate()}</div>
                {items.slice(0, 4).map(chip)}
                {items.length > 4 && <button type="button" className="btn ghost sm" style={{ minHeight: 0, padding: '0 4px' }} onClick={() => { setCursor(d); setView('list'); }}>+{items.length - 4} autres</button>}
              </div>
            );
          })}
        </div>
      )}
      {q.data && view === 'week' && (
        <div className="agenda-week">
          {days.map((d) => {
            const k = toInputDate(d);
            return (
              <div key={k} className={`agenda-col${k === today ? ' today' : ''}`}>
                <div className="agenda-head">{fmt(d, { weekday: 'short', day: 'numeric' })}</div>
                {(byDay.get(k) ?? []).map(chip)}
                {can('agenda.events.create') && <button type="button" className="btn ghost sm" onClick={() => openNew(k)} aria-label={`Ajouter le ${fmt(d, { dateStyle: 'full' })}`}>+</button>}
              </div>
            );
          })}
        </div>
      )}
      {q.data && view === 'list' && (
        <div className="stack" style={{ gap: 12 }}>
          {days.filter((d) => byDay.has(toInputDate(d))).length === 0 && <div className="card empty">Aucun événement sur cette période.</div>}
          {days.filter((d) => byDay.has(toInputDate(d))).map((d) => (
            <section key={d.toISOString()} className="card" style={{ padding: 14 }}>
              <h3 className="cap-first">{fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {byDay.get(toInputDate(d))!.map((o) => (
                  <li key={o.id + o.occurrence}>
                    <button type="button" className="agenda-row" onClick={() => setSel({ id: o.id, occurrence: o.occurrence })}>
                      <span className="nowrap" style={{ minWidth: 110 }}>{timeRange(o)}</span>
                      <span className="grow" style={{ textAlign: 'left' }}><CategoryDot c={o.category} /><strong>{o.title}</strong>{o.location && <span className="muted"> · {o.location}</span>}</span>
                      {o.participants.invited + o.participants.yes + o.participants.maybe + o.participants.no > 0 && <span className="small muted nowrap">{o.participants.yes} présent(s) / {o.participants.invited + o.participants.yes + o.participants.maybe + o.participants.no}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <div className="row small muted" style={{ marginTop: 12, gap: 14 }}>
        {Object.entries(EVENT_CATEGORIES).map(([k, v]) => <span key={k}><CategoryDot c={k as EventCategory} />{v.label}</span>)}
      </div>
      <div style={{ marginTop: 16 }}><Subscription /></div>
      <EventModal
        sel={sel}
        onClose={() => setSel(null)}
        onChanged={refresh}
        onEdit={(d) => {
          setSel(null);
          const s = new Date(d.startAt);
          const e = new Date(d.allDay ? new Date(d.endAt).getTime() - DAY : d.endAt);
          setForm({
            editId: d.id,
            initial: {
              ...emptyForm(), title: d.title, category: d.category, location: d.location ?? '', description: d.description ?? '', allDay: d.allDay,
              date: toInputDate(s), startTime: toInputTime(s), endDate: toInputDate(e), endTime: toInputTime(e), visibility: d.visibility,
              repeat: d.rule?.freq ?? 'none', interval: d.rule?.interval ?? 1, weekdays: d.rule?.byWeekday ?? [], until: d.rule?.until ?? '',
            },
          });
        }}
      />
      <EventForm open={Boolean(form)} initial={form?.initial ?? emptyForm()} editId={form?.editId} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />
    </>
  );
}
