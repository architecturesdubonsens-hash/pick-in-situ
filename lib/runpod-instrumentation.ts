// lib/runpod-instrumentation.ts
// Instrumentation GPU RunPod & Traçabilité COGS (INSTR-2)
// Assure que :
// 1. 100% des jobs soumis portent un runpod_job_id et sont journalisés avant tout résultat.
// 2. Le temps GPU facturé (executionTime) et le délai de file (delayTime) sont enregistrés
//    au retour dans releves et appels_fournisseurs.
// 3. Aucun job ne reste bloqué en processing : cleanup-expired borne l'état terminal.

export interface StartReleveParams {
  supaUrl: string;
  supaKey: string;
  releveId: string;
  runpodJobId: string;
  preset?: string;
  nbPhotos?: number;
  options?: Record<string, unknown>;
  endpointId?: string;
}

export interface FinalizeReleveParams {
  supaUrl: string;
  supaKey: string;
  releveId?: string;
  runpodJobId: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED" | string;
  executionTimeMs?: number;
  delayTimeMs?: number;
  error?: string | null;
  journalId?: string | null;
}

export interface CleanupResult {
  totalTraites: number;
  completedCount: number;
  expiredCount: number;
  failedCount: number;
  details: Array<{
    id: string;
    nom: string;
    ancienStatut: string;
    nouveauStatut: string;
    runpodJobId: string | null;
    tempsGpuSec: number | null;
    motif: string;
  }>;
}

/**
 * Journalise l'appel RunPod AU LANCEMENT (avant tout résultat).
 * Invoque la RPC Postgres journaliser_appel créée dans INSTR-1.
 * Ne bloque JAMAIS la production en cas d'erreur de journalisation.
 */
