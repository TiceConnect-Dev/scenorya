import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatCents, MODULES, MODULES_BY_ID, ModuleId } from '@scenorya/shared';
import { api } from '../api/client';
import type { AuditEntry } from '../api/types';
import { useApp } from '../state';
import { Alert, Breadcrumb, ErrorBox, formatDate, Loading, ModuleLogo, PageHead, StateBadge } from '../components/ui';

interface Summary {
  widgets: {
    modules: { active: number; readonly: number; missingDependency: ModuleId[] };
    members?: { active: number; pending: number; volunteers: number; newThisMonth: number };
    users?: { active: number };
    dues?: { open: number; outstandingCents: number };
    tasks?: { mine: number; overdue: number; dueSoon: number };
    upcoming?: { id: string; title: string; category: string; location: string | null; allDay: boolean; start: string; end: string }[];
    recentActivity?: AuditEntry[];
  };
}

/** Vérifie côté client que le module est visible ; le serveur applique de toute façon le contrôle. */
export function ModuleGate({ id, children }: { id: ModuleId; children: ReactNode }) {
  const { ctx, ctxLoading, ctxError, me } = useApp();
  if (id === 'system') return me?.user.isSuperAdmin ? <>{children}</> : <Unavailable id={id} reason="Réservé aux superadministrateurs de l’instance." />;
  if (ctxLoading) return <Loading />;
  if (ctxError) return <ErrorBox error={ctxError} />;
  if (!ctx) return <Loading />;
  if (!ctx.visibleModules.includes(id)) {
    const r = ctx.modules[id];
    const reason = !r.usable
      ? r.state === 'missing_dependency'
        ? `Dépendance manquante : ${r.missing.map((m) => MODULES_BY_ID[m].name).join(', ')}.`
        : r.state === 'unavailable'
          ? "Module désactivé au niveau de l'instance."
          : "Ce module n'est pas activé pour votre association."
      : "Vous ne disposez d'aucun droit sur ce module.";
    return <Unavailable id={id} reason={reason} state={r.state} />;
  }
  return <>{children}</>;
}

function Unavailable({ id, reason, state }: { id: ModuleId; reason: string; state?: Parameters<typeof StateBadge>[0]['state'] }) {
  const { can } = useApp();
  const m = MODULES_BY_ID[id];
  return (
    <>
      <Breadcrumb items={[{ label: m.name }]} />
      <PageHead title={`${m.name} indisponible`} />
      <div className="card stack">
        <div className="row">
          {state && <StateBadge state={state} />}
          <span>{reason}</span>
        </div>
        {can('admin.modules.read') && (
          <p>
            <Link to="/admin/modules">Gérer les modules de l’association</Link>
          </p>
        )}
      </div>
    </>
  );
}

