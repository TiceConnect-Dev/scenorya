import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, deleteWithConfirm } from '../../api/client';
import { useApp } from '../../state';
import { Attachments } from '../drive/Drive';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, ModuleLogo, PageHead } from '../../components/ui';

type Status = 'todo' | 'doing' | 'waiting' | 'done';
type Priority = 'low' | 'normal' | 'high' | 'urgent';
interface Project { id: string; name: string; description: string | null; referenceDate: string | null; isTemplate: boolean; archivedAt: string | null; open: number; done: number; overdue: number }
interface Task {
  id: string; projectId: string; parentId: string | null; title: string; description: string | null; status: Status; priority: Priority;
  assigneeId: string | null; assigneeName: string | null; dueDate: string | null; dueOffsetDays: number | null; labels: string[];
  checklist: { text: string; done: boolean }[]; position: number; completedAt: string | null; subtasks: number; subtasksDone: number; comments: number; projectName?: string;
}
type TaskDetail = Omit<Task, 'subtasks' | 'comments'> & { subtasks: Task[]; comments: { id: string; body: string; author: string | null; authorId: string | null; createdAt: string }[]; project: { name: string; isTemplate: boolean; archivedAt: string | null }; mine: boolean };
interface Assignee { id: string; displayName: string }

export const STATUS: Record<Status, string> = { todo: 'À faire', doing: 'En cours', waiting: 'En attente', done: 'Terminé' };
const PRIORITY: Record<Priority, [string, 'neutral' | 'info' | 'warning' | 'danger']> = { low: ['Basse', 'neutral'], normal: ['Normale', 'info'], high: ['Haute', 'warning'], urgent: ['Urgente', 'danger'] };
const today = () => new Date().toISOString().slice(0, 10);
const crumbs = (label: string, extra: { label: string; to?: string }[] = []) => [{ label: 'Scenorya Projects', to: '/projects' }, ...extra, { label }];

function Due({ t }: { t: Pick<Task, 'dueDate' | 'status' | 'dueOffsetDays'> }) {
  if (t.dueOffsetDays !== null && !t.dueDate) return <span className="small muted">J{t.dueOffsetDays >= 0 ? '+' : ''}{t.dueOffsetDays}</span>;
  if (!t.dueDate) return null;
  const late = t.status !== 'done' && t.dueDate < today();
  return <span className="small" style={{ color: late ? 'var(--danger)' : 'var(--text-muted)', fontWeight: late ? 700 : 400 }}>{late ? '! ' : ''}{formatDate(t.dueDate)}</span>;
}

/* --------------------------------------------------- Liste des projets */

