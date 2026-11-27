# Installation : Docker, Portainer et Nginx Proxy Manager

Cible : VPS Debian avec Docker, Portainer et Nginx Proxy Manager (NPM). Architecture : deux conteneurs (`scenorya`, `db`) ; PostgreSQL n’est jamais exposé hors du réseau Docker interne. Redis n’est pas encore requis (il le sera pour les files d’attente des phases 5 et 7).

## 1. Prérequis

- Docker 24+ avec Compose v2, ou Portainer 2.19+ ;
- un nom de domaine pointant vers le VPS ;
- Nginx Proxy Manager en conteneur.

Créez une fois le réseau partagé avec NPM et rattachez-y NPM :

```bash
docker network create npm_proxy
docker network connect npm_proxy <conteneur-nginx-proxy-manager>
```

## 2. Variables

Copiez `.env.example`. Obligatoires :

| Variable | Rôle |
|---|---|
| `APP_SECRET` | 32 caractères minimum (`openssl rand -base64 48`). Chiffre les secrets stockés : **à sauvegarder** ; le perdre rend illisibles le mot de passe SMTP et l’IBAN. |
| `POSTGRES_PASSWORD` | Mot de passe de la base. |
| `PUBLIC_URL` | URL publique, ex. `https://scenorya.mon-asso.fr`. En `https://`, les cookies sont automatiquement `Secure`. |

Facultatives : `SETUP_TOKEN`, `SCENORYA_BIND`/`SCENORYA_PORT`, `PROXY_NETWORK`, `SESSION_TTL_HOURS`, `BACKUP_RETENTION`.

## 3a. Ligne de commande

```bash
git clone <dépôt> scenorya && cd scenorya
cp .env.example .env && nano .env
docker compose up -d --build
docker logs scenorya | grep "Jeton"
```

## 3b. Portainer avec l’image publiée (recommandé)

La CI publie à chaque version l’image `ghcr.io/ticeconnect-dev/scenorya` (amd64 et arm64), étiquetée `latest`, par version et par commit.

1. Le dépôt étant privé, l’image l’est aussi : **Registries → Add registry → Custom registry**, URL `ghcr.io`, identifiant GitHub et un jeton personnel (*classic*) avec le seul droit `read:packages`.
2. **Stacks → Add stack → Web editor** : collez `docker-compose.portainer.yml`.
3. Variables : `APP_SECRET`, `POSTGRES_PASSWORD`, `PUBLIC_URL`, et `PROXY_NETWORK` = nom du réseau Docker de Nginx Proxy Manager (`docker network ls`).
4. **Deploy the stack**, puis journaux du conteneur `scenorya` → jeton d’installation.

Mise à jour : *Pull and redeploy* sur la pile (avec `SCENORYA_VERSION=latest`) ou changez `SCENORYA_VERSION`.

## 3c. Portainer en construisant depuis le dépôt

1. **Stacks → Add stack → Repository** : URL du dépôt Git, référence `refs/heads/main`, *Compose path* `docker-compose.yml` (la pile est construite par Portainer à partir du `Dockerfile`).
2. Section **Environment variables** : saisissez `APP_SECRET`, `POSTGRES_PASSWORD`, `PUBLIC_URL` (et les variables facultatives).
3. **Deploy the stack**, puis ouvrez les journaux du conteneur `scenorya` pour lire le jeton d’installation.

Images multi-architecture : le `Dockerfile` n’utilise que des bases officielles disponibles en `linux/amd64` et `linux/arm64` ; `docker buildx build --platform linux/amd64,linux/arm64 .` produit les deux (non vérifié dans l’environnement de développement, faute d’accès au registre Docker Hub).

## 4. Nginx Proxy Manager

*Hosts → Proxy Hosts → Add* :

- Domain : `scenorya.mon-asso.fr` ;
- Scheme `http`, Forward Hostname `scenorya`, Forward Port `3000` (le conteneur est joint par le réseau `npm_proxy`) ;
- **Websockets Support : activé** (synchronisation temps réel) ;
- Block Common Exploits : activé ;
- onglet SSL : certificat Let’s Encrypt, *Force SSL*, *HTTP/2*, *HSTS*.

Onglet *Advanced* recommandé (taille des imports CSV) :

```nginx
client_max_body_size 5m;
```

L’application fait confiance au premier proxy (`TRUST_PROXY=true`) pour l’adresse IP réelle, utilisée par la protection anti-force brute et le journal d’audit.

## 5. Premier démarrage

Ouvrez `https://scenorya.mon-asso.fr/installation` :

1. jeton d’installation ;
2. administrateur (devient superadministrateur de l’instance) ;
3. association ;
4. profil de départ et modules (présélection modifiable) ;
5. messagerie SMTP (facultative) ;
6. récapitulatif.

Le jeton est supprimé une fois l’installation terminée ; l’assistant ne peut pas être rejoué.

## 6. Mise à jour

```bash
# 1. Sauvegarde (Scenorya System → Sauvegardes, ou commande ci-dessous)
docker exec scenorya-db pg_dump -U scenorya -Fc scenorya > avant-maj.dump
# 2. Nouvelle version
git pull && docker compose up -d --build
```

Les migrations SQL versionnées s’appliquent au démarrage (`RUN_MIGRATIONS=true`) ; elles sont non destructives. Retour arrière : restaurer la sauvegarde (voir [sauvegarde-restauration.md](sauvegarde-restauration.md)) puis redéployer la version précédente.

## 7. Santé

- sonde publique : `GET /api/system/healthz` (utilisée par le `HEALTHCHECK` Docker) ;
- tableau détaillé : Scenorya System → Santé technique (superadministrateur).
