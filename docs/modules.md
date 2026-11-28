# Modules, dépendances et cycle de vie

Source de vérité : `packages/shared/src/modules.ts` (registre) et `packages/shared/src/resolver.ts` (résolution). Le registre reprend intégralement `branding/modules.json` (identifiant, nom, couleur, logos, icônes, route, permission d’entrée, socle) et l’enrichit des règles ci-dessous. Un test vérifie la concordance avec `modules.json` et l’existence locale de chaque fichier graphique.

## Modules de socle

`hub`, `admin`, `system` sont toujours actifs (état **Requis**) ; leur accès reste soumis aux droits. Le noyau technique (authentification, associations, permissions, audit, paramètres, sauvegardes) n’est pas désactivable. `system` agit au niveau de l’instance et est réservé aux superadministrateurs.

## Service d’événements partagé

Pour ne pas imposer Show à une billetterie généraliste, les **événements** (représentation d’un spectacle ou événement autonome) relèvent d’un service partagé du socle (livré avec la phase 4/5). Conséquences :

- Tickets n’exige pas Show (vente d’événements autonomes ; la vente des représentations de Show est une fonctionnalité conditionnelle) ;
- Régie s’attache à un événement compatible, qu’il vienne de Show ou non.

## Graphe

Dépendances **strictes** (le module ne fonctionne pas sans) :

| Module | Requiert |
|---|---|
| Scan | Tickets |
| Maintenance | Stock |

Tous les autres modules n’ont aucune dépendance stricte. Les liens restants sont des **intégrations facultatives** ou des **fonctionnalités conditionnelles** :

| Fonctionnalité | Module | Requiert |
|---|---|---|
| Vente de billets en caisse | POS | Tickets |
| Décrément des stocks en temps réel | POS | Stock |
| Export comptable des clôtures | POS | Finance |
| Bloc billetterie | Web | Tickets |
| Cartes de spectacles / agenda / comédiens / adhésion | Web | Show / Agenda / Cast / Asso |
| Prêts et réservations de matériel | Booking | Stock (la réservation de salles fonctionne seule) |
| Vente des représentations de Show | Tickets | Show |
| Écritures comptables (ventes, cotisations, factures) | Tickets, Asso, Factures | Finance |
| Distributions par spectacle | Cast | Show |
| Rattachement aux représentations | Régie | Show |
| Pièces jointes des tâches | Projects | Drive |
| Fiche, cotisations, convocations dans l’Espace | Espace | Asso |
| Agenda et réponses de présence dans l’Espace | Espace | Agenda |
| Documents publiés dans l’Espace | Espace | Drive |
| Convocations de répétition dans l’agenda | Cast | Agenda |
| Rôles, répétitions et indisponibilités dans l’espace du comédien | Cast | Espace |
| Distributions rattachées aux spectacles | Cast | Show |
| Représentations dans l’agenda (équipe et distribution) | Show | Agenda |
| Documents du spectacle | Show | Drive |
| Conduite rattachée au spectacle et aux représentations | Régie | Show |
| Cartoucheur | Régie | Drive |
| Prêts et réservations de matériel | Booking | Stock |
| Réservations confirmées dans l’agenda | Booking | Agenda |
| Pannes et entretien du matériel | Maintenance | Stock (requis) |
| Matériel hors service retiré des prêts | Maintenance | Booking |
| Billetterie des représentations (date et lieu suivis) | Tickets | Show |
| Contrôle des entrées | Scan | Tickets (requis) |

Finance fonctionne sans POS. L’absence de cycle est vérifiée par test (tri topologique).

## États

| État | Signification | Lecture | Écriture |
|---|---|---|---|
| Requis | Module de socle | ✔ | ✔ |
| Actif | Activé pour l’association | ✔ | ✔ |
| Lecture seule | Mode clôture : consultation et archives autorisées | ✔ | ✘ (`MODULE_READONLY`) |
| Inactif | Désactivé ; données conservées | ✘ (`MODULE_DISABLED`) | ✘ |
| Dépendance manquante | Configuré actif mais une dépendance stricte est inutilisable | ✘ | ✘ |
| Indisponible | Désactivé au niveau de l’instance par un superadministrateur | ✘ | ✘ |

Une dépendance en lecture seule reste satisfaisante (ex. Scan reste utilisable si Tickets est en clôture).

## Disponibilité et droits sont indépendants

