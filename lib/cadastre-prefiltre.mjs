// lib/cadastre-prefiltre.mjs
// Pre-filtrage foncier & servitudes PickInSitu (JEV-CAD-5).
// Qualifie un lot de parcelles (potentiel_division / typologie / recours_abf)
// via un classificateur deterministe (legacy) et, en mode shadow/active, le
// modele Jev (~typesafe/jev-latest) en coupe-circuit fail-open. Chaque
// qualification est journalisee en local (data/observations-cadastre.jsonl) et,
// si SUPABASE_URL + une cle sont presentes, dans la table dev_jev_observations
// (flux_metier = 'cadastre_pick').
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_OBS = path.join(__dirname, '..', 'data', 'observations-cadastre.jsonl');
const TIMEOUT_MS = parseInt(process.env.JEV_TIMEOUT_MS || '1500', 10);
const apiKey = process.env.OPENROUTER_API_KEY;

const SCHEMA_CADASTRE = {
  potentiel_division: {
    type: 'noul',
    instructions: "La parcelle presente-t-elle un potentiel reel de division fonciere pour creer un lot a batir ou une operation autonome ?",
    criteria: {
      "true": "Division fonciere realisable (surface, facade, PLU)",
      "false": "Division impossible (surface saturee, zone N/A/PPRI, enclavement)",
    },
  },
  typologie: {
    type: 'choice',
    instructions: "Quelle est l'orientation d'amenagement la plus creatrice de valeur pour cette parcelle ?",
    criteria: {
      division_lot_a_batir: "Detachement d'un ou plusieurs lots a batir",
      surelevation_extension: "Extension ou surelevation du bati existant",
      densification_collective: "Operation de logements collectifs ou requalification d'emprise",
      inconstructible_espace_protege: "Inconstructible (agricole, naturel, inondable, sature)",
    },
  },
  recours_abf: {
    type: 'noul',
    instructions: "Le projet necessite-t-il obligatoirement l'avis de l'Architecte des Batiments de France (ABF) ?",
    criteria: {
      "true": "Perimetre de protection ou covisibilite avec un Monument Historique",
      "false": "Hors perimetre des monuments historiques",
    },
  },
};

// Seuil de confiance minimal pour adopter la décision Jev en mode 'active'.
// Sous ce seuil (zone grise), on conserve le legacy : on ne laisse pas Jev
// écarter une piste réglementaire sur une décision incertaine.
const CONFIDENCE_MIN = parseFloat(process.env.JEV_CONFIDENCE_MIN || '0.8');

// Confiance globale d'une réponse Jev = minimum des marges de décision.
// - noul   : marge au seuil binaire (1 = tranché, 0 = pile à 0.5).
// - choice : confiance déclarée par le modèle (0-1).
function jevConfidence(answers, noulFields, choiceFields) {
  const vals = [];
  for (const k of noulFields) {
    const n = answers?.[k]?.noul;
    if (typeof n === 'number') vals.push(2 * Math.abs(n - 0.5));
  }
  for (const k of choiceFields) {
    const c = answers?.[k]?.confidence;
    if (typeof c === 'number') vals.push(c);
  }
  if (!vals.length) return null;
  return Math.min(...vals);
}

// --- Classificateur deterministe (legacy) ---
export function qualifierParcelleLegacy(data) {
  const inconstructible = /zone a\b|zone n\b|ppri|ebc|znieff|inconstructible|interdiction stricte|rejet de plein droit/i.test(data);
  const noBuildRight = /aucun droit à construire/i.test(data);
  const enclave = /sans facade|enclav|porche|coeur d'ilot/i.test(data);
  const noGroundExt = /aucune possibilité d'extension au sol/i.test(data);

  const m = data.match(/(\d[\d\s]*)\s*m²/);
  const surf = m ? parseInt(m[1].replace(/\s/g, ''), 10) : null;
  const petit = surf !== null && surf < 650;

  const potentiel_division = !(inconstructible || noBuildRight || enclave || noGroundExt || petit);

  const recours_abf = /monument historique|\bmh\b|inscrit|périmètre de protection|covisibilité|périmètre abf/i.test(data);

  let typologie;
  if (inconstructible || noBuildRight) {
    typologie = 'inconstructible_espace_protege';
  } else if (/densification|collectif|axe structurant|requalifier|operation d'amenagement|friche|hangar|1au|entre deux pignons|dent creuse|obsolète/i.test(data)) {
    typologie = 'densification_collective';
  } else if (/surelevation|extension au sol|centre historique|immeuble|porche|sans facade/i.test(data)) {
    typologie = 'surelevation_extension';
  } else if (potentiel_division) {
    typologie = 'division_lot_a_batir';
  } else {
    typologie = 'surelevation_extension';
  }

  return { potentiel_division, typologie, recours_abf };
}

