import { MODULES, ModuleId } from './modules';

/**
 * Catalogue des permissions.
 * Format : `<module>.<ressource>.<action>` ; la permission d'entrée d'un module
 * est `<module>.read` (issue de modules.json).
 *
 * Scenorya System agit au niveau de l'instance : ses routes sont réservées aux
 * superadministrateurs et ne relèvent pas des rôles d'association.
 *
 * Seules les permissions correspondant à des fonctionnalités réellement
 * implémentées sont déclarées en détail ; les modules prévus n'exposent que
 * leur permission d'entrée. Le catalogue est étendu à chaque module livré.
 */

export const PERMISSION_ACTIONS = {
  read: 'Consulter',
  create: 'Créer',
  update: 'Modifier',
  delete: 'Supprimer',
  archive: 'Archiver',
  restore: 'Restaurer',
  import: 'Importer',
  export: 'Exporter',
  download: 'Télécharger',
  validate: 'Valider',
  publish: 'Publier',
  cancel: 'Annuler',
  refund: 'Rembourser',
  admin: 'Administrer',
  sensitive: 'Consulter les données sensibles',
  history: "Consulter l'historique",
} as const;

export type PermissionAction = keyof typeof PERMISSION_ACTIONS;

export interface PermissionResource {
  module: ModuleId;
  resource: string;
  label: string;
  actions: PermissionAction[];
}

export const PERMISSION_RESOURCES: PermissionResource[] = [
  { module: 'admin', resource: 'users', label: 'Utilisateurs', actions: ['read', 'create', 'update', 'archive', 'restore'] },
  { module: 'admin', resource: 'roles', label: 'Rôles et permissions', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'admin', resource: 'modules', label: 'Modules et fonctionnalités', actions: ['read', 'admin'] },
  { module: 'admin', resource: 'audit', label: "Journal d'audit", actions: ['read', 'export'] },
  { module: 'admin', resource: 'association', label: "Fiche de l'association", actions: ['read', 'update', 'sensitive'] },
  {
    module: 'asso', resource: 'members', label: 'Adhérents',
    // download : cartes d'adhérent (PDF)
    actions: ['read', 'create', 'update', 'archive', 'restore', 'import', 'export', 'download', 'sensitive', 'history'],
  },
  { module: 'asso', resource: 'groups', label: 'Groupes et commissions', actions: ['read', 'create', 'update', 'archive'] },
  { module: 'asso', resource: 'fields', label: 'Champs personnalisés', actions: ['read', 'admin'] },
  { module: 'agenda', resource: 'events', label: 'Événements', actions: ['read', 'create', 'update', 'delete', 'export'] },
  { module: 'asso', resource: 'plans', label: 'Formules de cotisation', actions: ['read', 'create', 'update', 'archive'] },
  {
    module: 'asso', resource: 'dues', label: 'Cotisations et règlements',
    // validate : enregistrer un règlement ou exonérer ; cancel : annuler une cotisation ou un règlement
    actions: ['read', 'create', 'validate', 'cancel', 'export', 'download'],
  },
];

export interface PermissionEntry {
  key: string;
  module: ModuleId;
  resource: string | null;
  action: PermissionAction | 'read';
  label: string;
}

