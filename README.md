<p align="center">
  <img src="branding/derived/logos/scenorya-horizontal.png" alt="Scenorya — Gestion associative, culturelle et événementielle" width="460">
</p>

<p align="center"><strong>De la gestion aux applaudissements.</strong><br>Une application de TiceConnect — édition <em>Community</em> (auto-hébergée)</p>

---

Scenorya est une suite modulaire de gestion pour associations, compagnies de théâtre et structures culturelles et événementielles. Une seule plateforme intégrée — une authentification, une base de données, un système de permissions, une identité graphique — découpée en **22 modules** activables individuellement pour chaque association.

> Application indépendante, sans lien avec les services de l’État. L’interface s’inspire des sites institutionnels français sans en reprendre les logos ni prétendre à une quelconque affiliation.

## État d’avancement (v0.6.0)

| Domaine | État |
|---|---|
| **Socle** : authentification, sessions, CSRF, assistant d’installation, multi-associations, rôles et permissions granulaires, journal d’audit chaîné, paramètres, santé technique, SMTP, sauvegardes de la base | ✅ Opérationnel, testé |
| **Système modulaire** : registre des 22 modules, graphe de dépendances, états (actif, lecture seule, inactif, dépendance manquante, indisponible), disponibilité par instance, activation/désactivation avec analyse d’impact, temps réel | ✅ Opérationnel, testé |
| **Scenorya Hub** : tableau de bord selon droits et modules | 🟡 Partiel (widgets non personnalisables) |
| **Scenorya Asso** : adhérents (fiches, numérotation, archivage, données sensibles, import/export CSV, historique) cotisations (formules, règlements, reçus PDF, renouvellements), groupes et commissions, champs personnalisés, cartes d’adhérent QR, gouvernance (AG, convocations, présences, procurations, délibérations, PV figés, mandats) | 🟡 Partiel (adhésion en ligne à venir) |
| **Scenorya Admin** : utilisateurs, rôles, matrice des droits, modules, association, audit | ✅ Opérationnel |
| **Scenorya System** : associations, modules de l’instance, santé, SMTP, sauvegardes, journal de l’instance | 🟡 Partiel (sauvegardes planifiées et S3 à venir) |
| **Scenorya Agenda** : événements, récurrences, invitations d’adhérents et de groupes, conflits, vues mois/semaine/liste, export et abonnement iCal | 🟡 Partiel (salles avec Booking, vue année) |
| **Scenorya Projects** : projets, Kanban, sous-tâches, checklists, commentaires, Mes tâches, modèles, pièces jointes | 🟡 Partiel (vues calendrier et chronologique) |
| **Scenorya Drive** : dossiers, envoi par glisser-déposer, contenu dédupliqué, versions, corbeille (30 jours), dossiers restreints par rôle, étiquettes, recherche, favoris, aperçus sûrs, liens de partage (expiration, mot de passe, nombre de téléchargements), quota par association, journal des accès | ✅ Opérationnel, testé |
| Cast, Show, Régie, Tickets, Scan, POS, Finance, Factures, Stock, Booking, Maintenance, Web, Com, Espace, Analytics | ⏳ Prévus — activables et configurables, sans fonctionnalité métier pour l’instant |

Le détail est tenu à jour dans [PROGRESS.md](PROGRESS.md) et le plan dans [ROADMAP.md](ROADMAP.md).

## Démarrage rapide (Docker)

```bash
cp .env.example .env
# Renseignez APP_SECRET (openssl rand -base64 48) et POSTGRES_PASSWORD
docker network create npm_proxy   # une fois, réseau partagé avec Nginx Proxy Manager
docker compose up -d --build
docker logs scenorya               # affiche le jeton d'installation
```

Ouvrez ensuite `PUBLIC_URL/installation` : l’assistant crée le premier administrateur, la première association, les modules à activer et (facultatif) la messagerie. **Aucun compte par défaut n’existe.**

Guides : [installation Docker / Portainer / Nginx Proxy Manager](docs/installation-docker-portainer.md) · [sauvegarde et restauration](docs/sauvegarde-restauration.md) · [modules et dépendances](docs/modules.md) · [guide administrateur](docs/guide-administrateur.md) · [développement](docs/developpement.md) · [API](docs/api.md).

## Architecture en bref

Monolithe modulaire TypeScript (npm workspaces) :

- `packages/shared` — registre des modules, graphe de dépendances, résolution des états, catalogue des permissions, profils (code partagé serveur/client) ;
- `apps/api` — NestJS 11, PostgreSQL 16 via Drizzle ORM, migrations SQL versionnées, Socket.IO, OpenAPI (`/api/docs`) ;
- `apps/web` — React 19, Vite, TanStack Query, PWA installable ;
- `branding` — pack graphique officiel (intact) et variantes recadrées générées.

Voir [ARCHITECTURE.md](ARCHITECTURE.md) et [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test            # registre partagé (vitest) + tests de bout en bout de l'API (jest, PostgreSQL réel)
```

116 tests : graphe de dépendances, montants et périodes de cotisation, refus par défaut, CSRF, verrouillage des connexions, cycle de vie des modules (activation, désactivation, réactivation sans perte, lecture seule, instance), permissions et anti-escalade, isolation entre associations, concurrence, inaltérabilité du journal d’audit et des règlements, trop-perçus simultanés, reçus PDF, temps réel, import CSV.

## Licence et identité

Nom, logos et emblèmes : pack graphique officiel Scenorya (voir `branding/CHARTE-GRAPHIQUE.md`). La disponibilité juridique du nom n’a pas été vérifiée. Licence du code : à définir par TiceConnect avant publication.
