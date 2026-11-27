# Journal des modifications

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) — versionnage sémantique.

## [0.12.0] — 2026-11-28

### Ajouté — Scenorya Régie

- Conduites rattachées ou non à un spectacle : tops par service (lumière, son, vidéo, plateau, cintres, autre), déclenchement, page, durée, notes ; insertion, réordonnancement, renumérotation automatique ; conduite figée ; copie de travail ; PDF par service.
- Conduite en direct : GO, retour, saut, « attention » sur le top suivant, notes au journal ; synchronisation instantanée de tous les postes (Socket.IO) ; filtre par service ; raccourcis clavier.
- Modes : répétition, ou représentation (conduite verrouillée pendant la séance) ; une seule séance ouverte par conduite.
- Cartoucheur (avec Drive) : sons rangés dans Drive, touches de lancement, volume, boucle, fondus, lancement automatique avec un top, « tout couper ».
- Hors connexion : la conduite reste affichée (copie locale), les actions sont appliquées localement puis rejouées avec leur heure d’origine.
- Journal horodaté, rapport de séance, rapport PDF ; historique des séances.
- Suppression de tout (top, son, séance et journal, conduite).
- Permissions `regie.cuesheets` et `regie.runs` (nouvelle action `operate`) ; modèles « Régisseur général » et techniciens mis à jour.

## [0.11.0] — 2026-11-27

### Ajouté — Scenorya Show

- Spectacles (auteur, mise en scène, genre, durée, entracte, âge conseillé, présentation, état).
- Représentations : ajout de plusieurs dates d’un coup, fin calculée d’après la durée et l’entracte, heure d’accueil du public, jauge (celle du lieu par défaut), états prévue / confirmée / jouée / annulée ; déplacer une date conserve la durée.
- Lieux de représentation (adresse, jauge, accessibilité).
- Équipe du spectacle par fonction.
- Distributions de Scenorya Cast rattachées au spectacle (fonctionnalité `cast.distributions`).
- Avec Agenda : un événement par représentation, équipe et titulaires convoqués, réponses visibles par date ; resynchronisé quand l’équipe ou la distribution change (y compris depuis Cast) ; annuler une date annule son événement.
- Avec Drive : documents du spectacle (fiche technique, affiche…).
- Fiche spectacle en PDF ; calendrier de toutes les représentations.
- Espace personnel : *Mes représentations*.
- Suppression de tout (équipe, rattachement, représentation et son événement, lieu, spectacle).
- Permissions `show.shows`, `show.performances`, `show.venues` ; modèles de rôles mis à jour.

### Corrigé

- Formulaire de dates : le bouton de retrait d’une date s’affichait sous le champ.

## [0.10.0] — 2026-11-27

### Ajouté — Scenorya Cast

- Productions (titre, auteur, saison, état, première) ; rôles par catégorie ; distribution avec titulaires et doublures, pressentis ou confirmés.
- Scènes (acte, numéro, titre) et grille de présence des personnages.
- Répétitions : convoqués calculés à partir des scènes travaillées (filage = toute la pièce), doublures en option, aperçu en direct avec conflits (indisponibilités, autres répétitions, agenda).
- Avec Scenorya Agenda : événement de répétition et convocations synchronisés, réponses des comédiens visibles dans la répétition ; mise à jour automatique quand la distribution ou les scènes changent.
- Indisponibilités des comédiens, saisies par la mise en scène ou déclarées dans l’espace personnel.
- PDF : distribution (rôles, titulaires, doublures, présence par scène) et feuille de service d’une répétition.
- Espace du comédien : *Mes rôles et répétitions* (rôles, prochaines répétitions avec scènes, indisponibilités).
- Permissions `cast.productions`, `cast.rehearsals`, `cast.availability` ; modèle « Metteur en scène » complété.
- Suppression de tout (rôle, distribution, scène, répétition et son événement, indisponibilité, production).

### Corrigé

- Champs d’heure non stylés (police et hauteur différentes des autres champs).
- PDF : la flèche « → » (absente des polices standard) s’affichait « !' » sur la feuille d’émargement des réunions.
- Navigation : une entrée peut dépendre d’une fonctionnalité conditionnelle.

## [0.9.0] — 2026-11-27

### Ajouté — Suppression de tout ce qui se crée

