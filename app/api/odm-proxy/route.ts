// Proxy photogrammétrie — RunPod Serverless + Supabase Storage
// Porté depuis CapInSitu (app-v3/api/odm-proxy.js) le 14/07/2026, logique inchangée.
// Variables d'environnement Vercel requises :
//   BC_KEY              → clé partagée client (pickinsitu)
//   RUNPOD_API_KEY      → clé API RunPod (Settings → API Keys)
//   RUNPOD_ENDPOINT_ID  → alfkh0yfkkfukq (endpoint propre 01/07 ; ancien ppmj21flholosp bloqué à ~50s)
//   SUPABASE_URL        → https://fnfrusblyzndbzckkfir.supabase.co
//   SUPABASE_SERVICE_KEY → service_role key (Supabase Dashboard → Settings → API)

import { NextRequest, NextResponse } from "next/server";

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

    // ── Lance un job RunPod ────────────────────────────────────────────────────
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
      if (!body.releve_id) return json({ error: "releve_id manquant" }, 400);

      const r = await fetch(`https://api.runpod.ai/v2/${RUNPOD_EP}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RUNPOD_KEY}`,
        },
        // policy.executionTimeout (ms) : force le timeout, écrase le défaut endpoint.
        // Sans ça, les jobs mouraient à ~75s ("job timed out after 1 retries") quelle
        // que soit l'étape ODM — un execution timeout effectif bien < 3600s.
        // ttl : durée max en file avant prise en charge (cold start lents image GPU).
        // 45 min max : un run HD normal fait 13-17 min, le retry de dégradation
        // ×2 au pire ~35 min. Au-delà = pathologique → tuer tôt plutôt que
        // facturer (vécu 08/07 : >5h consommées sur un job silencieux).
        body: JSON.stringify({
          input: body,
          policy: { executionTimeout: 2700000, ttl: 1800000 },
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        return json({ error: `RunPod start: ${txt.slice(0, 200)}` }, r.status);
      }
      return json(await r.json());
    }

    // ── Interroge le statut d'un job RunPod ───────────────────────────────────
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
      return json(await r.json());
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
      return json(await r.json());
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
