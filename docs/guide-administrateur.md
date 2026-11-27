# Guide administrateur

## Rôles : instance et association

- **Superadministrateur** (créé par l’assistant) : gère l’instance dans Scenorya System — associations, modules disponibles, messagerie, sauvegardes, santé. Il n’a pas d’accès implicite aux données des associations dont il n’est pas membre.
- **Administrateur associatif** : tous les droits sur son association (rôle non modifiable). Au moins un administrateur actif est toujours conservé.

## Activer ou désactiver un module

Scenorya Admin → **Modules et fonctionnalités**.

- Filtrez par catégorie, état ou texte.
- *Activer…* affiche les dépendances qui seront activées et les fonctionnalités débloquées.
- *Lecture seule…* (clôture) : les données restent consultables, toute modification est refusée.
- *Désactiver…* affiche les modules dépendants, les fonctionnalités perdues et les conséquences ; une confirmation explicite est demandée. Les données sont conservées et retrouvées à la réactivation.
- Activer un module ne donne aucun droit : attribuez les permissions ensuite.

## Utilisateurs

Scenorya Admin → **Utilisateurs** → *Ajouter* : nom, e-mail, mot de passe provisoire (changé obligatoirement à la première connexion), rôles, date d’expiration facultative (accès temporaire). Un compte existant (même e-mail) est simplement rattaché à l’association.

Actions : modifier les rôles et l’expiration, définir un mot de passe provisoire (ferme les sessions de l’utilisateur), désactiver/réactiver l’accès.

## Supprimer

Tout ce que vous créez peut être supprimé (bouton **Supprimer**). La suppression est définitive et inscrite au journal d’audit, qui conserve la trace de ce qui a été effacé.

- Quand elle a des conséquences importantes (règlements encaissés, reçus émis, procès-verbal figé), Scenorya les détaille et demande une seconde confirmation.
- Un adhérent cité dans un procès-verbal clôturé est **anonymisé** plutôt qu’effacé : le document reste intact, mais ses données personnelles disparaissent.
- Pour un simple arrêt d’activité, préférez *Archiver* (adhérents, groupes, projets), *Terminer* (mandats) ou *Annuler* (événements) : rien n’est perdu et tout reste restaurable.
- Supprimer une association (Scenorya System) efface toutes ses données et ses documents. Faites une sauvegarde avant ; la saisie du nom exact de l’association est exigée.

## Rôles et permissions

Scenorya Admin → **Rôles et permissions** : matrice module × ressource × action. Choisissez les rôles affichés, cochez/décochez, puis *Enregistrer* sous la colonne. Une case grisée cochée est couverte par un joker (ex. `asso.*`). Vous ne pouvez accorder ou retirer que des droits que vous possédez.

Droit particulier : **Adhérents — Consulter les données sensibles** (date de naissance, adresse, représentant légal, notes).

## Journal d’audit

Toutes les opérations importantes sont tracées (connexions, modules, droits, fiches, exports). Le bandeau indique l’intégrité de la chaîne. Export CSV avec le droit dédié.

## Fiche de l’association

RNA, SIRET, coordonnées, couleur principale, début d’exercice, assurance, IBAN (chiffré ; droit « données sensibles » requis).

## Cotisations

Scenorya Asso → **Formules** : créez vos tarifs (montant, période couverte, catégorie attribuée au règlement). Retirer une formule conserve l’historique.

**Cotisations** : *Appeler une cotisation* (ou depuis la fiche adhérent). Ouvrez une cotisation pour enregistrer un ou plusieurs règlements ; le reçu PDF numéroté est émis dès que le montant est intégralement réglé et l’adhésion passe en « active ». Un règlement erroné ne se modifie pas : il s’annule avec un motif (le reçu est alors annulé et un nouveau numéro sera attribué). Exonération et annulation exigent aussi un motif.

**Renouvellements** : liste des adhérents non couverts sur la période choisie ; sélectionnez-les et appelez la cotisation en une fois.