- Bouton **Supprimer** partout : adhérents, cotisations, formules, groupes, champs personnalisés, réunions (y compris clôturées), mandats, événements d’agenda, projets et modèles, commentaires, utilisateurs, associations (System), sauvegardes, configuration de la messagerie. (Drive, rôles, tâches, délibérations, convoqués et liens de partage l’avaient déjà.)
- Double confirmation quand la suppression a des conséquences importantes : le serveur répond `CONFIRM_REQUIRED` avec le détail (règlements encaissés, numéros de reçus, procès-verbal figé…), l’interface l’affiche et ne force la suppression (`?force=1`) qu’après un second accord.
- Adhérent cité dans un procès-verbal figé : sa fiche est **anonymisée** (nom, coordonnées, champs, notes effacés) et tout le reste supprimé, car il ne peut pas disparaître d’un document déjà clôturé.
- Formule supprimée : les cotisations déjà appelées gardent leur libellé et leur montant. Champ personnalisé supprimé : sa valeur est effacée de toutes les fiches.
- Utilisateur retiré : s’il n’appartient à aucune autre association, son compte est supprimé (identité effacée, sessions fermées).
- Association supprimée (System, saisie du nom exigée) : toutes ses données et ses documents sont effacés ; seuls le journal d’audit et l’historique des modules, en ajout seul, en gardent la trace.
- Événement d’agenda : *Annuler* (conservé) ou *Supprimer* (définitif).
- Nouvelles permissions `delete` (adhérents, cotisations, formules, groupes, réunions, mandats, projets, utilisateurs).

### Corrigé

- Le déclencheur de protection des réunions renvoyait `NEW` lors d’une suppression : toute suppression de réunion était ignorée sans erreur.

### Sécurité

- Les règlements et les réunions clôturées restent **non modifiables**. Leur suppression n’est possible que par une autorisation explicite limitée à la transaction (`scenorya.allow_purge`), après confirmation, et elle est toujours inscrite au journal d’audit, qui reste inaltérable.

## [0.8.0] — 2026-11-27

### Ajouté — Scenorya Espace (adhérents)

- Invitation depuis la fiche d’un adhérent : e-mail (si la messagerie est configurée) ou lien à transmettre, valable 14 jours, usage unique.
- Page publique `/invitation/…` : création du compte (mot de passe choisi par l’adhérent) ou, pour un compte existant, connexion puis acceptation.
- Rattachement d’une fiche à un compte existant de l’association ; retrait de l’accès.
- Espace personnel : accueil (adhésion, validité de la cotisation, groupes, mandats), coordonnées modifiables et journalisées, cotisations et reçus PDF, carte d’adhérent, agenda des six prochains mois avec réponse de présence, assemblées et réunions (convocation, procès-verbal après clôture), documents des dossiers Drive publiés dans l’Espace.
- Drive : option « Publier dans l’Espace des membres » sur un dossier (sous-dossiers compris).

### Modifié

- Après connexion, retour à la page demandée (`?next=`, chemins internes uniquement) ; un compte n’ayant accès qu’à l’Espace arrive directement sur celui-ci au lieu d’un Hub inaccessible.

## [0.7.0] — 2026-11-27

### Ajouté — Scenorya Drive

- Explorateur de documents : dossiers et sous-dossiers, envoi multiple par bouton ou glisser-déposer (avec progression), renommage, déplacement, description, étiquettes.
- Stockage adressé par contenu : un contenu identique n’est stocké qu’une fois (versions, copies), nettoyage automatique des contenus orphelins.
- Versions : nouvelle version par envoi (ou automatiquement pour un document du même nom, au choix), téléchargement et restauration d’une version antérieure.
- Corbeille : un dossier part et revient avec tout son contenu ; restauration sans conflit de nom ; effacement définitif ; vidage automatique après 30 jours.
- Dossiers restreints par rôle (sous-dossiers compris) ; bouton « Créer les espaces recommandés » (Administratif et Comptabilité restreints au bureau).
- Recherche (nom, description, étiquette), nuage d’étiquettes, favoris personnels, documents récents.
- Aperçus sûrs (images, PDF, son, vidéo, texte) ; SVG et HTML toujours téléchargés.
- Liens de partage publics : expiration (1 à 90 jours), mot de passe facultatif, nombre maximal de téléchargements, page publique `/partage/…`, révocation, verrouillage après 10 mauvais mots de passe.
- Quota par association (System → Stockage), taille maximale par fichier (`DRIVE_MAX_UPLOAD_MB`), refus des exécutables même renommés.
- Journal des accès (téléchargements, aperçus, liens publics, mots de passe refusés) ; toutes les modifications sont dans le journal d’audit.
- Nouvelles permissions `drive.files.read/create/update/delete/publish/admin` ; modèles de rôles mis à jour pour les nouvelles associations.
- Analyse d’impact : désactiver Drive signale les liens de partage qui seront suspendus.

