---
name: sync-drive
description: Synchronisation Drive↔GitHub multi-projets (PickInSitu, CapInSitu, Génération, Forme1, Family Office, Orbit, VizInSitu…) — à exécuter à chaque ouverture de session, ou quand l'utilisateur dit « ouverture de session », « synchronise », « commite et push », « une modif a été faite » après des modifications dans Drive.
---

# Synchronisation Drive ↔ GitHub (tous les projets)

L'utilisateur édite les fichiers de ses projets dans des dossiers Google Drive,
tous situés sous le dossier Drive **« claude »**
(`18177G5wXO760JCQYhsMUDfa8sKgQ0hKM`). Chaque projet correspond à un dépôt
GitHub (source de référence déployée sur Vercel). Le registre complet —
dossiers Drive, dépôts, branches, workflow, état de la dernière synchro par
fichier — est dans **`.drive-sync.json`** à la racine de `pick-in-situ`. Le
tableur Drive « Deploiements Vercel BC-Archi » est la référence humaine des
projets : le relire si le registre semble périmé ou si un dossier inconnu
apparaît.

## Procédure

1. **Inventorier Drive** : `list_recent_files` (connecteur Google Drive, tri
   `lastModified`, 15–20 entrées). Rattacher chaque fichier récent à un projet
   du registre via son `parentId` (dossier projet ou sous-dossier — en cas de
   doute, remonter la chaîne des parents avec `get_file_metadata`). Ignorer les
   dossiers hors registre non listés dans le tableur (dossiers d'affaires,
   obsidian-vault, outputs, claude-code-sessions-backup, `.claude`…).
   Un fichier est **modifié côté Drive** si son `modifiedTime` est postérieur à
   celui enregistré dans le registre (ou si son projet n'a aucune entrée).

2. **Pour chaque projet touché, préparer le dépôt** :
   - `pick-in-situ` est déjà cloné (`/home/user/pick-in-situ`) : `git fetch
     origin main` puis repartir de `origin/main` sur la branche désignée de la
     session (la branche distante est supprimée après chaque fusion de PR).
   - Autre dépôt pas encore dans la session : `add_repo` puis clone shallow
     dans `/workspace/<repo>` (suivre les consignes du résultat d'add_repo),
     `register_repo_root`, et `git config user.email noreply@anthropic.com &&
     git config user.name Claude`.
   - `repo: null` dans le registre (Orbit, VizInSitu) : ne rien commiter —
     signaler la modification à l'utilisateur et lui demander la destination
     (VizInSitu est déployé manuellement sur Hostinger).

3. **Comparer et rapatrier chaque fichier modifié** :
   - **Drive seul modifié** (cas courant) : `download_file_content` (résultat
     JSON sauvegardé → `jq -r '.content' <tool-result> | base64 -d >
     <repoPath>`), lire le diff pour comprendre et décrire le changement.
   - **GitHub seul modifié** : Drive est en retard. Le connecteur ne sait PAS
     remplacer un fichier Drive (seulement créer un doublon) : envoyer le
     fichier à jour via `SendUserFile` (display: attach) en demandant à
     l'utilisateur de remplacer sa copie Drive. Pas de doublon sans accord.
   - **Les deux modifiés** : fusion à 3 voies — base =
     `git show <baseCommit>:<repoPath>` ; `git merge-file <drive> <base>
     <version-repo>`. En cas de conflit, montrer les zones et demander
     arbitrage avant de commiter.
   - **Identiques** : mettre à jour le registre, rien d'autre.

4. **Vérifier avant de commiter** : pour les pages HTML statiques, test de
   fumée en Chromium headless (`/opt/pw-browsers/chromium-*/chrome-linux/chrome`
   + `playwright-core`, serveur statique sur le dossier du site) : chargement
   sans erreur JavaScript (ignorer les erreurs réseau `net::`/`ERR_`). Pour un
   projet Next.js/Node : lint ou build léger si disponible.

5. **Commiter, pousser, déployer** — selon le `workflow` du projet dans le
   registre :
   - `pick-in-situ` : branche désignée → push (`--force-with-lease` accepté si
     la branche ne porte que de l'historique déjà fusionné) → PR vers `main` →
     squash-merge (flux validé par l'utilisateur). Vercel suit `main`.
   - `bc-archi-capinsitu` : commit direct sur `master`, push. Vercel suit
     `master`.
   - Projet à la « première synchro » : regarder les branches du clone ; s'il
     n'y a que la branche par défaut avec des commits directs, faire pareil ;
     sinon demander à l'utilisateur. Consigner la décision dans le registre.
   Message de commit descriptif en français (conventionnel `feat:`/`fix:`).

6. **Mettre à jour `.drive-sync.json`** (dans pick-in-situ) : nouveaux
   `driveModifiedTime`, `baseCommit` = commit de synchro créé (sha court du
   squash pour pick-in-situ), nouvelles entrées de fichiers découvertes,
   décisions de workflow. Commiter ce registre via le flux pick-in-situ —
   regroupable avec une synchro pick-in-situ du même tour.

## Pièges connus

- Les timestamps Drive sont en UTC ; en cas de doute sur « qui a changé »,
  télécharger et comparer le contenu (diff), pas seulement les métadonnées.
- `download_file_content` renvoie du JSON `{content: base64}` sauvegardé dans
  un fichier tool-results : toujours passer par `jq -r '.content' | base64 -d`.
- Les `fileSize` renvoyés par Drive peuvent être légèrement périmés — seule la
  comparaison du contenu fait foi.
- Ne jamais pousser une version Drive par-dessus le dépôt sans diff préalable :
  une copie Drive basée sur une version périmée écraserait des correctifs faits
  directement sur GitHub — c'est ce que la fusion à 3 voies évite.
- Les commits de squash-merge créés par GitHub (committer `noreply@github.com`)
  ne doivent JAMAIS être amendés/réécrits pour satisfaire un hook de
  signature : aligner la branche, ne pas réécrire `main`.
- Le module photo-relevé existe en deux exemplaires divergents :
  `pick-in-situ/public/photo-releve.html` (actif) et
  `app-v3/photo-releve.html` (CapInSitu, d'où il a été migré) — ne pas les
  confondre lors du rattachement d'une modification.
