# Architecture de Scenorya

## Principes

- **Monolithe modulaire** : un seul processus Node.js sert l’API, le temps réel, l’interface web et le pack graphique. Pas de microservices.
- **Une plateforme, 22 modules** : même authentification, même base, mêmes permissions, mêmes composants. Un module n’est pas une application installable séparément ; c’est un ensemble de routes, d’écrans et de tables soumis au registre.
- **Refus par défaut** : chaque route déclare sa règle d’accès ; sinon 403.
- **Rien n’est supprimé par une désactivation** ; les migrations sont versionnées et non destructives.
- **Montants financiers** (à partir de la phase 5) : entiers en centimes, jamais de flottants.

## Arborescence

```
packages/shared/src/
  modules.ts       registre des 22 modules (identité + règles)
  resolver.ts      résolution des états, plans d'activation/désactivation, tri topologique
  permissions.ts   catalogue des permissions, jokers, modèles de rôles
apps/api/
  drizzle/         migrations SQL versionnées (0000_init, 0001_audit_immutability…)
  src/
    bootstrap.ts   Helmet/CSP, cookies, OpenAPI, service du pack graphique et de la SPA
    common/        règles d'accès (@Public, @Authenticated, @SuperAdminOnly, @MemberOnly, @Access), garde globale, chiffrement, CSV
    auth/          sessions (cookie httpOnly + CSRF), connexion, mot de passe
    setup/         assistant d'installation (jeton, transaction verrouillée)
    modules/       service central des modules (cache, verrous, historique, impacts, évènements) + contrôleurs
    admin/         permissions, utilisateurs, rôles, audit, fiche association
    audit/         journal chaîné SHA-256
    system/        santé, associations, SMTP, sauvegardes (pg_dump)
    hub/           tableau de bord
    asso/          adhérents
    realtime/      passerelle Socket.IO
  test/            tests de bout en bout sur PostgreSQL réel
apps/web/src/
  api/             client HTTP (CSRF, association courante)
  state.tsx        utilisateur, contexte d'association, temps réel, thème, notifications
  layout/          coque : en-tête, lanceur, recherche globale, navigation latérale
  pages/           Public (connexion, installation), Hub, Admin, System, Asso, Compte
branding/          pack officiel intact + derived/ (variantes recadrées générées)
scripts/           derive-branding.mjs
```

## Requête type

```
Navigateur ── cookie scn_session (httpOnly, SameSite=Lax) + X-CSRF-Token + X-Scenorya-Association
   │
AccessGuard
   1. règle déclarée ?                         sinon 403 ACCESS_NOT_DECLARED
   2. session valide (hash SHA-256 en base)    sinon 401
   3. CSRF (méthodes non sûres)                sinon 403 CSRF_INVALID
   4. changement de mot de passe imposé ?      403 PASSWORD_CHANGE_REQUIRED
   5. appartenance active, non expirée         sinon 403 NOT_MEMBER
   6. module utilisable / modifiable           sinon 403 MODULE_DISABLED / MODULE_READONLY
   7. permission (jokers *, module.*, …)       sinon 403 PERMISSION_DENIED
   │
Contrôleur → requêtes filtrées par association_id (jamais d'identifiant seul)
```

## Données

Tables du socle : `users`, `sessions`, `login_attempts`, `associations`, `association_users`, `roles`, `role_assignments` (portée facultative `scope_type/scope_id` et expiration), `instance_modules`, `association_modules`, `module_config_history`, `audit_logs`, `instance_settings`, `backups`, `counters`. Module Asso : `members`, cotisations, groupes, champs, gouvernance. Agenda : `events`, `event_participants`, `calendar_feeds`. Projects : `projects`, `tasks`, `task_comments`. Drive : `drive_blobs` (contenus), `drive_folders`, `drive_files`, `drive_file_versions`, `drive_favorites`, `drive_shares`, `drive_access_log`, `drive_links` (rattachement générique fichier ↔ élément d'un autre module), `drive_settings` (quota).

Toutes les tables métier portent `association_id` ; l’isolation est testée.

## Décisions

| Décision | Motif |
|---|---|
| Drizzle ORM plutôt que Prisma | Pas de moteur binaire à télécharger (déploiement ARM64/hors ligne simplifié), SQL explicite, migrations SQL relisibles et personnalisables (déclencheurs). |
| Sessions opaques en base plutôt que JWT | Révocation immédiate, liste des sessions actives, pas de secret de signature exposé côté client. |
| Jeton d’installation | Empêche l’appropriation d’une instance exposée avant configuration. |
| System réservé aux superadministrateurs | Il agit sur l’instance (toutes les associations) ; il ne relève donc pas des rôles d’une association. |
| Superadministrateur sans accès implicite aux données | Moindre privilège : il administre l’instance ; l’accès aux données d’une association passe par une appartenance explicite et auditée. |
| Lecture seule comme mode de clôture | Permet de cesser l’activité d’un module sans perdre l’accès aux archives et obligations. |
| Service d’événements partagé | Tickets et Régie ne dépendent pas de Show (voir docs/modules.md). |
| Variantes recadrées des emblèmes | Les PNG fournis contiennent ~79 % de marge transparente ; recadrage automatique sans retouche du dessin. |
| Drive adressé par contenu (`DATA_DIR/files/aa/bb/<sha256>`) | Déduplication gratuite (versions et copies identiques), aucun chemin issu de l’utilisateur sur le disque, copie incrémentale sûre ; un verrou consultatif par empreinte sérialise envoi et nettoyage. Le stockage S3 pourra reprendre la même clé. |
| Rattachements par `drive_links` | Un module (Projects, plus tard Show, Booking…) attache des documents sans dépendre de Drive : la fonctionnalité est conditionnelle (`projects.attachments`). |
| Redis différé | Inutile tant qu’il n’y a qu’un processus et aucune file ; sera introduit avec les envois d’e-mails en masse et la billetterie. |

## Temps réel

Socket.IO sur `/api/realtime`, authentifié par le cookie de session avant la connexion. Les clients rejoignent la salle de leur association (appartenance vérifiée). Évènement actuel : `modules:changed`. Une seule instance applicative est supportée ; un adaptateur Redis sera nécessaire pour plusieurs réplicas.

## Éditions

`BRAND.edition` vaut `Community`. L’architecture multi-associations, la configuration des modules par instance et l’absence d’état local hors `DATA_DIR` préparent une édition Cloud (plusieurs instances ou locataires gérés) sans la mettre en œuvre.
