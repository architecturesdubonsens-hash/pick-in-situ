/* ===== LIB_JEV COPIE VENDOREE DE lib_jev — NE PAS EDITER A LA MAIN =====
      Source    : claude-gouvernance, lib_jev/jev_client.mjs
      Empreinte : sha256 e3bc34845c50
      Regenerer : node lib_jev/sync-vers-consommateurs.mjs --vers <ce depot> --ecrire
      La copie suit la source a l octet : seul ce bandeau est ajoute ici.
   ===== */
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_OBSERVATIONS_LOG = path.join(__dirname, 'observations.jsonl');

/**
 * Modes de fonctionnement du Coupe-Circuit Jev :
 * - 'off'    : Bypass total, zéro appel réseau émis.
 * - 'shadow' : Mode observation silencieuse. Exécute le legacy immédiatement et Jev en tâche de fond.
 * - 'active' : Filtre actif en amont avec sécurité Fail-Open (timeout dur 1.5s).
 */
export const JEV_MODE = process.env.JEV_MODE || 'shadow';
export const JEV_TIMEOUT_MS = parseInt(process.env.JEV_TIMEOUT_MS || '1500', 10);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/**
 * Un auto-test n'écrit pas dans le journal d'observation. Ses entrées portent
 * les flux test_*, dans le même fichier que les observations réelles, et rien
 * ne les en distingue à la relecture. Constat LEV-JEV-COR-1 du 23/09/2026 :
 * deux exécutions du banc ont ajouté 2 lignes (test_failopen, test_active)
 * juste après une observation réelle bim_tapir.
 */
const EN_AUTO_TEST = process.argv.includes('--test');
/**
 * Confiance globale d'une réponse Jev = minimum des marges de décision.
 * - noul   : distance au seuil binaire (1 = tranché, 0 = pile à 0.5).
 * - choice : confiance déclarée par le modèle (0-1).
 */
function extractConfidence(answers) {
  if (!answers || typeof answers !== 'object') return null;
  const vals = [];
  for (const v of Object.values(answers)) {
    if (v && typeof v === 'object') {
      if (typeof v.noul === 'number') vals.push(2 * Math.abs(v.noul - 0.5));
      if (typeof v.confidence === 'number') vals.push(v.confidence);
    }
  }
  if (!vals.length) return null;
  return Math.min(...vals);
}

/**
 * Enregistrement télémétrique asynchrone (Non-bloquant)
 */
