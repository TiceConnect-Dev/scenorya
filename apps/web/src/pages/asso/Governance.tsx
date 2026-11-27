import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';
import { Group, MemberPicker } from './Groups';

const TYPES: Record<string, string> = { ag_ordinaire: 'Assemblée générale ordinaire', ag_extraordinaire: 'Assemblée générale extraordinaire', ca: 'Conseil d’administration', bureau: 'Réunion du bureau', autre: 'Autre réunion' };
const STATUS: Record<string, [string, 'neutral' | 'info' | 'warning' | 'success']> = { draft: ['Brouillon', 'neutral'], convened: ['Convoquée', 'info'], held: ['Tenue', 'warning'], closed: ['✓ Clôturée', 'success'] };
const PRESENCE: Record<string, string> = { convened: 'Convoqué', present: 'Présent', represented: 'Représenté', excused: 'Excusé', absent: 'Absent' };
const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Asso', to: '/asso' }, ...extra, { label }];

interface Item { title: string; description?: string | null; vote: boolean }
interface Meeting { id: string; type: string; title: string; startAt: string; location: string | null; agendaItems: Item[]; quorumPercent: number | null; maxProxies: number | null; status: string; convenedAt: string | null; minutes: string | null; eventId: string | null; closedAt: string | null; attendees: number; resolutions: number }
interface Attendee { memberId: string; number: number; firstName: string; lastName: string; email: string | null; status: string; proxyMemberId: string | null; proxyName: string | null; emailStatus: string | null }
interface Resolution { id: string; number: number; title: string; text: string | null; votesFor: number; votesAgainst: number; abstentions: number; result: 'pending' | 'adopted' | 'rejected' }
type MeetingDetail = Omit<Meeting, 'attendees' | 'resolutions'> & { attendees: Attendee[]; resolutions: Resolution[]; quorum: { total: number; present: number; represented: number; percent: number; required: number | null; reached: boolean | null } };

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function MeetingForm({ open, initial, onClose, onSubmit }: { open: boolean; initial: Partial<Meeting> | null; onClose: () => void; onSubmit: (body: object) => Promise<void> }) {
  const [f, setF] = useState({ type: 'ag_ordinaire', title: '', startAt: '', location: '', quorumPercent: '', maxProxies: '', items: [] as Item[] });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF({
      type: initial?.type ?? 'ag_ordinaire', title: initial?.title ?? '', startAt: initial?.startAt ? localInput(initial.startAt) : '', location: initial?.location ?? '',
      quorumPercent: initial?.quorumPercent?.toString() ?? '', maxProxies: initial?.maxProxies?.toString() ?? '',
      items: initial?.agendaItems ?? [{ title: 'Rapport moral', vote: true }, { title: 'Rapport financier', vote: true }, { title: 'Questions diverses', vote: false }],
    });
  }, [open, initial]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await onSubmit({
        type: f.type, title: f.title, startAt: new Date(f.startAt).toISOString(), location: f.location || null,
        quorumPercent: f.quorumPercent ? Number(f.quorumPercent) : null, maxProxies: f.maxProxies === '' ? null : Number(f.maxProxies),
        agendaItems: f.items.filter((i) => i.title.trim()),
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal open={open} title={initial?.id ? 'Modifier la réunion' : 'Nouvelle réunion'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <div className="form-grid">
          <Field label="Instance">{(id) => <select id={id} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
          <Field label="Intitulé">{(id) => <input id={id} type="text" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="AG annuelle 2027" />}</Field>
          <Field label="Date et heure">{(id) => <input id={id} type="datetime-local" required value={f.startAt} onChange={(e) => setF({ ...f, startAt: e.target.value })} />}</Field>
          <Field label="Lieu">{(id) => <input id={id} type="text" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />}</Field>
          <Field label="Quorum (% des convoqués)" hint="Selon vos statuts ; vide si aucun.">{(id, d) => <input id={id} aria-describedby={d} type="number" min={1} max={100} value={f.quorumPercent} onChange={(e) => setF({ ...f, quorumPercent: e.target.value })} />}</Field>
          <Field label="Procurations par mandataire" hint="Vide = sans limite.">{(id, d) => <input id={id} aria-describedby={d} type="number" min={0} max={50} value={f.maxProxies} onChange={(e) => setF({ ...f, maxProxies: e.target.value })} />}</Field>
        </div>
        <fieldset>
          <legend>Ordre du jour</legend>
          {f.items.map((it, i) => (
            <div key={i} className="row" style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
              <span className="small muted">{i + 1}.</span>
              <label className="sr-only" htmlFor={`item-${i}`}>Point {i + 1}</label>
              <input id={`item-${i}`} type="text" value={it.title} onChange={(e) => setF({ ...f, items: f.items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
              <label className="check nowrap small"><input type="checkbox" checked={it.vote} onChange={(e) => setF({ ...f, items: f.items.map((x, j) => (j === i ? { ...x, vote: e.target.checked } : x)) })} />vote</label>
              <button type="button" className="btn ghost sm" aria-label={`Retirer le point ${i + 1}`} onClick={() => setF({ ...f, items: f.items.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
          <button type="button" className="btn secondary sm" onClick={() => setF({ ...f, items: [...f.items, { title: '', vote: false }] })}>Ajouter un point</button>
        </fieldset>
        <div className="form-actions"><button className="btn secondary" type="button" onClick={onClose}>Annuler</button><button className="btn" type="submit">Enregistrer</button></div>
      </form>
    </Modal>
  );
}

export function MeetingsPage() {
  const { can } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['meetings'], queryFn: () => api.get<Meeting[]>('/asso/meetings') });
  const [open, setOpen] = useState(false);
  return (
    <>
      <Breadcrumb items={crumbs('Instances et assemblées')} />
      <PageHead title="Instances et assemblées" description="Assemblées générales, conseils d’administration et réunions du bureau : convocations, présences, délibérations et procès-verbaux." actions={can('asso.meetings.create') && <button className="btn" type="button" onClick={() => setOpen(true)}>Nouvelle réunion</button>} />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.length === 0 ? <div className="card empty">Aucune réunion.</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Date</th><th scope="col">Réunion</th><th scope="col">Convoqués</th><th scope="col">Résolutions</th><th scope="col">État</th></tr></thead>
            <tbody>
              {q.data.map((m) => (
                <tr key={m.id}>
                  <td className="nowrap">{formatDate(m.startAt, true)}</td>
                  <td><Link to={`/asso/instances/${m.id}`}><strong>{m.title}</strong></Link><div className="small muted">{TYPES[m.type]}</div></td>
                  <td>{m.attendees}</td>
                  <td>{m.resolutions}</td>
                  <td><Badge tone={STATUS[m.status][1]}>{STATUS[m.status][0]}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <MeetingForm open={open} initial={null} onClose={() => setOpen(false)} onSubmit={async (body) => { const r = await api.post<{ id: string }>('/asso/meetings', body); qc.invalidateQueries({ queryKey: ['meetings'] }); setOpen(false); navigate(`/asso/instances/${r.id}`); }} />
    </>
  );
}

export function MeetingDetailPage() {
  const { id } = useParams();
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['meeting', id], queryFn: () => api.get<MeetingDetail>(`/asso/meetings/${id}`) });
  const groups = useQuery({ queryKey: ['groups', false], queryFn: () => api.get<Group[]>('/asso/groups?archived=false'), enabled: can('asso.groups.read') });
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [convening, setConvening] = useState(false);
  const [message, setMessage] = useState('');
  const [minutes, setMinutes] = useState('');
  const [res, setRes] = useState({ title: '', text: '' });
  const m = q.data;
  useEffect(() => { if (m) setMinutes(m.minutes ?? ''); }, [m?.id, m?.minutes]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { q.refetch(); qc.invalidateQueries({ queryKey: ['meetings'] }); };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); refresh(); return true; } catch (e) { toast(errorMessage(e), 'error'); return false; }
  };
  if (q.isLoading) return <Loading />;
  if (q.error || !m) return <ErrorBox error={q.error} />;
  const editable = can('asso.meetings.update') && !m.closedAt;
  const present = m.attendees.filter((a) => a.status === 'present');
  const dl = (doc: string) => api.download(`/asso/meetings/${m.id}/${doc}.pdf`, `${doc}.pdf`).catch((e) => toast(errorMessage(e), 'error'));

  return (
    <>
      <Breadcrumb items={crumbs(m.title, [{ label: 'Instances et assemblées', to: '/asso/instances' }])} />
      <PageHead
        title={m.title}
        description={`${TYPES[m.type]} — ${formatDate(m.startAt, true)}${m.location ? ` — ${m.location}` : ''}`}
        actions={
          <>
            <Badge tone={STATUS[m.status][1]}>{STATUS[m.status][0]}</Badge>
            {can('asso.meetings.download') && (
              <>
                <button className="btn secondary sm" type="button" onClick={() => dl('convocation')}>Convocation</button>
                <button className="btn secondary sm" type="button" onClick={() => dl('emargement')}>Émargement</button>
                <button className="btn secondary sm" type="button" onClick={() => dl('proces-verbal')}>Procès-verbal</button>
              </>
            )}
            {editable && <button className="btn secondary sm" type="button" onClick={() => setEdit(true)}>Modifier</button>}
            {editable && <button className="btn sm" type="button" onClick={() => setConvening(true)}>{m.convenedAt ? 'Reconvoquer' : 'Convoquer'}</button>}
            {can('asso.meetings.validate') && !m.closedAt && m.status !== 'draft' && (
              <button className="btn sm" type="button" onClick={() => window.confirm('Clôturer ? Le procès-verbal sera définitivement figé.') && act(() => api.post(`/asso/meetings/${m.id}/close`), 'Réunion clôturée : procès-verbal figé.')}>Clôturer</button>
            )}
          </>
        }
      />
      {m.closedAt && <div style={{ marginBottom: 12 }}><Alert tone="success">Clôturée le {formatDate(m.closedAt, true)} : le procès-verbal est figé et ne peut plus être modifié.</Alert></div>}
      <div className="grid-2">
        <section className="card">
          <h2>Ordre du jour</h2>
          <ol>{m.agendaItems.map((i, k) => <li key={k}>{i.title}{i.vote && <Badge tone="info">vote</Badge>}</li>)}</ol>
          {m.eventId && <p className="small"><Link to="/agenda">Inscrite à l’agenda</Link></p>}
        </section>
        <section className="card">
          <h2>Quorum</h2>
          <p className="kpi"><span className="value">{m.quorum.percent.toLocaleString('fr-FR')} %</span></p>
          <p className="small">{m.quorum.present} présent(s), {m.quorum.represented} représenté(s) sur {m.quorum.total} convoqué(s).</p>
          {m.quorum.required !== null && (
            <Badge tone={m.quorum.reached ? 'success' : 'warning'}>{m.quorum.reached ? `✓ Quorum de ${m.quorum.required} % atteint` : `! Quorum de ${m.quorum.required} % non atteint`}</Badge>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="row between"><h2 style={{ margin: 0 }}>Convoqués et présences</h2>{editable && <button className="btn secondary sm" type="button" onClick={() => { setPicked([]); setGroupIds([]); setAdding(true); }}>Ajouter des convoqués</button>}</div>
        {m.attendees.length === 0 ? <p className="muted" style={{ marginTop: 10 }}>Aucun convoqué.</p> : (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead><tr><th scope="col">Membre</th><th scope="col">Présence</th><th scope="col">Mandataire</th><th scope="col">E-mail</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
              <tbody>
                {m.attendees.map((a) => (
                  <tr key={a.memberId}>
                    <td><strong>{a.lastName.toUpperCase()}</strong> {a.firstName}</td>
                    <td>
                      {editable ? (
                        <select aria-label={`Présence de ${a.firstName}`} style={{ width: 'auto', minHeight: 32 }} value={a.status} onChange={(e) => {
                          if (e.target.value === 'represented') {
                            const holder = present.find((p) => p.memberId !== a.memberId);
                            if (!holder) return toast('Marquez d’abord le mandataire comme présent.', 'error');
                            act(() => api.patch(`/asso/meetings/${m.id}/attendees/${a.memberId}`, { status: 'represented', proxyMemberId: holder.memberId }), 'Procuration enregistrée.');
                          } else act(() => api.patch(`/asso/meetings/${m.id}/attendees/${a.memberId}`, { status: e.target.value }), 'Présence enregistrée.');
                        }}>{Object.entries(PRESENCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                      ) : PRESENCE[a.status]}
                    </td>
                    <td>
                      {a.status === 'represented' && editable ? (
                        <select aria-label={`Mandataire de ${a.firstName}`} style={{ width: 'auto', minHeight: 32 }} value={a.proxyMemberId ?? ''} onChange={(e) => act(() => api.patch(`/asso/meetings/${m.id}/attendees/${a.memberId}`, { status: 'represented', proxyMemberId: e.target.value }), 'Mandataire modifié.')}>
                          {present.filter((p) => p.memberId !== a.memberId).map((p) => <option key={p.memberId} value={p.memberId}>{p.firstName} {p.lastName}</option>)}
                        </select>
                      ) : a.proxyName ?? '—'}
                    </td>
                    <td className="small">{a.emailStatus === 'sent' ? '✓ envoyé' : a.emailStatus === 'no_email' ? 'sans adresse' : a.emailStatus?.startsWith('failed') ? <span style={{ color: 'var(--danger)' }}>échec</span> : '—'}</td>
                    <td className="actions">{editable && <button className="btn ghost sm" type="button" aria-label={`Retirer ${a.firstName}`} onClick={() => act(() => api.delete(`/asso/meetings/${m.id}/attendees/${a.memberId}`), 'Convoqué retiré.')}>✕</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Délibérations</h2>
        {m.resolutions.length === 0 && <p className="muted">Aucune résolution.</p>}
        {m.resolutions.map((r) => (
          <div key={r.id} style={{ borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
            <strong>Résolution n° {r.number} — {r.title}</strong>
            {r.text && <p className="small">{r.text}</p>}
            {editable ? (
              <form className="row" style={{ marginTop: 6 }} onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                act(() => api.patch(`/asso/meetings/${m.id}/resolutions/${r.id}`, { votesFor: Number(fd.get('for')), votesAgainst: Number(fd.get('against')), abstentions: Number(fd.get('abst')), result: fd.get('result') }), 'Vote enregistré.');
              }}>
                {[['for', 'Pour', r.votesFor], ['against', 'Contre', r.votesAgainst], ['abst', 'Abstentions', r.abstentions]].map(([n, l, v]) => (
                  <label key={n as string} className="small">{l as string}<input name={n as string} type="number" min={0} defaultValue={v as number} style={{ width: 80, marginLeft: 6 }} /></label>
                ))}
                <label className="small">Résultat
                  <select name="result" defaultValue={r.result} style={{ width: 'auto', marginLeft: 6 }}><option value="pending">À voter</option><option value="adopted">Adoptée</option><option value="rejected">Rejetée</option></select>
                </label>
                <button className="btn secondary sm" type="submit">Enregistrer</button>
                <button className="btn ghost sm" type="button" onClick={() => act(() => api.delete(`/asso/meetings/${m.id}/resolutions/${r.id}`), 'Résolution supprimée.')}>Supprimer</button>
              </form>
            ) : (
              <p className="small">Pour {r.votesFor} — Contre {r.votesAgainst} — Abstentions {r.abstentions} : <Badge tone={r.result === 'adopted' ? 'success' : r.result === 'rejected' ? 'warning' : 'neutral'}>{{ adopted: 'Adoptée', rejected: 'Rejetée', pending: 'À voter' }[r.result]}</Badge></p>
            )}
          </div>
        ))}
        {editable && (
          <form className="stack" style={{ marginTop: 12, gap: 8 }} onSubmit={async (e) => { e.preventDefault(); if (await act(() => api.post(`/asso/meetings/${m.id}/resolutions`, { title: res.title, text: res.text || null }), 'Résolution ajoutée.')) setRes({ title: '', text: '' }); }}>
            <Field label="Nouvelle résolution">{(fid) => <input id={fid} type="text" required value={res.title} onChange={(e) => setRes({ ...res, title: e.target.value })} placeholder="Approbation des comptes de l’exercice" />}</Field>
            <Field label="Texte (facultatif)">{(fid) => <textarea id={fid} value={res.text} onChange={(e) => setRes({ ...res, text: e.target.value })} style={{ minHeight: 60 }} />}</Field>
            <div><button className="btn secondary sm" type="submit">Ajouter la résolution</button></div>
          </form>
        )}
        <p className="small muted" style={{ marginTop: 8 }}>Les voix sont saisies après décompte en séance. Le vote électronique n’est pas proposé : vérifiez ce que vos statuts autorisent.</p>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Compte rendu des débats</h2>
        {editable ? (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); act(() => api.patch(`/asso/meetings/${m.id}`, { minutes }), 'Compte rendu enregistré.'); }}>
            <label className="sr-only" htmlFor="minutes">Compte rendu</label>
            <textarea id="minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ minHeight: 200 }} />
            <div><button className="btn secondary" type="submit">Enregistrer le compte rendu</button></div>
          </form>
        ) : <p style={{ whiteSpace: 'pre-wrap' }}>{m.minutes ?? '—'}</p>}
      </section>

      <MeetingForm open={edit} initial={m as unknown as Meeting} onClose={() => setEdit(false)} onSubmit={async (body) => { await api.patch(`/asso/meetings/${m.id}`, body); toast('Réunion modifiée.'); setEdit(false); refresh(); }} />
      <Modal open={adding} title="Ajouter des convoqués" onClose={() => setAdding(false)}>
        <div className="stack">
          <button className="btn secondary" type="button" onClick={async () => { if (await act(() => api.put(`/asso/meetings/${m.id}/attendees`, { allActive: true }), 'Adhérents actifs convoqués.')) setAdding(false); }}>Convoquer tous les adhérents actifs</button>
          {groups.data && groups.data.length > 0 && (
            <fieldset><legend>Groupes</legend><div className="chips">{groups.data.map((g) => <button key={g.id} type="button" className="chip" aria-pressed={groupIds.includes(g.id)} onClick={() => setGroupIds(groupIds.includes(g.id) ? groupIds.filter((x) => x !== g.id) : [...groupIds, g.id])}>{g.name}</button>)}</div></fieldset>
          )}
          <MemberPicker value={picked} onChange={setPicked} />
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={() => setAdding(false)}>Annuler</button>
            <button className="btn" type="button" disabled={!picked.length && !groupIds.length} onClick={async () => { if (await act(() => api.put(`/asso/meetings/${m.id}/attendees`, { memberIds: picked.map((p) => p.id), groupIds }), 'Convoqués ajoutés.')) setAdding(false); }}>Ajouter</button>
          </div>
        </div>
      </Modal>
      <Modal open={convening} title="Convoquer" onClose={() => setConvening(false)}>
        <div className="stack">
          <p>{m.attendees.length} membre(s) convoqué(s), dont {m.attendees.filter((a) => a.email).length} avec une adresse e-mail.</p>
          <Field label="Message (facultatif)">{(fid) => <textarea id={fid} value={message} onChange={(e) => setMessage(e.target.value)} style={{ minHeight: 80 }} />}</Field>
          <p className="small muted">L’envoi par e-mail joint la convocation PDF (avec un pouvoir à compléter). Sans messagerie configurée, téléchargez la convocation et diffusez-la vous-même.</p>
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={async () => { if (await act(() => api.post(`/asso/meetings/${m.id}/convene`, { send: false }), 'Réunion marquée comme convoquée.')) setConvening(false); }}>Marquer comme convoquée sans envoi</button>
            <button className="btn" type="button" onClick={async () => {
              try { const r = await api.post<{ sent: number; failed: number; noEmail: number }>(`/asso/meetings/${m.id}/convene`, { send: true, message: message || null }); toast(`${r.sent} convocation(s) envoyée(s)${r.failed ? `, ${r.failed} échec(s)` : ''}${r.noEmail ? `, ${r.noEmail} sans adresse` : ''}.`, r.failed ? 'error' : 'success'); setConvening(false); refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
            }}>Envoyer par e-mail</button>
          </div>
        </div>
      </Modal>
    </>
  );
}

interface Mandate { id: string; body: string; role: string; startDate: string; endDate: string | null; memberId: string; firstName: string; lastName: string; number: number }
const BODIES: Record<string, string> = { bureau: 'Bureau', ca: 'Conseil d’administration', autre: 'Autre' };

export function MandatesPage() {
  const { can, toast } = useApp();
  const [current, setCurrent] = useState(true);
  const q = useQuery({ queryKey: ['mandates', current], queryFn: () => api.get<Mandate[]>(`/asso/mandates?current=${current}`) });
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([]);
  const [f, setF] = useState({ body: 'bureau', role: '', startDate: new Date().toISOString().slice(0, 10), endDate: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (picked.length !== 1) return setError('Choisissez un adhérent.');
    try {
      await api.post('/asso/mandates', { memberId: picked[0].id, ...f, endDate: f.endDate || null });
      toast('Mandat enregistré.');
      setOpen(false);
      q.refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Mandats')} />
      <PageHead title="Mandats des élus" description="Composition du bureau et du conseil d’administration. Le président et le secrétaire en exercice signent les documents générés." actions={can('asso.mandates.create') && <button className="btn" type="button" onClick={() => { setPicked([]); setError(null); setOpen(true); }}>Nouveau mandat</button>} />
      <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={!current} onChange={(e) => setCurrent(!e.target.checked)} /><span>Afficher aussi les mandats terminés</span></label>
      {q.isLoading && <Loading />}
      {q.data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Instance</th><th scope="col">Fonction</th><th scope="col">Élu(e)</th><th scope="col">Début</th><th scope="col">Fin</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {q.data.length === 0 && <tr><td colSpan={6} className="empty">Aucun mandat.</td></tr>}
              {q.data.map((x) => (
                <tr key={x.id}>
                  <td>{BODIES[x.body]}</td>
                  <td><strong>{x.role}</strong></td>
                  <td><Link to={`/asso/adherents/${x.memberId}`}>{x.firstName} {x.lastName}</Link></td>
                  <td>{formatDate(x.startDate)}</td>
                  <td>{x.endDate ? formatDate(x.endDate) : '—'}</td>
                  <td className="actions">{can('asso.mandates.update') && !x.endDate && <button className="btn ghost sm" type="button" onClick={async () => { const d = window.prompt('Date de fin du mandat (AAAA-MM-JJ) :', new Date().toISOString().slice(0, 10)); if (!d) return; try { await api.patch(`/asso/mandates/${x.id}`, { endDate: d }); toast('Mandat terminé.'); q.refetch(); } catch (e) { toast(errorMessage(e), 'error'); } }}>Terminer</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={open} title="Nouveau mandat" onClose={() => setOpen(false)}>
        <form className="stack" onSubmit={submit}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <MemberPicker value={picked} onChange={(v) => setPicked(v.slice(-1))} />
          <div className="form-grid">
            <Field label="Instance">{(id) => <select id={id} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })}>{Object.entries(BODIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
            <Field label="Fonction">{(id) => <input id={id} type="text" required list="roles" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />}</Field>
            <datalist id="roles"><option value="Président(e)" /><option value="Vice-président(e)" /><option value="Trésorier(ère)" /><option value="Secrétaire" /><option value="Administrateur(trice)" /></datalist>
            <Field label="Début">{(id) => <input id={id} type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />}</Field>
            <Field label="Fin (facultatif)">{(id) => <input id={id} type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />}</Field>
          </div>
          <div className="form-actions"><button className="btn secondary" type="button" onClick={() => setOpen(false)}>Annuler</button><button className="btn" type="submit">Enregistrer</button></div>
        </form>
      </Modal>
    </>
  );
}