### Ajouté — Scenorya Projects

- Pièces jointes des tâches, stockées dans le dossier Drive « Pièces jointes » (fonctionnalité conditionnelle `projects.attachments`).

### Corrigé

- Les champs de saisie sans type explicite (ex. « Nom ») n’étaient pas stylés : hauteur et police différentes de leurs voisins.
- Les en-têtes de colonne « Actions » sont alignés à droite comme leur contenu.
- Documentation Nginx Proxy Manager : `client_max_body_size` relevé à 210 Mo pour les envois de documents.

### Sauvegarde

- Les documents de Drive sont dans le volume de données (`files/`) : à sauvegarder avec la base (procédure dans docs/sauvegarde-restauration.md).

## [0.6.1] — 2026-11-27

### Corrigé

- Formulaires : les champs placés côte à côte sont désormais alignés. L’aide s’affiche sous le champ (et non plus entre l’intitulé et le champ), tous les champs d’une ligne ont la même hauteur (texte, listes, dates, couleur) et les points numérotés de l’ordre du jour sont alignés.

## [0.6.0] — 2026-11-27

Scenorya Asso : gouvernance.

### Ajouté

- Instances : assemblées générales ordinaires et extraordinaires, conseils d’administration, bureaux ; ordre du jour (points soumis au vote), lieu, quorum et limite de procurations selon les statuts.
- Convocation des adhérents actifs, de groupes ou de personnes ; envoi par e-mail (SMTP) avec la convocation PDF et un pouvoir à compléter, suivi de l’envoi par destinataire ; refus explicite si la messagerie n’est pas configurée.
- Présences : présent, représenté (mandataire présent obligatoire, limite de procurations), excusé, absent ; calcul du quorum.
- Délibérations numérotées avec décompte des voix (contrôle : pas plus de voix que de votants) et résultat.
- Compte rendu des débats ; clôture qui fige le procès-verbal (déclencheurs PostgreSQL sur la réunion, les présences et les délibérations).
- PDF : convocation avec pouvoir détachable, feuille d’émargement, procès-verbal signé par la présidence et le secrétariat en exercice.
- Mandats des élus (bureau, CA) avec historique.
- Réunions inscrites automatiquement à l’agenda lorsque Scenorya Agenda est actif (fonctionnalité conditionnelle).

## [0.5.0] — 2026-11-27

Scenorya Projects.

### Ajouté

- Projets avec date de référence, archivage (lecture seule) et restauration.
- Tâches : état, priorité, responsable, échéance, étiquettes, checklist, sous-tâches (un niveau), commentaires.
- Tableau Kanban (À faire, En cours, En attente, Terminé) par glisser-déposer, avec alternative au clavier (sélecteur « Déplacer ») ; vue liste ; filtres par responsable et étiquette ; ajout rapide par colonne.
- « Mes tâches » : tâches attribuées, tous projets confondus ; indicateur dans Scenorya Hub (en retard, cette semaine).
- Droit « responsable » : la personne à qui une tâche est attribuée peut en changer l’état, cocher la checklist et commenter, sans autre droit de modification.
- Modèles de projets avec échéances relatives (J-30, J+1…) ; modèle fourni « Organisation d’un spectacle » (16 étapes, sous-tâches et checklists).
- Rôle Bénévole : consultation des projets et de ses tâches ; rôles Secrétaire et Metteur en scène : gestion complète des projets et de l’agenda.

## [0.4.0] — 2026-11-27

Scenorya Agenda.

### Ajouté

- Événements typés (répétition, représentation, réunion, AG, permanence, échéance, public, maintenance), journée entière, lieu, visibilité interne/publique.
- Récurrences quotidiennes, hebdomadaires (plusieurs jours, toutes les N semaines) et mensuelles, calculées à l’heure de Paris (aucun décalage au changement d’heure), annulation d’une seule date.
- Invitations d’adhérents et de groupes entiers (fonctionnalité conditionnée à Scenorya Asso), réponses des participants (présent, excusé, peut-être), noms visibles seulement avec l’accès aux adhérents.
- Détection des conflits de participants et de lieu, en direct dans le formulaire.
- Vues mois, semaine et liste (liste par défaut sur smartphone), filtre par type.
- Export iCalendar et abonnement personnel pour les applications d’agenda (lien secret révocable, droits réévalués à chaque synchronisation).
- Bloc « Prochains événements » dans Scenorya Hub ; conséquences signalées avant désactivation d’Agenda.

## [0.3.0] — 2026-11-27

Scenorya Asso : groupes, champs personnalisés, cartes d’adhérent.

