// Proxy d'images — Contournement CORS pour Street View et Panoramax
// Porté depuis CapInSitu (app-v3/api/img-proxy.js) le 14/07/2026, logique inchangée.
// Utilisé par photo-releve.html pour télécharger les images en Blob directement dans le navigateur

import { NextRequest, NextResponse } from "next/server";

const ALLOWED_PROXY_HOSTS = [
  "maps.googleapis.com",
  "maps.google.com",
  "panoramax.ign.fr",
  "data.geopf.fr",
  "api-adresse.data.gouv.fr",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-BC-Key",
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  // Sécurité via clé d'application
  const key = req.headers.get("x-bc-key") || params.get("key");
  const BC_KEY = process.env.BC_KEY || "pickinsitu";
  if (key !== BC_KEY) {
    return jsonError("Non autorisé", 401);
  }

  const url = params.get("url");
  if (!url) {
    return jsonError("Paramètre url requis", 400);
  }

  try {
    const targetUrl = decodeURIComponent(url);
    const parsedUrl = new URL(targetUrl);
    const targetHost = parsedUrl.hostname;

    if (!ALLOWED_PROXY_HOSTS.some((host) => targetHost.endsWith(host))) {
      return jsonError(`Hôte non autorisé : ${targetHost}`, 403);
    }

    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "BCArchi-VercelProxy/1.0",
        Accept: "image/*,application/json,application/geo+json",
      },
    });

    if (!response.ok) {
      return jsonError(`Erreur distante : ${response.statusText}`, response.status);
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = await response.arrayBuffer();

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": contentType,
        "Content-Length": String(buffer.byteLength),
        // Cache de 24h pour limiter la bande passante Google/IGN
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), 500);
  }
}
