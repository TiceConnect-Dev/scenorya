# Feuille de route

Légende : ✅ fait et testé · 🟡 partiel · ⏳ à faire

## Phase 1 — Fondations

- ✅ Monorepo, registre des modules, graphe de dépendances, profils
- ✅ Base PostgreSQL, migrations versionnées, déclencheurs d’inaltérabilité de l’audit
- ✅ Assistant d’installation (jeton, administrateur, association, modules, SMTP)
- ✅ Authentification par session, CSRF, anti-force brute, changement de mot de passe, sessions actives
- ✅ Multi-associations, rôles prédéfinis (19 modèles) et personnalisés, matrice des droits, accès temporaires
- ✅ Modules par association et par instance, lecture seule, analyse d’impact, historique, temps réel
- ✅ Journal d’audit chaîné, export CSV, vérification
- ✅ Interface : en-tête, lanceur, recherche globale, navigation, fil d’Ariane, mode sombre, responsive, PWA
- ✅ Docker, Compose/Portainer, documentation NPM, sauvegarde `pg_dump`, restauration documentée et testée
- 🟡 Portées de permission par ressource (modèle de données et vérification prêts ; utilisation avec Show, caisses, dossiers)
- ⏳ Personnalisation du logo et des couleurs de l’association dans l’interface (couleur enregistrée, logo à venir avec Drive)

## Phase 2 — Gestion associative

- 🟡 Asso : fiches, numérotation, catégories, statuts, mineurs/représentants, droit à l’image, archivage, import/export CSV, historique
- ✅ Asso : formules, cotisations, règlements, reçus PDF, renouvellements
- ✅ Asso : groupes et commissions, champs personnalisés, cartes d’adhérent QR avec vérification publique
- ⏳ Asso : export Excel/PDF, formulaire d’adhésion en ligne, photo
- ⏳ Gouvernance (AG, CA, convocations, procès-verbaux)
- ✅ Agenda : événements, récurrences, participants, conflits, export et abonnement iCal
- ⏳ Agenda : vue année, planning par ressource, réservations de salles (avec Booking)
- ⏳ Cast, Projects, Drive, Espace

## Phase 3 — Gestion technique

⏳ Stock, Booking, Maintenance, salles et locaux, QR codes et étiquettes

## Phase 4 — Spectacles et régie

⏳ Service d’événements partagé, Show, Régie (conduite, tops, modes, synchronisation, cartoucheur, hors connexion)

## Phase 5 — Billetterie et caisse

⏳ Tickets (plans de salle, réservations atomiques), paiements (HelloAsso/Stripe), billets PDF/QR, Scan (atomique + hors ligne), POS ; fournisseurs d’impact bloquants (ventes ouvertes, caisses ouvertes) ; Redis

## Phase 6 — Comptabilité

⏳ Finance (partie double, centimes, FEC), Factures

## Phase 7 — Sites et communication

⏳ Web (CMS par blocs, thèmes artistiques), Com (SMTP en file, newsletters, notifications push)

## Phase 8 — Finalisation

⏳ Analytics, widgets personnalisables, 2FA TOTP, RGPD (export, effacement, conservation), sauvegardes planifiées et S3, export/import d’association, notifications de version, audit d’accessibilité RGAA, tests de charge