async function logObservation(record) {
  if (EN_AUTO_TEST) return;
  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...record
    }) + '\n';
    await fs.appendFile(LOCAL_OBSERVATIONS_LOG, line, 'utf8');

    // Si Supabase est configuré dans l'environnement, insertion REST facultative
    const supaUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supaUrl && supaKey) {
      fetch(`${supaUrl}/rest/v1/dev_jev_observations`, {
        method: 'POST',
        headers: {
          'apikey': supaKey,
          'Authorization': `Bearer ${supaKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          flux_metier: record.flux,
          element_id: record.elementId,
          state_payload: record.state?.slice(0, 1000),
          jev_answers: record.answers,
          confidence_score: record.confidence,
          latency_ms: record.latencyMs,
          cost_usd: record.cost,
          mode: record.mode,
          bypassed: record.bypassed
        })
      }).catch(() => {}); // Ignorer silencieusement si la table n'est pas encore créée
    }
  } catch (err) {
    // La télémétrie ne doit JAMAIS faire planter le process
    console.error("[JEV TELEMETRY WARNING]", err.message);
  }
}

/**
 * Appel brut à l'API Jev avec timeout dur
 */
async function callJevRaw(state, questions, timeoutMs) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY non disponible.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const t0 = performance.now();
  try {
    const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://bc-archi.com",
        "X-Title": "InSitu Studio Jev Middleware"
      },
      body: JSON.stringify({
        model: "~typesafe/jev-latest",
        state,
        questions
      })
    });

    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return {
      answers: data.answers || {},
      usage: data.usage || {},
      latencyMs
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * API principale du Coupe-Circuit Jev
 * 
 * @param {Object} params
 * @param {string} params.flux - Nom du flux ('bim_tapir', 'parkings_aper', 'cadastre_pick', 'gouvernance')
 * @param {string} params.state - Données brutes ou texte à analyser
 * @param {Object} params.questions - Définition du schéma de questions Jev
 * @param {string} [params.elementId] - Identifiant de l'entité (ELEM-DOOR-01, Section AB n° 142...)
 * @param {Function} [params.legacyFallback] - Fonction de calcul ou d'analyse historique à court-circuiter
 */
export async function evaluateWithCircuitBreaker({
  flux,
  state,
  questions,
  elementId = null,
  legacyFallback = null
}) {
  const currentMode = (process.env.JEV_MODE || JEV_MODE).toLowerCase();

  const timeoutMs = parseInt(process.env.JEV_TIMEOUT_MS || '1500', 10);

  // 1. CAS OFF : Court-circuit total
  if (currentMode === 'off') {
    const legacyRes = legacyFallback ? await legacyFallback() : null;
    return {
      mode: 'off',
      bypassed: true,
      reason: 'JEV_MODE_OFF',
      answers: null,
      result: legacyRes
    };
  }

  // 2. CAS SHADOW : Exécution immédiate du legacy + appel Jev silencieux en arrière-plan
  if (currentMode === 'shadow') {
    const legacyPromise = legacyFallback ? legacyFallback() : Promise.resolve(null);

    // Lancement de Jev sans bloquer le retour
    callJevRaw(state, questions, timeoutMs)
      .then(jevRes => {
        logObservation({
          flux,
          elementId,
          state,
          answers: jevRes.answers,
          confidence: extractConfidence(jevRes.answers),
          latencyMs: jevRes.latencyMs,
          cost: jevRes.usage.cost || 0,
          mode: 'shadow',
          bypassed: false
        });
      })
      .catch(err => {
        logObservation({
          flux,
          elementId,
          state,
          error: err.message,
          mode: 'shadow',
          bypassed: true
        });
      });

    const legacyRes = await legacyPromise;
    return {
      mode: 'shadow',
      bypassed: false,
      isBackground: true,
      result: legacyRes
    };
  }

  // 3. CAS ACTIVE : Jev filtre en amont avec sécurité FAIL-OPEN
  const t0 = performance.now();
  try {
    const jevRes = await callJevRaw(state, questions, timeoutMs);
    
    // Log télémétrie
    logObservation({
      flux,
      elementId,
      state,
      answers: jevRes.answers,
      confidence: extractConfidence(jevRes.answers),
      latencyMs: jevRes.latencyMs,
      cost: jevRes.usage.cost || 0,
      mode: 'active',
      bypassed: false
    });

    return {
      mode: 'active',
      bypassed: false,
      latencyMs: jevRes.latencyMs,
      answers: jevRes.answers,
      cost: jevRes.usage.cost || 0
    };

  } catch (err) {
    // FAIL-OPEN : Si Jev échoue ou dépasse le délai, on repasse silencieusement au legacy
    const elapsed = Math.round(performance.now() - t0);
    console.warn(`[JEV CIRCUIT-BREAKER FAIL-OPEN] ${err.message} (${elapsed}ms) -> Bascule transparente sur le legacy.`);

    logObservation({
      flux,
      elementId,
      state,
      error: err.message,
      latencyMs: elapsed,
      mode: 'active',
      bypassed: true
    });

    const legacyRes = legacyFallback ? await legacyFallback() : null;
    return {
      mode: 'active',
      bypassed: true,
      error: err.message,
      result: legacyRes
    };
  }
}

// Test unitaire d'auto-vérification si lancé en direct
if (process.argv.includes('--test')) {
  console.log("=== TEST D'AUTO-VÉRIFICATION DU CLIENT JEV CIRCUIT-BREAKER ===");

  // Un banc qui affiche FAIL et rend 0 ne prouve rien : tout appelant qui lit
  // le code de sortie — un agent, une étape de clôture, un workflow — le voit
  // vert. Constat LEV-JEV-COR-1 du 23/09/2026 : Test 3 affichait « ❌ FAIL »
  // et la commande rendait EXIT 0.
  let verts = 0, rouges = 0, sautes = 0;
  const verdict = (ok, label, detail) => {
    if (ok) { verts++; console.log(`Test ${label} : ✅ PASS${detail ? ' — ' + detail : ''}`); }
    else { rouges++; console.log(`Test ${label} : ❌ FAIL${detail ? ' — ' + detail : ''}`); }
  };
  
  // Test 1 : Mode OFF
  process.env.JEV_MODE = 'off';
  const rOff = await evaluateWithCircuitBreaker({
    flux: 'test_off',
    state: 'test off',
    questions: { q: { type: 'noul', instructions: 'ok?', criteria: { true: 'y', false: 'n' } } },
    legacyFallback: () => "LEGACY_RESULT_OFF"
  });
  verdict(rOff.bypassed && rOff.result === "LEGACY_RESULT_OFF", "Mode OFF");

  // Test 2 : Mode FAIL-OPEN (Timeout forcé à 1ms)
  process.env.JEV_MODE = 'active';
  process.env.JEV_TIMEOUT_MS = '1'; // Provoque un timeout immédiat
  const rFailOpen = await evaluateWithCircuitBreaker({
    flux: 'test_failopen',
    state: 'test timeout',
    questions: { q: { type: 'noul', instructions: 'ok?', criteria: { true: 'y', false: 'n' } } },
    legacyFallback: () => "LEGACY_RESULT_FAILOPEN"
  });
  verdict(rFailOpen.bypassed && rFailOpen.result === "LEGACY_RESULT_FAILOPEN", "Fail-Open Timeout");

  // Test 3 : Mode ACTIVE Nominal (nécessite OPENROUTER_API_KEY + réseau)
  if (!OPENROUTER_API_KEY) {
    console.log("Test Mode Active Nominal : [SKIP] OPENROUTER_API_KEY absente - appel réseau non exécuté");
  } else {
    process.env.JEV_TIMEOUT_MS = '5000';
    const rActive = await evaluateWithCircuitBreaker({
      flux: 'test_active',
      state: 'Porte coupe-feu 930x2100 mm conforme aux prescriptions',
      questions: {
        conforme: { type: 'noul', instructions: 'Est-ce conforme?', criteria: { true: 'oui', false: 'non' } }
      },
      legacyFallback: () => "FALLBACK_NOT_CALLED"
    });
    // La cause est nommée : la réserve de JEV-COR-1 portait sur un fail-open
    // silencieux du test nominal, qu'aucune ligne ne distinguait d'un succès.
    const cause = rActive.bypassed
      ? (rActive.error || 'fail-open sans motif exposé')
      : (rActive.answers && rActive.answers.conforme ? '' : 'réponse reçue sans le champ attendu');
    verdict(!rActive.bypassed && !!(rActive.answers && rActive.answers.conforme), "Mode Active Nominal", cause);
    console.log(`  Latence: ${rActive.latencyMs}ms | Réponses:`, rActive.answers);
  }

  console.log('');
  console.log(`BILAN : ${verts} vert(s), ${rouges} rouge(s), ${sautes} sauté(s).`);
  if (rouges > 0) {
    process.exitCode = 1;
    console.log("EXIT 1 : au moins un test a échoué. Un banc rouge ne rend pas 0.");
  }
}
