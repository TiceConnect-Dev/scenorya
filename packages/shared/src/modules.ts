/**
 * Registre central des modules Scenorya.
 *
 * Source : branding/modules.json (pack graphique officiel), enrichi des
 * métadonnées nécessaires au système modulaire : catégorie, dépendances
 * strictes, intégrations facultatives, fonctionnalités conditionnelles et
 * état d'implémentation réel.
 *
 * Ce fichier est la SEULE source de vérité pour l'identité et les règles des
 * modules ; le serveur et le client l'importent tous deux.
 */

export const MODULE_IDS = [
  'hub', 'asso', 'cast', 'show', 'regie', 'tickets', 'scan', 'pos', 'finance', 'factures',
  'stock', 'booking', 'maintenance', 'agenda', 'drive', 'web', 'com', 'projects', 'espace',
  'analytics', 'admin', 'system',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export type ModuleCategory =
  | 'socle'
  | 'association'
  | 'artistique'
  | 'billetterie'
  | 'finance'
  | 'logistique'
  | 'collaboration'
  | 'publication';

export const MODULE_CATEGORIES: Record<ModuleCategory, string> = {
  socle: 'Socle',
  association: 'Vie associative',
  artistique: 'Création et scène',
  billetterie: 'Billetterie et ventes',
  finance: 'Finance et facturation',
  logistique: 'Matériel et logistique',
  collaboration: 'Organisation et documents',
  publication: 'Publication et communication',
};

export interface ModuleFeature {
  id: string;
  label: string;
  /** Modules devant être utilisables pour que la fonctionnalité soit disponible. */
  requires: ModuleId[];
}

export type ImplementationStatus = 'available' | 'partial' | 'planned';

export interface ModuleDefinition {
  id: ModuleId;
  name: string;
  shortName: string;
  /** Description courte issue de modules.json. */
  tagline: string;
  /** Description complète (présentation officielle). */
  description: string;
  color: string;
  /**
   * Fichiers servis à l'interface. Les PNG (logo, logoDark, icon) sont les
   * variantes recadrées de branding/derived/ (marges transparentes retirées,
   * dessin inchangé) ; `source` pointe vers les fichiers d'origine du pack.
   */
  assets: {
    logo: string;
    logoDark: string;
    icon: string;
    flat: string;
    outline: string;
    source: { logo: string; logoDark: string; icon: string };
  };
  route: string;
  /** Permission d'entrée issue de modules.json (accès au tableau de bord du module). */
  permission: string;
  /** Module de socle : toujours actif, accès soumis aux droits. */
  core: boolean;
  category: ModuleCategory;
  /** Dépendances strictes : le module ne fonctionne pas sans elles. */
  requires: ModuleId[];
  /** Intégrations facultatives : enrichissent le module si présentes. */
  integrations: ModuleId[];
  /** Fonctionnalités conditionnées à d'autres modules. */
  features: ModuleFeature[];
  implementation: { status: ImplementationStatus; phase: number; note: string };
}

const asset = (id: ModuleId) => ({
  logo: `/branding/derived/modules/${id}/logo.png`,
  logoDark: `/branding/derived/modules/${id}/logo-dark.png`,
  icon: `/branding/derived/modules/${id}/icon.png`,
  flat: `/branding/modules/${id}/flat.svg`,
  outline: `/branding/modules/${id}/outline.svg`,
  source: {
    logo: `/branding/modules/${id}/logo.png`,
    logoDark: `/branding/modules/${id}/logo-dark.png`,
    icon: `/branding/modules/${id}/icon.png`,
  },
});

type Def = Omit<ModuleDefinition, 'assets' | 'route' | 'permission' | 'name'> & { name?: string };

const defs: Def[] = [
  {
    id: 'hub', shortName: 'Hub', tagline: 'Tableau de bord', color: '#1765AD', core: true, category: 'socle',
    description: "Tableau de bord central et pilotage de l'association",
    requires: [], integrations: ['asso', 'show', 'tickets', 'finance', 'stock', 'agenda', 'projects'], features: [],
    implementation: { status: 'partial', phase: 1, note: 'Indicateurs du socle et des adhérents ; widgets personnalisables prévus en phase 8.' },
  },
  {
    id: 'asso', shortName: 'Asso', tagline: 'Adhérents et gouvernance', color: '#008780', core: false, category: 'association',
    description: 'Adhérents, cotisations, bénévoles et gouvernance',
    requires: [], integrations: ['finance', 'com', 'espace', 'agenda'],
    features: [
      { id: 'asso.membershipPayments', label: 'Écritures comptables des cotisations', requires: ['finance'] },
      { id: 'asso.governanceAgenda', label: 'Réunions des instances inscrites à l’agenda', requires: ['agenda'] },
    ],
    implementation: { status: 'partial', phase: 2, note: 'Fichier des adhérents opérationnel ; cotisations et gouvernance en phase 2.' },
  },
  {
    id: 'cast', shortName: 'Cast', tagline: 'Comédiens et équipes', color: '#D64B3F', core: false, category: 'artistique',
    description: 'Comédiens, distributions et équipes artistiques',
    requires: [], integrations: ['asso', 'show', 'agenda', 'espace'],
    features: [
      { id: 'cast.agendaCalls', label: 'Convocations de répétition dans l’agenda', requires: ['agenda'] },
      { id: 'cast.espace', label: 'Rôles, répétitions et indisponibilités dans l’espace des comédiens', requires: ['espace'] },
      { id: 'cast.distributions', label: 'Distributions rattachées aux spectacles de Show', requires: ['show'] },
    ],
    implementation: { status: 'partial', phase: 2, note: 'Productions, rôles, distribution (titulaires et doublures), scènes et présence des personnages, indisponibilités, répétitions avec convocations calculées et conflits, feuille de service PDF. Rattachement aux spectacles avec Show.' },
  },
  {
    id: 'show', shortName: 'Show', tagline: 'Spectacles et productions', color: '#7539B2', core: false, category: 'artistique',
    description: 'Spectacles, productions et représentations',
    requires: [], integrations: ['cast', 'tickets', 'regie', 'stock', 'finance', 'agenda', 'drive'],
    features: [
      { id: 'show.agenda', label: 'Représentations dans l’agenda (équipe et distribution convoquées)', requires: ['agenda'] },
      { id: 'show.attachments', label: 'Documents du spectacle (fiche technique, affiche…) dans Drive', requires: ['drive'] },
    ],
    implementation: { status: 'partial', phase: 4, note: 'Spectacles, représentations, lieux, équipe, rattachement des distributions de Cast, agenda, documents, fiche spectacle PDF. Billetterie avec Tickets, conduite avec Régie.' },
  },
  {
    id: 'regie', name: 'Scenorya Régie', shortName: 'Régie', tagline: 'Conduite technique', color: '#1266B2', core: false, category: 'artistique',
    description: 'Conduite de spectacle, son, lumière et vidéo',
    // Les conduites sont rattachées au service d'événements partagé du socle :
    // une représentation (Show) ou un événement autonome. Pas de dépendance stricte à Show.
    requires: [], integrations: ['show', 'cast', 'stock', 'drive'],
    features: [
      { id: 'regie.showLink', label: 'Rattachement aux spectacles et représentations de Show', requires: ['show'] },
      { id: 'regie.cart', label: 'Cartoucheur (sons stockés dans Drive)', requires: ['drive'] },
    ],
    implementation: { status: 'partial', phase: 4, note: 'Conduites (tops par service), modes édition / répétition / spectacle, conduite en direct synchronisée, cartoucheur, journal horodaté et rapport, fonctionnement hors connexion, PDF. Matériel avec Stock.' },
  },
  {
    id: 'tickets', shortName: 'Tickets', tagline: 'Billetterie', color: '#C77A08', core: false, category: 'billetterie',
    description: 'Billetterie, réservations et billets électroniques',
    // Billetterie généraliste : vend des événements autonomes du socle, Show facultatif.
    requires: [], integrations: ['show', 'finance', 'com', 'espace', 'web'],
    features: [
      { id: 'tickets.showEvents', label: 'Vente des représentations de Show', requires: ['show'] },
      { id: 'tickets.accounting', label: 'Écritures comptables des ventes', requires: ['finance'] },
    ],
    implementation: { status: 'available', phase: 5, note: 'Séances (autonomes ou représentations de Show), tarifs et quotas, jauge, vente au guichet, réservation en ligne, billets QR (PDF et lien), annulations, statistiques, exports.' },
  },
  {
    id: 'scan', shortName: 'Scan', tagline: 'Contrôle des billets', color: '#00845D', core: false, category: 'billetterie',
    description: 'Contrôle des billets sur smartphone',
    requires: ['tickets'], integrations: [], features: [],
    implementation: { status: 'available', phase: 5, note: 'Lecture des QR codes à la caméra ou saisie du code, refus des doublons, annulation d’une entrée, compteur en direct, fonctionnement hors connexion.' },
  },
  {
    id: 'pos', shortName: 'POS', tagline: 'Caisse tactile', color: '#B52668', core: false, category: 'billetterie',
    description: 'Caisse tactile, buvette et ventes sur place',
    requires: [], integrations: ['tickets', 'stock', 'finance'],
    features: [
      { id: 'pos.ticketSales', label: 'Vente de billets en caisse', requires: ['tickets'] },
      { id: 'pos.stockSync', label: 'Décrément des stocks en temps réel', requires: ['stock'] },
      { id: 'pos.accounting', label: 'Export comptable des clôtures', requires: ['finance'] },
    ],
    implementation: { status: 'planned', phase: 5, note: 'Prévu en phase 5.' },
  },
  {
    id: 'finance', shortName: 'Finance', tagline: 'Comptabilité', color: '#238143', core: false, category: 'finance',
    description: 'Comptabilité, budgets et trésorerie',
    requires: [], integrations: ['factures', 'pos', 'tickets', 'asso'], features: [],
    implementation: { status: 'planned', phase: 6, note: 'Prévu en phase 6.' },
  },
  {
    id: 'factures', shortName: 'Factures', tagline: 'Facturation', color: '#1469B3', core: false, category: 'finance',
    description: 'Devis, factures, justificatifs et notes de frais',
    requires: [], integrations: ['finance'],
    features: [{ id: 'factures.accounting', label: 'Génération des écritures comptables', requires: ['finance'] }],
    implementation: { status: 'planned', phase: 6, note: 'Prévu en phase 6.' },
  },
  {
    id: 'stock', shortName: 'Stock', tagline: 'Matériel et stocks', color: '#896027', core: false, category: 'logistique',
    description: 'Matériel, inventaires et consommables',
    requires: [], integrations: ['booking', 'maintenance', 'pos', 'regie'], features: [],
    implementation: { status: 'available', phase: 3, note: 'Articles (matériel et consommables), emplacements, mouvements et inventaire, seuils d’alerte, étiquettes QR, export CSV.' },
  },
  {
    id: 'booking', shortName: 'Booking', tagline: 'Réservations et prêts', color: '#783CA7', core: false, category: 'logistique',
    description: 'Réservations de matériel, prêts et salles',
    // La réservation de salles fonctionne seule ; les prêts de matériel exigent Stock.
    requires: [], integrations: ['stock', 'agenda'],
    features: [
      { id: 'booking.equipmentLoans', label: 'Prêts et réservations de matériel', requires: ['stock'] },
      { id: 'booking.agenda', label: 'Réservations de salles dans l’agenda', requires: ['agenda'] },
    ],
    implementation: { status: 'available', phase: 3, note: 'Salles et ressources, réservations sans double réservation, validation, prêts de matériel avec disponibilité, sortie et retour, agenda.' },
  },
  {
    id: 'maintenance', shortName: 'Maintenance', tagline: 'Maintenance', color: '#C63D41', core: false, category: 'logistique',
    description: 'Pannes, réparations et entretien',
    requires: ['stock'], integrations: ['booking'], features: [],
    implementation: { status: 'available', phase: 3, note: 'Signalements de panne, interventions, matériel hors service (retiré des prêts), coûts, entretien préventif périodique.' },
  },
  {
    id: 'agenda', shortName: 'Agenda', tagline: 'Agenda et planning', color: '#1168A9', core: false, category: 'collaboration',
    description: 'Planning, répétitions et événements',
    requires: [], integrations: ['show', 'booking', 'web', 'asso'],
    features: [{ id: 'agenda.memberInvitations', label: 'Invitations des adhérents et des groupes', requires: ['asso'] }],
    implementation: { status: 'partial', phase: 2, note: 'Événements, récurrences, participants, conflits, export et abonnement iCal ; réservation de salles avec Booking (phase 3).' },
  },
  {
    id: 'drive', shortName: 'Drive', tagline: 'Documents', color: '#008A9A', core: false, category: 'collaboration',
    description: 'Stockage documentaire et partage de fichiers',
    requires: [], integrations: ['projects'], features: [],
    implementation: { status: 'available', phase: 2, note: 'Dossiers, versions, corbeille, dossiers restreints par rôle, favoris, étiquettes, recherche, liens de partage protégés, quota, journal des accès, pièces jointes des tâches.' },
  },
  {
    id: 'web', shortName: 'Web', tagline: 'Sites internet', color: '#3B51A9', core: false, category: 'publication',
    description: 'Création et publication de sites internet',
    requires: [], integrations: ['tickets', 'show', 'agenda', 'cast', 'asso'],
    features: [
      { id: 'web.ticketingBlock', label: 'Bloc billetterie', requires: ['tickets'] },
      { id: 'web.showsBlock', label: 'Cartes de spectacles', requires: ['show'] },
      { id: 'web.agendaBlock', label: 'Bloc agenda', requires: ['agenda'] },
      { id: 'web.castBlock', label: 'Présentation des comédiens', requires: ['cast'] },
      { id: 'web.membershipBlock', label: "Appel à adhésion", requires: ['asso'] },
    ],
    implementation: { status: 'planned', phase: 7, note: 'Prévu en phase 7.' },
  },
  {
    id: 'com', shortName: 'Com', tagline: 'Communication', color: '#B52D70', core: false, category: 'publication',
    description: 'Communication, newsletters et notifications',
    requires: [], integrations: ['asso', 'tickets'], features: [],
    implementation: { status: 'planned', phase: 7, note: 'Prévu en phase 7.' },
  },
  {
    id: 'projects', shortName: 'Projects', tagline: 'Projets et tâches', color: '#8140B5', core: false, category: 'collaboration',
    description: 'Gestion des projets et des tâches',
    requires: [], integrations: ['show', 'agenda', 'drive'],
    features: [{ id: 'projects.attachments', label: 'Pièces jointes des tâches (stockées dans Drive)', requires: ['drive'] }],
    implementation: { status: 'partial', phase: 2, note: 'Projets, Kanban, sous-tâches, checklists, commentaires, modèles, pièces jointes avec Drive ; vues calendrier et chronologique à venir.' },
  },
  {
    id: 'espace', shortName: 'Espace', tagline: 'Espace personnel', color: '#00899B', core: false, category: 'association',
    description: 'Espace personnel des membres et spectateurs',
    requires: [], integrations: ['asso', 'tickets', 'agenda', 'cast', 'drive'], features: [],
    implementation: { status: 'partial', phase: 2, note: 'Espace des adhérents : invitation, coordonnées, cotisations et reçus, carte, agenda avec réponse, convocations et procès-verbaux, documents publiés depuis Drive. Espace spectateurs (billets) avec Tickets.' },
  },
  {
    id: 'analytics', shortName: 'Analytics', tagline: 'Statistiques', color: '#C65D11', core: false, category: 'collaboration',
    description: 'Statistiques, rapports et indicateurs',
    requires: [], integrations: ['tickets', 'finance', 'asso', 'stock', 'pos'], features: [],
    implementation: { status: 'planned', phase: 8, note: 'Prévu en phase 8.' },
  },
  {
    id: 'admin', shortName: 'Admin', tagline: 'Permissions et sécurité', color: '#184C87', core: true, category: 'socle',
    description: 'Utilisateurs, permissions et sécurité',
    requires: [], integrations: [], features: [],
    implementation: { status: 'available', phase: 1, note: 'Utilisateurs, rôles, matrice des permissions, modules, journal d’audit, association.' },
  },
  {
    id: 'system', shortName: 'System', tagline: 'Configuration et serveur', color: '#526C85', core: true, category: 'socle',
    description: 'Configuration, sauvegardes et santé du serveur',
    requires: [], integrations: [], features: [],
    implementation: { status: 'partial', phase: 1, note: 'Associations, modules de l’instance, santé technique, SMTP, sauvegardes de la base.' },
  },
];

export const MODULES: ModuleDefinition[] = defs.map((d) => ({
  ...d,
  name: d.name ?? `Scenorya ${d.shortName}`,
  assets: asset(d.id),
  route: `/${d.id}`,
  permission: `${d.id}.read`,
}));

export const MODULES_BY_ID: Record<ModuleId, ModuleDefinition> = Object.fromEntries(
  MODULES.map((m) => [m.id, m]),
) as Record<ModuleId, ModuleDefinition>;

export const CORE_MODULES: ModuleId[] = MODULES.filter((m) => m.core).map((m) => m.id);

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === 'string' && (MODULE_IDS as readonly string[]).includes(value);
}

/** Profils de départ : simples présélections modifiables (hors modules de socle). */
export const MODULE_PROFILES: { id: string; label: string; description: string; modules: ModuleId[] }[] = [
  {
    id: 'simple', label: 'Association simple',
    description: 'Adhérents, comptabilité, documents, site internet et communication.',
    modules: ['asso', 'finance', 'factures', 'agenda', 'drive', 'web', 'com', 'espace'],
  },
  {
    id: 'theatre', label: 'Compagnie de théâtre',
    description: 'Spectacles, comédiens, régie, billetterie et contrôle des entrées.',
    modules: ['asso', 'cast', 'show', 'regie', 'tickets', 'scan', 'agenda', 'drive', 'web', 'com', 'projects', 'espace', 'stock'],
  },
  {
    id: 'evenementiel', label: 'Association événementielle',
    description: 'Matériel, prêts, maintenance, caisse, billetterie et planning.',
    modules: ['stock', 'booking', 'maintenance', 'pos', 'tickets', 'scan', 'agenda', 'finance', 'projects', 'com'],
  },
  { id: 'personnalise', label: 'Personnalisé', description: 'Choisissez vous-même chaque module.', modules: [] },
];
