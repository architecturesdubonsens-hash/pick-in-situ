<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Ouverture de session : synchronisation Drive ↔ GitHub

L'utilisateur édite les fichiers de `public/` dans le dossier Google Drive
« pick in situ ». À chaque ouverture de session (ou sur « synchronise »,
« commite et push »), exécuter la skill **`sync-drive`**
(`.claude/skills/sync-drive/SKILL.md`) : elle compare Drive et `origin/main`
via `.drive-sync.json`, fusionne à 3 voies si les deux côtés ont changé, et
décrit le flux commit → push → PR → squash-merge validé par l'utilisateur.