export const PERMISSIONS: PermissionEntry[] = [
  ...MODULES.map((m) => ({
    key: m.permission,
    module: m.id,
    resource: null,
    action: 'read' as const,
    label: `Accéder à ${m.name}`,
  })),
  ...PERMISSION_RESOURCES.flatMap((r) =>
    r.actions.map((a) => ({
      key: `${r.module}.${r.resource}.${a}`,
      module: r.module,
      resource: r.resource,
      action: a,
      label: `${r.label} — ${PERMISSION_ACTIONS[a]}`,
    })),
  ),
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

/** Une permission accordée est valide si elle est dans le catalogue ou est un joker reconnu. */
export function isValidGrant(grant: string): boolean {
  if (grant === '*') return true;
  if (grant.endsWith('.*')) {
    const prefix = grant.slice(0, -2);
    return PERMISSIONS.some((p) => p.key === prefix || p.key.startsWith(prefix + '.'));
  }
  return PERMISSION_KEYS.has(grant);
}

/** Vérifie qu'une liste de permissions accordées couvre la permission demandée (jokers acceptés). */
export function grantsCover(granted: Iterable<string>, required: string): boolean {
  for (const g of granted) {
    if (g === '*' || g === required) return true;
    if (g.endsWith('.*')) {
      const prefix = g.slice(0, -1); // garde le point final
      if (required.startsWith(prefix) || required === prefix.slice(0, -1)) return true;
    }
  }
  return false;
}

/** Un utilisateur voit un module s'il possède au moins une permission de ce module. */
export function canSeeModule(granted: Iterable<string>, module: ModuleId): boolean {
  const list = [...granted];
  if (grantsCover(list, `${module}.read`)) return true;
  return list.some((g) => g.startsWith(`${module}.`));
}

/** Modèles de rôles prédéfinis, recopiés dans chaque nouvelle association (modifiables). */
export const ROLE_TEMPLATES: { key: string; name: string; description: string; permissions: string[] }[] = [
  { key: 'admin', name: 'Administrateur associatif', description: "Tous les droits sur l'association.", permissions: ['*'] },
  {
    key: 'president', name: 'Président', description: 'Pilotage général, consultation étendue.',
    permissions: ['hub.read', 'asso.*', 'admin.read', 'admin.users.read', 'admin.roles.read', 'admin.modules.read', 'admin.audit.read', 'admin.association.read', 'admin.association.update', 'show.read', 'finance.read', 'agenda.read', 'agenda.events.read', 'drive.read', 'analytics.read'],
  },
  {
    key: 'vice_president', name: 'Vice-président', description: 'Suppléance de la présidence.',
    permissions: ['hub.read', 'asso.read', 'asso.members.read', 'asso.members.export', 'admin.read', 'admin.association.read', 'show.read', 'agenda.read', 'agenda.events.read', 'drive.read'],
  },
  {
    key: 'tresorier', name: 'Trésorier', description: 'Finances, factures et cotisations.',
    permissions: ['hub.read', 'finance.read', 'factures.read', 'pos.read', 'tickets.read', 'analytics.read', 'asso.read', 'asso.members.read', 'asso.members.export', 'asso.dues.*', 'asso.plans.*', 'admin.read', 'admin.association.read', 'admin.association.sensitive'],
  },
  {
    key: 'secretaire', name: 'Secrétaire', description: 'Adhérents, gouvernance et documents.',
    permissions: ['hub.read', 'asso.*', 'agenda.*', 'drive.read', 'com.read', 'admin.read', 'admin.association.read', 'admin.association.update'],
  },
  { key: 'regisseur', name: 'Régisseur général', description: 'Régie, matériel et spectacles.', permissions: ['hub.read', 'regie.read', 'show.read', 'stock.read', 'booking.read', 'maintenance.read', 'agenda.read', 'agenda.events.read', 'drive.read'] },
  { key: 'tech_son', name: 'Technicien son', description: 'Vue son de la régie.', permissions: ['hub.read', 'regie.read', 'stock.read', 'agenda.read', 'agenda.events.read'] },
  { key: 'tech_lumiere', name: 'Technicien lumière', description: 'Vue lumière de la régie.', permissions: ['hub.read', 'regie.read', 'stock.read', 'agenda.read', 'agenda.events.read'] },
  { key: 'tech_video', name: 'Technicien vidéo', description: 'Vue vidéo de la régie.', permissions: ['hub.read', 'regie.read', 'stock.read', 'agenda.read', 'agenda.events.read'] },
  { key: 'resp_materiel', name: 'Responsable matériel', description: 'Parc matériel, prêts et maintenance.', permissions: ['hub.read', 'stock.read', 'booking.read', 'maintenance.read', 'agenda.read', 'agenda.events.read'] },
  { key: 'resp_billetterie', name: 'Responsable billetterie', description: 'Billetterie et contrôle.', permissions: ['hub.read', 'tickets.read', 'scan.read', 'pos.read', 'show.read', 'analytics.read'] },
  { key: 'controleur', name: 'Contrôleur de billets', description: 'Contrôle des entrées uniquement.', permissions: ['scan.read'] },
  { key: 'caissier', name: 'Caissier', description: 'Caisse tactile.', permissions: ['pos.read'] },
  { key: 'resp_com', name: 'Responsable communication', description: 'Communication et site.', permissions: ['hub.read', 'com.read', 'web.read', 'drive.read', 'agenda.read', 'agenda.events.read'] },
  { key: 'webmaster', name: 'Webmaster', description: 'Sites internet.', permissions: ['hub.read', 'web.read', 'drive.read'] },
  { key: 'metteur_en_scene', name: 'Metteur en scène', description: 'Spectacles, distributions, régie.', permissions: ['hub.read', 'show.read', 'cast.read', 'regie.read', 'agenda.read', 'agenda.events.read', 'drive.read', 'projects.read'] },
  { key: 'comedien', name: 'Comédien', description: 'Espace personnel et planning.', permissions: ['espace.read', 'agenda.read', 'agenda.events.read'] },
  { key: 'benevole', name: 'Bénévole', description: 'Espace personnel et planning.', permissions: ['espace.read', 'agenda.read', 'agenda.events.read'] },
  { key: 'adherent', name: 'Adhérent', description: 'Espace personnel.', permissions: ['espace.read'] },
];
