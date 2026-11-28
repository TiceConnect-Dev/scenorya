import type { ModuleId } from '@scenorya/shared';

export interface NavItem {
  label: string;
  to: string;
  /** Permission requise pour afficher l'entrée (vérifiée aussi côté serveur). */
  permission?: string;
  superAdmin?: boolean;
  /** Fonctionnalité conditionnelle requise (ex. cast.espace). */
  feature?: string;
  /** Module qui doit être utilisable (actif ou en lecture seule). */
  module?: string;
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
    { label: 'Instances et AG', to: '/asso/instances', permission: 'asso.meetings.read', group: 'Gouvernance' },
    { label: 'Mandats', to: '/asso/mandats', permission: 'asso.mandates.read', group: 'Gouvernance' },
  ],
  agenda: [{ label: 'Planning', to: '/agenda' }],
  espace: [
    { label: 'Accueil', to: '/espace', permission: 'espace.read' },
    { label: 'Mes coordonnées', to: '/espace/profil', permission: 'espace.read' },
    { label: 'Mes cotisations', to: '/espace/cotisations', permission: 'espace.read' },
    { label: 'Mon agenda', to: '/espace/agenda', permission: 'espace.read' },
    { label: 'Assemblées et réunions', to: '/espace/reunions', permission: 'espace.read' },
    { label: 'Documents', to: '/espace/documents', permission: 'espace.read' },
    { label: 'Mes rôles et répétitions', to: '/espace/scene', permission: 'espace.read', feature: 'cast.espace' },
    { label: 'Mes représentations', to: '/espace/representations', permission: 'espace.read', module: 'show' },
  ],
  stock: [
    { label: 'Inventaire', to: '/stock', permission: 'stock.items.read' },
    { label: 'Emplacements', to: '/stock/emplacements', permission: 'stock.locations.read' },
  ],
  booking: [
    { label: 'Réservations', to: '/booking', permission: 'booking.bookings.read' },
    { label: 'Ressources', to: '/booking/ressources', permission: 'booking.resources.read' },
  ],
  tickets: [
    { label: 'Séances', to: '/tickets', permission: 'tickets.events.read' },
  ],
  pos: [
    { label: 'Caisses', to: '/pos', permission: 'pos.catalog.read' },
    { label: 'Historique', to: '/pos/sessions', permission: 'pos.sessions.read' },
    { label: 'Caisses et produits', to: '/pos/catalogue', permission: 'pos.catalog.update' },
  ],
  scan: [
    { label: 'Contrôle des entrées', to: '/scan', permission: 'scan.entries.read' },
  ],
  maintenance: [
    { label: 'Interventions', to: '/maintenance', permission: 'maintenance.tickets.read' },
    { label: 'Entretien préventif', to: '/maintenance/entretiens', permission: 'maintenance.plans.read' },
  ],
  regie: [
    { label: 'Conduites', to: '/regie', permission: 'regie.cuesheets.read' },
  ],
  show: [
    { label: 'Spectacles', to: '/show', permission: 'show.shows.read' },
    { label: 'Représentations', to: '/show/representations', permission: 'show.performances.read' },
    { label: 'Lieux', to: '/show/lieux', permission: 'show.venues.read' },
  ],
  cast: [
    { label: 'Productions', to: '/cast', permission: 'cast.productions.read' },
    { label: 'Indisponibilités', to: '/cast/disponibilites', permission: 'cast.availability.read' },
  ],
  drive: [
    { label: 'Documents', to: '/drive', permission: 'drive.files.read' },
    { label: 'Récents', to: '/drive/recents', permission: 'drive.files.read' },
    { label: 'Favoris', to: '/drive/favoris', permission: 'drive.files.read' },
    { label: 'Recherche', to: '/drive/recherche', permission: 'drive.files.read' },
    { label: 'Liens de partage', to: '/drive/partages', permission: 'drive.files.publish' },
    { label: 'Corbeille', to: '/drive/corbeille', permission: 'drive.files.read' },
    { label: 'Journal des accès', to: '/drive/journal', permission: 'drive.files.admin' },
  ],
  projects: [
    { label: 'Projets', to: '/projects', permission: 'projects.projects.read' },
    { label: 'Mes tâches', to: '/projects/mes-taches', permission: 'projects.tasks.read' },
    { label: 'Modèles', to: '/projects/modeles', permission: 'projects.projects.read' },
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
    { label: 'Stockage', to: '/system/stockage', superAdmin: true },
    { label: 'Sauvegardes', to: '/system/sauvegardes', superAdmin: true },
    { label: "Journal de l'instance", to: '/system/journal', superAdmin: true },
  ],
};
