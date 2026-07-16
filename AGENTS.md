<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Ouverture de session : synchronisation Drive ↔ GitHub

L'utilisateur édite les fichiers de TOUS ses projets (PickInSitu, CapInSitu,
Génération, Forme1, Family Office…) dans des dossiers Google Drive sous le
dossier « claude ». À chaque ouverture de session (ou sur « synchronise »,
« commite et push », « une modif a été faite »), exécuter la skill
**`sync-drive`** (`.claude/skills/sync-drive/SKILL.md`) : elle rattache les
fichiers Drive récemment modifiés à leur projet via le registre
`.drive-sync.json`, fusionne à 3 voies si les deux côtés ont changé, et
applique le workflow de commit/déploiement propre à chaque dépôt.
