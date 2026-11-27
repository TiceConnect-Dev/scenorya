# Guide administrateur

## Rôles : instance et association

- **Superadministrateur** (créé par l’assistant) : gère l’instance dans Scenorya System — associations, modules disponibles, messagerie, sauvegardes, santé. Il n’a pas d’accès implicite aux données des associations dont il n’est pas membre.
- **Administrateur associatif** : tous les droits sur son association (rôle non modifiable). Au moins un administrateur actif est toujours conservé.

## Activer ou désactiver un module

Scenorya Admin → **Modules et fonctionnalités**.

- Filtrez par catégorie, état ou texte.
- *Activer…* affiche les dépendances qui seront activées et les fonctionnalités débloquées.
- *Lecture seule…* (clôture) : les données restent consultables, toute modification est refusée.
- *Désactiver…* affiche les modules dépendants, les fonctionnalités perdues et les conséquences ; une confirmation explicite est demandée. Les données sont conservées et retrouvées à la réactivation.
- Activer un module ne donne aucun droit : attribuez les permissions ensuite.

## Utilisateurs

Scenorya Admin → **Utilisateurs** → *Ajouter* : nom, e-mail, mot de passe provisoire (changé obligatoirement à la première connexion), rôles, date d’expiration facultative (accès temporaire). Un compte existant (même e-mail) est simplement rattaché à l’association.

Actions : modifier les rôles et l’expiration, définir un mot de passe provisoire (ferme les sessions de l’utilisateur), désactiver/réactiver l’accès.

## Rôles et permissions

Scenorya Admin → **Rôles et permissions** : matrice module × ressource × action. Choisissez les rôles affichés, cochez/décochez, puis *Enregistrer* sous la colonne. Une case grisée cochée est couverte par un joker (ex. `asso.*`). Vous ne pouvez accorder ou retirer que des droits que vous possédez.

Droit particulier : **Adhérents — Consulter les données sensibles** (date de naissance, adresse, représentant légal, notes).

## Journal d’audit

Toutes les opérations importantes sont tracées (connexions, modules, droits, fiches, exports). Le bandeau indique l’intégrité de la chaîne. Export CSV avec le droit dédié.

## Fiche de l’association

RNA, SIRET, coordonnées, couleur principale, début d’exercice, assurance, IBAN (chiffré ; droit « données sensibles » requis).

## Adhérents

Scenorya Asso → **Adhérents** : recherche, filtres, tri, pagination, export CSV (formules neutralisées, compatible Excel). **Importer (CSV)** : simulation obligatoire avant import, rapport ligne par ligne.
