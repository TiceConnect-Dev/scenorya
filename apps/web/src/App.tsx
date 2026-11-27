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
import { AssociationsPage, BackupsPage, HealthPage, InstanceModulesPage, SmtpPage } from './pages/system/System';
import { AssoHome, MemberDetail, MemberForm, MembersImport, MembersList } from './pages/asso/Asso';
import { DuesPage, PlansPage, RenewalsPage } from './pages/asso/Dues';
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

/** Modules livrés : routes dédiées. Modules prévus : page d'accueil honnête du module. */
const DELIVERED = new Set(['hub', 'asso', 'admin', 'system']);

export function App() {
  return (
    <>
      <Routes>
        <Route path="/installation" element={<SetupPage />} />
        <Route path="/connexion" element={<LoginPage />} />
        <Route path="/mot-de-passe" element={<ChangePasswordPage />} />
        <Route path="/verifier/carte/:token" element={<VerifyCardPage />} />
        <Route element={<RequireAuth><Shell /></RequireAuth>}>
          <Route index element={<Navigate to="/hub" replace />} />
          <Route path="/hub" element={<HubPage />} />
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