export function ProjectsPage({ templates = false }: { templates?: boolean }) {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const q = useQuery({ queryKey: ['projects', templates, archived], queryFn: () => api.get<Project[]>(`/projects?templates=${templates}&archived=${archived}`) });
  const tpl = useQuery({ queryKey: ['projects', true, false], queryFn: () => api.get<Project[]>('/projects?templates=true') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', referenceDate: '', templateId: '' });
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const p = await api.post<Project>('/projects', { name: form.name, description: form.description || null, referenceDate: form.referenceDate || null, isTemplate: templates, templateId: form.templateId || undefined });
      qc.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const install = async () => {
    try {
      const p = await api.post<Project>('/projects/templates/spectacle');
      toast('Modèle installé : vous pouvez l’adapter.');
      qc.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${p.id}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <Breadcrumb items={templates ? crumbs('Modèles') : [{ label: 'Scenorya Projects' }]} />
      {!templates && <div className="module-banner"><ModuleLogo id="projects" /></div>}
      <PageHead
        title={templates ? 'Modèles de projets' : 'Projets'}
        description={templates ? 'Projets types réutilisables : les échéances sont exprimées par rapport à une date de référence (J-30, J+1…).' : 'Organisation des spectacles, événements et chantiers de l’association.'}
        actions={can('projects.projects.create') && <button className="btn" type="button" onClick={() => { setForm({ name: '', description: '', referenceDate: '', templateId: '' }); setError(null); setOpen(true); }}>{templates ? 'Nouveau modèle' : 'Nouveau projet'}</button>}
      />
      {templates && can('projects.projects.create') && tpl.data && !tpl.data.some((p) => p.name === 'Organisation d’un spectacle') && (
        <div style={{ marginBottom: 16 }}>
          <Alert>
            Scenorya fournit un rétroplanning type « Organisation d’un spectacle » (droits, salle, distribution, communication, billetterie, générale, bilan…).{' '}
            <button className="btn sm" type="button" onClick={install}>Installer ce modèle</button>
          </Alert>
        </div>
      )}
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        <span>Afficher les éléments archivés</span>
      </label>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.length === 0 ? <div className="card empty">{templates ? 'Aucun modèle.' : 'Aucun projet.'}</div> : (
        <div className="grid-3">
          {q.data.map((p) => {
            const total = p.open + p.done;
            return (
              <Link key={p.id} to={`/projects/${p.id}`} className="card stack" style={{ textDecoration: 'none', color: 'inherit', gap: 8 }}>
                <h2 style={{ margin: 0, color: 'var(--blue)' }}>{p.name}</h2>
                {p.referenceDate && <span className="small muted">Date de référence : {formatDate(p.referenceDate)}</span>}
                {!templates && (
                  <>
                    <div className="progress" aria-hidden="true"><span style={{ width: `${total ? Math.round((p.done / total) * 100) : 0}%` }} /></div>
                    <span className="small">{p.done}/{total} tâche(s) terminée(s){p.overdue > 0 && <strong style={{ color: 'var(--danger)' }}> · {p.overdue} en retard</strong>}</span>
                  </>
                )}
                {templates && <span className="small muted">{total} tâche(s)</span>}
              </Link>
            );
          })}
        </div>
      ))}
      <Modal open={open} title={templates ? 'Nouveau modèle' : 'Nouveau projet'} onClose={() => setOpen(false)}>
        <form className="stack" onSubmit={submit}>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <Field label="Nom">{(id) => <input id={id} type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          {!templates && tpl.data && tpl.data.length > 0 && (
            <Field label="Partir d’un modèle (facultatif)">
              {(id) => <select id={id} value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}><option value="">Projet vide</option>{tpl.data!.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
            </Field>
          )}
          {!templates && (
            <Field label="Date de référence" hint="Ex. : date de la première représentation. Les échéances du modèle (J-30…) sont calculées à partir d’elle.">
              {(id, d) => <input id={id} aria-describedby={d} type="date" value={form.referenceDate} onChange={(e) => setForm({ ...form, referenceDate: e.target.value })} />}
            </Field>
          )}
          <Field label="Description">{(id) => <textarea id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
          <div className="form-actions"><button className="btn secondary" type="button" onClick={() => setOpen(false)}>Annuler</button><button className="btn" type="submit">Créer</button></div>
        </form>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------ Détail tâche */

function TaskModal({ id, assignees, onClose, onChanged }: { id: string | null; assignees: Assignee[]; onClose: () => void; onChanged: () => void }) {
  const { can, toast, ctx, me } = useApp();
  const q = useQuery({ queryKey: ['task', id], queryFn: () => api.get<TaskDetail>(`/tasks/${id}`), enabled: Boolean(id) });
  const full = can('projects.tasks.update');
  const [edit, setEdit] = useState<Partial<Task> | null>(null);
  const [comment, setComment] = useState('');
  const [sub, setSub] = useState('');
  const [item, setItem] = useState('');
  const d = q.data;
  useEffect(() => setEdit(null), [id]);
  const readOnly = Boolean(d?.project.archivedAt);
  const canStatus = !readOnly && (full || d?.mine);
  const save = async (patch: Partial<Task>, ok = 'Tâche mise à jour.') => {
    try {
      await api.patch(`/tasks/${id}`, patch);
      toast(ok);
      q.refetch();
      onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Modal open={Boolean(id)} title={d?.title ?? 'Tâche'} onClose={onClose}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {d && (
        <div className="stack">
          {readOnly && <Alert tone="warning">Projet archivé : lecture seule.</Alert>}
          {edit && full ? (
            <form className="stack" onSubmit={async (e) => { e.preventDefault(); await save(edit); setEdit(null); }}>
              <div className="form-grid">
                <Field label="Titre" className="full">{(fid) => <input id={fid} type="text" required value={edit.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />}</Field>
                <Field label="Priorité">{(fid) => <select id={fid} value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value as Priority })}>{Object.entries(PRIORITY).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
                <Field label="Responsable">{(fid) => <select id={fid} value={edit.assigneeId ?? ''} onChange={(e) => setEdit({ ...edit, assigneeId: e.target.value || null })}><option value="">Personne</option>{assignees.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select>}</Field>
                {d.project.isTemplate ? (
                  <Field label="Échéance relative (jours)" hint="Négatif = avant la date de référence.">{(fid, h) => <input id={fid} aria-describedby={h} type="number" value={edit.dueOffsetDays ?? ''} onChange={(e) => setEdit({ ...edit, dueOffsetDays: e.target.value === '' ? null : Number(e.target.value) })} />}</Field>
                ) : (
                  <Field label="Échéance">{(fid) => <input id={fid} type="date" value={edit.dueDate ?? ''} onChange={(e) => setEdit({ ...edit, dueDate: e.target.value || null })} />}</Field>
                )}
                <Field label="Étiquettes (séparées par des virgules)">{(fid) => <input id={fid} type="text" value={(edit.labels ?? []).join(', ')} onChange={(e) => setEdit({ ...edit, labels: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />}</Field>
                <Field label="Description" className="full">{(fid) => <textarea id={fid} value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value || null })} />}</Field>
              </div>
              <div className="form-actions"><button className="btn secondary" type="button" onClick={() => setEdit(null)}>Annuler</button><button className="btn" type="submit">Enregistrer</button></div>
            </form>
          ) : (
            <dl className="props">
              <dt>Projet</dt><dd>{d.project.name}</dd>
              <dt>État</dt>
              <dd>
                {canStatus ? (
                  <select aria-label="État" style={{ width: 'auto', minHeight: 32 }} value={d.status} onChange={(e) => save({ status: e.target.value as Status })}>{Object.entries(STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                ) : STATUS[d.status]}
              </dd>
              <dt>Priorité</dt><dd><Badge tone={PRIORITY[d.priority][1]}>{PRIORITY[d.priority][0]}</Badge></dd>
              <dt>Responsable</dt><dd>{d.assigneeName ?? '—'}</dd>
              <dt>Échéance</dt><dd><Due t={d} />{!d.dueDate && d.dueOffsetDays === null && '—'}</dd>
              {d.labels.length > 0 && (<><dt>Étiquettes</dt><dd className="row" style={{ gap: 4 }}>{d.labels.map((l) => <Badge key={l}>{l}</Badge>)}</dd></>)}
              {d.description && (<><dt>Description</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.description}</dd></>)}
            </dl>
          )}

          <section>
            <h3>Checklist</h3>
            {d.checklist.length === 0 && <p className="small muted">Aucun élément.</p>}
            {d.checklist.map((c, i) => (
              <label key={i} className="check">
                <input type="checkbox" checked={c.done} disabled={!canStatus} onChange={(e) => save({ checklist: d.checklist.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)) }, 'Checklist mise à jour.')} />
                <span style={c.done ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>{c.text}</span>
              </label>
            ))}
            {full && !readOnly && (
              <form className="row" style={{ marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); if (item.trim()) { save({ checklist: [...d.checklist, { text: item.trim(), done: false }] }); setItem(''); } }}>
                <label className="sr-only" htmlFor="new-item">Nouvel élément</label>
                <input id="new-item" type="text" placeholder="Ajouter un élément" value={item} onChange={(e) => setItem(e.target.value)} style={{ maxWidth: 320 }} />
                <button className="btn secondary sm" type="submit">Ajouter</button>
              </form>
            )}
          </section>

          {!d.parentId && (
            <section>
              <h3>Sous-tâches</h3>
              {d.subtasks.length === 0 && <p className="small muted">Aucune.</p>}
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {d.subtasks.map((s) => (
                  <li key={s.id} className="row" style={{ padding: '4px 0' }}>
                    <input type="checkbox" aria-label={`Terminer : ${s.title}`} checked={s.status === 'done'} disabled={!full || readOnly} onChange={async (e) => { await api.patch(`/tasks/${s.id}`, { status: e.target.checked ? 'done' : 'todo' }); q.refetch(); onChanged(); }} />
                    <span style={s.status === 'done' ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>{s.title}</span>
                  </li>
                ))}
              </ul>
              {can('projects.tasks.create') && !readOnly && (
                <form className="row" style={{ marginTop: 6 }} onSubmit={async (e) => { e.preventDefault(); if (!sub.trim()) return; try { await api.post(`/projects/${d.projectId}/tasks`, { title: sub.trim(), parentId: d.id }); setSub(''); q.refetch(); onChanged(); } catch (err) { toast(errorMessage(err), 'error'); } }}>
                  <label className="sr-only" htmlFor="new-sub">Nouvelle sous-tâche</label>
                  <input id="new-sub" type="text" placeholder="Ajouter une sous-tâche" value={sub} onChange={(e) => setSub(e.target.value)} style={{ maxWidth: 320 }} />
                  <button className="btn secondary sm" type="submit">Ajouter</button>
                </form>
              )}
            </section>
          )}

          {ctx?.modules.projects?.features['projects.attachments'] && can('drive.files.read') && (
            <section>
              <h3>Pièces jointes</h3>
              <Attachments module="projects" entityType="task" entityId={d.id} />
            </section>
          )}

          <section>
            <h3>Commentaires</h3>
            {d.comments.length === 0 && <p className="small muted">Aucun commentaire.</p>}
            {d.comments.map((k) => (
              <div key={k.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{k.body}</div>
                <div className="small muted">
                  {k.author} · {formatDate(k.createdAt, true)}
                  {(k.authorId === me?.user.id || can('projects.tasks.update')) && (
                    <> · <button type="button" className="link-btn small" onClick={() => deleteWithConfirm(`/tasks/${d.id}/comments/${k.id}`, 'Supprimer ce commentaire ?').then((r) => { if (r) { q.refetch(); onChanged(); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button></>
                  )}
                </div>
              </div>
            ))}
            {canStatus && (
              <form className="stack" style={{ marginTop: 8, gap: 6 }} onSubmit={async (e) => { e.preventDefault(); if (!comment.trim()) return; try { await api.post(`/tasks/${d.id}/comments`, { body: comment }); setComment(''); q.refetch(); onChanged(); } catch (err) { toast(errorMessage(err), 'error'); } }}>
                <label className="sr-only" htmlFor="new-comment">Commentaire</label>
                <textarea id="new-comment" placeholder="Écrire un commentaire" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 64 }} />
                <div><button className="btn secondary sm" type="submit">Publier</button></div>
              </form>
            )}
          </section>

          {full && !readOnly && !edit && (
            <div className="row">
              <button className="btn secondary" type="button" onClick={() => setEdit({ title: d.title, priority: d.priority, assigneeId: d.assigneeId, dueDate: d.dueDate, dueOffsetDays: d.dueOffsetDays, labels: d.labels, description: d.description })}>Modifier</button>
              {can('projects.tasks.delete') && <button className="btn ghost" type="button" onClick={async () => { if (!window.confirm('Supprimer cette tâche et ses sous-tâches ?')) return; await api.delete(`/tasks/${d.id}`); toast('Tâche supprimée.'); onChanged(); onClose(); }}>Supprimer</button>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- Kanban */

export function ProjectBoard() {
  const { id } = useParams();
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/projects/${id}`) });
  const list = useQuery({ queryKey: ['tasks', id], queryFn: () => api.get<Task[]>(`/projects/${id}/tasks`) });
  const assignees = useQuery({ queryKey: ['assignees'], queryFn: () => api.get<Assignee[]>('/projects/assignees') });
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<'board' | 'list'>(() => (window.matchMedia('(max-width: 700px)').matches ? 'list' : 'board'));
  const [filter, setFilter] = useState({ assignee: '', label: '' });
  const [drag, setDrag] = useState<string | null>(null);
  const [quick, setQuick] = useState<Record<Status, string>>({ todo: '', doing: '', waiting: '', done: '' });
  const p = project.data;
  const editable = can('projects.tasks.update') && !p?.archivedAt;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tasks', id] });
    qc.invalidateQueries({ queryKey: ['projects'] });
    qc.invalidateQueries({ queryKey: ['hub'] });
  };
  const roots = useMemo(() => (list.data ?? []).filter((t) => !t.parentId).filter((t) => (!filter.assignee || t.assigneeId === filter.assignee) && (!filter.label || t.labels.includes(filter.label))), [list.data, filter]);
  const labels = useMemo(() => [...new Set((list.data ?? []).flatMap((t) => t.labels))].sort(), [list.data]);

  const moveTo = async (taskId: string, status: Status, beforeId?: string) => {
    const column = roots.filter((t) => t.status === status && t.id !== taskId).map((t) => t.id);
    const idx = beforeId ? column.indexOf(beforeId) : -1;
    column.splice(idx >= 0 ? idx : column.length, 0, taskId);
    try {
      await api.post(`/projects/${id}/board`, { status, orderedIds: column });
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (project.isLoading) return <Loading />;
  if (project.error || !p) return <ErrorBox error={project.error} />;

  const card = (t: Task) => (
    <article
      key={t.id}
      className="kanban-card"
      draggable={editable}
      onDragStart={(e) => { setDrag(t.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={() => setDrag(null)}
      onDragOver={(e) => editable && drag && e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (drag && drag !== t.id) moveTo(drag, t.status, t.id); }}
      style={{ opacity: drag === t.id ? 0.5 : 1 }}
    >
      <button type="button" className="kanban-title" onClick={() => setOpenId(t.id)}>{t.title}</button>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        {t.priority !== 'normal' && <Badge tone={PRIORITY[t.priority][1]}>{PRIORITY[t.priority][0]}</Badge>}
        {t.labels.map((l) => <Badge key={l}>{l}</Badge>)}
      </div>
      <div className="row between small muted" style={{ marginTop: 6 }}>
        <span>{t.assigneeName ?? 'Non attribuée'}</span>
        <Due t={t} />
      </div>
      {(t.subtasks > 0 || t.checklist.length > 0 || t.comments > 0) && (
        <div className="small muted" style={{ marginTop: 4 }}>
          {t.subtasks > 0 && <span>☑ {t.subtasksDone}/{t.subtasks} </span>}
          {t.checklist.length > 0 && <span>✓ {t.checklist.filter((c) => c.done).length}/{t.checklist.length} </span>}
          {t.comments > 0 && <span>💬 {t.comments}</span>}
        </div>
      )}
      {editable && (
        <>
          <label className="sr-only" htmlFor={`mv-${t.id}`}>Déplacer « {t.title} »</label>
          <select id={`mv-${t.id}`} className="kanban-move" value={t.status} onChange={(e) => moveTo(t.id, e.target.value as Status)}>
            {Object.entries(STATUS).map(([k, l]) => <option key={k} value={k}>→ {l}</option>)}
          </select>
        </>
      )}
    </article>
  );

  return (
    <>
      <Breadcrumb items={crumbs(p.name, p.isTemplate ? [{ label: 'Modèles', to: '/projects/modeles' }] : [])} />
      <PageHead
        title={p.name}
        description={[p.isTemplate ? 'Modèle' : null, p.referenceDate ? `Date de référence : ${formatDate(p.referenceDate)}` : null, p.description].filter(Boolean).join(' — ') || undefined}
        actions={
          <>
            {can('projects.projects.archive') && <button className="btn secondary" type="button" onClick={async () => { await api.post(`/projects/${p.id}/archive`, { restore: Boolean(p.archivedAt) }); toast(p.archivedAt ? 'Projet restauré.' : 'Projet archivé.'); qc.invalidateQueries({ queryKey: ['project', id] }); refresh(); }}>{p.archivedAt ? 'Restaurer' : 'Archiver'}</button>}
            {can('projects.projects.delete') && <button className="btn danger" type="button" onClick={() => deleteWithConfirm<{ tasks: number }>(`/projects/${p.id}`, `Supprimer définitivement ${p.isTemplate ? 'le modèle' : 'le projet'} « ${p.name} », ses tâches et ses commentaires ? (Les pièces jointes restent dans Drive.)`)
              .then((r) => { if (r) { toast(`${p.isTemplate ? 'Modèle' : 'Projet'} supprimé (${r.tasks} tâche(s)).`); qc.invalidateQueries({ queryKey: ['projects'] }); navigate(p.isTemplate ? '/projects/modeles' : '/projects'); } }, (e) => toast(errorMessage(e), 'error'))}>Supprimer</button>}
          </>
        }
      />
      {p.archivedAt && <div style={{ marginBottom: 12 }}><Alert tone="warning">Projet archivé : lecture seule.</Alert></div>}
      <div className="toolbar">
        <Field label="Responsable">{(fid) => <select id={fid} value={filter.assignee} onChange={(e) => setFilter({ ...filter, assignee: e.target.value })}><option value="">Tous</option>{assignees.data?.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select>}</Field>
        {labels.length > 0 && <Field label="Étiquette">{(fid) => <select id={fid} value={filter.label} onChange={(e) => setFilter({ ...filter, label: e.target.value })}><option value="">Toutes</option>{labels.map((l) => <option key={l} value={l}>{l}</option>)}</select>}</Field>}
        <div className="chips" role="group" aria-label="Vue" style={{ alignSelf: 'flex-end' }}>
          <button type="button" className="chip" aria-pressed={view === 'board'} onClick={() => setView('board')}>Tableau</button>
          <button type="button" className="chip" aria-pressed={view === 'list'} onClick={() => setView('list')}>Liste</button>
        </div>
      </div>
      {list.isLoading && <Loading />}
      {list.data && view === 'board' && (
        <div className="kanban">
          {(Object.keys(STATUS) as Status[]).map((s) => {
            const col = roots.filter((t) => t.status === s);
            return (
              <section key={s} className="kanban-col" aria-label={STATUS[s]} onDragOver={(e) => editable && drag && e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (drag) moveTo(drag, s); }}>
                <h2 className="kanban-head">{STATUS[s]} <span className="muted small">{col.length}</span></h2>
                {col.map(card)}
                {can('projects.tasks.create') && !p.archivedAt && (
                  <form onSubmit={async (e) => { e.preventDefault(); if (!quick[s].trim()) return; try { await api.post(`/projects/${id}/tasks`, { title: quick[s].trim(), status: s }); setQuick({ ...quick, [s]: '' }); refresh(); } catch (err) { toast(errorMessage(err), 'error'); } }}>
                    <label className="sr-only" htmlFor={`quick-${s}`}>Nouvelle tâche « {STATUS[s]} »</label>
                    <input id={`quick-${s}`} type="text" placeholder="+ Ajouter une tâche" value={quick[s]} onChange={(e) => setQuick({ ...quick, [s]: e.target.value })} />
                  </form>
                )}
              </section>
            );
          })}
        </div>
      )}
      {list.data && view === 'list' && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Tâche</th><th scope="col">État</th><th scope="col">Priorité</th><th scope="col">Responsable</th><th scope="col">Échéance</th></tr></thead>
            <tbody>
              {roots.length === 0 && <tr><td colSpan={5} className="empty">Aucune tâche.</td></tr>}
              {[...roots].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')).map((t) => (
                <tr key={t.id}>
                  <td><button type="button" className="btn ghost sm" style={{ padding: 0, textAlign: 'left' }} onClick={() => setOpenId(t.id)}>{t.title}</button></td>
                  <td>{STATUS[t.status]}</td>
                  <td><Badge tone={PRIORITY[t.priority][1]}>{PRIORITY[t.priority][0]}</Badge></td>
                  <td>{t.assigneeName ?? '—'}</td>
                  <td><Due t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TaskModal id={openId} assignees={assignees.data ?? []} onClose={() => setOpenId(null)} onChanged={refresh} />
    </>
  );
}

/* ------------------------------------------------------ Mes tâches */

export function MyTasksPage() {
  const q = useQuery({ queryKey: ['tasks', 'mine'], queryFn: () => api.get<Task[]>('/tasks/mine') });
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <Breadcrumb items={crumbs('Mes tâches')} />
      <PageHead title="Mes tâches" description="Tâches qui vous sont attribuées dans les projets en cours." />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.length === 0 ? <div className="card empty">Aucune tâche en attente. 🎭</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Tâche</th><th scope="col">Projet</th><th scope="col">État</th><th scope="col">Échéance</th></tr></thead>
            <tbody>
              {q.data.map((t) => (
                <tr key={t.id}>
                  <td><button type="button" className="btn ghost sm" style={{ padding: 0, textAlign: 'left' }} onClick={() => setOpenId(t.id)}>{t.title}</button>{t.priority !== 'normal' && <> <Badge tone={PRIORITY[t.priority][1]}>{PRIORITY[t.priority][0]}</Badge></>}</td>
                  <td><Link to={`/projects/${t.projectId}`}>{t.projectName}</Link></td>
                  <td>{STATUS[t.status]}</td>
                  <td><Due t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <TaskModal id={openId} assignees={[]} onClose={() => setOpenId(null)} onChanged={() => qc.invalidateQueries({ queryKey: ['tasks'] })} />
    </>
  );
}
