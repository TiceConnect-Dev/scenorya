import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MODULE_CATEGORIES, MODULES, MODULES_BY_ID, ModuleCategory, ModuleId, ModuleDefinition } from '@scenorya/shared';
import { api, errorMessage } from '../../api/client';
import type { CatalogueItem } from '../../api/types';
import { useApp } from '../../state';
import { Alert, Badge, Breadcrumb, ErrorBox, Field, formatDate, Loading, Modal, PageHead, StateBadge } from '../../components/ui';

interface ActivationPlan {
  toActivate: ModuleId[];
  blockers: { module: ModuleId; reason: string }[];
  unlockedFeatures: { module: ModuleId; label: string }[];
}
interface DeactivationPlan {
  dependents: ModuleId[];
  lostFeatures: { module: ModuleId; label: string }[];
  blockers: { module: ModuleId; reason: string }[];
  impacts: { module: ModuleId; level: 'blocking' | 'warning' | 'info'; message: string }[];
  canProceed: boolean;
}
interface HistoryRow {
  id: number;
  moduleId: ModuleId;
  oldState: string | null;
  newState: string;
  reason: string | null;
  actor: string | null;
  createdAt: string;
}

const STATE_FR: Record<string, string> = { active: 'actif', readonly: 'lecture seule', inactive: 'inactif' };
const names = (ids: ModuleId[]) => ids.map((i) => MODULES_BY_ID[i].name).join(', ');

function ImplBadge({ m }: { m: ModuleDefinition }) {
  if (m.implementation.status === 'available') return <Badge tone="success">Disponible</Badge>;
  if (m.implementation.status === 'partial') return <Badge tone="info">Partiel · phase {m.implementation.phase}</Badge>;
  return <Badge tone="neutral">Prévu · phase {m.implementation.phase}</Badge>;
}

