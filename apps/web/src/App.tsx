import type { ModuleId } from '@scenorya/shared';
import { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MODULES } from '@scenorya/shared';
import { api } from './api/client';
import { useApp } from './state';
import { Shell } from './layout/Shell';
import { Loading } from './components/ui';
import { ChangePasswordPage, LoginPage, SetupPage } from './pages/Public';
import { HubPage, ModuleGate, PlannedModulePage } from './pages/Hub';
import { AccountPage } from './pages/Account';
import { ModulesPage } from './pages/admin/Modules';
import { AdminHome, AssociationPage, AuditPage, RolesPage, UsersPage } from './pages/admin/Admin';
import { AssociationsPage, BackupsPage, HealthPage, InstanceModulesPage, SmtpPage, StoragePage } from './pages/system/System';
import { AssoHome, MemberDetail, MemberForm, MembersImport, MembersList } from './pages/asso/Asso';
import { DuesPage, PlansPage, RenewalsPage } from './pages/asso/Dues';
import { AgendaPage } from './pages/agenda/Agenda';
import { MyTasksPage, ProjectBoard, ProjectsPage } from './pages/projects/Projects';
import { CuesheetPage, LivePage, RegieHome } from './pages/regie/Regie';
import { LocationsPage, StockHome, StockItemPage } from './pages/stock/Stock';
import { EventPage as TicketEventPage, TicketsHome } from './pages/tickets/Tickets';
import { PublicOrderPage, PublicTicketCheck, PublicTicketing } from './pages/tickets/PublicTickets';
import { ScanHome, ScanPage } from './pages/scan/Scan';
import { CatalogPage as PosCatalogPage, PosHome, PosScreen, SessionPage as PosSessionPage, SessionsPage as PosSessionsPage } from './pages/pos/Pos';
import { BookingHome, ResourcesPage } from './pages/booking/Booking';
import { MaintenanceHome, PlansPage as MaintenancePlansPage, TicketPage } from './pages/maintenance/Maintenance';
import { EspaceShows, PerformancesPage, ShowHome, ShowPage, VenuesPage } from './pages/show/Show';
import { CastHome, EspaceCast, ProductionPage, UnavailabilityPage } from './pages/cast/Cast';
import { EspaceAgenda, EspaceDocuments, EspaceDues, EspaceHome, EspaceMeetings, EspaceProfile, InvitationPage } from './pages/espace/Espace';
import { DriveAccessLogPage, DriveFavoritesPage, DrivePage, DriveRecentPage, DriveSearchPage, DriveSharesPage, DriveTrashPage, PublicSharePage } from './pages/drive/Drive';
import { MandatesPage, MeetingDetailPage, MeetingsPage } from './pages/asso/Governance';
import { CardsPage, FieldsPage, GroupDetail, GroupsPage, VerifyCardPage } from './pages/asso/Groups';
import { PwaPrompt } from './components/PwaPrompt';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, meLoading } = useApp();
  const location = useLocation();
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup/status'), enabled: !meLoading && !me });
  if (meLoading || (!me && setup.isLoading)) return <div className="main"><Loading /></div>;
  if (!me) return <Navigate to={setup.data?.needsSetup ? '/installation' : '/connexion'} replace state={{ from: location.pathname }} />;
  if (me.user.mustChangePassword) return <Navigate to="/mot-de-passe" replace />;
  if (me.associations.length === 0 && !me.user.isSuperAdmin) {
    return <div className="auth-page"><div className="card auth-card"><h1>Aucune association</h1><p>Votre compte n’est rattaché à aucune association active. Contactez un administrateur.</p></div></div>;
  }
  return <>{children}</>;
}

