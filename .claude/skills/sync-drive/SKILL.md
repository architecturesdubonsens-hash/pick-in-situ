---
name: sync-drive
description: Synchronisation Drive↔GitHub du projet pick-in-situ — à exécuter à chaque ouverture de session, ou quand l'utilisateur dit « ouverture de session », « synchronise », « commite et push » après des modifications dans Drive.
---

# Synchronisation Drive ↔ GitHub (pick-in-situ)

L'utilisateur édite les fichiers du projet dans le dossier Google Drive
**« pick in situ »** (miroir partiel du dépôt). GitHub (`main`) est la source de
référence déployée (Vercel). Cette skill décrit la synchro à faire en début de
session. L'état de la dernière synchro est dans **`.drive-sync.json`** (racine
du dépôt) : pour chaque fichier suivi — `repoPath`, `driveFileId`,
`driveModifiedTime` (à la dernière synchro) et `baseCommit` (commit dont le
contenu était commun aux deux côtés).

## Procédure

1. **Préparer le dépôt** : `git fetch origin main`, puis repartir de
   `origin/main` sur la branche de travail désignée (la branche distante est
   supprimée après chaque fusion de PR — c'est normal).

2. **Inventorier Drive** : `list_recent_files` (connecteur Google Drive,
   tri `lastModified`) ; repérer les fichiers du dossier « pick in situ »
   (IDs dans `.drive-sync.json`). Un fichier est **modifié côté Drive** si son
   `modifiedTime` est postérieur à celui enregistré. Il est **modifié côté
   GitHub** si `git show <baseCommit>:<repoPath>` diffère de la version
   `origin/main`.

3. **Selon le cas, pour chaque fichier suivi** :
   - **Drive seul modifié** (cas courant) : `download_file_content`
     (résultat JSON → `jq -r '.content' | base64 -d > <repoPath>`), lire le
     diff, puis flux normal (étapes 4–6).
   - **GitHub seul modifié** : Drive est en retard. Le connecteur ne sait PAS
     remplacer un fichier Drive (seulement créer un doublon) : envoyer le
     fichier à jour à l'utilisateur via `SendUserFile` (display: attach) en lui
     demandant de remplacer la copie dans Drive. Ne pas créer de doublon Drive
     sans accord explicite.
   - **Les deux modifiés** : fusion à 3 voies —
     `git show <baseCommit>:<repoPath> > /tmp/base` ; version Drive téléchargée
     dans `/tmp/drive` ; `git merge-file /tmp/drive /tmp/base <repoPath>` puis
     copier le résultat dans `<repoPath>`. En cas de conflit, montrer les zones
     en conflit à l'utilisateur et demander arbitrage avant de commiter.
   - **Identiques** (l'utilisateur a rafraîchi sa copie Drive) : mettre à jour
     `driveModifiedTime` dans `.drive-sync.json`, rien d'autre.

4. **Vérifier avant de commiter** : test de fumée des pages modifiées de
   `public/` en Chromium headless (`/opt/pw-browsers/chromium-*/chrome-linux/chrome`
   + `playwright-core`, serveur statique sur `public/`) : la page doit se
   charger sans erreur JavaScript (ignorer les erreurs réseau `net::`/`ERR_`).

5. **Mettre à jour `.drive-sync.json`** : nouveaux `driveModifiedTime`, et
   `baseCommit` = le commit de synchro qui va être créé (le renseigner après
   coup ou utiliser le sha court du commit de squash de la PR).

6. **Commiter, pousser, fusionner** : message de commit descriptif en français
   (conventionnel `feat:`/`fix:`), push sur la branche désignée
   (`--force-with-lease` accepté si la branche ne porte que de l'historique
   déjà fusionné), PR vers `main`, fusion en squash — l'utilisateur a validé ce
   flux ; Vercel redéploie `main` automatiquement.

## Pièges connus

- Les timestamps Drive sont en UTC ; en cas de doute sur « qui a changé »,
  télécharger et comparer le contenu (diff), pas seulement les métadonnées.
- `download_file_content` renvoie du JSON `{content: base64}` sauvegardé dans
  un fichier tool-results : toujours passer par `jq -r '.content' | base64 -d`.
- Ne jamais pousser une version Drive par-dessus `main` sans diff préalable :
  une copie Drive basée sur une version périmée écraserait des correctifs
  faits directement sur GitHub — c'est précisément ce que la fusion à 3 voies
  (cas « les deux modifiés ») évite.