export async function journaliserLancement(params: StartReleveParams): Promise<string | null> {
  const { supaUrl, supaKey, releveId, runpodJobId, preset, nbPhotos, options, endpointId } = params;
  if (!supaUrl || !supaKey) return null;

  try {
    const res = await fetch(`${supaUrl}/rest/v1/rpc/journaliser_appel`, {
      method: "POST",
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_surface: "photo-releve",
        p_fournisseur: "runpod",
        p_modele_demande: "bc-archi-odm:v63",
        p_passerelle: "serverless",
        p_unite_ref: releveId,
        p_unite_type: "releve",
        p_tache: "INSTR-2",
        p_metadata: {
          preset: preset || "standard",
          nb_photos: nbPhotos ?? null,
          runpod_endpoint: endpointId || "alfkh0yfkkfukq",
          runpod_job_id: runpodJobId,
          options: options || {},
          timestamp_soumission: new Date().toISOString(),
        },
      }),
    });

    if (res.ok) {
      const journalId = await res.json();
      if (typeof journalId === "string") {
        if (runpodJobId) {
          await fetch(`${supaUrl}/rest/v1/appels_fournisseurs?id=eq.${journalId}`, {
            method: "PATCH",
            headers: {
              apikey: supaKey,
              Authorization: `Bearer ${supaKey}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ ref_fournisseur: runpodJobId }),
          }).catch(() => {});
        }
        return journalId;
      }
      return null;
    } else {
      const txt = await res.text();
      console.warn(`[INSTR-2] journaliser_appel retour HTTP ${res.status}: ${txt.slice(0, 200)}`);
      return null;
    }
  } catch (e) {
    console.warn("[INSTR-2] Erreur journaliserLancement :", e);
    return null;
  }
}

/**
 * Écrit runpod_job_id et statut 'processing' sur public.releves dès la soumission.
 * Garantit le critère (a) : runpod_job_id écrit serveur avant tout résultat.
 */
export async function enregistrerDemarrageReleve(params: StartReleveParams, journalId: string | null): Promise<boolean> {
  const { supaUrl, supaKey, releveId, runpodJobId } = params;
  if (!supaUrl || !supaKey || !releveId) return false;

  try {
    // 1. Lire options existantes pour fusionner journal_id
    let existingOptions: Record<string, unknown> = {};
    const rGet = await fetch(`${supaUrl}/rest/v1/releves?id=eq.${releveId}&select=options`, {
      headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
    });
    if (rGet.ok) {
      const rows = await rGet.json();
      if (rows?.[0]?.options && typeof rows[0].options === "object") {
        existingOptions = rows[0].options;
      }
    }

    const mergedOptions = { ...existingOptions };
    if (journalId) mergedOptions.journal_id = journalId;

    const patchBody: Record<string, unknown> = {
      runpod_job_id: runpodJobId,
      statut: "processing",
      updated_at: new Date().toISOString(),
      options: mergedOptions,
    };

    const res = await fetch(`${supaUrl}/rest/v1/releves?id=eq.${releveId}`, {
      method: "PATCH",
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patchBody),
    });

    return res.ok;
  } catch (e) {
    console.warn("[INSTR-2] Erreur enregistrerDemarrageReleve :", e);
    return false;
  }
}

/**
 * Finalise l'appel dans appels_fournisseurs (RPC finaliser_appel).
 * Enregistre le temps GPU (secondes_gpu) et l'issue réelle (succes, echec, expire).
 */
export async function finaliserAppelJournal(params: FinalizeReleveParams): Promise<boolean> {
  const { supaUrl, supaKey, journalId, runpodJobId, status, executionTimeMs, delayTimeMs, error } = params;
  if (!supaUrl || !supaKey) return false;

  const tempsGpuSec = executionTimeMs != null && executionTimeMs > 0
    ? Math.round(executionTimeMs / 1000)
    : 0;

  let issue = "echec";
  if (status === "COMPLETED") issue = "succes";
  else if (status === "EXPIRED") issue = "expire";

  try {
    // Si journalId est fourni, mise à jour directe
    let targetId = journalId;

    // Si absent, recherche par ref_fournisseur (runpodJobId)
    if (!targetId && runpodJobId) {
      const q = await fetch(
        `${supaUrl}/rest/v1/appels_fournisseurs?ref_fournisseur=eq.${runpodJobId}&select=id&order=horodatage.desc&limit=1`,
        {
          headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
        }
      );
      if (q.ok) {
        const rows = await q.json();
        if (rows?.[0]?.id) targetId = rows[0].id;
      }
    }

    if (!targetId) {
      // Si la ligne initiale n'a pu être trouvée, journalisation directe au retour
      const fallbackRes = await fetch(`${supaUrl}/rest/v1/appels_fournisseurs`, {
        method: "POST",
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          surface: "photo-releve",
          fournisseur: "runpod",
          modele_demande: "bc-archi-odm:v63",
          modele_resolu: "bc-archi-odm:v63",
          passerelle: "serverless",
          unite_ref: params.releveId || null,
          unite_type: "releve",
          volume_sortie: tempsGpuSec,
          unite_volume: "secondes_gpu",
          issue,
          ref_fournisseur: runpodJobId,
          tache: "INSTR-2",
          metadata: {
            execution_time_ms: executionTimeMs,
            delay_time_ms: delayTimeMs,
            error: error || null,
          },
        }),
      });
      return fallbackRes.ok;
    }

    const res = await fetch(`${supaUrl}/rest/v1/rpc/finaliser_appel`, {
      method: "POST",
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_id: targetId,
        p_issue: issue,
        p_modele_resolu: "bc-archi-odm:v63",
        p_ref_fournisseur: runpodJobId,
        p_volume_sortie: tempsGpuSec,
        p_unite_volume: "secondes_gpu",
        p_metadata: {
          execution_time_ms: executionTimeMs,
          delay_time_ms: delayTimeMs,
          error: error || null,
          horodatage_fin: new Date().toISOString(),
        },
      }),
    });

    return res.ok;
  } catch (e) {
    console.warn("[INSTR-2] Erreur finaliserAppelJournal :", e);
    return false;
  }
}

/**
 * Enregistre les métriques finales (temps GPU, délai file, durée totale) sur public.releves.
 */
export async function enregistrerFinReleve(params: FinalizeReleveParams): Promise<boolean> {
  const { supaUrl, supaKey, releveId, runpodJobId, status, executionTimeMs, delayTimeMs, error } = params;
  if (!supaUrl || !supaKey) return false;

  const tempsGpuSec = executionTimeMs != null && executionTimeMs > 0
    ? Math.round(executionTimeMs / 1000)
    : 0;
  const delaiQueueSec = delayTimeMs != null && delayTimeMs > 0
    ? Math.round(delayTimeMs / 1000)
    : 0;

  const isCompleted = status === "COMPLETED";

  try {
    // Retrouver le relevé pour calculer durée totale bout en bout
    const filter = releveId ? `id=eq.${releveId}` : `runpod_job_id=eq.${runpodJobId}`;
    const rGet = await fetch(`${supaUrl}/rest/v1/releves?${filter}&select=id,created_at,options,statut&limit=1`, {
      headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
    });

    let targetReleveId = releveId;
    let dureeTotaleSec = 0;
    let existingOptions: Record<string, unknown> = {};

    if (rGet.ok) {
      const rows = await rGet.json();
      if (rows?.[0]) {
        targetReleveId = rows[0].id;
        existingOptions = typeof rows[0].options === "object" && rows[0].options ? rows[0].options : {};
        if (rows[0].created_at) {
          const startMs = new Date(rows[0].created_at).getTime();
          dureeTotaleSec = Math.max(0, Math.round((Date.now() - startMs) / 1000));
        }
      }
    }

    if (!targetReleveId) return false;

    const mergedOptions = {
      ...existingOptions,
      temps_gpu_secondes: tempsGpuSec,
      delai_file_secondes: delaiQueueSec,
      duree_totale_secondes: dureeTotaleSec,
      execution_time_ms: executionTimeMs,
      delay_time_ms: delayTimeMs,
    };

    const patchBody: Record<string, unknown> = {
      statut: isCompleted ? "completed" : "failed",
      updated_at: new Date().toISOString(),
      options: mergedOptions,
    };

    if (!isCompleted && error) {
      patchBody.erreur = error;
    }

    // Tente avec les colonnes dédiées si présentes
    const patchBodyWithColumns = {
      ...patchBody,
      temps_gpu_secondes: tempsGpuSec,
      delai_file_secondes: delaiQueueSec,
      duree_totale_secondes: dureeTotaleSec,
    };

    let res = await fetch(`${supaUrl}/rest/v1/releves?id=eq.${targetReleveId}`, {
      method: "PATCH",
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patchBodyWithColumns),
    });

    if (!res.ok) {
      // Si échec (ex. colonnes dédiées non encore créées), mise à jour via options JSONB seul
      res = await fetch(`${supaUrl}/rest/v1/releves?id=eq.${targetReleveId}`, {
        method: "PATCH",
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(patchBody),
      });
    }

    return res.ok;
  } catch (e) {
    console.warn("[INSTR-2] Erreur enregistrerFinReleve :", e);
    return false;
  }
}

/**
 * Watchdog / Nettoyage des jobs expirés ou abandonnés (Critère c).
 * Assure qu'aucun job ne reste indéfiniment en processing (> maxAgeHours, défaut 2h).
 */
export async function nettoyerJobsExpires(config: {
  supaUrl: string;
  supaKey: string;
  runpodKey: string;
  runpodEp: string;
  maxAgeHours?: number;
}): Promise<CleanupResult> {
  const { supaUrl, supaKey, runpodKey, runpodEp, maxAgeHours = 2 } = config;
  const cutoffTime = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();

  const result: CleanupResult = {
    totalTraites: 0,
    completedCount: 0,
    expiredCount: 0,
    failedCount: 0,
    details: [],
  };

  try {
    // Relevés non terminés créés avant le cutoff
    const url = `${supaUrl}/rest/v1/releves?statut=in.(processing,downloading,pending,uploading)&created_at=lt.${cutoffTime}&select=id,nom,statut,runpod_job_id,created_at,options&order=created_at.asc`;
    const r = await fetch(url, {
      headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
    });
    if (!r.ok) return result;

    const releves = (await r.json()) as Array<{
      id: string;
      nom: string;
      statut: string;
      runpod_job_id: string | null;
      created_at: string;
      options?: Record<string, unknown> | null;
      journal_id?: string | null;
    }>;

    for (const rel of releves) {
      result.totalTraites++;
      let nouveauStatut = "failed";
      let executionTimeMs = 0;
      let delayTimeMs = 0;
      let motif = `Délai expiré (> ${maxAgeHours} h en traitement sans issue)`;

      if (rel.runpod_job_id && runpodKey && runpodEp) {
        try {
          const rStatus = await fetch(`https://api.runpod.ai/v2/${runpodEp}/status/${rel.runpod_job_id}`, {
            headers: { Authorization: `Bearer ${runpodKey}` },
          });

          if (rStatus.ok) {
            const data = await rStatus.json();
            executionTimeMs = data.executionTime || 0;
            delayTimeMs = data.delayTime || 0;

            if (data.status === "COMPLETED") {
              nouveauStatut = "completed";
              motif = "Job RunPod terminé avec succès (rattrapé par watchdog)";
              result.completedCount++;
            } else if (data.status === "FAILED" || data.status === "CANCELLED") {
              nouveauStatut = "failed";
              motif = `Échec RunPod (${data.status}) : ${data.error || "erreur"}`;
              result.failedCount++;
            } else {
              // Toujours IN_QUEUE ou IN_PROGRESS après > 2h -> expiré
              nouveauStatut = "failed";
              motif = `Délai RunPod dépassé (> ${maxAgeHours} h, statut=${data.status})`;
              result.expiredCount++;
            }
          } else if (rStatus.status === 404) {
            // RunPod purge les jobs après 24h
            nouveauStatut = "failed";
            motif = "Purge historique RunPod (> 24h ou job non trouvé)";
            result.expiredCount++;
          }
        } catch {
          motif = `Erreur interrogation RunPod pour job ${rel.runpod_job_id}`;
          result.expiredCount++;
        }
      } else {
        motif = "Abandonné sans identifiant RunPod (> 2 h)";
        result.expiredCount++;
      }

      const tempsGpuSec = executionTimeMs > 0 ? Math.round(executionTimeMs / 1000) : 0;

      // 1. Mettre à jour public.releves
      await enregistrerFinReleve({
        supaUrl,
        supaKey,
        releveId: rel.id,
        runpodJobId: rel.runpod_job_id || "aucun",
        status: nouveauStatut === "completed" ? "COMPLETED" : "EXPIRED",
        executionTimeMs,
        delayTimeMs,
        error: motif,
      });

      // 2. Finaliser appels_fournisseurs
      await finaliserAppelJournal({
        supaUrl,
        supaKey,
        journalId: ((rel.options as Record<string, unknown> | null)?.journal_id as string) || rel.journal_id,
        runpodJobId: rel.runpod_job_id || "aucun",
        releveId: rel.id,
        status: nouveauStatut === "completed" ? "COMPLETED" : "EXPIRED",
        executionTimeMs,
        delayTimeMs,
        error: motif,
      });

      result.details.push({
        id: rel.id,
        nom: rel.nom,
        ancienStatut: rel.statut,
        nouveauStatut,
        runpodJobId: rel.runpod_job_id,
        tempsGpuSec,
        motif,
      });
    }

    return result;
  } catch (e) {
    console.warn("[INSTR-2] Erreur nettoyerJobsExpires :", e);
    return result;
  }
}

