# Journal des modifications

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) — versionnage sémantique.

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
