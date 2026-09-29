// Proxy photogrammétrie — RunPod Serverless + Supabase Storage + Traçabilité GPU (INSTR-2)
// Porté depuis CapInSitu (app-v3/api/odm-proxy.js) le 14/07/2026.
// Instrumenté pour traçabilité COGS, temps GPU et état terminal garanti le 29/09/2026.
// Variables d'environnement Vercel requises :
//   BC_KEY              → clé partagée client (pickinsitu)
//   RUNPOD_API_KEY      → clé API RunPod (Settings → API Keys)
//   RUNPOD_ENDPOINT_ID  → alfkh0yfkkfukq (endpoint propre 01/07)
//   SUPABASE_URL        → https://fnfrusblyzndbzckkfir.supabase.co
//   SUPABASE_SERVICE_KEY → service_role key (Supabase Dashboard → Settings → API)

import { NextRequest, NextResponse } from "next/server";
import {
  journaliserLancement,
  enregistrerDemarrageReleve,
  finaliserAppelJournal,
  enregistrerFinReleve,
  nettoyerJobsExpires,
  calculerCoutReleves,
} from "@/lib/runpod-instrumentation";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-BC-Key",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

async function handle(req: NextRequest) {
  const key = req.headers.get("x-bc-key");
  if (!process.env.BC_KEY || key !== process.env.BC_KEY) {
    return json({ error: "Non autorisé" }, 401);
  }

  const params = req.nextUrl.searchParams;
  const action = params.get("action");
  const SUPA_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || "";
  const RUNPOD_KEY = process.env.RUNPOD_API_KEY || "";
  const RUNPOD_EP = process.env.RUNPOD_ENDPOINT_ID || "alfkh0yfkkfukq";

  try {
    // ── Génère une URL signée pour upload direct browser → Supabase Storage ──
    if (action === "upload-url") {
      let path: string | null = params.get("path");
      if (req.method === "POST") {
        try {
          const body = await req.json();
          if (body?.path) path = body.path;
        } catch {
          /* body absent ou non-JSON : on garde le query param */
        }
      }
      if (!path) return json({ error: "path requis" }, 400);

      const r = await fetch(
        `${SUPA_URL}/storage/v1/object/sign/upload/releves/${path}`,
        {
          method: "POST",
          headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expiresIn: 3600 }),
        }
      );
      if (!r.ok) {
        const txt = await r.text();
        return json({ error: `Supabase sign: ${txt.slice(0, 200)}` }, r.status);
      }
      const data = await r.json();
      const signedURL = data.signedURL || data.url || "";
      const fullURL = signedURL.startsWith("http")
        ? signedURL
        : `${SUPA_URL}/storage/v1${signedURL}`;
      return json({ signedURL: fullURL, token: data.token });
    }

    // ── Lance un job RunPod avec traçabilité GPU immédiate (Critère a & f) ───
    if (action === "runpod-start") {
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        try {
          const parsed = await req.json();
          if (parsed && typeof parsed === "object") body = parsed;
        } catch {
          /* body non parsable : fallback query param */
        }
      }
      // releve_id en query param en fallback si le body parsing échoue
      if (!body.releve_id && params.get("releve_id")) {
        body.releve_id = params.get("releve_id");
      }
      const releveId = body.releve_id as string;
      if (!releveId) return json({ error: "releve_id manquant" }, 400);

      const r = await fetch(`https://api.runpod.ai/v2/${RUNPOD_EP}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RUNPOD_KEY}`,
        },
        body: JSON.stringify({
          input: body,
          policy: { executionTimeout: 2700000, ttl: 1800000 },
        }),
      });

      if (!r.ok) {
        const txt = await r.text();
        // Même en cas d'erreur de lancement, traçabilité assurée (issue echec)
        await finaliserAppelJournal({
          supaUrl: SUPA_URL,
          supaKey: SUPA_KEY,
          releveId,
          runpodJobId: "non_attribue",
          status: "FAILED",
          error: `Erreur API RunPod start (HTTP ${r.status}) : ${txt.slice(0, 200)}`,
        });
        await enregistrerFinReleve({
          supaUrl: SUPA_URL,
          supaKey: SUPA_KEY,
          releveId,
          runpodJobId: "non_attribue",
          status: "FAILED",
          error: `RunPod start: ${txt.slice(0, 200)}`,
        });
        return json({ error: `RunPod start: ${txt.slice(0, 200)}` }, r.status);
      }

      const runpodData = await r.json();
      const jobId = runpodData.id as string;

      // ── CRITÈRE (a) & (f) : Écriture serveur immédiate avant toute attente ──
      // 1. Journalisation dans appels_fournisseurs (RPC journaliser_appel)
      const opts = (body.options as Record<string, unknown>) || {};
      const journalId = await journaliserLancement({
        supaUrl: SUPA_URL,
        supaKey: SUPA_KEY,
        releveId,
        runpodJobId: jobId,
        preset: typeof opts.preset === "string" ? opts.preset : undefined,
        nbPhotos: typeof opts.nb_photos === "number" ? opts.nb_photos : undefined,
        options: opts,
        endpointId: RUNPOD_EP,
      });

      // 2. Écriture immédiate du runpod_job_id et statut processing sur public.releves
      await enregistrerDemarrageReleve(
        {
          supaUrl: SUPA_URL,
          supaKey: SUPA_KEY,
          releveId,
          runpodJobId: jobId,
        },
        journalId
      );

      return json({ ...runpodData, journal_id: journalId });
    }

    // ── Interroge le statut d'un job RunPod + Enregistrement temps GPU (Critère b)
    if (action === "runpod-status") {
      const jobId = params.get("jobId");
      if (!jobId) return json({ error: "jobId requis" }, 400);
      if (jobId === "ping") return json({ status: "ok" });

      const r = await fetch(
        `https://api.runpod.ai/v2/${RUNPOD_EP}/status/${jobId}`,
        { headers: { Authorization: `Bearer ${RUNPOD_KEY}` } }
      );
      if (!r.ok) {
        const txt = await r.text();
        return json({ error: `RunPod status: ${txt.slice(0, 200)}` }, r.status);
      }
      const data = await r.json();

      // ── CRITÈRE (b) : Enregistrement métrologique dès état terminal ───────
      const st = data.status;
      if (st === "COMPLETED" || st === "FAILED" || st === "CANCELLED") {
        const execMs = typeof data.executionTime === "number" ? data.executionTime : undefined;
        const delayMs = typeof data.delayTime === "number" ? data.delayTime : undefined;
        const errMsg = data.error || data.output?.error || data.output?.detail || undefined;

        // Mise à jour de public.releves (temps GPU, durée totale, statut terminal)
        await enregistrerFinReleve({
          supaUrl: SUPA_URL,
          supaKey: SUPA_KEY,
          runpodJobId: jobId,
          status: st,
          executionTimeMs: execMs,
          delayTimeMs: delayMs,
          error: errMsg,
        });

        // Finalisation dans appels_fournisseurs (RPC finaliser_appel)
        await finaliserAppelJournal({
          supaUrl: SUPA_URL,
          supaKey: SUPA_KEY,
          runpodJobId: jobId,
          status: st,
          executionTimeMs: execMs,
          delayTimeMs: delayMs,
          error: errMsg,
        });
      }

      return json(data);
    }

    // ── Annule un job RunPod ──────────────────────────────────────────────────
    if (action === "runpod-cancel") {
      const jobId = params.get("jobId");
      if (!jobId) return json({ error: "jobId requis" }, 400);

      const r = await fetch(
        `https://api.runpod.ai/v2/${RUNPOD_EP}/cancel/${jobId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${RUNPOD_KEY}` },
        }
      );
      const data = await r.json();

      // Marquer le relevé comme annulé
      await enregistrerFinReleve({
        supaUrl: SUPA_URL,
        supaKey: SUPA_KEY,
        runpodJobId: jobId,
        status: "CANCELLED",
        error: "Job annulé par demande utilisateur (runpod-cancel)",
      });
      await finaliserAppelJournal({
        supaUrl: SUPA_URL,
        supaKey: SUPA_KEY,
        runpodJobId: jobId,
        status: "CANCELLED",
        error: "Job annulé par demande utilisateur (runpod-cancel)",
      });

      return json(data);
    }

    // ── Watchdog : Nettoie les jobs expirés ou abandonnés (Critère c) ─────────
    if (action === "cleanup-expired") {
      const maxAge = Number(params.get("maxAgeHours")) || 2;
      const result = await nettoyerJobsExpires({
        supaUrl: SUPA_URL,
        supaKey: SUPA_KEY,
        runpodKey: RUNPOD_KEY,
        runpodEp: RUNPOD_EP,
        maxAgeHours: maxAge,
      });
      return json(result);
    }

    // ── Métriques COGS : Coût et temps GPU par relevé livré (Critère d) ──────
    if (action === "cost-stats") {
      const fromDate = params.get("fromDate") || undefined;
      const stats = await calculerCoutReleves(SUPA_URL, SUPA_KEY, fromDate);
      return json(stats || { error: "Impossible de calculer les statistiques" });
    }

    return json({ error: `Action inconnue: ${action}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