/** Page d'accueil : le Hub, ou l'Espace pour un compte qui n'a accès qu'à son espace personnel. */
/** Sans accès au Hub : l'Espace adhérent, sinon la caisse (caissiers) ou le contrôle des entrées (contrôleurs). */
function fallbackHome(isVisible: (m: ModuleId) => boolean) {
  if (isVisible('hub')) return '/hub';
  if (isVisible('espace')) return '/espace';
  if (isVisible('pos')) return '/pos';
  if (isVisible('scan')) return '/scan';
  return '/hub';
}
function HomeRedirect() {
  const { isVisible, ctxLoading } = useApp();
  if (ctxLoading) return <Loading />;
  return <Navigate to={fallbackHome(isVisible)} replace />;
}
function HubOrEspace() {
  const { isVisible, ctxLoading } = useApp();
  if (ctxLoading) return <Loading />;
  if (!isVisible('hub') && fallbackHome(isVisible) !== '/hub') return <Navigate to={fallbackHome(isVisible)} replace />;
  return <HubPage />;
}

/** Modules livrés : routes dédiées. Modules prévus : page d'accueil honnête du module. */
const DELIVERED = new Set(['hub', 'asso', 'admin', 'system', 'agenda', 'projects', 'drive', 'espace', 'cast', 'show', 'regie', 'stock', 'booking', 'maintenance', 'tickets', 'scan', 'pos']);