### Ajouté

- Groupes, commissions, troupes et bureau : composition, fonction de chaque membre, archivage, filtre de la liste des adhérents, impression des cartes d’un groupe.
- Champs personnalisés des fiches (texte, nombre, date, oui/non, liste) : obligatoires, sensibles (masqués sans droit dédié), archivables sans perte de valeurs, inclus dans l’export CSV.
- Cartes d’adhérent au format carte bancaire (unitaire ou planche A4 de 10) avec QR code de vérification : jeton aléatoire sans donnée personnelle, validité calculée en direct d’après les cotisations, révocation en cas de perte.
- Page publique de vérification (`/verifier/carte/…`) : prénom, initiale du nom, numéro et validité uniquement.
- CI GitHub Actions : tests sur PostgreSQL et image Docker multi-architecture publiée sur GHCR.

### Corrigé

- Les modifications partielles (adhérent, formule, rôle, groupe) réinitialisaient les champs non transmis à leur valeur par défaut ou les vidaient (comportement de `.partial()` de zod). Nouveau schéma `patchOf` sans valeurs par défaut, test de non-régression.

## [0.2.0] — 2026-11-27

Scenorya Asso : cotisations.

### Ajouté

- Formules de cotisation (montant, période : année civile, exercice de l’association, 12 mois glissants, ponctuelle ; catégorie attribuée au règlement ; retrait sans perte d’historique).
- Appels de cotisation individuels ou groupés, avec calcul automatique de la période et refus des doublons sur une même période.
- Règlements multiples (espèces, chèque, virement, carte, en ligne, autre), montants en centimes entiers, refus des trop-perçus même en cas d’encaissements simultanés (verrou de ligne).
- Règlements inaltérables en base (déclencheur PostgreSQL) : correction uniquement par annulation motivée.
- Exonération et annulation motivées.
- Reçu de cotisation PDF numéroté chronologiquement par année (non fiscal, mention explicite) ; annulation automatique du reçu si un règlement est annulé.
- Activation automatique de l’adhésion au règlement complet.
- Renouvellements : adhérents non couverts sur 0 à 90 jours, appel groupé.
- Section « Cotisations » dans la fiche adhérent, indicateur dans Scenorya Hub, export CSV.
- Conséquence signalée avant désactivation d’Asso : cotisations en attente.
- Rôle Trésorier : droits complets sur les cotisations et formules.

### Modifié

- Logo réduit (640 px) pour l’en-tête, les e-mails et les PDF : reçu de 840 Ko à 56 Ko.

## [0.1.0] — 2026-11-27

Première version : fondations de la plateforme et système modulaire.

### Ajouté

- Identité Scenorya : pack graphique officiel intégré localement, variantes recadrées, favicon et icônes PWA générés depuis l’icône principale, logos clair/sombre, emblèmes dans le lanceur, pictogrammes SVG dans les menus.
- Registre central des 22 modules (identité, catégorie, dépendances strictes, intégrations, fonctionnalités conditionnelles, état d’implémentation) partagé serveur/client.
- Résolution des états de modules, plans d’activation/désactivation, profils de départ (association simple, théâtre, événementiel, personnalisé).
- Assistant de première configuration avec jeton d’installation.
- Authentification par session, CSRF, anti-force brute, mot de passe provisoire, sessions actives et révocation.
- Multi-associations avec isolation stricte ; 19 rôles prédéfinis ; rôles personnalisés ; matrice des permissions ; accès temporaires ; anti-escalade ; protection du dernier administrateur.
- Scenorya Admin : modules et fonctionnalités (recherche, catégories, états, activation avec dépendances, désactivation avec conséquences, lecture seule, historique), utilisateurs, rôles, journal d’audit, fiche de l’association (IBAN chiffré).
- Scenorya System : associations, disponibilité des modules sur l’instance, santé technique, SMTP chiffré avec test d’envoi, sauvegardes `pg_dump` avec SHA-256 et rétention, journal de l’instance.
- Scenorya Hub : tableau de bord selon droits et modules.
- Scenorya Asso : fichier des adhérents (numérotation, catégories, statuts, données sensibles, mineurs, archivage/restauration, import CSV avec simulation, export CSV, historique).
- Journal d’audit en ajout seul, chaîné SHA-256, vérification d’intégrité.
- Synchronisation temps réel des changements de modules (Socket.IO).
- Recherche globale (/ ou Ctrl+K), mode sombre, interface responsive, PWA.
- Dockerfile multi-étapes, docker-compose compatible Portainer, `.env.example`, documentation française.
- 48 tests automatisés.