/** Accueil d'un module prévu : identité du module et état réel d'avancement, sans bouton fictif. */
export function PlannedModulePage({ id }: { id: ModuleId }) {
  const m = MODULES_BY_ID[id];
  const { can } = useApp();
  return (
    <ModuleGate id={id}>
      <Breadcrumb items={[{ label: m.name }]} />
      <div className="module-banner">
        <ModuleLogo id={id} />
      </div>
      <PageHead title={m.name} description={m.description} />
      <div className="stack">
        <Alert tone="info">
          <strong>Module en cours de développement (phase {m.implementation.phase}).</strong>
          <p>
            Il est activé pour votre association : sa configuration est enregistrée et ses données seront disponibles dès sa livraison. Aucune fonctionnalité n’est encore
            proposée ici, afin de ne pas présenter de boutons sans effet.
          </p>
        </Alert>
        <div className="grid-2">
          <div className="card">
            <h2>Dépendances</h2>
            <p>{m.requires.length ? m.requires.map((d) => MODULES_BY_ID[d].name).join(', ') : 'Aucune dépendance stricte.'}</p>
            <h3>Intégrations facultatives</h3>
            <p className="muted">{m.integrations.length ? m.integrations.map((d) => MODULES_BY_ID[d].shortName).join(', ') : 'Aucune.'}</p>
          </div>
          <div className="card">
            <h2>Fonctionnalités conditionnelles</h2>
            {m.features.length ? (
              <ul>
                {m.features.map((f) => (
                  <li key={f.id}>
                    {f.label} — requiert {f.requires.map((d) => MODULES_BY_ID[d].shortName).join(', ')}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Aucune.</p>
            )}
            {can('admin.modules.read') && <Link to="/admin/modules">Configurer les modules</Link>}
          </div>
        </div>
      </div>
    </ModuleGate>
  );
}

export function HubPage() {
  const { ctx, me } = useApp();
  const q = useQuery({ queryKey: ['hub', ctx?.association.id], queryFn: () => api.get<Summary>('/hub/summary'), enabled: Boolean(ctx?.visibleModules.includes('hub')) });
  const apps = MODULES.filter((m) => ctx?.visibleModules.includes(m.id) && m.id !== 'hub');

  return (
    <ModuleGate id="hub">
      <div className="module-banner">
        <ModuleLogo id="hub" />
        <div className="hide-mobile">
          <strong>{ctx?.association.name}</strong>
          <div className="muted small">Bonjour {me?.user.displayName.split(' ')[0]}.</div>
        </div>
      </div>
      <PageHead title="Tableau de bord" description="Vue d’ensemble de votre association, selon vos droits et les modules actifs." />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="stack">
          {q.data.widgets.modules.missingDependency.length > 0 && (
            <Alert tone="warning">
              Modules en attente d’une dépendance : {q.data.widgets.modules.missingDependency.map((m) => MODULES_BY_ID[m].name).join(', ')}.
            </Alert>
          )}
          <div className="grid-3">
            {q.data.widgets.members && (
              <Link to="/asso/adherents" className="card kpi" style={{ textDecoration: 'none' }}>
                <span className="label">Adhérents actifs</span>
                <span className="value">{q.data.widgets.members.active}</span>
                <span className="small muted">
                  dont {q.data.widgets.members.volunteers} bénévole(s) · {q.data.widgets.members.pending} en attente · {q.data.widgets.members.newThisMonth} ce mois-ci
                </span>
              </Link>
            )}
            {q.data.widgets.dues && (
              <Link to="/asso/cotisations" className="card kpi" style={{ textDecoration: 'none' }}>
                <span className="label">Cotisations en attente</span>
                <span className="value">{q.data.widgets.dues.open}</span>
                <span className="small muted">Reste à encaisser : {formatCents(q.data.widgets.dues.outstandingCents)}</span>
              </Link>
            )}
            {q.data.widgets.tasks && (
              <Link to="/projects/mes-taches" className="card kpi" style={{ textDecoration: 'none' }}>
                <span className="label">Mes tâches à réaliser</span>
                <span className="value">{q.data.widgets.tasks.mine}</span>
                <span className="small muted">
                  {q.data.widgets.tasks.overdue > 0 ? <strong style={{ color: 'var(--danger)' }}>{q.data.widgets.tasks.overdue} en retard</strong> : 'Aucune en retard'} · {q.data.widgets.tasks.dueSoon} cette semaine
                </span>
              </Link>
            )}
            {q.data.widgets.users && (
              <div className="card kpi">
                <span className="label">Utilisateurs ayant accès</span>
                <span className="value">{q.data.widgets.users.active}</span>
              </div>
            )}
            <div className="card kpi">
              <span className="label">Modules actifs (hors socle)</span>
              <span className="value">{q.data.widgets.modules.active}</span>
              {q.data.widgets.modules.readonly > 0 && <span className="small muted">{q.data.widgets.modules.readonly} en lecture seule</span>}
            </div>
          </div>
          <section className="card">
            <h2>Vos applications</h2>
            {apps.length === 0 ? (
              <p className="muted">Aucune autre application ne vous est accessible.</p>
            ) : (
              <ul className="launcher-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
                {apps.map((m) => (
                  <li key={m.id}>
                    <Link to={m.route}>
                      <img src={m.assets.icon} alt="" />
                      <span>{m.shortName}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {q.data.widgets.upcoming && (
            <section className="card">
              <div className="row between"><h2 style={{ margin: 0 }}>Prochains événements</h2><Link to="/agenda">Agenda</Link></div>
              {q.data.widgets.upcoming.length === 0 ? (
                <p className="muted" style={{ marginTop: 10 }}>Rien de prévu dans les 14 prochains jours.</p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
                  {q.data.widgets.upcoming.map((e) => (
                    <li key={e.id + e.start} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', flexWrap: 'nowrap' }}>
                      <span className="nowrap small cap-first" style={{ minWidth: 150, display: 'inline-block' }}>
                        {new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', ...(e.allDay ? {} : { hour: '2-digit', minute: '2-digit' }) }).format(new Date(e.start))}
                      </span>
                      <span><strong>{e.title}</strong>{e.location && <span className="muted"> · {e.location}</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {q.data.widgets.recentActivity && (
            <section className="card">
              <h2>Activité récente</h2>
              {q.data.widgets.recentActivity.length === 0 ? (
                <p className="muted">Aucune activité.</p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {q.data.widgets.recentActivity.map((a) => (
                    <li key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="clamp-2" title={a.summary}>{a.summary}</span>
                      <div className="small muted">
                        {a.actorLabel} · {formatDate(a.createdAt, true)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </ModuleGate>
  );
}
