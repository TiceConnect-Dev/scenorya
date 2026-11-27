import type { ModuleId } from '@scenorya/shared';

export interface NavItem {
  label: string;
  to: string;
  /** Permission requise pour afficher l'entrée (vérifiée aussi côté serveur). */
  permission?: string;
  superAdmin?: boolean;
  group?: string;
}

/** Navigation secondaire de chaque module livré. Les modules prévus n'ont que leur page d'accueil. */
export const MODULE_NAV: Partial<Record<ModuleId, NavItem[]>> = {
  hub: [{ label: 'Tableau de bord', to: '/hub' }],
  asso: [
    { label: 'Tableau de bord', to: '/asso' },
    { label: 'Adhérents', group: 'Adhérents', to: '/asso/adherents', permission: 'asso.members.read' },
    { label: 'Nouvel adhérent', to: '/asso/adherents/nouveau', permission: 'asso.members.create' },
    { label: 'Importer (CSV)', to: '/asso/import', permission: 'asso.members.import' },
    { label: 'Groupes et commissions', to: '/asso/groupes', permission: 'asso.groups.read' },
    { label: 'Cartes d’adhérent', to: '/asso/cartes', permission: 'asso.members.download' },
    { label: 'Champs personnalisés', to: '/asso/champs', permission: 'asso.fields.admin' },
    { label: 'Cotisations', to: '/asso/cotisations', permission: 'asso.dues.read', group: 'Cotisations' },
    { label: 'Renouvellements', to: '/asso/renouvellements', permission: 'asso.dues.read', group: 'Cotisations' },
    { label: 'Formules', to: '/asso/formules', permission: 'asso.plans.read', group: 'Cotisations' },
  ],
  admin: [
    { label: "Vue d'ensemble", to: '/admin' },
    { label: 'Modules et fonctionnalités', to: '/admin/modules', permission: 'admin.modules.read', group: 'Plateforme' },
    { label: 'Association', to: '/admin/association', permission: 'admin.association.read', group: 'Plateforme' },
    { label: 'Utilisateurs', to: '/admin/utilisateurs', permission: 'admin.users.read', group: 'Accès' },
    { label: 'Rôles et permissions', to: '/admin/roles', permission: 'admin.roles.read', group: 'Accès' },
    { label: "Journal d'audit", to: '/admin/audit', permission: 'admin.audit.read', group: 'Traçabilité' },
  ],
  system: [
    { label: 'Santé technique', to: '/system', superAdmin: true },
    { label: 'Associations', to: '/system/associations', superAdmin: true },
    { label: "Modules de l'instance", to: '/system/modules', superAdmin: true },
    { label: 'Messagerie (SMTP)', to: '/system/messagerie', superAdmin: true },
    { label: 'Sauvegardes', to: '/system/sauvegardes', superAdmin: true },
    { label: "Journal de l'instance", to: '/system/journal', superAdmin: true },
  ],
};
