# État d’avancement — reprise du développement

_Dernière mise à jour : 27 novembre 2026 — version 0.10.0_

Ce fichier permet de reprendre le travail dans une nouvelle session sans perte de contexte.

## Où en est-on ?

Phase 1 terminée (hors points notés 🟡 dans ROADMAP.md). Phase 2 en cours : fichier des adhérents, **cotisations** (formules, règlements, reçus PDF, renouvellements), **groupes et commissions**, **champs personnalisés** et **cartes d’adhérent QR** livrés ; **Scenorya Agenda** livré (événements, récurrences, invitations, conflits, iCal) ; **Scenorya Projects** livré (Kanban, tâches, modèles) ; **gouvernance** livrée (instances, convocations, PV figés, mandats) ; **Scenorya Drive** livré (stockage adressé par contenu, versions, corbeille, dossiers restreints, partage public protégé, quota, journal des accès, pièces jointes des tâches) ; **Scenorya Espace** livré pour les adhérents (invitation, compte, cotisations, carte, agenda, réunions, documents). **Scenorya Cast** livré (productions, distribution, scènes, indisponibilités, répétitions, PDF, espace du comédien). Les 15 modules métier non livrés sont **activables et configurables** mais affichent une page d’accueil indiquant honnêtement leur phase ; aucun bouton fictif.

## Vérifications effectuées

| Vérification | Résultat |
|---|---|
| `packages/shared` : vitest | 32/32 |
| `apps/api` : jest e2e sur PostgreSQL 16 | 125/125 (plateforme 28, cotisations 16, Drive 13, groupes/champs/cartes 12, agenda 11, Espace 10, suppressions 10, projets 9, Cast 8, gouvernance 8) |
| CI GitHub Actions (tests) | OK |
| Typage strict API et web | OK |
| Build Vite + PWA | OK |
| Parcours navigateur (Chrome headless) : installation, connexion, tableau de bord, lanceur, création d’adhérent, liste, modules (activation, désactivation), rôles, audit, santé, module prévu, mode sombre, mobile 390 px | OK, aucune erreur console hors 401 attendu avant connexion |
| Reproduction des étapes du Dockerfile (ci, build, prune, copie) puis exécution : migrations, installation, sauvegarde `pg_dump` | OK |
| Restauration `pg_restore` d’une sauvegarde | OK |
| Parcours navigateur des cotisations : formules, appel depuis la fiche, règlement partiel puis complet, téléchargement du reçu, liste, renouvellements | OK |
| Rendu du reçu PDF (vérifié visuellement) | OK |
| Parcours navigateur de Drive : espaces recommandés, envoi multiple, aperçu d’image, étiquettes, lien de partage, page publique, recherche par étiquette, pièce jointe d’une tâche, corbeille, journal, stockage (System) | OK |
| Parcours navigateur de l’Espace : invitation depuis la fiche, création du compte par l’adhérent, connexion et redirection vers l’Espace, coordonnées, réponse à une répétition, documents publiés | OK |
| Construction réelle de l’image Docker | Effectuée par la CI GitHub Actions (amd64 + arm64) |
| Envoi SMTP réel | **Non vérifié** (pas de serveur SMTP accessible) ; le code d’envoi et le gabarit sont en place |
| Audit RGAA complet | Non réalisé (bonnes pratiques appliquées : libellés, focus visible, navigation clavier, états non portés par la seule couleur, `prefers-reduced-motion`) |

## Décisions récentes

- Drizzle ORM (pas de binaire Prisma) ; sessions opaques ; jeton d’installation ; System réservé au superadministrateur.
- Graphe strict minimal : Scan → Tickets, Maintenance → Stock ; le reste en intégrations et fonctionnalités conditionnelles (docs/modules.md).
- Agenda : heures stockées en UTC, récurrences développées à l’heure de `Europe/Paris` (`packages/shared/src/recurrence.ts`) ; abonnement iCal par jeton haché, droits réévalués à chaque lecture.
- Validation : toute modification partielle utilise `patchOf(schema)` (jamais `.partial()`, qui applique les valeurs par défaut).
- Cartes : QR = URL de vérification avec jeton aléatoire ; validité calculée en direct.
- Cotisations : centimes entiers partout ; règlements inaltérables (annulation motivée) ; reçu non fiscal numéroté `AAAA-NNNN` par association ; pdfkit épinglé en 0.16 (dépendances CommonJS, compatibles Jest).
- Drive : contenu stocké une fois sous `DATA_DIR/files/aa/bb/<sha256>` (verrou consultatif par empreinte pour l’envoi et le nettoyage) ; le type MIME est déduit de l’extension ; exécutables refusés par extension et par signature (MZ, ELF, Mach-O, `#!`) ; SVG et HTML toujours téléchargés, jamais affichés ; `?assoc=` accepté sur les seules requêtes GET pour les aperçus ouverts par le navigateur.
- Cast : les convoqués d’une répétition ne sont pas stockés ; ils se déduisent à chaque lecture de la distribution confirmée et de la présence des personnages dans les scènes. L’événement d’agenda (fonctionnalité `cast.agendaCalls`) est resynchronisé à chaque changement de distribution ou de scène, en conservant les réponses déjà données.
- PDF : les polices standard de pdfkit (WinAnsi) n’ont pas « → », « ✓ »… : n’utiliser que des caractères latins dans les PDF.
- **Règle de développement : tout ce qui se crée doit pouvoir se supprimer** (demande de Thomas). Chaque nouvelle entité livre sa route `DELETE`, son bouton et son test. Quand la suppression a des conséquences, le serveur répond `CONFIRM_REQUIRED` avec le détail et l’interface passe par `deleteWithConfirm` (seconde confirmation, puis `?force=1`). Les lignes protégées par déclencheur se suppriment via `allowPurge(tx)` (common/purge.ts).
- Espace : la fiche d’adhérent est reliée au compte par `members.user_id` (unique par association) ; invitation à jeton haché, usage unique, 14 jours ; un compte existant doit se connecter avec la même adresse pour accepter ; le rôle « Adhérent » est ajouté seulement si le compte n’a pas déjà `espace.read`. Toutes les routes `espace/*` ne lisent que la fiche du compte connecté.
- Page d’accueil : un compte sans accès au Hub mais avec l’Espace arrive directement sur `/espace` ; la connexion respecte `?next=` (chemins internes uniquement).
- Champs de formulaire : un `<input>` sans `type` est désormais stylé comme les autres (cause d’une partie des décalages signalés).
- Emblèmes PNG du pack recadrés automatiquement (`scripts/derive-branding.mjs`) car ~79 % de marge transparente ; originaux intacts.

## Prochaines étapes suggérées

1. Asso : formulaire d’adhésion en ligne, photo, passage automatique en « expirée » (tâche planifiée), export Excel/PDF.
2. Show (spectacles, représentations ; rattachement des productions de Cast), puis Régie (phase 4).
3. Asso : formulaire d’adhésion en ligne (s’appuiera sur l’Espace).
4. Drive : stockage S3, logo de l’association.
5. Ajouter à chaque nouveau module : permissions dans `permissions.ts`, navigation dans `apps/web/src/navigation.ts`, `implementation.status` dans `modules.ts`, fournisseur d’impact, tests d’accès (module désactivé, lecture seule, isolation).

## Démarrer en développement

Voir docs/developpement.md.
