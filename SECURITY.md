# Sécurité de Scenorya

## Mesures en place (v0.1.0)

| Domaine | Mesure | Vérification |
|---|---|---|
| Accès | Garde globale à refus par défaut ; toute route doit déclarer sa règle | test automatique sur toutes les routes |
| Autorisations | Vérifiées côté serveur à chaque requête : appartenance, module, lecture seule, permission | tests e2e |
| Moindre privilège | Activer un module ne donne aucun droit ; superadministrateur sans accès implicite aux données | tests e2e |
| Anti-escalade | On ne peut accorder ni retirer un droit que l’on ne détient pas ; rôle administrateur non modifiable ; un administrateur actif toujours conservé | tests e2e |
| Comptes partagés | Réinitialisation du mot de passe d’un compte présent dans plusieurs associations réservée au superadministrateur | code |
| Mots de passe | Argon2id (19 Mio, t=2), 12 caractères minimum, mot de passe provisoire à changer | — |
| Sessions | Jeton aléatoire 256 bits, stocké haché (SHA-256), cookie `httpOnly`, `SameSite=Lax`, `Secure` en HTTPS, expiration glissante, révocation, liste des sessions | — |
| CSRF | Jeton par session exigé dans `X-CSRF-Token` pour toute méthode non sûre, comparaison à temps constant | test e2e |
| Force brute | 5 échecs par compte ou 30 par IP sur 15 min → 429 ; vérification factice pour les comptes inexistants | test e2e |
| Installation | Jeton d’installation obligatoire, transaction verrouillée, aucun compte par défaut | tests e2e |
| Isolation | `association_id` sur toutes les requêtes métier ; en-tête d’association vérifié contre l’appartenance | tests e2e |
| Données sensibles | IBAN et mot de passe SMTP chiffrés (AES-256-GCM, clé dérivée d’`APP_SECRET`) ; champs sensibles des adhérents masqués sans droit dédié | test e2e |
| Finances | Montants en centimes entiers ; verrou de ligne contre les trop-perçus simultanés ; règlements inaltérables (déclencheur PostgreSQL), annulation motivée et journalisée | tests e2e |
| Audit | Journal en ajout seul (déclencheurs PostgreSQL refusant UPDATE/DELETE/TRUNCATE), chaîné par SHA-256, vérification d’intégrité ; secrets masqués | tests e2e |
| En-têtes | Helmet, CSP stricte (`script-src 'self'`), `frame-ancestors 'none'` | — |
| Injections | Requêtes paramétrées (Drizzle), validation zod de toutes les entrées, neutralisation des formules dans les exports CSV | test e2e |
| Temps réel | Authentification avant connexion ; abonnement soumis à l’appartenance | test e2e |
| Infrastructure | PostgreSQL non exposé ; application liée à 127.0.0.1 par défaut ; conteneur non root ; aucun terminal ni commande arbitraire dans l’interface ; restauration hors interface | — |
| Fichiers (Drive) | Exécutables refusés par extension **et** par signature (MZ, ELF, Mach-O, `#!`) ; type MIME déduit du nom, jamais du navigateur ; SVG/HTML toujours téléchargés ; aperçus servis avec `nosniff`, `CSP: sandbox` (sauf PDF), `no-store` ; noms nettoyés ; contenu stocké sous son empreinte (aucun chemin fourni par l’utilisateur) ; fichiers temporaires supprimés même en cas d’erreur | tests e2e |
| Dossiers restreints | Visibilité calculée côté serveur sur toute la chaîne de dossiers parents (liste, recherche, favoris, téléchargement, corbeille) ; sortir un document d’un dossier restreint ou le partager publiquement est réservé aux administrateurs de Drive | tests e2e |
| Liens de partage | Jeton 192 bits stocké haché ; expiration obligatoire (90 jours max) ; mot de passe Argon2id facultatif ; verrouillage 15 min après 10 échecs ; limite de téléchargements atomique ; révocation immédiate, et automatique à la suppression du document ; suspendus si Drive est désactivé ; accès journalisés | tests e2e |
| Espace personnel | Chaque route `espace/*` ne lit que la fiche reliée au compte connecté (aucun identifiant d’adhérent accepté) ; coordonnées modifiables limitées à une liste blanche et journalisées ; procès-verbal communiqué seulement après clôture ; documents limités aux dossiers publiés | tests e2e |
| Invitations | Jeton 192 bits haché, usage unique (verrou de ligne), 14 jours, révoqué par une nouvelle invitation ; un compte existant doit être connecté avec l’adresse invitée ; redirection après connexion limitée aux chemins internes | tests e2e |
| PWA | Le service worker ne met jamais en cache `/api` | configuration |

## Limites connues

- Pas encore d’authentification à deux facteurs (TOTP), de vérification d’adresse e-mail ni de réinitialisation de mot de passe par e-mail (phase 8 / phase 7).
- Pas de politique de conservation automatisée ni d’outil d’export/effacement RGPD (phase 8).
- Pas d’analyse antivirus des documents déposés dans Drive (les exécutables sont refusés ; une analyse ClamAV est envisagée en phase 8).
- Protection anti-force brute stockée en base : suffisante pour une instance, à compléter par un limiteur au niveau du proxy.
- `npm audit` : une alerte modérée subsiste dans `drizzle-kit` (esbuild, serveur de développement), outil non embarqué dans l’image de production.
- Audit de sécurité externe non réalisé.

## Responsabilités de l’association

Scenorya fournit des outils ; il ne rend pas automatiquement conforme au RGPD ni aux obligations comptables et fiscales. L’association reste responsable de son registre des traitements, de l’information des personnes, des durées de conservation, des droits attribués, de la protection d’`APP_SECRET` et des sauvegardes hors site.

## Signaler une vulnérabilité

Contact privé auprès de TiceConnect (adresse à définir avant publication). Merci de ne pas ouvrir de ticket public.