Activer un module **ne donne aucun droit**. Chaque route serveur déclare : le module concerné, la permission exacte (`<module>.<ressource>.<action>`), et le caractère lecture/écriture. La garde globale (`AccessGuard`) vérifie dans l’ordre : session, CSRF, appartenance active et non expirée, module utilisable (et modifiable pour une écriture), permission. Toute route sans déclaration est refusée (test automatique).

## Activation

1. Aperçu (`POST /api/admin/modules/:id/preview-activation`) : dépendances à activer, blocages (dépendance indisponible sur l’instance), fonctionnalités débloquées.
2. Si des dépendances doivent être activées, la confirmation est obligatoire (`confirmDependencies: true`, sinon `409 DEPENDENCIES_CONFIRMATION_REQUIRED`).
3. Les données et paramètres d’une activation antérieure sont retrouvés tels quels.

## Désactivation et clôture

1. Aperçu (`preview-deactivation`, mode `inactive` ou `readonly`) : modules dépendants, fonctionnalités perdues ailleurs, conséquences déclarées par les modules (fournisseurs d’impact).
2. Niveaux de conséquence : **bloquant** (dossiers actifs : ventes ouvertes, billets valides, caisses ouvertes…) → la désactivation est refusée (`409 ACTIVE_RECORDS`) mais la **lecture seule reste possible** ; **avertissement** → confirmation obligatoire ; **information**.
3. Les dépendants ne sont jamais désactivés silencieusement : confirmation explicite obligatoire (`409 DEPENDENTS_CONFIRMATION_REQUIRED` sinon).
4. Aucune donnée n’est supprimée ; aucune table n’est retirée. Désactiver ne désinstalle rien.

Fournisseurs d’impact actuellement déclarés : **Asso** (nombre de fiches conservées, présence de mineurs). Chaque module livré ensuite déclarera les siens (Tickets : ventes ouvertes et billets valides ; POS : caisses ouvertes ; Booking : prêts en cours…), conformément à la politique ci-dessous.

## Politique des tâches automatiques et des obligations

À appliquer par chaque module lors de sa livraison (aucune tâche planifiée n’existe encore) :

- module **inactif** : ses tâches planifiées sont suspendues ; les obligations déjà engagées envers des tiers (remboursements, confirmations de paiement, envoi de billets déjà vendus) sont **terminées** et jamais perdues ;
- module en **lecture seule** : aucune nouvelle opération, mais les webhooks de paiement entrants pour des opérations existantes restent traités et journalisés ;
- les données comptables, confirmations de paiement et remboursements ne sont jamais supprimés ni rendus inaccessibles aux personnes habilitées (accès d’archive).

## Sessions, caches et temps réel

L’état résolu est mis en cache 30 s par association et **invalidé immédiatement** à chaque changement. Un évènement `modules:changed` est diffusé (Socket.IO, `/api/realtime`) aux membres connectés de l’association : menus, lanceur, tableau de bord et recherche se rechargent sans déconnexion. Les sessions restent valides ; les droits sont réévalués à chaque requête.

## Niveau instance

Un superadministrateur peut rendre un module indisponible pour toute l’instance (`PUT /api/system/instance-modules/:id`). Les configurations des associations sont conservées et retrouvées quand le module redevient disponible.

## Traçabilité

Chaque changement est inscrit dans `module_config_history` (ancien/nouvel état, auteur, date, motif — table en ajout seul) et dans le journal d’audit chaîné.

## Procédure de récupération

- **Module désactivé par erreur** : Scenorya Admin → Modules → Activer. Les données sont intactes.
- **Plus aucun administrateur ne peut accéder à Admin** : impossible via l’interface (au moins un administrateur actif est garanti). En dernier recours, un superadministrateur peut créer une nouvelle appartenance via la base :
  ```sql
  -- à exécuter dans le conteneur db, après sauvegarde
  INSERT INTO association_users (association_id, user_id) VALUES ('<association>', '<utilisateur>') ON CONFLICT DO NOTHING;
  INSERT INTO role_assignments (association_user_id, role_id)
    SELECT au.id, r.id FROM association_users au JOIN roles r ON r.association_id = au.association_id AND r.key = 'admin'
    WHERE au.association_id = '<association>' AND au.user_id = '<utilisateur>';
  ```
- **Suppression définitive des données d’un module** : non proposée dans l’interface. Elle fera l’objet d’une procédure distincte, réservée au superadministrateur, auditée, précédée d’une sauvegarde et compatible avec les durées de conservation légales (comptabilité : 10 ans).
