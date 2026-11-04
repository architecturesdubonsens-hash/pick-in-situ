# Qui appelle les tables bim_* — rapport pour PICK-RLS-BIM-1 — 04/11/2026

Établi par recherche textuelle sur le dépôt (`grep -rIn "bim_"` hors `node_modules`) et lecture du code. Rien n'a été
exécuté contre une base réelle.

## Appelants dans ce dépôt

**Un seul fichier appelle les tables `bim_*` : `components/ViewerMulti.tsx`, 25 appels**, tous par le client Supabase
du navigateur (`db` = `supabase.schema("pick_in_situ")`, `lib/supabase.ts`) et donc avec la **session de l'utilisateur
connecté** quand il y en a une.

| Table | Lecture | Création | Modification | Suppression |
|---|---|---|---|---|
| `bim_murs` | ligne 580 | 782, 814, 816 | 789 | 795, 824 |
| `bim_ouvertures` | 586 | 850 | 821, 822, 858 | 870 |
| `bim_dalles` | 589 | 879 | 886 | 892 |
| `bim_toits` | 591 | 956 | 963 | 969 |
| `bim_ancres` | 593 | 1001 | 1014 | 1007 |

Le composant n'est monté qu'à un endroit : `app/chantier/[id]/page.tsx`, qui appelle `useRequireAuth()` (redirection
vers `/login` sans session). Les écritures portent `chantier_id` pris dans l'URL du chantier ouvert.

## Appels sans session utilisateur : aucun dans le dépôt

- `components/ViewerMulti.tsx` : tous les appels se font depuis une page derrière `useRequireAuth`.
- Application iOS (`ios/`) : écrit `scans` et le stockage avec la clé publique, jamais `bim_*`.
- `runpod-worker/`, `public/*.html`, `app/api/*` : aucun appel à `bim_*`.
- `lib_jev/jev_client.mjs` : la chaîne `bim_tapir` y est un nom de flux, pas une table.

## Ce qui n'est pas établi

- Les appelants **hors dépôt** (autres applications branchées sur le même projet Supabase) : non vérifié.
- `useRequireAuth` est une redirection côté navigateur : elle protège l'interface, pas les données. C'est la raison de
  fond de la migration.
- Constat voisin, hors périmètre : l'application iOS envoie la clé publique comme jeton (`Authorization: Bearer`) pour
  écrire dans `scans`, dont la politique exige `auth.uid()`. Cette écriture devrait être refusée tant qu'aucune session
  utilisateur n'est posée ; non éprouvé, à vérifier séparément.
