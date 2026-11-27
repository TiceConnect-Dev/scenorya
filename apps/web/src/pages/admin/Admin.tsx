import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { grantsCover, MODULES, MODULES_BY_ID, PermissionEntry } from '@scenorya/shared';
import { api, errorMessage } from '../../api/client';
import type { AuditEntry, Paged } from '../../api/types';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, ModuleLogo, PageHead, Pagination } from '../../components/ui';
import { MODULE_NAV } from '../../navigation';

const crumbs = (label: string) => [{ label: 'Scenorya Admin', to: '/admin' }, { label }];

export function AdminHome() {
  const { can } = useApp();
  const items = (MODULE_NAV.admin ?? []).filter((i) => i.to !== '/admin' && (!i.permission || can(i.permission)));
  const verify = useQuery({ queryKey: ['audit-verify'], queryFn: () => api.get<{ valid: boolean; checked: number }>('/admin/audit/verify'), enabled: can('admin.audit.read') });
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Admin' }]} />
      <div className="module-banner">
        <ModuleLogo id="admin" />
      </div>
      <PageHead title="Administration" description="Utilisateurs, permissions, modules et sécurité de l’association." />
      <div className="grid-3">
        {items.map((i) => (
          <Link key={i.to} to={i.to} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
            <h2 style={{ color: 'var(--blue)' }}>{i.label}</h2>
            <p className="muted small">{i.group}</p>
          </Link>
        ))}
      </div>
      {verify.data && (
        <div style={{ marginTop: 16 }}>
          <Alert tone={verify.data.valid ? 'success' : 'danger'}>
            Intégrité du journal d’audit : {verify.data.valid ? 'chaîne valide' : 'RUPTURE DÉTECTÉE'} ({verify.data.checked} entrées vérifiées).
          </Alert>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------ Utilisateurs */

interface Role {
  id: string;
  key: string | null;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  assigned: number;
}
interface UserRow {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  status: string;
  userStatus: string;
  expiresAt: string | null;
  lastLoginAt: string | null;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  roles: { roleId: string; name: string; scopeType: string | null }[];
}

function RolePicker({ roles, value, onChange }: { roles: Role[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend>Rôles</legend>
      <div className="module-pick">
        {roles.map((r) => (
          <label key={r.id} title={r.description}>
            <input type="checkbox" checked={value.includes(r.id)} onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />
            <span>{r.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function UsersPage() {
  const { can, toast, me } = useApp();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<UserRow[]>('/admin/users') });
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => api.get<Role[]>('/admin/roles'), enabled: can('admin.roles.read') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [form, setForm] = useState({ email: '', displayName: '', password: '', roleIds: [] as string[], expiresAt: '' });
  const [error, setError] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ['admin-users'] });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'disable' | 'enable' }) => api.post(`/admin/users/${id}/${action}`),
    onSuccess: () => {
      toast('Accès mis à jour.');
      reload();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const submitAdd = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/admin/users', {
        email: form.email,
        displayName: form.displayName,
        password: form.password || undefined,
        roleIds: form.roleIds,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      });
      toast('Utilisateur ajouté. Il devra changer son mot de passe à la première connexion.');
      setAdding(false);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const submitEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      await api.patch(`/admin/users/${editing.id}`, { roleIds: form.roleIds, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null });
      toast('Droits mis à jour.');
      setEditing(null);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const submitReset = async (e: FormEvent) => {
    e.preventDefault();
    if (!resetting) return;
    setError(null);
    try {
      await api.post(`/admin/users/${resetting.id}/reset-password`, { password: form.password });
      toast('Mot de passe provisoire défini ; les sessions de l’utilisateur ont été fermées.');
      setResetting(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const roleList = roles.data ?? [];
  return (
    <>
      <Breadcrumb items={crumbs('Utilisateurs')} />
      <PageHead
        title="Utilisateurs"
        description="Personnes ayant un compte d’accès à l’association. Les droits proviennent exclusivement des rôles attribués."
        actions={
          can('admin.users.create') && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                setForm({ email: '', displayName: '', password: '', roleIds: [], expiresAt: '' });
                setError(null);
                setAdding(true);
              }}
            >
              Ajouter un utilisateur
            </button>
          )
        }
      />
      {users.isLoading && <Loading />}
      {users.error && <ErrorBox error={users.error} />}
      {users.data && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Utilisateurs de l’association</caption>
            <thead>
              <tr>
                <th scope="col">Nom</th>
                <th scope="col">Rôles</th>
                <th scope="col">État</th>
                <th scope="col">Expiration</th>
                <th scope="col">Dernière connexion</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.displayName}</strong>
                    {u.isSuperAdmin && <> <Badge tone="info">Superadmin</Badge></>}
                    <div className="small muted">{u.email}</div>
                  </td>
                  <td>{u.roles.map((r) => r.name).join(', ') || <span className="muted">Aucun</span>}</td>
                  <td>
                    {u.status === 'active' && u.userStatus === 'active' ? <Badge tone="success">✓ Actif</Badge> : <Badge tone="neutral">○ Désactivé</Badge>}
                    {u.mustChangePassword && <div className="small muted">Mot de passe provisoire</div>}
                  </td>
                  <td>{u.expiresAt ? formatDate(u.expiresAt, true) : '—'}</td>
                  <td>{formatDate(u.lastLoginAt, true)}</td>
                  <td className="actions">
                    {can('admin.users.update') && (
                      <button
                        className="btn ghost sm"
                        type="button"
                        onClick={() => {
                          setForm({ ...form, roleIds: u.roles.filter((r) => !r.scopeType).map((r) => r.roleId), expiresAt: u.expiresAt ? u.expiresAt.slice(0, 16) : '' });
                          setError(null);
                          setEditing(u);
                        }}
                      >
                        Modifier
                      </button>
                    )}
                    {can('admin.users.update') && u.userId !== me?.user.id && (
                      <button
                        className="btn ghost sm"
                        type="button"
                        onClick={() => {
                          setForm({ ...form, password: '' });
                          setError(null);
                          setResetting(u);
                        }}
                      >
                        Mot de passe
                      </button>
                    )}
                    {u.userId !== me?.user.id && u.status === 'active' && can('admin.users.archive') && (
                      <button className="btn ghost sm" type="button" onClick={() => act.mutate({ id: u.id, action: 'disable' })}>
                        Désactiver
                      </button>
                    )}
                    {u.status !== 'active' && can('admin.users.restore') && (
                      <button className="btn ghost sm" type="button" onClick={() => act.mutate({ id: u.id, action: 'enable' })}>
                        Réactiver
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={adding} title="Ajouter un utilisateur" onClose={() => setAdding(false)}>
        <form className="stack" onSubmit={submitAdd}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <div className="form-grid">
            <Field label="Nom complet">{(id) => <input id={id} type="text" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}</Field>
            <Field label="E-mail">{(id) => <input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
            <Field label="Mot de passe provisoire" hint="Obligatoire pour un nouveau compte. À changer à la première connexion.">
              {(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
            </Field>
            <Field label="Accès temporaire jusqu’au (facultatif)">{(id) => <input id={id} type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />}</Field>
          </div>
          <RolePicker roles={roleList} value={form.roleIds} onChange={(roleIds) => setForm({ ...form, roleIds })} />
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={() => setAdding(false)}>Annuler</button>
            <button className="btn" type="submit">Ajouter</button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(editing)} title={`Droits de ${editing?.displayName ?? ''}`} onClose={() => setEditing(null)}>
        <form className="stack" onSubmit={submitEdit}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <RolePicker roles={roleList} value={form.roleIds} onChange={(roleIds) => setForm({ ...form, roleIds })} />
          <Field label="Accès temporaire jusqu’au" hint="Laisser vide pour un accès sans date d’expiration.">
            {(id, d) => <input id={id} aria-describedby={d} type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />}
          </Field>
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={() => setEditing(null)}>Annuler</button>
            <button className="btn" type="submit">Enregistrer</button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(resetting)} title={`Mot de passe provisoire — ${resetting?.displayName ?? ''}`} onClose={() => setResetting(null)}>
        <form className="stack" onSubmit={submitReset}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <p>L’utilisateur devra le changer à sa prochaine connexion ; ses sessions ouvertes seront fermées.</p>
          <Field label="Mot de passe provisoire" hint="12 caractères minimum.">
            {(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
          </Field>
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={() => setResetting(null)}>Annuler</button>
            <button className="btn" type="submit">Définir</button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/* ------------------------------------------------ Rôles et matrice des droits */

export function RolesPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => api.get<Role[]>('/admin/roles') });
  const catalogue = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<{ permissions: PermissionEntry[] }>('/admin/permissions') });
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', from: '' });
  const [error, setError] = useState<string | null>(null);
  const canEdit = can('admin.roles.update');

  useEffect(() => {
    if (roles.data && selected.length === 0) setSelected(roles.data.slice(0, 6).map((r) => r.id));
  }, [roles.data, selected.length]);

  const grouped = useMemo(() => {
    const out = new Map<string, PermissionEntry[]>();
    for (const p of catalogue.data?.permissions ?? []) out.set(p.module, [...(out.get(p.module) ?? []), p]);
    return [...out.entries()].sort((a, b) => MODULES.findIndex((m) => m.id === a[0]) - MODULES.findIndex((m) => m.id === b[0]));
  }, [catalogue.data]);

  const perms = (r: Role) => draft[r.id] ?? r.permissions;
  const toggle = (r: Role, key: string, on: boolean) => setDraft((d) => ({ ...d, [r.id]: on ? [...perms(r), key] : perms(r).filter((p) => p !== key) }));
  const save = async (r: Role) => {
    try {
      await api.patch(`/admin/roles/${r.id}`, { permissions: perms(r) });
      toast(`Rôle « ${r.name} » enregistré.`);
      setDraft(({ [r.id]: _, ...rest }) => rest);
      qc.invalidateQueries({ queryKey: ['admin-roles'] });
      qc.invalidateQueries({ queryKey: ['context'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const remove = async (r: Role) => {
    if (!window.confirm(`Supprimer le rôle « ${r.name} » ?`)) return;
    try {
      await api.delete(`/admin/roles/${r.id}`);
      toast('Rôle supprimé.');
      setSelected((s) => s.filter((x) => x !== r.id));
      qc.invalidateQueries({ queryKey: ['admin-roles'] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const base = roles.data?.find((r) => r.id === form.from);
      const r = await api.post<Role>('/admin/roles', { name: form.name, description: form.description, permissions: base?.permissions ?? [] });
      toast('Rôle créé.');
      setCreating(false);
      setSelected((s) => [...s, r.id]);
      qc.invalidateQueries({ queryKey: ['admin-roles'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const shown = (roles.data ?? []).filter((r) => selected.includes(r.id));
  return (
    <>
      <Breadcrumb items={crumbs('Rôles et permissions')} />
      <PageHead
        title="Rôles et permissions"
        description="Matrice des droits par module, ressource et action. Vous ne pouvez accorder ou retirer que des droits que vous détenez vous-même."
        actions={can('admin.roles.create') && <button className="btn" type="button" onClick={() => { setForm({ name: '', description: '', from: '' }); setError(null); setCreating(true); }}>Créer un rôle</button>}
      />
      {(roles.isLoading || catalogue.isLoading) && <Loading />}
      {roles.error && <ErrorBox error={roles.error} />}
      {roles.data && catalogue.data && (
        <div className="stack">
          <fieldset>
            <legend>Rôles affichés dans la matrice</legend>
            <div className="chips">
              {roles.data.map((r) => (
                <button key={r.id} type="button" className="chip" aria-pressed={selected.includes(r.id)} onClick={() => setSelected((s) => (s.includes(r.id) ? s.filter((x) => x !== r.id) : [...s, r.id]))}>
                  {r.name} ({r.assigned})
                </button>
              ))}
            </div>
          </fieldset>
          <div className="table-wrap">
            <table className="table matrix">
              <caption className="sr-only">Matrice des permissions</caption>
              <thead>
                <tr>
                  <th scope="col">Permission</th>
                  {shown.map((r) => (
                    <th key={r.id} scope="col" className="rot" title={r.description}>
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grouped.map(([module, list]) => (
                  <FragmentRows key={module} module={module} list={list} shown={shown} perms={perms} toggle={toggle} canEdit={canEdit} />
                ))}
                <tr>
                  <td />
                  {shown.map((r) => (
                    <td key={r.id} className="cell">
                      {!r.isSystem && canEdit && draft[r.id] && (
                        <button className="btn sm" type="button" onClick={() => save(r)}>
                          Enregistrer
                        </button>
                      )}
                      {!r.isSystem && can('admin.roles.delete') && !draft[r.id] && (
                        <button className="btn ghost sm" type="button" onClick={() => remove(r)} aria-label={`Supprimer le rôle ${r.name}`}>
                          Supprimer
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted">Le rôle « Administrateur associatif » détient tous les droits (*) et ne peut être modifié. Une case grisée cochée est couverte par un joker (ex. asso.*).</p>
        </div>
      )}
      <Modal open={creating} title="Créer un rôle" onClose={() => setCreating(false)}>
        <form className="stack" onSubmit={create}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <Field label="Nom">{(id) => <input id={id} type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Description">{(id) => <input id={id} type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
          <Field label="Partir des droits de" hint="Facultatif : copie les permissions d’un rôle existant.">
            {(id, d) => (
              <select id={id} aria-describedby={d} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
                <option value="">Aucun droit</option>
                {roles.data?.filter((r) => !r.isSystem).map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            )}
          </Field>
          <div className="form-actions">
            <button className="btn secondary" type="button" onClick={() => setCreating(false)}>Annuler</button>
            <button className="btn" type="submit">Créer</button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function FragmentRows({ module, list, shown, perms, toggle, canEdit }: { module: string; list: PermissionEntry[]; shown: Role[]; perms: (r: Role) => string[]; toggle: (r: Role, k: string, on: boolean) => void; canEdit: boolean }) {
  return (
    <>
      <tr className="group">
        <td colSpan={shown.length + 1}>{MODULES_BY_ID[module as keyof typeof MODULES_BY_ID]?.name ?? module}</td>
      </tr>
      {list.map((p) => (
        <tr key={p.key}>
          <th scope="row" style={{ fontWeight: 400, background: 'transparent' }}>
            {p.label}
            <div className="small muted mono">{p.key}</div>
          </th>
          {shown.map((r) => {
            const list = perms(r);
            const direct = list.includes(p.key);
            const covered = !direct && grantsCover(list, p.key);
            return (
              <td key={r.id} className="cell">
                <input
                  type="checkbox"
                  aria-label={`${p.label} pour ${r.name}`}
                  checked={direct || covered}
                  disabled={r.isSystem || covered || !canEdit}
                  title={covered ? 'Accordé par un joker' : undefined}
                  onChange={(e) => toggle(r, p.key, e.target.checked)}
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

/* --------------------------------------------------------------- Audit */

export function AuditPage({ instance = false }: { instance?: boolean }) {
  const { can, toast } = useApp();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const base = instance ? '/system/audit' : '/admin/audit';
  const params = `page=${page}&pageSize=30${q ? `&q=${encodeURIComponent(q)}` : ''}${action && !instance ? `&action=${encodeURIComponent(action)}` : ''}`;
  const list = useQuery({ queryKey: ['audit', instance, params], queryFn: () => api.get<Paged<AuditEntry>>(`${base}?${params}`) });
  const verify = useQuery({ queryKey: ['audit-verify', instance], queryFn: () => api.get<{ valid: boolean; checked: number; brokenAt: number | null }>(`${base}/verify`) });
  return (
    <>
      <Breadcrumb items={instance ? [{ label: 'Scenorya System', to: '/system' }, { label: "Journal de l'instance" }] : crumbs("Journal d'audit")} />
      <PageHead
        title={instance ? "Journal de l'instance" : "Journal d'audit"}
        description="Entrées en ajout seul, chaînées par empreinte SHA-256 : toute modification est refusée par la base et détectée à la vérification."
        actions={
          !instance && can('admin.audit.export') && (
            <button className="btn secondary" type="button" onClick={() => api.download(`/admin/audit/export.csv?${params}`, 'journal-audit.csv').catch((e) => toast(errorMessage(e), 'error'))}>
              Exporter (CSV)
            </button>
          )
        }
      />
      {verify.data && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone={verify.data.valid ? 'success' : 'danger'}>
            {verify.data.valid ? `✓ Chaîne intègre — ${verify.data.checked} entrées vérifiées.` : `Rupture d’intégrité détectée à l’entrée n° ${verify.data.brokenAt}.`}
          </Alert>
        </div>
      )}
      <div className="toolbar">
        <Field label="Rechercher">{(id) => <input id={id} type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Résumé ou utilisateur" />}</Field>
        {!instance && (
          <Field label="Type d’action">
            {(id) => (
              <select id={id} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
                <option value="">Toutes</option>
                <option value="module">Modules</option>
                <option value="user">Utilisateurs</option>
                <option value="role">Rôles</option>
                <option value="member">Adhérents</option>
                <option value="association">Association</option>
              </select>
            )}
          </Field>
        )}
      </div>
      {list.isLoading && <Loading />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Utilisateur</th>
                  <th scope="col">Action</th>
                  <th scope="col">Détail</th>
                  <th scope="col">IP</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">Aucune entrée.</td>
                  </tr>
                )}
                {list.data.items.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{formatDate(a.createdAt, true)}</td>
                    <td>{a.actorLabel ?? '—'}</td>
                    <td className="mono">{a.action}</td>
                    <td>{a.summary}</td>
                    <td className="mono small">{a.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------- Association */

interface AssociationData {
  name: string; shortName: string | null; legalName: string | null; rna: string | null; siret: string | null; email: string | null; phone: string | null;
  website: string | null; addressLine: string | null; postalCode: string | null; city: string | null; country: string; primaryColor: string;
  fiscalYearStartMonth: number; insurance: string | null; iban: string | null; bic: string | null; canSeeSensitive: boolean;
}

export function AssociationPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-association'], queryFn: () => api.get<AssociationData>('/admin/association') });
  const [form, setForm] = useState<AssociationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);
  const editable = can('admin.association.update');
  const set = (k: keyof AssociationData) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    try {
      const { canSeeSensitive, ...payload } = form;
      await api.put('/admin/association', { ...payload, fiscalYearStartMonth: Number(form.fiscalYearStartMonth), iban: canSeeSensitive ? form.iban : undefined });
      toast('Fiche de l’association enregistrée.');
      qc.invalidateQueries({ queryKey: ['admin-association'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const text = (k: keyof AssociationData, label: string, opts: { hint?: string; type?: string; full?: boolean } = {}) => (
    <Field label={label} hint={opts.hint} className={opts.full ? 'full' : ''}>
      {(id, d) => <input id={id} aria-describedby={d} type={opts.type ?? 'text'} value={(form?.[k] as string) ?? ''} onChange={set(k)} disabled={!editable} />}
    </Field>
  );

  return (
    <>
      <Breadcrumb items={crumbs('Association')} />
      <PageHead title="Fiche de l’association" description="Informations légales et coordonnées utilisées dans les documents et e-mails." />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {form && (
        <form className="stack" onSubmit={submit}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <fieldset>
            <legend>Identité</legend>
            <div className="form-grid">
              {text('name', 'Nom d’usage')}
              {text('shortName', 'Sigle')}
              {text('legalName', 'Dénomination légale', { full: true })}
              {text('rna', 'Numéro RNA', { hint: 'Format W123456789' })}
              {text('siret', 'SIRET', { hint: '14 chiffres' })}
              <Field label="Couleur principale" hint="Utilisée en accent dans les documents.">
                {(id, d) => <input id={id} aria-describedby={d} type="color" value={form.primaryColor} onChange={set('primaryColor')} disabled={!editable} />}
              </Field>
              <Field label="Début de l’exercice comptable">
                {(id) => (
                  <select id={id} value={form.fiscalYearStartMonth} onChange={set('fiscalYearStartMonth')} disabled={!editable}>
                    {['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'].map((m, i) => (
                      <option key={m} value={i + 1}>1er {m}</option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          </fieldset>
          <fieldset>
            <legend>Coordonnées</legend>
            <div className="form-grid">
              {text('email', 'E-mail', { type: 'email' })}
              {text('phone', 'Téléphone', { type: 'tel' })}
              {text('website', 'Site internet', { type: 'url', full: true })}
              {text('addressLine', 'Adresse', { full: true })}
              {text('postalCode', 'Code postal')}
              {text('city', 'Ville')}
              {text('country', 'Pays')}
            </div>
          </fieldset>
          <fieldset>
            <legend>Assurance et banque</legend>
            <div className="form-grid">
              {text('insurance', 'Assurance (assureur, n° de contrat)', { full: true })}
              <Field label="IBAN" hint={form.canSeeSensitive ? 'Stocké chiffré.' : 'Donnée sensible : droit spécifique requis pour la consulter ou la modifier.'}>
                {(id, d) => <input id={id} aria-describedby={d} type="text" value={form.iban ?? ''} onChange={set('iban')} disabled={!editable || !form.canSeeSensitive} />}
              </Field>
              {text('bic', 'BIC')}
            </div>
          </fieldset>
          {editable && (
            <div className="form-actions">
              <button className="btn" type="submit">Enregistrer</button>
            </div>
          )}
        </form>
      )}
    </>
  );
}