async function logObservation(record) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n';
  try {
    await fs.mkdir(path.dirname(LOCAL_OBS), { recursive: true });
    await fs.appendFile(LOCAL_OBS, line, 'utf8');
  } catch (err) {
    console.error('[cadastre telemetrie locale]', err.message);
  }
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (supaUrl && supaKey) {
    try {
      await fetch(supaUrl + '/rest/v1/dev_jev_observations', {
        method: 'POST',
        headers: {
          apikey: supaKey,
          Authorization: 'Bearer ' + supaKey,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          flux_metier: 'cadastre_pick',
          element_id: record.elementId,
          state_payload: (record.state || '').slice(0, 1000),
          jev_answers: record.answers,
          confidence_score: record.confidence,
          latency_ms: record.latencyMs,
          cost_usd: record.cost,
          mode: record.mode,
          bypassed: record.bypassed,
          decision_legacy: record.decisionLegacy ? JSON.stringify(record.decisionLegacy) : null,
          concordance: record.concordance,
        }),
      });
    } catch (e) {
      // silencieux : la telemetrie ne doit jamais faire echouer la qualification
    }
  }
}

async function callJevRaw(state, questions, timeoutMs) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY non disponible.');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://bc-archi.com',
        'X-Title': 'PickInSitu Cadastre Prefiltre Jev',
      },
      body: JSON.stringify({ model: '~typesafe/jev-latest', state, questions }),
    });
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + await res.text());
    const data = await res.json();
    return { answers: data.answers || {}, usage: data.usage || {}, latencyMs };
  } finally {
    clearTimeout(t);
  }
}

export async function qualifierParcelle(data, opts = {}) {
  const mode = (process.env.JEV_MODE || 'shadow').toLowerCase();
  const elementId = opts.elementId || null;
  const legacyResult = qualifierParcelleLegacy(data);

  let answers = null;
  let bypassed = false;
  let latencyMs = null;
  let cost = 0;
  let error = null;

  if (mode === 'active' || mode === 'shadow') {
    try {
      const jevRes = await callJevRaw(data, SCHEMA_CADASTRE, TIMEOUT_MS);
      answers = jevRes.answers;
      latencyMs = jevRes.latencyMs;
      cost = jevRes.usage?.cost || 0;
    } catch (e) {
      bypassed = true;
      error = e.message;
    }
  }

  let result = legacyResult;
  let concordance = null;
  let confidence = null;
  if (mode === 'active' && !bypassed && answers) {
    const jevResult = {
      potentiel_division: (answers.potentiel_division?.noul ?? 0) >= 0.5,
      typologie: answers.typologie?.choice ?? legacyResult.typologie,
      recours_abf: (answers.recours_abf?.noul ?? 0) >= 0.5,
    };
    concordance = jevResult.potentiel_division === legacyResult.potentiel_division && jevResult.recours_abf === legacyResult.recours_abf;
    confidence = jevConfidence(answers, ['potentiel_division', 'recours_abf'], ['typologie']);
    // Zone grise : sous le seuil de confiance, on conserve le legacy pour ne pas
    // écarter une piste (division foncière, avis ABF) sur une décision incertaine.
    if (confidence === null || confidence >= CONFIDENCE_MIN) {
      result = jevResult;
    }
  }

  await logObservation({
    flux: 'cadastre_pick',
    elementId,
    state: data,
    answers,
    confidence,
    latencyMs,
    cost,
    mode,
    bypassed,
    error,
    decisionLegacy: legacyResult,
    concordance,
  });

  return { mode, bypassed, result };
}

export async function qualifierBatch(parcelles) {
  const results = [];
  for (const p of parcelles) {
    const r = await qualifierParcelle(p.data, { elementId: p.id });
    results.push({ id: p.id, parcelle: p.parcelle, ground_truth: p.ground_truth, prediction: r.result, mode: r.mode });
  }
  return results;
}
