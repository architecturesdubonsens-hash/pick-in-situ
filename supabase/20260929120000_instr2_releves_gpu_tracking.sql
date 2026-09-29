-- =============================================================================
-- Migration Supabase : Traçabilité GPU & Rapprochement RunPod — INSTR-2
-- Complète public.releves avec colonnes dédiées pour le temps GPU facturé,
-- le délai de file d'attente et la durée totale bout en bout.
-- Vue v_couts_releves_photo pour le calcul du COGS par relevé livré.
-- =============================================================================

-- 1. Ajout des colonnes métrologie GPU sur public.releves
ALTER TABLE public.releves 
  ADD COLUMN IF NOT EXISTS temps_gpu_secondes numeric,
  ADD COLUMN IF NOT EXISTS delai_file_secondes numeric,
  ADD COLUMN IF NOT EXISTS duree_totale_secondes numeric,
  ADD COLUMN IF NOT EXISTS journal_id uuid;

COMMENT ON COLUMN public.releves.temps_gpu_secondes IS 
  'Temps GPU facturé par RunPod en secondes (lu dans executionTime retour RunPod). Distinct de la durée bout en bout.';

COMMENT ON COLUMN public.releves.delai_file_secondes IS 
  'Temps d''attente en file ou cold start du container en secondes (lu dans delayTime retour RunPod).';

COMMENT ON COLUMN public.releves.duree_totale_secondes IS 
  'Durée totale bout en bout en secondes (updated_at - created_at lors de la finalisation).';

COMMENT ON COLUMN public.releves.journal_id IS 
  'Lien vers public.appels_fournisseurs(id) pour rapprochement direct COGS.';

-- 2. Index pour requêtes d'analyse et watchdog de nettoyage
CREATE INDEX IF NOT EXISTS idx_releves_statut_created_at 
  ON public.releves(statut, created_at);

CREATE INDEX IF NOT EXISTS idx_releves_runpod_job_id 
  ON public.releves(runpod_job_id) 
  WHERE runpod_job_id IS NOT NULL;

-- 3. Vue analytique : Coût et temps GPU par relevé livré (Critère d)
CREATE OR REPLACE VIEW public.v_couts_releves_photo AS
SELECT
  count(*) AS total_soumis,
  count(*) FILTER (WHERE statut = 'completed') AS total_livres,
  count(*) FILTER (WHERE statut = 'failed') AS total_echoues,
  count(*) FILTER (WHERE statut IN ('processing', 'downloading', 'pending')) AS total_en_cours,
  round(
    100.0 * count(*) FILTER (WHERE statut = 'completed') / nullif(count(*), 0),
    1
  ) AS taux_reussite_pct,
  coalesce(sum(temps_gpu_secondes), 0) AS total_secondes_gpu,
  round(
    coalesce(sum(temps_gpu_secondes), 0)::numeric / nullif(count(*) FILTER (WHERE statut = 'completed'), 0),
    1
  ) AS temps_gpu_moyen_sec_par_livrable,
  round(
    coalesce(avg(duree_totale_secondes) FILTER (WHERE statut = 'completed'), 0),
    1
  ) AS duree_moyenne_bout_en_bout_sec
FROM public.releves;

COMMENT ON VIEW public.v_couts_releves_photo IS
  'Agrégation COGS des relevés photogrammétriques : taux de réussite, temps GPU moyen par unité livrée et écart avec durée totale.';
