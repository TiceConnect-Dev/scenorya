import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EVENT_CATEGORIES, EventCategory, formatCents } from '@scenorya/shared';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatBytes, formatDate, Loading, Modal, PageHead } from '../../components/ui';
import { AuthLayout } from '../Public';
import { MEETING_TYPES } from '../asso/Governance';

/* --------------------------------------------------------------- Types */

interface Me {
  association: string;
  member: null | {
    id: string; number: number; firstName: string; lastName: string; email: string | null; phone: string | null; birthDate: string | null;
    addressLine: string | null; postalCode: string | null; city: string | null; category: string; status: string; joinedAt: string;
    isMinor: boolean; guardianName: string | null; imageRights: boolean;
  };
  upToDate?: boolean; validUntil?: string | null;
  groups?: { name: string; kind: string }[];
  mandates?: { role: string; body: string; startDate: string; endDate: string | null }[];
  sections: { dues: boolean; card: boolean; events: boolean; meetings: boolean; documents: boolean; cast?: boolean; show?: boolean };
}
interface Due { id: string; label: string; amountCents: number; paidCents: number; status: string; periodStart: string; periodEnd: string | null; receipt: string | null }
interface EspaceEvent { id: string; occurrence: string; title: string; category: EventCategory; location: string | null; allDay: boolean; start: string; end: string; description: string | null; status: 'invited' | 'yes' | 'no' | 'maybe'; comment: string | null }
interface EspaceMeeting { id: string; title: string; type: string; startAt: string; location: string | null; status: string; attendance: string; agenda: string[]; convocation: boolean; minutes: boolean }
interface EspaceDoc { id: string; name: string; size: number; mime: string; updatedAt: string; description: string | null; folder: string }

const crumbs = (label?: string) => [{ label: 'Mon espace', to: label ? '/espace' : undefined }, ...(label ? [{ label }] : [])];
const STATUS: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral' | 'info']> = {
  active: ['Adhérent actif', 'success'], pending: ['Adhésion en attente', 'warning'], expired: ['Adhésion expirée', 'danger'], archived: ['Archivé', 'neutral'],
};
const DUE_STATUS: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral' | 'info']> = {
  pending: ['À régler', 'warning'], partial: ['Partiellement réglée', 'info'], paid: ['Réglée', 'success'], waived: ['Exonérée', 'neutral'],
};
const RSVP: Record<string, string> = { invited: 'Pas encore répondu', yes: 'Présent(e)', no: 'Absent(e)', maybe: 'Incertain(e)' };
const ATTENDANCE: Record<string, string> = { convened: 'Convoqué(e)', present: 'Présent(e)', represented: 'Représenté(e)', excused: 'Excusé(e)', absent: 'Absent(e)' };

function useMe() {
  return useQuery({ queryKey: ['espace', 'me'], queryFn: () => api.get<Me>('/espace/me') });
}

/** Garde : compte non relié à une fiche d'adhérent. */
function NotLinked({ association }: { association: string }) {
  return (
    <>
      <Breadcrumb items={crumbs()} />
      <PageHead title="Mon espace" />
      <Alert>
        Votre compte n’est pas encore relié à une fiche d’adhérent de « {association} ». Demandez à l’association de vous envoyer une invitation à l’Espace,
        ou de relier votre compte depuis votre fiche.
      </Alert>
    </>
  );
}

/* ---------------------------------------------------------- Accueil */

