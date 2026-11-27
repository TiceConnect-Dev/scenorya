# État d’avancement — reprise du développement

_Dernière mise à jour : 27 novembre 2026 — version 0.3.0_

Ce fichier permet de reprendre le travail dans une nouvelle session sans perte de contexte.

## Où en est-on ?

Phase 1 terminée (hors points notés 🟡 dans ROADMAP.md). Phase 2 en cours : fichier des adhérents, **cotisations** (formules, règlements, reçus PDF, renouvellements), **groupes et commissions**, **champs personnalisés** et **cartes d’adhérent QR** livrés. Les 18 modules métier non livrés sont **activables et configurables** mais affichent une page d’accueil indiquant honnêtement leur phase ; aucun bouton fictif.

## Vérifications effectuées

| Vérification | Résultat |
|---|---|
| `packages/shared` : vitest | 26/26 |
| `apps/api` : jest e2e sur PostgreSQL 16 | 56/56 (plateforme 28, cotisations 16, groupes/champs/cartes 12) |
| CI GitHub Actions (tests) | OK |
| Typage strict API et web | OK |
| Build Vite + PWA | OK |
| Parcours navigateur (Chrome headless) : installation, connexion, tableau de bord, lanceur, création d’adhérent, liste, modules (activation, désactivation), rôles, audit, santé, module prévu, mode sombre, mobile 390 px | OK, aucune erreur console hors 401 attendu avant connexion |
| Reproduction des étapes du Dockerfile (ci, build, prune, copie) puis exécution : migrations, installation, sauvegarde `pg_dump` | OK |
| Restauration `pg_restore` d’une sauvegarde | OK |
| Parcours navigateur des cotisations : formules, appel depuis la fiche, règlement partiel puis complet, téléchargement du reçu, liste, renouvellements | OK |
| Rendu du reçu PDF (vérifié visuellement) | OK |
| Construction réelle de l’image Docker | Effectuée par la CI GitHub Actions (amd64 + arm64) |
| Envoi SMTP réel | **Non vérifié** (pas de serveur SMTP accessible) ; le code d’envoi et le gabarit sont en place |
| Audit RGAA complet | Non réalisé (bonnes pratiques appliquées : libellés, focus visible, navigation clavier, états non portés par la seule couleur, `prefers-reduced-motion`) |

## Décisions récentes

- Drizzle ORM (pas de binaire Prisma) ; sessions opaques ; jeton d’installation ; System réservé au superadministrateur.
- Graphe strict minimal : Scan → Tickets, Maintenance → Stock ; le reste en intégrations et fonctionnalités conditionnelles (docs/modules.md).
- Validation : toute modification partielle utilise `patchOf(schema)` (jamais `.partial()`, qui applique les valeurs par défaut).
- Cartes : QR = URL de vérification avec jeton aléatoire ; validité calculée en direct.
- Cotisations : centimes entiers partout ; règlements inaltérables (annulation motivée) ; reçu non fiscal numéroté `AAAA-NNNN` par association ; pdfkit épinglé en 0.16 (dépendances CommonJS, compatibles Jest).
- Emblèmes PNG du pack recadrés automatiquement (`scripts/derive-branding.mjs`) car ~79 % de marge transparente ; originaux intacts.

## Prochaines étapes suggérées

1. Asso : formulaire d’adhésion en ligne, photo, passage automatique en « expirée » (tâche planifiée), export Excel/PDF.
2. Drive (stockage local + S3), nécessaire au logo d’association, aux pièces jointes et aux sauvegardes de fichiers.
3. Agenda et Projects.
4. Ajouter à chaque nouveau module : permissions dans `permissions.ts`, navigation dans `apps/web/src/navigation.ts`, `implementation.status` dans `modules.ts`, fournisseur d’impact, tests d’accès (module désactivé, lecture seule, isolation).

## Démarrer en développement

Voir docs/developpement.md.
