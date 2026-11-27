# Journal des modifications

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) — versionnage sémantique.

## [0.1.0] — 2026-11-27

Première version : fondations de la plateforme et système modulaire.

### Ajouté

- Identité Scenorya : pack graphique officiel intégré localement, variantes recadrées, favicon et icônes PWA générés depuis l’icône principale, logos clair/sombre, emblèmes dans le lanceur, pictogrammes SVG dans les menus.
- Registre central des 22 modules (identité, catégorie, dépendances strictes, intégrations, fonctionnalités conditionnelles, état d’implémentation) partagé serveur/client.
- Résolution des états de modules, plans d’activation/désactivation, profils de départ (association simple, théâtre, événementiel, personnalisé).
- Assistant de première configuration avec jeton d’installation.
- Authentification par session, CSRF, anti-force brute, mot de passe provisoire, sessions actives et révocation.
- Multi-associations avec isolation stricte ; 19 rôles prédéfinis ; rôles personnalisés ; matrice des permissions ; accès temporaires ; anti-escalade ; protection du dernier administrateur.
- Scenorya Admin : modules et fonctionnalités (recherche, catégories, états, activation avec dépendances, désactivation avec conséquences, lecture seule, historique), utilisateurs, rôles, journal d’audit, fiche de l’association (IBAN chiffré).
- Scenorya System : associations, disponibilité des modules sur l’instance, santé technique, SMTP chiffré avec test d’envoi, sauvegardes `pg_dump` avec SHA-256 et rétention, journal de l’instance.
- Scenorya Hub : tableau de bord selon droits et modules.
- Scenorya Asso : fichier des adhérents (numérotation, catégories, statuts, données sensibles, mineurs, archivage/restauration, import CSV avec simulation, export CSV, historique).
- Journal d’audit en ajout seul, chaîné SHA-256, vérification d’intégrité.
- Synchronisation temps réel des changements de modules (Socket.IO).
- Recherche globale (/ ou Ctrl+K), mode sombre, interface responsive, PWA.
- Dockerfile multi-étapes, docker-compose compatible Portainer, `.env.example`, documentation française.
- 48 tests automatisés.
