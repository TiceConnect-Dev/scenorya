/**
 * Modèle fourni « Organisation d'un spectacle ». Échéances exprimées en jours
 * par rapport à la date de la première représentation (négatif = avant).
 * Il s'agit d'un contenu de travail modifiable, pas de données de démonstration.
 */
export const SPECTACLE_TEMPLATE: {
  name: string;
  description: string;
  tasks: { title: string; offset: number; labels: string[]; priority?: 'low' | 'normal' | 'high' | 'urgent'; description?: string; checklist?: string[]; subtasks?: string[] }[];
} = {
  name: 'Organisation d’un spectacle',
  description: 'Rétroplanning type, de la décision de création au bilan. Renseignez la date de la première représentation lors de la création du projet.',
  tasks: [
    { title: 'Choisir le texte et vérifier les droits de représentation', offset: -180, labels: ['Artistique', 'Administratif'], priority: 'high', checklist: ['Identifier l’auteur et l’éditeur', 'Demander l’autorisation (SACD ou ayants droit)', 'Conserver l’accord écrit'] },
    { title: 'Établir le budget prévisionnel', offset: -150, labels: ['Finances'], checklist: ['Décors et costumes', 'Location de salle', 'Communication', 'Droits d’auteur', 'Recettes attendues'] },
    { title: 'Réserver la salle de représentation', offset: -150, labels: ['Logistique'], priority: 'high', subtasks: ['Visite technique de la salle', 'Signature de la convention', 'Attestation d’assurance'] },
    { title: 'Distribution des rôles', offset: -120, labels: ['Artistique'], subtasks: ['Lecture collective', 'Auditions', 'Annonce de la distribution'] },
    { title: 'Planifier les répétitions', offset: -120, labels: ['Artistique'], description: 'Créer les répétitions récurrentes dans Scenorya Agenda et inviter la troupe.' },
    { title: 'Concevoir décors et accessoires', offset: -90, labels: ['Technique'] },
    { title: 'Costumes : création, essayages, retouches', offset: -60, labels: ['Costumes'], checklist: ['Liste des costumes par rôle', 'Prise des mesures', 'Premiers essayages', 'Retouches'] },
    { title: 'Plan de communication', offset: -60, labels: ['Communication'], subtasks: ['Affiche', 'Communiqué de presse', 'Réseaux sociaux', 'Diffusion dans les commerces'] },
    { title: 'Ouvrir la billetterie', offset: -45, labels: ['Billetterie'], priority: 'high', checklist: ['Tarifs', 'Jauge', 'Places réservées (PMR, invités)'] },
    { title: 'Fiche technique et conduite son/lumière', offset: -30, labels: ['Technique'] },
    { title: 'Déclarations et autorisations', offset: -30, labels: ['Administratif'], checklist: ['Déclaration SACD', 'Autorisation de buvette si nécessaire', 'Sécurité : capacité et issues de secours'] },
    { title: 'Organiser l’accueil et la buvette', offset: -14, labels: ['Logistique'], subtasks: ['Planning des bénévoles', 'Fond de caisse', 'Approvisionnement'] },
    { title: 'Répétition générale', offset: -2, labels: ['Artistique', 'Technique'], priority: 'urgent' },
    { title: 'Montage technique', offset: -1, labels: ['Technique'], priority: 'urgent' },
    { title: 'Démontage et rangement du matériel', offset: 1, labels: ['Technique', 'Logistique'] },
    { title: 'Bilan financier et artistique', offset: 30, labels: ['Finances'], checklist: ['Recettes et dépenses réelles', 'Fréquentation', 'Retours du public et de la troupe'] },
  ],
};