export function EspaceHome() {
  const q = useMe();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  if (!d.member) return <NotLinked association={d.association} />;
  const m = d.member;
  const [label, tone] = STATUS[m.status] ?? [m.status, 'neutral'];
  return (
    <>
      <Breadcrumb items={crumbs()} />
      <PageHead title={`Bonjour ${m.firstName}`} description={`Votre espace personnel — ${d.association}`} />
      <div className="grid-3">
        <section className="card stack">
          <h2>Mon adhésion</h2>
          <div><Badge tone={tone}>{label}</Badge></div>
          <p className="small muted" style={{ margin: 0 }}>Adhérent n° {m.number} · depuis le {formatDate(m.joinedAt)}</p>
          {d.sections.dues && (
            d.upToDate
              ? <Alert tone="success">Cotisation à jour{d.validUntil ? ` jusqu’au ${formatDate(d.validUntil)}` : ''}.</Alert>
              : <Alert tone="warning">Aucune cotisation en cours de validité.</Alert>
          )}
          <div className="row">
            {d.sections.dues && <Link className="btn secondary sm" to="/espace/cotisations">Mes cotisations</Link>}
            {d.sections.card && <button className="btn secondary sm" type="button" onClick={() => api.download('/espace/card.pdf', `carte-${m.number}.pdf`)}>Ma carte d’adhérent</button>}
          </div>
        </section>
        <section className="card stack">
          <h2>Mes coordonnées</h2>
          <dl className="props">
            <dt>E-mail</dt><dd>{m.email ?? '—'}</dd>
            <dt>Téléphone</dt><dd>{m.phone ?? '—'}</dd>
            <dt>Adresse</dt><dd>{[m.addressLine, [m.postalCode, m.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'}</dd>
          </dl>
          <div><Link className="btn secondary sm" to="/espace/profil">Modifier</Link></div>
        </section>
        <section className="card stack">
          <h2>Mes engagements</h2>
          {!d.groups?.length && !d.mandates?.length && <p className="muted" style={{ margin: 0 }}>Aucun groupe ni mandat.</p>}
          {!!d.mandates?.length && <ul style={{ margin: 0, paddingLeft: 18 }}>{d.mandates.map((x, i) => <li key={i}><strong>{x.role}</strong> <span className="small muted">({x.body === 'bureau' ? 'bureau' : x.body === 'ca' ? 'conseil d’administration' : x.body})</span></li>)}</ul>}
          {!!d.groups?.length && <div className="chips">{d.groups.map((g) => <span key={g.name} className="tag">{g.name}</span>)}</div>}
        </section>
      </div>
      <div className="grid-3" style={{ marginTop: 16 }}>
        {d.sections.events && <Link className="card tile-link" to="/espace/agenda"><h2>Mon agenda</h2><p className="muted">Répétitions et événements auxquels vous êtes invité(e) ; indiquez votre présence.</p></Link>}
        {d.sections.meetings && <Link className="card tile-link" to="/espace/reunions"><h2>Assemblées et réunions</h2><p className="muted">Convocations et procès-verbaux des instances auxquelles vous êtes convoqué(e).</p></Link>}
        {d.sections.cast && <Link className="card tile-link" to="/espace/scene"><h2>Mes rôles et répétitions</h2><p className="muted">Vos rôles, vos convocations aux répétitions et vos indisponibilités.</p></Link>}
        {d.sections.show && <Link className="card tile-link" to="/espace/representations"><h2>Mes représentations</h2><p className="muted">Les dates où vous êtes attendu(e), sur scène ou dans l’équipe.</p></Link>}
        {d.sections.documents && <Link className="card tile-link" to="/espace/documents"><h2>Documents</h2><p className="muted">Documents mis à disposition des membres par l’association.</p></Link>}
      </div>
    </>
  );
}

/* ---------------------------------------------------------- Profil */

export function EspaceProfile() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useMe();
  const [f, setF] = useState<{ email: string; phone: string; addressLine: string; postalCode: string; city: string; imageRights: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const m = q.data?.member;
    if (m && !f) setF({ email: m.email ?? '', phone: m.phone ?? '', addressLine: m.addressLine ?? '', postalCode: m.postalCode ?? '', city: m.city ?? '', imageRights: m.imageRights });
  }, [q.data, f]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data!.member) return <NotLinked association={q.data!.association} />;
  if (!f) return <Loading />;
  const m = q.data!.member;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const n = (v: string) => v.trim() || null;
      const r = await api.patch<{ changed: string[] }>('/espace/me', { email: n(f.email), phone: n(f.phone), addressLine: n(f.addressLine), postalCode: n(f.postalCode), city: n(f.city), imageRights: f.imageRights });
      toast(r.changed.length ? 'Coordonnées enregistrées.' : 'Aucune modification.');
      qc.invalidateQueries({ queryKey: ['espace'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Mes coordonnées')} />
      <PageHead title="Mes coordonnées" description="Les modifications sont transmises à l’association et tracées. Pour changer votre nom ou votre date de naissance, contactez l’association." />
      <form className="card form-grid" onSubmit={submit}>
        {error && <div className="alert danger full" role="alert">{error}</div>}
        <Field label="Prénom">{(id) => <input id={id} type="text" value={m.firstName} disabled />}</Field>
        <Field label="Nom">{(id) => <input id={id} type="text" value={m.lastName} disabled />}</Field>
        <Field label="E-mail" hint="Adresse de contact de l’association (votre identifiant de connexion ne change pas)">{(id, d) => <input id={id} aria-describedby={d} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="Téléphone">{(id) => <input id={id} type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        <Field label="Adresse" className="full">{(id) => <input id={id} type="text" autoComplete="street-address" value={f.addressLine} onChange={(e) => setF({ ...f, addressLine: e.target.value })} />}</Field>
        <Field label="Code postal">{(id) => <input id={id} type="text" autoComplete="postal-code" maxLength={12} value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} />}</Field>
        <Field label="Ville">{(id) => <input id={id} type="text" autoComplete="address-level2" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
        <label className="check full"><input type="checkbox" checked={f.imageRights} onChange={(e) => setF({ ...f, imageRights: e.target.checked })} /> J’autorise l’association à utiliser mon image (photos, vidéos de spectacles)</label>
        <div className="form-actions full"><button className="btn" type="submit">Enregistrer</button></div>
      </form>
    </>
  );
}

/* ---------------------------------------------------------- Cotisations */

export function EspaceDues() {
  const me = useMe();
  const q = useQuery({ queryKey: ['espace', 'dues'], queryFn: () => api.get<Due[]>('/espace/dues'), enabled: !!me.data?.member });
  if (me.isLoading || q.isLoading) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} />;
  if (!me.data!.member) return <NotLinked association={me.data!.association} />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <Breadcrumb items={crumbs('Mes cotisations')} />
      <PageHead title="Mes cotisations" description="Le reçu est disponible dès qu’une cotisation est entièrement réglée." />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Cotisation</th><th>Période</th><th>Montant</th><th>Réglé</th><th>État</th><th className="actions">Reçu</th></tr></thead>
          <tbody>
            {q.data!.map((d) => {
              const [l, t] = DUE_STATUS[d.status] ?? [d.status, 'neutral'];
              return (
                <tr key={d.id}>
                  <td className="strong">{d.label}</td>
                  <td className="small">{formatDate(d.periodStart)}{d.periodEnd ? ` → ${formatDate(d.periodEnd)}` : ''}</td>
                  <td>{formatCents(d.amountCents)}</td>
                  <td>{formatCents(d.paidCents)}</td>
                  <td><Badge tone={t}>{l}</Badge></td>
                  <td className="actions">{d.receipt ? <button className="btn ghost sm" type="button" onClick={() => api.download(`/espace/dues/${d.id}/receipt.pdf`, `recu-${d.receipt}.pdf`)}>Reçu n° {d.receipt}</button> : <span className="small muted">—</span>}</td>
                </tr>
              );
            })}
            {!q.data!.length && <tr><td colSpan={6} className="empty">Aucune cotisation enregistrée.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------------------------------------------------- Agenda */

export function EspaceAgenda() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const me = useMe();
  const q = useQuery({ queryKey: ['espace', 'events'], queryFn: () => api.get<EspaceEvent[]>('/espace/events'), enabled: !!me.data?.member });
  const [answer, setAnswer] = useState<{ e: EspaceEvent; status: 'yes' | 'no' | 'maybe'; comment: string } | null>(null);
  if (me.isLoading || q.isLoading) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} />;
  if (!me.data!.member) return <NotLinked association={me.data!.association} />;
  if (q.error) return <ErrorBox error={q.error} />;
  const send = async () => {
    if (!answer) return;
    try {
      await api.post(`/espace/events/${answer.e.id}/response`, { status: answer.status, comment: answer.comment || null });
      toast('Réponse enregistrée.');
      setAnswer(null);
      qc.invalidateQueries({ queryKey: ['espace', 'events'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Mon agenda')} />
      <PageHead title="Mon agenda" description="Événements des six prochains mois auxquels vous êtes invité(e). Pour un événement récurrent, votre réponse vaut pour toute la série." />
      <div className="stack">
        {q.data!.map((e) => (
          <article key={`${e.id}-${e.occurrence}`} className="card row between" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="small muted">{e.allDay ? formatDate(e.start) : formatDate(e.start, true)}{e.location ? ` · ${e.location}` : ''} · {EVENT_CATEGORIES[e.category]?.label ?? e.category}</div>
              <div className="strong" style={{ fontSize: '1.05rem' }}>{e.title}</div>
              {e.comment && <div className="small muted">Votre commentaire : {e.comment}</div>}
            </div>
            <div className="row">
              <Badge tone={e.status === 'yes' ? 'success' : e.status === 'no' ? 'danger' : e.status === 'maybe' ? 'warning' : 'neutral'}>{RSVP[e.status]}</Badge>
              <button className="btn secondary sm" type="button" onClick={() => setAnswer({ e, status: e.status === 'invited' ? 'yes' : e.status, comment: e.comment ?? '' })}>Répondre</button>
            </div>
          </article>
        ))}
        {!q.data!.length && <div className="card empty">Aucun événement prévu pour vous.</div>}
      </div>
      {answer && (
        <Modal open title={answer.e.title} onClose={() => setAnswer(null)} footer={<><button className="btn secondary" type="button" onClick={() => setAnswer(null)}>Annuler</button><button className="btn" type="button" onClick={send}>Envoyer ma réponse</button></>}>
          <fieldset className="stack">
            <legend className="small">Serez-vous présent(e) ?</legend>
            {(['yes', 'maybe', 'no'] as const).map((s) => (
              <label key={s} className="check"><input type="radio" name="rsvp" checked={answer.status === s} onChange={() => setAnswer({ ...answer, status: s })} /> {RSVP[s]}</label>
            ))}
          </fieldset>
          <Field label="Commentaire (facultatif)">{(id) => <input id={id} type="text" maxLength={300} value={answer.comment} onChange={(e) => setAnswer({ ...answer, comment: e.target.value })} />}</Field>
        </Modal>
      )}
    </>
  );
}

/* ---------------------------------------------------------- Réunions */

export function EspaceMeetings() {
  const me = useMe();
  const q = useQuery({ queryKey: ['espace', 'meetings'], queryFn: () => api.get<EspaceMeeting[]>('/espace/meetings'), enabled: !!me.data?.member });
  if (me.isLoading || q.isLoading) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} />;
  if (!me.data!.member) return <NotLinked association={me.data!.association} />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <Breadcrumb items={crumbs('Assemblées et réunions')} />
      <PageHead title="Assemblées et réunions" description="Le procès-verbal est disponible une fois la réunion clôturée." />
      <div className="stack">
        {q.data!.map((m) => (
          <article key={m.id} className="card stack">
            <div className="row between" style={{ flexWrap: 'wrap' }}>
              <div>
                <div className="small muted">{MEETING_TYPES[m.type] ?? m.type} · {formatDate(m.startAt, true)}{m.location ? ` · ${m.location}` : ''}</div>
                <div className="strong" style={{ fontSize: '1.05rem' }}>{m.title}</div>
              </div>
              <Badge tone={m.attendance === 'present' ? 'success' : 'neutral'}>{ATTENDANCE[m.attendance] ?? m.attendance}</Badge>
            </div>
            {m.agenda.length > 0 && <ol className="small" style={{ margin: 0 }}>{m.agenda.map((a, i) => <li key={i}>{a}</li>)}</ol>}
            <div className="row">
              {m.convocation && <button className="btn secondary sm" type="button" onClick={() => api.download(`/espace/meetings/${m.id}/convocation.pdf`, 'convocation.pdf')}>Convocation (PDF)</button>}
              {m.minutes ? <button className="btn secondary sm" type="button" onClick={() => api.download(`/espace/meetings/${m.id}/proces-verbal.pdf`, 'proces-verbal.pdf')}>Procès-verbal (PDF)</button> : <span className="small muted">Procès-verbal non encore disponible</span>}
            </div>
          </article>
        ))}
        {!q.data!.length && <div className="card empty">Aucune convocation.</div>}
      </div>
    </>
  );
}

/* ---------------------------------------------------------- Documents */

export function EspaceDocuments() {
  const me = useMe();
  const q = useQuery({ queryKey: ['espace', 'documents'], queryFn: () => api.get<EspaceDoc[]>('/espace/documents'), enabled: !!me.data?.member });
  if (me.isLoading || q.isLoading) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} />;
  if (!me.data!.member) return <NotLinked association={me.data!.association} />;
  if (q.error) return <ErrorBox error={q.error} />;
  const byFolder = new Map<string, EspaceDoc[]>();
  for (const d of q.data!) byFolder.set(d.folder, [...(byFolder.get(d.folder) ?? []), d]);
  return (
    <>
      <Breadcrumb items={crumbs('Documents')} />
      <PageHead title="Documents" description="Documents mis à disposition des membres par l’association." />
      <div className="stack">
        {[...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b, 'fr')).map(([folder, docs]) => (
          <section key={folder} className="card">
            <h2 style={{ fontSize: '1.05rem' }}>{folder}</h2>
            <ul className="attachments">
              {docs.map((d) => (
                <li key={d.id}>
                  <button type="button" className="link-btn" onClick={() => api.download(`/espace/documents/${d.id}`, d.name)}>{d.name}</button>
                  <span className="small muted">{formatBytes(d.size)} · {formatDate(d.updatedAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!q.data!.length && <div className="card empty">Aucun document pour le moment.</div>}
      </div>
    </>
  );
}

/* ---------------------------------------------------------- Invitation (publique) */

export function InvitationPage() {
  const { token = '' } = useParams();
  const { me, setAssociation } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['invitation', token], queryFn: () => api.get<{ association: string; firstName: string; lastName: string; email: string; accountExists: boolean; expiresAt: string }>(`/public/invitations/${token}`), retry: false });
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = `/invitation/${token}`;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw !== pw2) return setError('Les deux mots de passe ne correspondent pas.');
    setBusy(true);
    try {
      const r = await api.post<{ email: string }>(`/public/invitations/${token}/accept`, { password: pw });
      setCreated(r.email);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const claim = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ associationId: string }>(`/espace/invitations/${token}/claim`);
      setAssociation(r.associationId);
      await qc.invalidateQueries();
      navigate('/espace');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1>Votre espace personnel</h1>
      {q.isLoading && <Loading />}
      {q.error && <Alert tone="warning">{errorMessage(q.error)}</Alert>}
      {created && (
        <div className="stack">
          <Alert tone="success">Votre compte est créé. Connectez-vous avec l’adresse {created} et le mot de passe choisi.</Alert>
          <Link className="btn" to={`/connexion?email=${encodeURIComponent(created)}&next=/espace`}>Se connecter</Link>
        </div>
      )}
      {q.data && !created && (
        <div className="stack">
          <p>
            <strong>{q.data.association}</strong> invite <strong>{q.data.firstName} {q.data.lastName}</strong> à accéder à son espace : fiche, cotisations et reçus,
            carte d’adhérent, agenda, convocations et documents.
          </p>
          <p className="small muted" style={{ margin: 0 }}>Invitation pour {q.data.email}, valable jusqu’au {formatDate(q.data.expiresAt)}.</p>
          {error && <div className="alert danger" role="alert">{error}</div>}
          {me ? (
            <>
              <p className="small">Connecté(e) en tant que {me.user.email}.</p>
              <button className="btn" type="button" disabled={busy} onClick={claim}>Accepter et ouvrir mon espace</button>
            </>
          ) : q.data.accountExists ? (
            <>
              <p>Un compte existe déjà pour cette adresse : connectez-vous pour accepter l’invitation.</p>
              <Link className="btn" to={`/connexion?email=${encodeURIComponent(q.data.email)}&next=${encodeURIComponent(here)}`}>Se connecter</Link>
            </>
          ) : (
            <form className="stack" onSubmit={create}>
              <Field label="Adresse e-mail (identifiant)">{(id) => <input id={id} type="email" value={q.data!.email} disabled />}</Field>
              <Field label="Choisissez un mot de passe" hint="12 caractères minimum">{(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" required minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
              <Field label="Confirmez le mot de passe">{(id) => <input id={id} type="password" autoComplete="new-password" required minLength={12} value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
              <button className="btn" type="submit" disabled={busy}>Créer mon accès</button>
            </form>
          )}
        </div>
      )}
    </AuthLayout>
  );
}

/* ---------------------------------------------------------- Gestion depuis la fiche adhérent */

interface Access { account: { id: string; email: string; displayName: string; lastLoginAt: string | null } | null; invitation: { email: string; createdAt: string; expiresAt: string; emailStatus: string | null } | null; espaceActive: boolean }

export function MemberEspaceCard({ memberId, memberEmail, archived }: { memberId: string; memberEmail: string | null; archived: boolean }) {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const key = ['member-espace', memberId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Access>(`/asso/members/${memberId}/espace`) });
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<{ userId: string; displayName: string; email: string }[]>('/admin/users'), enabled: can('admin.users.read') });
  const [open, setOpen] = useState<'invite' | 'link' | null>(null);
  const [email, setEmail] = useState(memberEmail ?? '');
  const [send, setSend] = useState(true);
  const [userId, setUserId] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (q.isLoading) return null;
  if (q.error) return null;
  const d = q.data!;
  const canEdit = can('asso.members.update') && !archived;
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ url: string; emailStatus: string }>(`/asso/members/${memberId}/espace/invite`, { email: email || undefined, send });
      setUrl(r.url);
      toast(r.emailStatus === 'sent' ? 'Invitation envoyée par e-mail.' : r.emailStatus === 'not_sent' ? 'Invitation créée : transmettez le lien.' : 'L’e-mail n’a pas pu partir : transmettez le lien.', r.emailStatus.startsWith('failed') ? 'error' : 'success');
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const link = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/asso/members/${memberId}/espace/link`, { userId });
      toast('Fiche reliée au compte.');
      setOpen(null);
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const unlink = async () => {
    if (!confirm('Retirer l’accès à l’Espace ? Le compte n’est pas supprimé, mais il ne verra plus cette fiche.')) return;
    try {
      await api.delete(`/asso/members/${memberId}/espace`);
      toast('Accès retiré.');
      refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const close = () => { setOpen(null); setUrl(null); setError(null); };

  return (
    <section className="card stack" style={{ marginTop: 16 }}>
      <h2>Espace personnel</h2>
      {!d.espaceActive && <p className="small muted" style={{ margin: 0 }}>Scenorya Espace n’est pas activé : l’adhérent ne pourra pas encore consulter son espace.</p>}
      {d.account ? (
        <p style={{ margin: 0 }}>Relié au compte <strong>{d.account.displayName}</strong> ({d.account.email}){d.account.lastLoginAt ? ` — dernière connexion le ${formatDate(d.account.lastLoginAt, true)}` : ' — jamais connecté'}.</p>
      ) : d.invitation ? (
        <p style={{ margin: 0 }}>
          Invitation envoyée à {d.invitation.email} le {formatDate(d.invitation.createdAt)}, valable jusqu’au {formatDate(d.invitation.expiresAt)}
          {d.invitation.emailStatus === 'sent' ? ' (e-mail envoyé).' : d.invitation.emailStatus?.startsWith('failed') ? ' (échec de l’e-mail : lien à transmettre).' : ' (lien transmis manuellement).'}
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>Aucun accès. Invitez l’adhérent à créer son compte, ou reliez la fiche à un compte existant.</p>
      )}
      {canEdit && (
        <div className="row">
          {!d.account && <button className="btn secondary sm" type="button" onClick={() => setOpen('invite')}>{d.invitation ? 'Renvoyer une invitation' : 'Inviter à l’Espace'}</button>}
          {!d.account && can('admin.users.read') && <button className="btn ghost sm" type="button" onClick={() => setOpen('link')}>Relier à un compte existant</button>}
          {(d.account || d.invitation) && <button className="btn ghost sm" type="button" onClick={unlink}>Retirer l’accès</button>}
        </div>
      )}
      {open === 'invite' && (
        <Modal open title="Inviter à l’Espace" onClose={close} footer={url ? <button className="btn" type="button" onClick={close}>Fermer</button> : <><button className="btn secondary" type="button" onClick={close}>Annuler</button><button className="btn" type="submit" form="invite-form">Créer l’invitation</button></>}>
          {url ? (
            <div className="stack">
              <Alert tone="success">Invitation créée (valable 14 jours). Ce lien ne sera plus affiché :</Alert>
              <code className="mono" style={{ wordBreak: 'break-all' }}>{url}</code>
              <div><button className="btn sm" type="button" onClick={() => navigator.clipboard?.writeText(url).then(() => toast('Lien copié.'))}>Copier le lien</button></div>
            </div>
          ) : (
            <form id="invite-form" className="stack" onSubmit={invite}>
              {error && <div className="alert danger" role="alert">{error}</div>}
              <Field label="Adresse e-mail" hint="Deviendra l’identifiant de connexion de l’adhérent">{(id, db) => <input id={id} aria-describedby={db} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
              <label className="check"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> Envoyer l’invitation par e-mail (sinon, vous transmettez le lien vous-même)</label>
              <p className="small muted" style={{ margin: 0 }}>Une nouvelle invitation annule la précédente.</p>
            </form>
          )}
        </Modal>
      )}
      {open === 'link' && (
        <Modal open title="Relier à un compte existant" onClose={close} footer={<><button className="btn secondary" type="button" onClick={close}>Annuler</button><button className="btn" type="submit" form="link-form" disabled={!userId}>Relier</button></>}>
          <form id="link-form" className="stack" onSubmit={link}>
            {error && <div className="alert danger" role="alert">{error}</div>}
            <Field label="Compte de l’association">{(id) => (
              <select id={id} value={userId} onChange={(e) => setUserId(e.target.value)} required>
                <option value="">Choisir…</option>
                {usersQ.data?.map((u) => <option key={u.userId} value={u.userId}>{u.displayName} — {u.email}</option>)}
              </select>
            )}</Field>
            <p className="small muted" style={{ margin: 0 }}>Le rôle « Adhérent » est ajouté si le compte n’a pas déjà accès à l’Espace.</p>
          </form>
        </Modal>
      )}
    </section>
  );
}
