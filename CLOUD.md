# Consignes pour une session cloud (claude.ai/code)

**Ce fichier ne vaut que si tu es dans une session cloud** : conteneur Linux, pas de
`D:\work`, pas de `C:\Users\...`. Sur le PC de l'utilisateur, ignore-le : `AGENTS.md`
et le `CLAUDE.md` global font foi.

Écrit le 02/10/2026. Pourquoi il existe : une session cloud ne voit ni le tableau, ni
le `CLAUDE.md` global, ni `insitu-tasks.ps1`. Sans ces consignes, elle travaille hors
tableau et peut pousser en production.

## Règles

- **Identité** : `claude-cloud`. C'est le nom à porter dans `assigne_a` et dans les rapports.
- **Branche** : travaille sur une branche `claude/<sujet>` et ouvre une pull request.
  **Ne pousse jamais sur `master` ni sur `main`** : tout push sur le tronc déclenche
  un déploiement Vercel, donc une mise en production.
- **Périmètre** : ce dépôt uniquement. Tu ne peux pas, et ne dois pas essayer de, modifier un autre dépôt.
- **Tableau** : consulte `dev_delegated_tasks` avant de modifier un fichier. Si la tâche
  est déjà prise par un autre agent, ne la reprends pas. Ne valide jamais ton propre travail.
- **Si Supabase est inaccessible** (réseau bloqué, variable absente) : ne t'arrête pas.
  Continue le travail sur le dépôt, écris dans ton rapport que le tableau n'a pas pu être
  consulté et pourquoi, et laisse l'utilisateur prendre ou soumettre la tâche depuis le PC.
  Une réponse vide ne prouve pas que le tableau est vide : dis « non vérifié ».
- **Preuve** : cite la commande lancée et sa sortie, pas seulement « c'est fait ».
- **Secrets** : ne recopie jamais une clé, même partielle, dans un commit, un rapport
  ou une réponse. Cite son emplacement et sa forme.
- **Langue** : français.
- **Dépôt** : `pick-in-situ` (branche de base : `main`). Dans le tableau, ne traite que les tâches dont le champ Dépôt ou Projet correspond à ce dépôt ; si tu ne trouves pas la correspondance, dis-le au lieu de deviner.
