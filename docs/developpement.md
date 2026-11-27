# Développement

## Prérequis

Node.js 22, PostgreSQL 16 local.

```bash
npm install
createuser -P scenorya && createdb -O scenorya scenorya && createdb -O scenorya scenorya_test
```

## Lancer

```bash
export DATABASE_URL=postgres://scenorya:<mdp>@localhost:5432/scenorya
export APP_SECRET=$(openssl rand -base64 48)
npm run build -w @scenorya/shared
npm run dev:api          # API sur :3000 (migrations au démarrage, jeton d'installation dans la console)
npm run dev:web          # Vite sur :5173, proxy /api, /branding et WebSocket vers :3000
```

## Tests

```bash
npm test                                  # tout
npm run test -w @scenorya/api             # e2e (base scenorya_test recréée à chaque exécution)
TEST_DATABASE_URL=postgres://… npm run test -w @scenorya/api
```

## Migrations

```bash
# après modification de apps/api/src/db/schema.ts
cd apps/api && npx drizzle-kit generate --name=<description>
```

Relire le SQL généré : aucune migration destructive (suppression de colonne ou de table contenant des données) sans procédure de reprise documentée.

## Identité graphique

- Ne jamais modifier `branding/` à la main (pack officiel).
- `node scripts/derive-branding.mjs` régénère `branding/derived/` (recadrage).
- `npm run icons -w @scenorya/web` régénère favicon et icônes PWA.

## Ajouter un module métier

1. `packages/shared/src/modules.ts` : `implementation.status`, dépendances, fonctionnalités.
2. `packages/shared/src/permissions.ts` : ressources et actions.
3. API : contrôleur avec `@Access('<module>', '<module>.<ressource>.<action>')` sur **chaque** route ; filtrer toutes les requêtes par `association_id` ; journaliser via `AuditService` ; déclarer un fournisseur d’impact (`ModulesService.registerImpactProvider`).
4. Web : routes dans `App.tsx` entourées de `<ModuleGate id>`, navigation dans `navigation.ts`.
5. Tests : accès refusé si module inactif, écriture refusée en lecture seule, isolation entre associations, permissions.
6. Mettre à jour PROGRESS.md, ROADMAP.md, CHANGELOG.md.