export function App() {
  return (
    <>
      <Routes>
        <Route path="/installation" element={<SetupPage />} />
        <Route path="/connexion" element={<LoginPage />} />
        <Route path="/mot-de-passe" element={<ChangePasswordPage />} />
        <Route path="/verifier/carte/:token" element={<VerifyCardPage />} />
        <Route path="/partage/:token" element={<PublicSharePage />} />
        <Route path="/invitation/:token" element={<InvitationPage />} />
        <Route path="/billetterie/:slug" element={<PublicTicketing />} />
        <Route path="/billets/:token" element={<PublicOrderPage />} />
        <Route path="/billet/:code" element={<PublicTicketCheck />} />
        <Route element={<RequireAuth><Shell /></RequireAuth>}>
          <Route index element={<HomeRedirect />} />
          <Route path="/hub" element={<HubOrEspace />} />
          <Route path="/compte" element={<AccountPage />} />

          <Route path="/asso" element={<ModuleGate id="asso"><AssoHome /></ModuleGate>} />
          <Route path="/asso/adherents" element={<ModuleGate id="asso"><MembersList /></ModuleGate>} />
          <Route path="/asso/adherents/nouveau" element={<ModuleGate id="asso"><MemberForm /></ModuleGate>} />
          <Route path="/asso/adherents/:id" element={<ModuleGate id="asso"><MemberDetail /></ModuleGate>} />
          <Route path="/asso/adherents/:id/modifier" element={<ModuleGate id="asso"><MemberForm /></ModuleGate>} />
          <Route path="/asso/import" element={<ModuleGate id="asso"><MembersImport /></ModuleGate>} />
          <Route path="/asso/cotisations" element={<ModuleGate id="asso"><DuesPage /></ModuleGate>} />
          <Route path="/asso/renouvellements" element={<ModuleGate id="asso"><RenewalsPage /></ModuleGate>} />
          <Route path="/asso/formules" element={<ModuleGate id="asso"><PlansPage /></ModuleGate>} />
          <Route path="/asso/groupes" element={<ModuleGate id="asso"><GroupsPage /></ModuleGate>} />
          <Route path="/asso/groupes/:id" element={<ModuleGate id="asso"><GroupDetail /></ModuleGate>} />
          <Route path="/asso/champs" element={<ModuleGate id="asso"><FieldsPage /></ModuleGate>} />
          <Route path="/asso/cartes" element={<ModuleGate id="asso"><CardsPage /></ModuleGate>} />
          <Route path="/asso/instances" element={<ModuleGate id="asso"><MeetingsPage /></ModuleGate>} />
          <Route path="/asso/instances/:id" element={<ModuleGate id="asso"><MeetingDetailPage /></ModuleGate>} />
          <Route path="/asso/mandats" element={<ModuleGate id="asso"><MandatesPage /></ModuleGate>} />

          <Route path="/agenda" element={<ModuleGate id="agenda"><AgendaPage /></ModuleGate>} />
          <Route path="/regie" element={<ModuleGate id="regie"><RegieHome /></ModuleGate>} />
          <Route path="/regie/conduites/:id" element={<ModuleGate id="regie"><CuesheetPage /></ModuleGate>} />
          <Route path="/regie/conduites/:id/direct" element={<ModuleGate id="regie"><LivePage /></ModuleGate>} />
          <Route path="/show" element={<ModuleGate id="show"><ShowHome /></ModuleGate>} />
          <Route path="/show/spectacles/:id" element={<ModuleGate id="show"><ShowPage /></ModuleGate>} />
          <Route path="/show/representations" element={<ModuleGate id="show"><PerformancesPage /></ModuleGate>} />
          <Route path="/show/lieux" element={<ModuleGate id="show"><VenuesPage /></ModuleGate>} />
          <Route path="/tickets" element={<ModuleGate id="tickets"><TicketsHome /></ModuleGate>} />
          <Route path="/tickets/seances/:id" element={<ModuleGate id="tickets"><TicketEventPage /></ModuleGate>} />
          <Route path="/pos" element={<ModuleGate id="pos"><PosHome /></ModuleGate>} />
          <Route path="/pos/caisse/:id" element={<ModuleGate id="pos"><PosScreen /></ModuleGate>} />
          <Route path="/pos/sessions" element={<ModuleGate id="pos"><PosSessionsPage /></ModuleGate>} />
          <Route path="/pos/sessions/:id" element={<ModuleGate id="pos"><PosSessionPage /></ModuleGate>} />
          <Route path="/pos/catalogue" element={<ModuleGate id="pos"><PosCatalogPage /></ModuleGate>} />
          <Route path="/scan" element={<ModuleGate id="scan"><ScanHome /></ModuleGate>} />
          <Route path="/scan/:id" element={<ModuleGate id="scan"><ScanPage /></ModuleGate>} />
          <Route path="/stock" element={<ModuleGate id="stock"><StockHome /></ModuleGate>} />
          <Route path="/stock/articles/:id" element={<ModuleGate id="stock"><StockItemPage /></ModuleGate>} />
          <Route path="/stock/emplacements" element={<ModuleGate id="stock"><LocationsPage /></ModuleGate>} />
          <Route path="/booking" element={<ModuleGate id="booking"><BookingHome /></ModuleGate>} />
          <Route path="/booking/ressources" element={<ModuleGate id="booking"><ResourcesPage /></ModuleGate>} />
          <Route path="/maintenance" element={<ModuleGate id="maintenance"><MaintenanceHome /></ModuleGate>} />
          <Route path="/maintenance/interventions/:id" element={<ModuleGate id="maintenance"><TicketPage /></ModuleGate>} />
          <Route path="/maintenance/entretiens" element={<ModuleGate id="maintenance"><MaintenancePlansPage /></ModuleGate>} />
          <Route path="/espace/representations" element={<ModuleGate id="espace"><EspaceShows /></ModuleGate>} />
          <Route path="/cast" element={<ModuleGate id="cast"><CastHome /></ModuleGate>} />
          <Route path="/cast/productions/:id" element={<ModuleGate id="cast"><ProductionPage /></ModuleGate>} />
          <Route path="/cast/disponibilites" element={<ModuleGate id="cast"><UnavailabilityPage /></ModuleGate>} />
          <Route path="/espace/scene" element={<ModuleGate id="espace"><EspaceCast /></ModuleGate>} />
          <Route path="/espace" element={<ModuleGate id="espace"><EspaceHome /></ModuleGate>} />
          <Route path="/espace/profil" element={<ModuleGate id="espace"><EspaceProfile /></ModuleGate>} />
          <Route path="/espace/cotisations" element={<ModuleGate id="espace"><EspaceDues /></ModuleGate>} />
          <Route path="/espace/agenda" element={<ModuleGate id="espace"><EspaceAgenda /></ModuleGate>} />
          <Route path="/espace/reunions" element={<ModuleGate id="espace"><EspaceMeetings /></ModuleGate>} />
          <Route path="/espace/documents" element={<ModuleGate id="espace"><EspaceDocuments /></ModuleGate>} />
          <Route path="/drive" element={<ModuleGate id="drive"><DrivePage /></ModuleGate>} />
          <Route path="/drive/dossier/:id" element={<ModuleGate id="drive"><DrivePage /></ModuleGate>} />
          <Route path="/drive/favoris" element={<ModuleGate id="drive"><DriveFavoritesPage /></ModuleGate>} />
          <Route path="/drive/recents" element={<ModuleGate id="drive"><DriveRecentPage /></ModuleGate>} />
          <Route path="/drive/recherche" element={<ModuleGate id="drive"><DriveSearchPage /></ModuleGate>} />
          <Route path="/drive/corbeille" element={<ModuleGate id="drive"><DriveTrashPage /></ModuleGate>} />
          <Route path="/drive/partages" element={<ModuleGate id="drive"><DriveSharesPage /></ModuleGate>} />
          <Route path="/drive/journal" element={<ModuleGate id="drive"><DriveAccessLogPage /></ModuleGate>} />
          <Route path="/projects" element={<ModuleGate id="projects"><ProjectsPage /></ModuleGate>} />
          <Route path="/projects/modeles" element={<ModuleGate id="projects"><ProjectsPage templates /></ModuleGate>} />
          <Route path="/projects/mes-taches" element={<ModuleGate id="projects"><MyTasksPage /></ModuleGate>} />
          <Route path="/projects/:id" element={<ModuleGate id="projects"><ProjectBoard /></ModuleGate>} />
          <Route path="/admin" element={<ModuleGate id="admin"><AdminHome /></ModuleGate>} />
          <Route path="/admin/modules" element={<ModuleGate id="admin"><ModulesPage /></ModuleGate>} />
          <Route path="/admin/utilisateurs" element={<ModuleGate id="admin"><UsersPage /></ModuleGate>} />
          <Route path="/admin/roles" element={<ModuleGate id="admin"><RolesPage /></ModuleGate>} />
          <Route path="/admin/audit" element={<ModuleGate id="admin"><AuditPage /></ModuleGate>} />
          <Route path="/admin/association" element={<ModuleGate id="admin"><AssociationPage /></ModuleGate>} />

          <Route path="/system" element={<ModuleGate id="system"><HealthPage /></ModuleGate>} />
          <Route path="/system/associations" element={<ModuleGate id="system"><AssociationsPage /></ModuleGate>} />
          <Route path="/system/modules" element={<ModuleGate id="system"><InstanceModulesPage /></ModuleGate>} />
          <Route path="/system/messagerie" element={<ModuleGate id="system"><SmtpPage /></ModuleGate>} />
          <Route path="/system/stockage" element={<ModuleGate id="system"><StoragePage /></ModuleGate>} />
          <Route path="/system/sauvegardes" element={<ModuleGate id="system"><BackupsPage /></ModuleGate>} />
          <Route path="/system/journal" element={<ModuleGate id="system"><AuditPage instance /></ModuleGate>} />

          {MODULES.filter((m) => !DELIVERED.has(m.id)).map((m) => (
            <Route key={m.id} path={`${m.route}/*`} element={<PlannedModulePage id={m.id} />} />
          ))}
          <Route path="*" element={<div className="card"><h1>Page introuvable</h1><p>Cette adresse ne correspond à aucune page de Scenorya.</p></div>} />
        </Route>
      </Routes>
      <PwaPrompt />
    </>
  );
}
