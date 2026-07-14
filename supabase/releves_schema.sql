-- ============================================================================
-- Schéma de référence — pipeline photogrammétrie (photo-relevé)
-- ============================================================================
-- DOCUMENTATION UNIQUEMENT : ce fichier reflète l'état réel du projet Supabase
-- partagé fnfrusblyzndbzckkfir au 14/07/2026 (extrait via information_schema /
-- pg_policy). La table et le bucket ont été créés à la main dans le dashboard,
-- sans migration versionnée — ce fichier comble ce manque. Ne pas l'exécuter
-- tel quel sur le projet existant.
--
-- Historique : module porté depuis CapInSitu (app-v3) le 14/07/2026.
-- Consommateurs :
--   - public/photo-releve.html + public/viewer.html (clé anon, lecture/écriture)
--   - app/api/odm-proxy/route.ts (service_role, URLs signées)
--   - runpod-worker/worker.py (service_role, download photos + upload livrables
--     + mise à jour statut)
--   - app/upload/page.tsx (clé anon, listing des relevés terminés + import GLB)
-- ============================================================================

-- ── Table des relevés photogrammétriques (schéma public, PAS pick_in_situ) ──
create table public.releves (
  id            uuid primary key default gen_random_uuid(),
  nom           text not null,
  projet_id     text,                          -- lien projet libre (non contraint)
  date          date default current_date,
  statut        text default 'pending',        -- pending → downloading → processing
                                               -- → uploading → completed | failed
  bbox          jsonb,                         -- emprise géographique optionnelle
  nb_photos     integer,
  options       jsonb,                         -- {preset, pc_quality, avertissement…}
  runpod_job_id text,                          -- id du job RunPod en cours
  fichiers      jsonb,                         -- chemins livrables {laz, e57, copc,
                                               --  web_laz, obj, glb, fbx, ortho…}
  erreur        text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- RLS activée mais policy totalement permissive (accès complet à tous les
-- rôles, y compris anon). C'est le modèle de sécurité actuel assumé : les
-- pages HTML statiques utilisent la clé anon sans compte utilisateur.
-- ⚠️ À DURCIR lors de l'intégration à l'auth PickInSitu (filtre par user/org).
alter table public.releves enable row level security;
create policy releves_all on public.releves
  for all using (true) with check (true);

-- ── Bucket Storage `releves` ─────────────────────────────────────────────────
-- Privé (public=false), accès via URLs signées / endpoint authenticated + anon.
-- Taille max fichier : 2 Gio.
-- Arborescence : {releve_id}/photos/*   (photos sources, purgeables)
--                {releve_id}/pointcloud/points{.laz,.e57,.copc.laz,_web.laz}
--                {releve_id}/mesh/mesh{.obj,.glb,.fbx}
--                {releve_id}/odm_orthophoto/odm_orthophoto.tif
--                {releve_id}/patch.json
-- insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
-- values ('releves', 'releves', false, 2147483648,
--         array['image/jpeg','image/png','image/tiff','application/octet-stream',
--               'application/json','model/obj','model/gltf-binary','model/gltf+json']);

-- Policies storage.objects (permissives, mêmes réserves que ci-dessus) :
create policy releves_insert on storage.objects
  for insert with check (bucket_id = 'releves');
create policy releves_select on storage.objects
  for select using (bucket_id = 'releves');
create policy releves_update on storage.objects
  for update using (bucket_id = 'releves');

-- ============================================================================
-- Variables d'environnement du pipeline (pour mémoire)
-- ============================================================================
-- Vercel (app/api/odm-proxy/route.ts) :
--   BC_KEY               clé applicative partagée, vérifiée en header X-BC-Key
--   RUNPOD_API_KEY       clé API RunPod
--   RUNPOD_ENDPOINT_ID   alfkh0yfkkfukq (endpoint sain du 01/07/2026)
--   SUPABASE_URL         https://fnfrusblyzndbzckkfir.supabase.co
--   SUPABASE_SERVICE_KEY clé service_role
--
-- Template d'endpoint RunPod (runpod-worker/worker.py) :
--   SUPABASE_URL         idem
--   SUPABASE_KEY         ⚠️ MÊME clé service_role que SUPABASE_SERVICE_KEY côté
--                        Vercel, sous un NOM DIFFÉRENT — incohérence historique
--                        assumée, ne pas renommer sans redéployer l'endpoint.
--   ODM_TIMEOUT_S        watchdog interne ODM (défaut 2400 s)
-- ============================================================================