/**
 * Calcule l'agrégation COGS démontrée (Critère d).
 * Rend le nombre de relevés livrés, la somme des temps GPU et la moyenne par relevé livré.
 */
export async function calculerCoutReleves(supaUrl: string, supaKey: string, fromDate?: string) {
  try {
    let url = `${supaUrl}/rest/v1/releves?select=id,statut,options,created_at`;
    if (fromDate) {
      url += `&created_at=gte.${fromDate}`;
    }

    const res = await fetch(url, {
      headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const rows = (await res.json()) as Array<{
      id: string;
      statut: string;
      options: Record<string, unknown> | null;
      temps_gpu_secondes?: number | null;
      duree_totale_secondes?: number | null;
    }>;

    const totalSoumis = rows.length;
    const completedRows = rows.filter((r) => r.statut === "completed");
    const failedRows = rows.filter((r) => r.statut === "failed");
    const totalLivres = completedRows.length;
    const totalEchoues = failedRows.length;

    const totalGpuSec = rows.reduce((acc, r) => {
      const sec = Number(r.temps_gpu_secondes) || Number(r.options?.temps_gpu_secondes) || 0;
      return acc + sec;
    }, 0);
    const moyenneGpuSecParLivre = totalLivres > 0 ? Math.round((totalGpuSec / totalLivres) * 10) / 10 : 0;
    const tauxReussite = totalSoumis > 0 ? Math.round((totalLivres / totalSoumis) * 1000) / 10 : 0;

    // Coût estimé en EUR : base RunPod serverless ~0.00055 $/sec (~0.00050 €/sec)
    const COUT_PAR_SEC_GPU_EUR = 0.0005;
    const coutEstimeParLivreEur = Math.round(moyenneGpuSecParLivre * COUT_PAR_SEC_GPU_EUR * 100) / 100;

    return {
      totalSoumis,
      totalLivres,
      totalEchoues,
      tauxReussitePct: tauxReussite,
      totalTempsGpuSec: totalGpuSec,
      tempsGpuMoyenSecParLivrable: moyenneGpuSecParLivre,
      coutMoyenEstimeParLivrableEur: coutEstimeParLivreEur,
    };
  } catch (e) {
    console.warn("[INSTR-2] Erreur calculerCoutReleves :", e);
    return null;
  }
}