Le reçu de cotisation n’est **pas un reçu fiscal** (Cerfa 11580) : il le précise explicitement.

## Groupes, champs et cartes

- **Groupes et commissions** : créez un groupe (commission, troupe, bureau…), ajoutez des adhérents avec leur fonction. La liste des adhérents se filtre par groupe.
- **Champs personnalisés** : ajoutez vos propres informations (taille de costume, permis…). Un champ « sensible » n’est visible qu’avec le droit « données sensibles ». Archiver un champ le masque sans effacer les valeurs.
- **Cartes d’adhérent** : depuis la fiche (carte unitaire) ou « Cartes d’adhérent » (planche A4 de 10, tous les actifs ou un groupe). Le QR code renvoie vers une page publique qui indique si l’adhésion est valide aujourd’hui ; il ne contient aucune donnée personnelle. En cas de perte : « Révoquer la carte ».

## Agenda

Scenorya Agenda → **Planning** : vues mois, semaine et liste. *Nouvel événement* : type, lieu, horaires ou journée entière, répétition (jours de la semaine, intervalle, date de fin), participants (adhérents ou groupes entiers). Les conflits de participants ou de lieu s’affichent pendant la saisie. Cliquez sur un événement pour enregistrer les réponses (présent, excusé), inviter d’autres personnes, annuler une seule date ou toute la série.

**Agenda sur mon téléphone** : chaque utilisateur peut créer son lien d’abonnement personnel ; il cesse de fonctionner s’il le révoque ou perd ses droits.

## Projets et tâches

Scenorya Projects → **Modèles** : installez le modèle fourni « Organisation d’un spectacle » ou créez les vôtres (échéances relatives : J-30, J+1…). **Projets** → *Nouveau projet* : partez d’un modèle et indiquez la date de référence (ex. première représentation) ; les échéances sont calculées.

Sur le tableau, glissez les cartes d’une colonne à l’autre (ou utilisez le sélecteur « Déplacer » de chaque carte). Une personne responsable d’une tâche peut changer son état, cocher la checklist et commenter, même sans droit de modification. **Mes tâches** regroupe les tâches de chacun.

## Documents (Scenorya Drive)

- **Premiers pas** : Drive vide → *Créer les espaces recommandés*. Administratif et Comptabilité sont restreints aux rôles du bureau ; les autres dossiers sont ouverts à tous les utilisateurs ayant accès à Drive.
- **Envoyer** : bouton *Envoyer des fichiers* ou glisser-déposer sur la liste. Un document du même nom est soit conservé en copie numérotée, soit ajouté comme nouvelle version (choix sous la barre d’outils). Programmes et scripts sont refusés.
- **Versions** : *Détails* d’un document → historique, téléchargement d’une ancienne version, *Restaurer* (crée une nouvelle version identique : rien n’est perdu).
- **Accès restreint** : *Accès* sur un dossier (droit `drive.files.admin`) → cocher les rôles autorisés. La restriction couvre les sous-dossiers. Sortir un document d’un dossier restreint ou le partager publiquement est réservé aux administrateurs de Drive.
- **Partager hors de l’association** : *Détails* → *Créer un lien de partage* (validité, mot de passe, nombre de téléchargements). Le lien n’est affiché qu’une fois. *Liens de partage* liste les liens actifs ; la révocation est immédiate. Supprimer le document révoque ses liens.
- **Corbeille** : conservation 30 jours ; un dossier revient avec tout son contenu. Le quota compte aussi les versions et la corbeille : videz-la pour libérer de la place.
- **Quota** : fixé par le superadministrateur dans *Scenorya System → Stockage* (5 Go par défaut).
- **Traçabilité** : *Journal des accès* (qui a ouvert ou téléchargé quoi, y compris par lien public) ; les modifications sont dans le journal d’audit.
- **Associations existantes** : les nouvelles permissions Drive ne sont pas ajoutées automatiquement aux rôles déjà créés ; ajoutez-les dans *Admin → Rôles* (les administrateurs les ont déjà).