export function ModulesPage() {
  const { can, toast } = useApp();
  const qc = useQueryClient();
  const catalogue = useQuery({ queryKey: ['admin-modules'], queryFn: () => api.get<{ items: CatalogueItem[] }>('/admin/modules') });
  const history = useQuery({ queryKey: ['admin-modules', 'history'], queryFn: () => api.get<HistoryRow[]>('/admin/modules/history') });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<ModuleCategory | 'all'>('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [activation, setActivation] = useState<{ id: ModuleId; plan: ActivationPlan } | null>(null);
  const [deactivation, setDeactivation] = useState<{ id: ModuleId; mode: 'inactive' | 'readonly'; plan: DeactivationPlan } | null>(null);
  const [ack, setAck] = useState(false);
  const canAdmin = can('admin.modules.admin');

  const byId = useMemo(() => new Map(catalogue.data?.items.map((i) => [i.id, i])), [catalogue.data]);
  const filtered = MODULES.filter((m) => {
    const item = byId.get(m.id);
    if (!item) return false;
    if (cat !== 'all' && m.category !== cat) return false;
    if (stateFilter !== 'all' && item.resolved.state !== stateFilter) return false;
    const n = q.trim().toLowerCase();
    return !n || `${m.name} ${m.description} ${m.tagline}`.toLowerCase().includes(n);
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-modules'] });
    qc.invalidateQueries({ queryKey: ['context'] });
    qc.invalidateQueries({ queryKey: ['hub'] });
  };

  const openActivation = async (id: ModuleId) => {
    try {
      setActivation({ id, plan: await api.post<ActivationPlan>(`/admin/modules/${id}/preview-activation`) });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const openDeactivation = async (id: ModuleId, mode: 'inactive' | 'readonly') => {
    try {
      setAck(false);
      setDeactivation({ id, mode, plan: await api.post<DeactivationPlan>(`/admin/modules/${id}/preview-deactivation`, { mode }) });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const activate = useMutation({
    mutationFn: (id: ModuleId) => api.post(`/admin/modules/${id}/activate`, { confirmDependencies: true }),
    onSuccess: (_d, id) => {
      toast(`${MODULES_BY_ID[id].name} activé.`);
      setActivation(null);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const deactivate = useMutation({
    mutationFn: (v: { id: ModuleId; mode: 'inactive' | 'readonly' }) =>
      api.post(`/admin/modules/${v.id}/deactivate`, { mode: v.mode, confirmDependents: true, acknowledgeWarnings: true }),
    onSuccess: (_d, v) => {
      toast(`${MODULES_BY_ID[v.id].name} ${v.mode === 'readonly' ? 'passé en lecture seule' : 'désactivé'}. Les données sont conservées.`);
      setDeactivation(null);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const dPlan = deactivation?.plan;
  const needsAck = Boolean(dPlan && (dPlan.dependents.length > 0 || dPlan.impacts.some((i) => i.level === 'warning') || dPlan.lostFeatures.length > 0));

  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Admin', to: '/admin' }, { label: 'Modules et fonctionnalités' }]} />
      <PageHead
        title="Modules et fonctionnalités"
        description="Activez uniquement les modules utiles à votre association. Désactiver un module n’efface jamais ses données ; un module actif ne donne aucun droit automatiquement."
      />
      {catalogue.isLoading && <Loading />}
      {catalogue.error && <ErrorBox error={catalogue.error} />}
      {catalogue.data && (
        <div className="stack">
          <div className="toolbar">
            <Field label="Rechercher">{(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom ou description" />}</Field>
            <Field label="État">
              {(id) => (
                <select id={id} value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                  <option value="all">Tous</option>
                  <option value="required">Requis (socle)</option>
                  <option value="active">Actifs</option>
                  <option value="readonly">Lecture seule</option>
                  <option value="inactive">Inactifs</option>
                  <option value="missing_dependency">Dépendance manquante</option>
                  <option value="unavailable">Indisponibles (instance)</option>
                </select>
              )}
            </Field>
          </div>
          <div className="chips" role="group" aria-label="Catégories">
            <button type="button" className="chip" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>
              Toutes
            </button>
            {(Object.keys(MODULE_CATEGORIES) as ModuleCategory[]).map((c) => (
              <button type="button" key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}>
                {MODULE_CATEGORIES[c]}
              </button>
            ))}
          </div>
          <p className="small muted" aria-live="polite">
            {filtered.length} module(s) affiché(s) sur {MODULES.length}
          </p>
          <div className="module-list">
            {filtered.map((m) => {
              const item = byId.get(m.id)!;
              const r = item.resolved;
              return (
                <article key={m.id} className="module-card" style={{ ['--mc' as string]: m.color }}>
                  <header>
                    <img src={m.assets.icon} alt="" />
                    <div>
                      <h3>{m.name}</h3>
                      <div className="small muted">{m.description}</div>
                    </div>
                  </header>
                  <div className="row">
                    <StateBadge state={r.state} />
                    <ImplBadge m={m} />
                  </div>
                  <div className="deps">
                    {m.requires.length > 0 && (
                      <div>
                        <strong>Requiert :</strong> {names(m.requires)}
                      </div>
                    )}
                    {r.state === 'missing_dependency' && <div style={{ color: 'var(--danger)' }}>Manquant : {names(r.missing)}</div>}
                    {m.integrations.length > 0 && (
                      <div>
                        <strong>S’intègre avec :</strong> {m.integrations.map((i) => MODULES_BY_ID[i].shortName).join(', ')}
                      </div>
                    )}
                    {m.features.length > 0 && (
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {m.features.map((f) => (
                          <li key={f.id}>
                            {f.label} — {r.features[f.id] ? 'disponible' : `requiert ${names(f.requires)}`}
                          </li>
                        ))}
                      </ul>
                    )}
                    {item.activatedAt && r.state === 'active' && <div className="small">Activé le {formatDate(item.activatedAt)}</div>}
                  </div>
                  <footer>
                    {m.core && <span className="small muted">Module de socle — accès soumis aux droits.</span>}
                    {!m.core && r.state === 'unavailable' && <span className="small muted">Désactivé par l’administrateur de l’instance.</span>}
                    {!m.core && canAdmin && r.state !== 'unavailable' && (
                      <>
                        {r.configured === 'inactive' && (
                          <button type="button" className="btn sm" onClick={() => openActivation(m.id)}>
                            Activer…
                          </button>
                        )}
                        {r.state === 'missing_dependency' && (
                          <button type="button" className="btn sm" onClick={() => openActivation(m.id)}>
                            Activer les dépendances…
                          </button>
                        )}
                        {r.configured === 'readonly' && (
                          <button type="button" className="btn sm" onClick={() => openActivation(m.id)}>
                            Réactiver…
                          </button>
                        )}
                        {r.configured === 'active' && (
                          <button type="button" className="btn secondary sm" onClick={() => openDeactivation(m.id, 'readonly')}>
                            Lecture seule…
                          </button>
                        )}
                        {r.configured !== 'inactive' && (
                          <button type="button" className="btn secondary sm" onClick={() => openDeactivation(m.id, 'inactive')}>
                            Désactiver…
                          </button>
                        )}
                      </>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>

          <section className="card">
            <h2>Historique des changements</h2>
            {history.data?.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Module</th>
                      <th scope="col">Changement</th>
                      <th scope="col">Motif</th>
                      <th scope="col">Auteur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.slice(0, 30).map((h) => (
                      <tr key={h.id}>
                        <td className="nowrap">{formatDate(h.createdAt, true)}</td>
                        <td>{MODULES_BY_ID[h.moduleId]?.name ?? h.moduleId}</td>
                        <td>
                          {h.oldState ? STATE_FR[h.oldState] ?? h.oldState : 'non configuré'} → {STATE_FR[h.newState] ?? h.newState}
                        </td>
                        <td>{h.reason}</td>
                        <td>{h.actor ?? 'système'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Aucun changement enregistré.</p>
            )}
          </section>
        </div>
      )}

      <Modal
        open={Boolean(activation)}
        title={activation ? `Activer ${MODULES_BY_ID[activation.id].name}` : ''}
        onClose={() => setActivation(null)}
        footer={
          activation && (
            <>
              <button type="button" className="btn secondary" onClick={() => setActivation(null)}>
                Annuler
              </button>
              <button type="button" className="btn" disabled={activation.plan.blockers.length > 0 || activate.isPending} onClick={() => activate.mutate(activation.id)}>
                {activation.plan.toActivate.length ? `Activer ${activation.plan.toActivate.length + 1} modules` : 'Activer'}
              </button>
            </>
          )
        }
      >
        {activation && (
          <div className="stack">
            {activation.plan.blockers.length > 0 && (
              <Alert tone="danger">
                <strong>Activation impossible</strong>
                <ul>
                  {activation.plan.blockers.map((b) => (
                    <li key={b.module}>
                      {MODULES_BY_ID[b.module].name} : {b.reason}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {activation.plan.toActivate.length > 0 ? (
              <Alert tone="warning">
                <strong>Dépendances qui seront également activées :</strong> {names(activation.plan.toActivate)}.
              </Alert>
            ) : (
              <p>Aucune dépendance supplémentaire n’est nécessaire.</p>
            )}
            {activation.plan.unlockedFeatures.length > 0 && (
              <div>
                <strong>Fonctionnalités débloquées :</strong>
                <ul>
                  {activation.plan.unlockedFeatures.map((f) => (
                    <li key={f.label}>
                      {MODULES_BY_ID[f.module].shortName} — {f.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="small muted">Activer un module ne donne aucun droit : attribuez ensuite les permissions dans « Rôles et permissions ». Les données conservées d’une précédente activation sont retrouvées.</p>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(deactivation)}
        title={deactivation ? `${deactivation.mode === 'readonly' ? 'Passer en lecture seule' : 'Désactiver'} ${MODULES_BY_ID[deactivation.id].name}` : ''}
        onClose={() => setDeactivation(null)}
        footer={
          deactivation && (
            <>
              <button type="button" className="btn secondary" onClick={() => setDeactivation(null)}>
                Annuler
              </button>
              {!deactivation.plan.canProceed && deactivation.mode === 'inactive' && (
                <button type="button" className="btn secondary" onClick={() => openDeactivation(deactivation.id, 'readonly')}>
                  Passer plutôt en lecture seule
                </button>
              )}
              <button
                type="button"
                className="btn danger"
                disabled={!deactivation.plan.canProceed || (needsAck && !ack) || deactivate.isPending}
                onClick={() => deactivate.mutate({ id: deactivation.id, mode: deactivation.mode })}
              >
                Confirmer
              </button>
            </>
          )
        }
      >
        {dPlan && deactivation && (
          <div className="stack">
            <Alert tone="info">
              {deactivation.mode === 'readonly'
                ? 'Mode clôture : les données restent consultables par les personnes autorisées, mais aucune modification n’est possible.'
                : 'Les données du module sont conservées. Elles seront retrouvées, avec les paramètres, lors d’une réactivation. L’accès direct (liens, API) sera refusé.'}
            </Alert>
            {dPlan.blockers.map((b) => (
              <Alert key={b.module} tone="danger">
                {b.reason}
              </Alert>
            ))}
            {dPlan.impacts.filter((i) => i.level === 'blocking').length > 0 && (
              <Alert tone="danger">
                <strong>Dossiers actifs à clôturer ou traiter d’abord :</strong>
                <ul>
                  {dPlan.impacts.filter((i) => i.level === 'blocking').map((i, k) => <li key={k}>{i.message}</li>)}
                </ul>
              </Alert>
            )}
            {dPlan.dependents.length > 0 && (
              <Alert tone="warning">
                <strong>Modules dépendants également désactivés :</strong> {names(dPlan.dependents)}.
              </Alert>
            )}
            {dPlan.lostFeatures.length > 0 && (
              <div>
                <strong>Fonctionnalités indisponibles dans d’autres modules :</strong>
                <ul>
                  {dPlan.lostFeatures.map((f) => (
                    <li key={f.label}>
                      {MODULES_BY_ID[f.module].shortName} — {f.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {dPlan.impacts.filter((i) => i.level !== 'blocking').length > 0 && (
              <ul>
                {dPlan.impacts.filter((i) => i.level !== 'blocking').map((i, k) => <li key={k}>{i.message}</li>)}
              </ul>
            )}
            {needsAck && dPlan.canProceed && (
              <label className="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>J’ai pris connaissance de ces conséquences.</span>
              </label>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
