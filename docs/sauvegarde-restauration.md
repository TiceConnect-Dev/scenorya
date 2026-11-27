# Sauvegarde et restauration

## Ce qui est sauvegardé

| Élément | Où | Sauvegarde |
|---|---|---|
| Base PostgreSQL (toutes les associations, audit, configuration) | volume `scenorya-db` | Scenorya System → Sauvegardes (`pg_dump`, format personnalisé, SHA-256) |
| Sauvegardes produites | volume `scenorya-data`, dossier `backups/` | à copier hors du serveur |
| `APP_SECRET` | fichier `.env` / Portainer | **à conserver séparément** : indispensable pour relire les secrets chiffrés |

Aucun fichier utilisateur n’est encore stocké (Drive arrive en phase 2) ; ils seront ajoutés à la sauvegarde avec ce module.

## Sauvegarde depuis l’interface

Scenorya System → Sauvegardes → *Lancer une sauvegarde*. Rétention : `BACKUP_RETENTION` sauvegardes réussies (les plus anciennes passent à l’état *expirée* et leur fichier est supprimé). Chaque téléchargement est journalisé.

## Sauvegarde en ligne de commande

```bash
docker exec scenorya-db pg_dump -U scenorya -Fc scenorya > scenorya-$(date +%F).dump
sha256sum scenorya-*.dump
```

Planification conseillée en attendant les sauvegardes automatiques intégrées (phase 8) : une tâche `cron` quotidienne sur l’hôte avec copie distante.

## Restauration (procédure testée)

> La restauration remplace toutes les données. Elle n’est volontairement pas proposée dans l’interface web.

```bash
# 1. Vérifier l'empreinte
sha256sum scenorya-XXXX.dump      # comparer avec la valeur affichée dans Scenorya System

# 2. Arrêter l'application (la base reste démarrée)
docker stop scenorya

# 3. Recréer une base vide et restaurer
docker exec -i scenorya-db dropdb -U scenorya scenorya
docker exec -i scenorya-db createdb -U scenorya scenorya
docker exec -i scenorya-db pg_restore -U scenorya --no-owner --exit-on-error -d scenorya < scenorya-XXXX.dump

# 4. Redémarrer : les migrations manquantes éventuelles s'appliquent
docker start scenorya
```

Avec le **même `APP_SECRET`** que lors de la sauvegarde. Contrôle après restauration : Scenorya Admin → Journal d’audit → la chaîne doit être indiquée « intègre ».

Cette procédure a été exécutée lors du développement : base restaurée avec utilisateurs, associations, journal d’audit (déclencheurs d’inaltérabilité compris) et historique des migrations.

## Migration vers une autre instance

Même procédure sur le nouveau serveur, avec le même `APP_SECRET`. L’export/import d’une seule association est prévu en phase 8.