## Espace personnel des adhérents (Scenorya Espace)

- **Activer** Scenorya Espace (Admin → Modules), puis, sur la fiche d’un adhérent, *Inviter à l’Espace*. L’invitation part par e-mail si la messagerie est configurée ; sinon (ou au choix) copiez le lien et transmettez-le. Le lien est valable 14 jours ; une nouvelle invitation annule la précédente.
- L’adhérent choisit son mot de passe et arrive directement dans son espace. S’il a déjà un compte Scenorya avec cette adresse, il se connecte puis accepte l’invitation. Vous pouvez aussi *Relier à un compte existant* de l’association.
- Le compte reçoit le rôle « Adhérent » (permission `espace.read`), sauf s’il a déjà accès à l’Espace par un autre rôle. Il ne voit **que sa propre fiche** : jamais la liste des adhérents.
- Ce que voit l’adhérent : son adhésion et sa validité, ses coordonnées (e-mail de contact, téléphone, adresse, droit à l’image — modifiables, chaque changement est journalisé), ses cotisations et reçus, sa carte d’adhérent, les événements où il est invité (avec réponse de présence), les réunions où il est convoqué (convocation, puis procès-verbal après clôture) et les documents des dossiers Drive publiés dans l’Espace (*Drive → Accès → Publier dans l’Espace des membres*).
- *Retirer l’accès* détache la fiche du compte (le compte n’est pas supprimé).

## Distributions et répétitions (Scenorya Cast)

- **Production** : *Nouvelle production* (titre, auteur, saison, état, date de la première).
- **Distribution** : ajoutez les rôles, puis pour chacun *+ Titulaire* ou *+ Doublure*. Une personne « pressentie » n’est pas encore convoquée ; *confirmer* la rend effective. *Distribution (PDF)* imprime la distribution et la présence par scène.
- **Scènes** : découpez la pièce (acte, numéro, titre) et cochez les personnages présents. C’est ce tableau qui détermine les convocations.
- **Répétitions** : *Planifier une répétition*, choisissez les scènes (ou le filage) : la liste des convoqués s’affiche aussitôt, avec en rouge les indisponibilités, les autres répétitions et les événements d’agenda au même moment. Avec Scenorya Agenda, la répétition apparaît dans l’agenda des convoqués, qui répondent depuis leur espace ; changer la distribution ou les scènes met les convocations à jour. *Feuille de service (PDF)* : convoqués, rôles, téléphones, remarques.
- **Indisponibilités** : saisissez-les dans *Indisponibilités*, ou laissez chaque comédien les déclarer dans son espace (*Mes rôles et répétitions*).
- Tout se supprime : rôles, distribution, scènes, répétitions (avec leur événement d’agenda), indisponibilités, production entière.

## Gouvernance

Scenorya Asso → **Mandats** : enregistrez le bureau et le CA ; la présidence et le secrétariat en exercice signent les documents. **Instances et AG** → *Nouvelle réunion* : type, date, lieu, quorum et limite de procurations selon vos statuts, ordre du jour. Ajoutez les convoqués (tous les adhérents actifs, des groupes ou des personnes), puis *Convoquer* : envoi par e-mail avec la convocation et un pouvoir en PDF (si la messagerie est configurée), ou simple marquage pour une diffusion manuelle.

En séance : pointez les présences et procurations (le quorum se calcule), saisissez les délibérations et leurs voix, rédigez le compte rendu. *Clôturer* fige définitivement le procès-verbal ; il reste téléchargeable.

## Adhérents

Scenorya Asso → **Adhérents** : recherche, filtres, tri, pagination, export CSV (formules neutralisées, compatible Excel). **Importer (CSV)** : simulation obligatoire avant import, rapport ligne par ligne.
