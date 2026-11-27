# API

Documentation interactive OpenAPI : **`/api/docs`** (générée à partir du code).

## Conventions

- Préfixe `/api`, JSON en entrée et sortie.
- Authentification : cookie de session `scn_session` (obtenu par `POST /api/auth/login`). Les méthodes non sûres exigent l’en-tête `X-CSRF-Token` (valeur renvoyée par la connexion ou `GET /api/auth/me`).
- Contexte d’association : en-tête `X-Scenorya-Association: <uuid>`.
- Erreurs : `{ statusCode, code, message, details? }` avec des codes stables : `UNAUTHENTICATED`, `CSRF_INVALID`, `NOT_MEMBER`, `MODULE_DISABLED`, `MODULE_READONLY`, `PERMISSION_DENIED`, `PRIVILEGE_ESCALATION`, `LAST_ADMIN`, `DEPENDENCIES_CONFIRMATION_REQUIRED`, `DEPENDENTS_CONFIRMATION_REQUIRED`, `WARNINGS_ACKNOWLEDGEMENT_REQUIRED`, `ACTIVE_RECORDS`, `VALIDATION_ERROR`, `TOO_MANY_ATTEMPTS`, `DUE_EXISTS`, `OVERPAYMENT`, `NO_RECEIPT`…

## Principales routes

| Méthode | Route | Règle |
|---|---|---|
| GET | `/setup/status` · POST `/setup` | public (jeton requis pour POST) |
| POST | `/auth/login` · `/auth/logout` · `/auth/password` | public / connecté |
| GET | `/auth/me` · `/auth/sessions` | connecté |
| GET | `/context` | membre |
| GET | `/hub/summary` | `hub.read` |
| GET/POST | `/admin/modules`, `/:id/preview-activation`, `/:id/activate`, `/:id/preview-deactivation`, `/:id/deactivate`, `/history` | `admin.modules.read` / `.admin` |
| GET/POST/PATCH | `/admin/users`, `/:id`, `/:id/disable`, `/:id/enable`, `/:id/reset-password` | `admin.users.*` |
| GET/POST/PATCH/DELETE | `/admin/roles`, `/admin/permissions` | `admin.roles.*` |
| GET | `/admin/audit`, `/verify`, `/export.csv` | `admin.audit.*` |
| GET/PUT | `/admin/association` | `admin.association.*` |
| GET/POST/PATCH | `/asso/members`, `/stats`, `/export.csv`, `/import`, `/:id`, `/:id/history`, `/:id/archive`, `/:id/restore` | `asso.members.*` |
| GET/POST/PATCH | `/asso/plans`, `/:id` | `asso.plans.*` |
| GET/POST | `/asso/dues`, `/summary`, `/renewals`, `/export.csv`, `/bulk`, `/:id`, `/:id/payments`, `/:id/payments/:paymentId/cancel`, `/:id/waive`, `/:id/cancel`, `/:id/receipt.pdf` | `asso.dues.*` |
| GET/PUT/POST | `/system/health`, `/associations`, `/instance-modules`, `/smtp`, `/smtp/test`, `/backups`, `/audit` | superadministrateur |
| GET | `/system/healthz` | public (sonde) |

Temps réel : Socket.IO, chemin `/api/realtime`, message `join { associationId }`, évènement `modules:changed`.

Les clés API, webhooks signés et intégrations externes (HelloAsso, Stripe, OSC/MIDI…) sont prévus dans les phases ultérieures.
