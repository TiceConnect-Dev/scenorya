import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, deleteWithConfirm } from '../../api/client';
import type { Member, Paged } from '../../api/types';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead } from '../../components/ui';

export interface Group { id: string; name: string; kind: 'group' | 'commission' | 'troupe' | 'bureau'; description: string | null; archivedAt: string | null; members: number; role: string | null }
export interface FieldDef { id: string; key: string; label: string; type: 'text' | 'number' | 'date' | 'boolean' | 'select'; options: string[]; required: boolean; sensitive: boolean; position: number; archivedAt: string | null }

export const GROUP_KINDS: Record<Group['kind'], string> = { group: 'Groupe', commission: 'Commission', troupe: 'Troupe', bureau: 'Bureau / CA' };
const FIELD_TYPES: Record<FieldDef['type'], string> = { text: 'Texte', number: 'Nombre', date: 'Date', boolean: 'Oui / non', select: 'Liste de choix' };
const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Asso', to: '/asso' }, ...extra, { label }];

/** Sélection d'adhérents par recherche (plusieurs possibles). */
export function MemberPicker({ value, onChange }: { value: { id: string; label: string }[]; onChange: (v: { id: string; label: string }[]) => void }) {
  const [q, setQ] = useState('');
  const found = useQuery({
    queryKey: ['members', 'pick', q],
    queryFn: () => api.get<Paged<Member>>(`/asso/members?pageSize=8&q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
  });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label="Rechercher un adhérent" hint="Deux lettres minimum ; nom, prénom ou numéro.">
        {(id, d) => <input id={id} aria-describedby={d} type="search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />}
      </Field>
      {found.data && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {found.data.items.filter((m) => !value.some((v) => v.id === m.id)).map((m) => (
            <li key={m.id}>
              <button type="button" className="btn ghost sm" onClick={() => onChange([...value, { id: m.id, label: `${m.firstName} ${m.lastName}` }])}>
                + {m.lastName.toUpperCase()} {m.firstName} (n° {m.number})
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length > 0 && (
        <div className="chips" aria-label="Adhérents sélectionnés">
          {value.map((v) => (
            <button key={v.id} type="button" className="chip" aria-pressed="true" onClick={() => onChange(value.filter((x) => x.id !== v.id))} title="Retirer">
              {v.label} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Groupes */

export function GroupsPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const q = useQuery({ queryKey: ['groups', archived], queryFn: () => api.get<Group[]>(`/asso/groups?archived=${archived}`) });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', kind: 'group' as Group['kind'], description: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const g = await api.post<Group>('/asso/groups', { ...form, description: form.description || null });
      toast('Groupe créé.');
      qc.invalidateQueries({ queryKey: ['groups'] });
      setOpen(false);
      navigate(`/asso/groupes/${g.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Groupes et commissions')} />
      <PageHead
        title="Groupes et commissions"
        description="Commissions, troupes, bureau : regroupez les adhérents et précisez leur fonction."
        actions={can('asso.groups.create') && <button className="btn" type="button" onClick={() => { setForm({ name: '', kind: 'group', description: '' }); setError(null); setOpen(true); }}>Nouveau groupe</button>}
      />
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        <span>Afficher les groupes archivés</span>
      </label>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        q.data.length === 0 ? <div className="card empty">Aucun groupe.</div> : (
          <div className="grid-3">
            {q.data.map((g) => (
              <Link key={g.id} to={`/asso/groupes/${g.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="row between"><Badge tone="info">{GROUP_KINDS[g.kind]}</Badge><span className="small muted">{g.members} membre(s)</span></div>
                <h2 style={{ marginTop: 10, color: 'var(--blue)' }}>{g.name}</h2>
                {g.description && <p className="small muted">{g.description}</p>}
              </Link>
            ))}
          </div>
        )
      )}
      <Modal open={open} title="Nouveau groupe" onClose={() => setOpen(false)}>
        <form className="stack" onSubmit={submit}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <Field label="Nom">{(id) => <input id={id} type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Type">{(id) => <select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Group['kind'] })}>{Object.entries(GROUP_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
          <Field label="Description">{(id) => <input id={id} type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
          <div className="form-actions"><button className="btn secondary" type="button" onClick={() => setOpen(false)}>Annuler</button><button className="btn" type="submit">Créer</button></div>
        </form>
      </Modal>
    </>
  );
}

interface GroupMember { id: string; number: number; firstName: string; lastName: string; email: string | null; status: string; role: string | null; since: string }

export function GroupDetail() {
  const navigateTo = useNavigate();
  const { id } = useParams();
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ['groups', 'all-for-detail'], queryFn: async () => [...(await api.get<Group[]>('/asso/groups')), ...(await api.get<Group[]>('/asso/groups?archived=true'))] });
  const g = groups.data?.find((x) => x.id === id);
  const list = useQuery({ queryKey: ['group-members', id], queryFn: () => api.get<GroupMember[]>(`/asso/groups/${id}/members`) });
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<{ id: string; label: string }[]>([]);
  const [role, setRole] = useState('');
  const [edit, setEdit] = useState<{ name: string; kind: Group['kind']; description: string } | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['groups'] });
    qc.invalidateQueries({ queryKey: ['group-members', id] });
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  if (groups.isLoading) return <Loading />;
  if (!g) return <ErrorBox error={new Error('Groupe introuvable.')} />;
  const editable = can('asso.groups.update') && !g.archivedAt;

  return (
    <>
      <Breadcrumb items={crumbs(g.name, [{ label: 'Groupes et commissions', to: '/asso/groupes' }])} />
      <PageHead
        title={g.name}
        description={`${GROUP_KINDS[g.kind]}${g.description ? ` — ${g.description}` : ''}`}
        actions={
          <>
            {can('asso.members.download') && list.data && list.data.length > 0 && (
              <button className="btn secondary" type="button" onClick={() => api.download(`/asso/cards.pdf?ids=${list.data!.filter((m) => m.status !== 'archived').map((m) => m.id).join(',')}`, 'cartes.pdf').catch((e) => toast(errorMessage(e), 'error'))}>Imprimer les cartes</button>
            )}
            {editable && <button className="btn secondary" type="button" onClick={() => setEdit({ name: g.name, kind: g.kind, description: g.description ?? '' })}>Modifier</button>}
            {can('asso.groups.archive') && (
              <button className="btn secondary" type="button" onClick={() => act(() => api.post(`/asso/groups/${g.id}/archive`, { restore: Boolean(g.archivedAt) }), g.archivedAt ? 'Groupe restauré.' : 'Groupe archivé.')}>
                {g.archivedAt ? 'Restaurer' : 'Archiver'}
              </button>
            )}
            {can('asso.groups.delete') && (
              <button className="btn danger" type="button" onClick={() => deleteWithConfirm(`/asso/groups/${g.id}`, `Supprimer le groupe « ${g.name} » ? Les adhérents ne sont pas supprimés, seule leur appartenance au groupe disparaît.`)
                .then((r) => { if (r) { toast('Groupe supprimé.'); qc.invalidateQueries({ queryKey: ['groups'] }); navigateTo('/asso/groupes'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>
            )}
            {editable && <button className="btn" type="button" onClick={() => { setPicked([]); setRole(''); setAdding(true); }}>Ajouter des membres</button>}
          </>
        }
      />
      {g.archivedAt && <div style={{ marginBottom: 12 }}><Alert tone="warning">Groupe archivé le {formatDate(g.archivedAt)} : composition figée.</Alert></div>}
      {list.isLoading && <Loading />}
      {list.data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Adhérent</th><th scope="col">Fonction</th><th scope="col">E-mail</th><th scope="col">Depuis</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={5} className="empty">Aucun membre.</td></tr>}
              {list.data.map((m) => (
                <tr key={m.id}>
                  <td><Link to={`/asso/adherents/${m.id}`}><strong>{m.lastName.toUpperCase()}</strong> {m.firstName}</Link>{m.status === 'archived' && <> <Badge>archivé</Badge></>}</td>
                  <td>{m.role ?? '—'}</td>
                  <td className="small">{m.email ?? '—'}</td>
                  <td>{formatDate(m.since)}</td>
                  <td className="actions">
                    {editable && (
                      <>
                        <button className="btn ghost sm" type="button" onClick={() => {
                          const r = window.prompt('Fonction dans le groupe (laisser vide pour aucune) :', m.role ?? '');
                          if (r !== null) act(() => api.put(`/asso/groups/${g.id}/members`, { memberIds: [m.id], role: r.trim() || null }), 'Fonction mise à jour.');
                        }}>Fonction</button>
                        <button className="btn ghost sm" type="button" onClick={() => act(() => api.delete(`/asso/groups/${g.id}/members/${m.id}`), 'Membre retiré du groupe.')}>Retirer</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={adding} title={`Ajouter à « ${g.name} »`} onClose={() => setAdding(false)}>
        <div className="stack">
          <MemberPicker value={picked} onChange={setPicked} />
          <Field label="Fonction (facultatif)" hint="Ex. : président de commission, référent.">{(fid, d) => <input id={fid} aria-describedby={d} type="text" value={role} onChange={(e) => setRole(e.target.value)} />}</Field>
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={() => setAdding(false)}>Annuler</button>
            <button className="btn" type="button" disabled={picked.length === 0} onClick={async () => { await act(() => api.put(`/asso/groups/${g.id}/members`, { memberIds: picked.map((p) => p.id), role: role.trim() || null }), `${picked.length} membre(s) ajouté(s).`); setAdding(false); }}>
              Ajouter {picked.length || ''}
            </button>
          </div>
        </div>
      </Modal>
      <Modal open={Boolean(edit)} title="Modifier le groupe" onClose={() => setEdit(null)}>
        {edit && (
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); await act(() => api.patch(`/asso/groups/${g.id}`, { ...edit, description: edit.description || null }), 'Groupe modifié.'); setEdit(null); }}>
            <Field label="Nom">{(fid) => <input id={fid} type="text" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <Field label="Type">{(fid) => <select id={fid} value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as Group['kind'] })}>{Object.entries(GROUP_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
            <Field label="Description">{(fid) => <input id={fid} type="text" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />}</Field>
            <div className="form-actions"><button className="btn secondary" type="button" onClick={() => setEdit(null)}>Annuler</button><button className="btn" type="submit">Enregistrer</button></div>
          </form>
        )}
      </Modal>
    </>
  );
}

/* --------------------------------------------- Champs personnalisés */

export function FieldsPage() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fields'], queryFn: () => api.get<FieldDef[]>('/asso/fields') });
  const [editing, setEditing] = useState<FieldDef | 'new' | null>(null);
  const [form, setForm] = useState({ label: '', type: 'text' as FieldDef['type'], options: '', required: false, sensitive: false, position: 0 });
  const [error, setError] = useState<string | null>(null);
  const openForm = (f: FieldDef | 'new') => {
    setError(null);
    setForm(f === 'new' ? { label: '', type: 'text', options: '', required: false, sensitive: false, position: (q.data?.length ?? 0) * 10 } : { label: f.label, type: f.type, options: f.options.join('\n'), required: f.required, sensitive: f.sensitive, position: f.position });
    setEditing(f);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const options = form.options.split('\n').map((o) => o.trim()).filter(Boolean);
    try {
      if (editing === 'new') await api.post('/asso/fields', { ...form, options });
      else if (editing) await api.patch(`/asso/fields/${editing.id}`, { label: form.label, options, required: form.required, sensitive: form.sensitive, position: form.position });
      toast('Champ enregistré.');
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['fields'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const archive = async (f: FieldDef, archived: boolean) => {
    try {
      await api.patch(`/asso/fields/${f.id}`, { archived });
      toast(archived ? 'Champ archivé (les valeurs sont conservées).' : 'Champ restauré.');
      qc.invalidateQueries({ queryKey: ['fields'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <Breadcrumb items={crumbs('Champs personnalisés')} />
      <PageHead title="Champs personnalisés" description="Ajoutez à la fiche adhérent les informations propres à votre association." actions={<button className="btn" type="button" onClick={() => openForm('new')}>Nouveau champ</button>} />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Libellé</th><th scope="col">Type</th><th scope="col">Options</th><th scope="col">Propriétés</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {q.data.length === 0 && <tr><td colSpan={5} className="empty">Aucun champ. Exemples : taille de costume, permis B, régime alimentaire.</td></tr>}
              {q.data.map((f) => (
                <tr key={f.id} style={f.archivedAt ? { opacity: 0.6 } : undefined}>
                  <td><strong>{f.label}</strong><div className="small muted mono">{f.key}</div></td>
                  <td>{FIELD_TYPES[f.type]}</td>
                  <td className="small">{f.options.join(', ') || '—'}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {f.required && <Badge tone="info">Obligatoire</Badge>}
                      {f.sensitive && <Badge tone="warning">Sensible</Badge>}
                      {f.archivedAt && <Badge>Archivé</Badge>}
                    </div>
                  </td>
                  <td className="actions">
                    {!f.archivedAt && <button className="btn ghost sm" type="button" onClick={() => openForm(f)}>Modifier</button>}
                    <button className="btn ghost sm" type="button" onClick={() => archive(f, !f.archivedAt)}>{f.archivedAt ? 'Restaurer' : 'Archiver'}</button>
                    <button className="btn ghost sm" type="button" onClick={() => deleteWithConfirm<{ cleared: number }>(`/asso/fields/${f.id}`, `Supprimer le champ « ${f.label} » ? Sa valeur sera effacée de toutes les fiches (l’archivage, lui, la conserve).`)
                      .then((r) => { if (r) { toast(`Champ supprimé (${r.cleared} fiche(s) concernée(s)).`); qc.invalidateQueries({ queryKey: ['fields'] }); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={Boolean(editing)} title={editing === 'new' ? 'Nouveau champ' : 'Modifier le champ'} onClose={() => setEditing(null)}>
        <form className="stack" onSubmit={submit}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <div className="form-grid">
            <Field label="Libellé">{(id) => <input id={id} type="text" required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />}</Field>
            <Field label="Type" hint={editing !== 'new' ? 'Le type ne peut plus être changé.' : undefined}>
              {(id, d) => <select id={id} aria-describedby={d} disabled={editing !== 'new'} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as FieldDef['type'] })}>{Object.entries(FIELD_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
            </Field>
            {form.type === 'select' && <Field label="Valeurs proposées (une par ligne)" className="full">{(id) => <textarea id={id} value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} />}</Field>}
            <Field label="Ordre d’affichage">{(id) => <input id={id} type="number" min={0} value={form.position} onChange={(e) => setForm({ ...form, position: Number(e.target.value) })} />}</Field>
            <div className="stack full" style={{ gap: 8 }}>
              <label className="check"><input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /><span>Obligatoire sur les nouvelles fiches</span></label>
              <label className="check"><input type="checkbox" checked={form.sensitive} onChange={(e) => setForm({ ...form, sensitive: e.target.checked })} /><span>Donnée sensible (santé, situation personnelle…) : visible seulement avec le droit dédié</span></label>
            </div>
          </div>
          <div className="form-actions"><button className="btn secondary" type="button" onClick={() => setEditing(null)}>Annuler</button><button className="btn" type="submit">Enregistrer</button></div>
        </form>
      </Modal>
    </>
  );
}

/** Saisie des champs personnalisés dans le formulaire d'adhérent. */
export function CustomFieldsInputs({ defs, values, onChange, sensitive }: { defs: FieldDef[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; sensitive: boolean }) {
  const active = defs.filter((d) => !d.archivedAt && (sensitive || !d.sensitive));
  if (active.length === 0) return null;
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  return (
    <fieldset>
      <legend>Informations complémentaires</legend>
      <div className="form-grid">
        {active.map((d) => {
          const label = `${d.label}${d.required ? ' *' : ''}${d.sensitive ? ' (sensible)' : ''}`;
          if (d.type === 'boolean') {
            return (
              <label key={d.key} className="check">
                <input type="checkbox" checked={values[d.key] === true} onChange={(e) => set(d.key, e.target.checked)} />
                <span>{label}</span>
              </label>
            );
          }
          return (
            <Field key={d.key} label={label}>
              {(id) =>
                d.type === 'select' ? (
                  <select id={id} value={(values[d.key] as string) ?? ''} onChange={(e) => set(d.key, e.target.value || null)}>
                    <option value="">—</option>
                    {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input id={id} type={d.type === 'number' ? 'text' : d.type === 'date' ? 'date' : 'text'} inputMode={d.type === 'number' ? 'decimal' : undefined} value={values[d.key] === undefined || values[d.key] === null ? '' : String(values[d.key])} onChange={(e) => set(d.key, e.target.value)} />
                )
              }
            </Field>
          );
        })}
      </div>
    </fieldset>
  );
}

/* --------------------------------------------------------------- Cartes */

export function CardsPage() {
  const { toast } = useApp();
  const groups = useQuery({ queryKey: ['groups', false], queryFn: () => api.get<Group[]>('/asso/groups?archived=false') });
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Breadcrumb items={crumbs("Cartes d'adhérent")} />
      <PageHead title="Cartes d’adhérent" description="Cartes au format carte bancaire, avec QR code de vérification." />
      <div className="grid-2">
        <section className="card stack">
          <h2>Imprimer une planche</h2>
          <p className="small muted">Planche A4 de 10 cartes à découper (85,6 × 54 mm), pour les adhérents dont l’adhésion est active.</p>
          <Field label="Adhérents">
            {(id) => (
              <select id={id} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Tous les adhérents actifs</option>
                {groups.data?.map((g) => <option key={g.id} value={g.id}>{GROUP_KINDS[g.kind]} — {g.name}</option>)}
              </select>
            )}
          </Field>
          <div>
            <button className="btn" type="button" disabled={busy} onClick={async () => {
              setBusy(true);
              await api.download(`/asso/cards.pdf${groupId ? `?groupId=${groupId}` : ''}`, 'cartes-adherents.pdf').catch((e) => toast(errorMessage(e), 'error'));
              setBusy(false);
            }}>{busy ? 'Génération…' : 'Télécharger la planche (PDF)'}</button>
          </div>
        </section>
        <section className="card">
          <h2>Comment fonctionne le QR code ?</h2>
          <ul>
            <li>Le QR code contient seulement une adresse de vérification avec un identifiant aléatoire : <strong>aucune donnée personnelle</strong>.</li>
            <li>Scanné avec n’importe quel téléphone, il indique si l’adhésion est valide aujourd’hui, avec le prénom et l’initiale du nom.</li>
            <li>La validité est calculée en direct d’après les cotisations : une carte imprimée reste à jour.</li>
            <li>Carte perdue ou volée : « Révoquer la carte » depuis la fiche de l’adhérent invalide l’ancien QR.</li>
          </ul>
        </section>
      </div>
    </>
  );
}

/* ---------------------------------------------- Vérification publique */

interface CardCheck { available: boolean; association: string; member?: string; number?: number; valid?: boolean; validUntil?: string | null; checkedAt?: string }

export function VerifyCardPage() {
  const { token } = useParams();
  const [state, setState] = useState<{ data?: CardCheck; error?: string }>({});
  useEffect(() => {
    document.title = 'Vérification de carte — Scenorya';
    api.get<CardCheck>(`/public/cards/${encodeURIComponent(token ?? '')}`).then((data) => setState({ data })).catch((e) => setState({ error: errorMessage(e) }));
  }, [token]);
  const d = state.data;
  const ok = d?.available && d.valid;
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="card stack" style={{ textAlign: 'center', borderTop: `6px solid ${state.error || (d && !ok) ? 'var(--danger)' : ok ? 'var(--success)' : 'var(--border)'}` }}>
          {!d && !state.error && <Loading label="Vérification…" />}
          {state.error && (<><div style={{ fontSize: 48 }} aria-hidden="true">✕</div><h1>Carte inconnue</h1><p>{state.error}</p></>)}
          {d && !d.available && (<><h1>{d.association}</h1><p>La vérification des cartes n’est pas disponible actuellement.</p></>)}
          {d && d.available && (
            <>
              <div style={{ fontSize: 48, color: ok ? 'var(--success)' : 'var(--danger)' }} aria-hidden="true">{ok ? '✓' : '✕'}</div>
              <h1>{ok ? 'Adhésion valide' : 'Adhésion non valide'}</h1>
              <p><strong>{d.member}</strong> — adhérent n° {d.number}<br />{d.association}</p>
              {ok && <p className="muted">{d.validUntil ? `Valide jusqu’au ${formatDate(d.validUntil)}` : 'Valide sans date de fin'}</p>}
              <p className="small muted">Vérifié le {formatDate(d.checkedAt, true)}</p>
            </>
          )}
        </div>
        <p className="auth-foot">Vérification proposée par Scenorya — Une application de TiceConnect</p>
      </div>
    </div>
  );
}
