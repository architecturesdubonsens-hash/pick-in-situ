# ===== LIB_JEV COPIE VENDOREE DE lib_jev — NE PAS EDITER A LA MAIN =====
#    Source    : claude-gouvernance, lib_jev/jev_client.py
#    Empreinte : sha256 443a78787fea
#    Regenerer : node lib_jev/sync-vers-consommateurs.mjs --vers <ce depot> --ecrire
#    La copie suit la source a l octet : seul ce bandeau est ajoute ici.
# ===== #
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module client Python pour Jev (TypeSafe AI) avec Coupe-Circuit (Circuit Breaker)
et Observabilité en Données Réelles pour les scripts Tapir / Archicad / Foncier.

Modes :
- 'off'    : Bypass total, zéro appel réseau émis.
- 'shadow' : Mode observation silencieuse (Legacy exécuté en direct, Jev en arrière-plan).
- 'active' : Filtre actif en amont avec sécurité FAIL-OPEN (timeout dur 1.5s).
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

DIR_PATH = os.path.dirname(os.path.abspath(__file__))
LOCAL_OBSERVATIONS_LOG = os.path.join(DIR_PATH, "observations.jsonl")

# Un auto-test n'écrit pas dans le journal d'observation : ses entrées
# porteraient les flux test_py dans le même fichier que les observations
# réelles. Même correctif que côté Node (LEV-JEV-COR-1, 23/09/2026).
EN_AUTO_TEST = "--test" in sys.argv
def extract_confidence(answers):
    """Confiance globale d'une réponse Jev = min des marges de décision.
    noul : distance au seuil binaire (1 = tranché, 0 = pile à 0.5).
    choice : confiance déclarée par le modèle (0-1)."""
    if not isinstance(answers, dict):
        return None
    vals = []
    for v in answers.values():
        if isinstance(v, dict):
            noul = v.get("noul")
            conf = v.get("confidence")
            if isinstance(noul, (int, float)):
                vals.append(2 * abs(noul - 0.5))
            if isinstance(conf, (int, float)):
                vals.append(conf)
    if not vals:
        return None
    return min(vals)


def log_observation(record: dict):
    """Enregistre l'observation dans le journal local JSONL."""
    if EN_AUTO_TEST:
        return
    try:
        record["timestamp"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with open(LOCAL_OBSERVATIONS_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        # La télémétrie ne doit jamais bloquer le calcul
        pass

def call_jev_raw(state: str, questions: dict, timeout_sec: float = 1.5) -> dict:
    """Appel direct à l'API Jev via OpenRouter Decisions."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY absente.")

    url = "https://openrouter.ai/api/alpha/decisions"
    payload = json.dumps({
        "model": "~typesafe/jev-latest",
        "state": state,
        "questions": questions
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://bc-archi.com",
        "X-Title": "InSitu Studio Python Jev Client"
    })

    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout_sec) as response:
        latency_ms = int((time.time() - t0) * 1000)
        body = response.read().decode("utf-8")
        data = json.loads(body)
        return {
            "answers": data.get("answers", {}),
            "usage": data.get("usage", {}),
            "latency_ms": latency_ms
        }

def evaluate_with_circuit_breaker(flux: str, state: str, questions: dict, element_id: str = None, legacy_fallback = None) -> dict:
    """
    Exécute une décision avec coupe-circuit transparent et observabilité.
    """
    mode = os.environ.get("JEV_MODE", "shadow").lower()
    timeout_sec = float(os.environ.get("JEV_TIMEOUT_MS", "1500")) / 1000.0

    # 1. CAS OFF : Court-circuit total
    if mode == "off":
        legacy_res = legacy_fallback() if callable(legacy_fallback) else None
        return {
            "mode": "off",
            "bypassed": True,
            "reason": "JEV_MODE_OFF",
            "answers": None,
            "result": legacy_res
        }

    # 2. CAS SHADOW : Exécution legacy immédiate + log Jev
    if mode == "shadow":
        legacy_res = legacy_fallback() if callable(legacy_fallback) else None
        try:
            jev_res = call_jev_raw(state, questions, timeout_sec)
            log_observation({
                "flux": flux,
                "elementId": element_id,
                "state": state[:500],
                "answers": jev_res.get("answers"),
                "confidence": extract_confidence(jev_res.get("answers")),
                "latencyMs": jev_res.get("latency_ms"),
                "cost": jev_res.get("usage", {}).get("cost", 0),
                "mode": "shadow",
                "bypassed": False
            })
        except Exception as e:
            log_observation({
                "flux": flux,
                "elementId": element_id,
                "state": state[:500],
                "error": str(e),
                "mode": "shadow",
                "bypassed": True
            })
        return {
            "mode": "shadow",
            "bypassed": False,
            "isBackground": True,
            "result": legacy_res
        }

    # 3. CAS ACTIVE : Jev filtre en amont avec FAIL-OPEN
    t0 = time.time()
    try:
        jev_res = call_jev_raw(state, questions, timeout_sec)
        log_observation({
            "flux": flux,
            "elementId": element_id,
            "state": state[:500],
            "answers": jev_res.get("answers"),
            "confidence": extract_confidence(jev_res.get("answers")),
            "latencyMs": jev_res.get("latency_ms"),
            "cost": jev_res.get("usage", {}).get("cost", 0),
            "mode": "active",
            "bypassed": False
        })
        return {
            "mode": "active",
            "bypassed": False,
            "latencyMs": jev_res.get("latency_ms"),
            "answers": jev_res.get("answers"),
            "cost": jev_res.get("usage", {}).get("cost", 0)
        }
    except Exception as e:
        elapsed = int((time.time() - t0) * 1000)
        sys.stderr.write(f"[JEV CIRCUIT-BREAKER FAIL-OPEN] {e} ({elapsed}ms) -> Bascule sur legacy.\n")
        log_observation({
            "flux": flux,
            "elementId": element_id,
            "state": state[:500],
            "error": str(e),
            "latencyMs": elapsed,
            "mode": "active",
            "bypassed": True
        })
        legacy_res = legacy_fallback() if callable(legacy_fallback) else None
        return {
            "mode": "active",
            "bypassed": True,
            "error": str(e),
            "result": legacy_res
        }

if __name__ == "__main__":
    if "--test" in sys.argv:
        print("=== TEST AUTO-VÉRIFICATION DU CLIENT JEV PYTHON CIRCUIT-BREAKER ===")

        # Un banc qui affiche FAIL et rend 0 ne prouve rien : tout appelant qui
        # lit le code de sortie le voit vert. Même correctif que côté Node
        # (LEV-JEV-COR-1, 23/09/2026).
        verts = 0
        rouges = 0
        sautes = 0

        def verdict(ok: bool, label: str, detail: str = ""):
            global verts, rouges
            suffixe = f" — {detail}" if detail else ""
            if ok:
                verts += 1
                print(f"Test {label} : ✅ PASS{suffixe}")
            else:
                rouges += 1
                print(f"Test {label} : ❌ FAIL{suffixe}")
        
        # Test 1 : Mode OFF
        os.environ["JEV_MODE"] = "off"
        r1 = evaluate_with_circuit_breaker("test_py", "state", {}, legacy_fallback=lambda: "PYTHON_LEGACY_OFF")
        verdict(bool(r1["bypassed"] and r1["result"] == "PYTHON_LEGACY_OFF"), "Mode OFF")

        # Test 2 : Mode Fail-Open
        os.environ["JEV_MODE"] = "active"
        os.environ["JEV_TIMEOUT_MS"] = "1"
        r2 = evaluate_with_circuit_breaker("test_py", "state", {}, legacy_fallback=lambda: "PYTHON_LEGACY_TIMEOUT")
        verdict(bool(r2["bypassed"] and r2["result"] == "PYTHON_LEGACY_TIMEOUT"), "Fail-Open Timeout")

        # Test 3 : Mode ACTIVE Nominal (nécessite OPENROUTER_API_KEY + réseau)
        if not os.environ.get("OPENROUTER_API_KEY"):
            print("Test Mode ACTIVE Nominal : [SKIP] OPENROUTER_API_KEY absente - appel réseau non exécuté")
        else:
            os.environ["JEV_TIMEOUT_MS"] = "5000"
            r3 = evaluate_with_circuit_breaker(
                "test_py",
                "Porte 930x2100 conforme",
                {"ok": {"type": "noul", "instructions": "conforme?", "criteria": {"true": "y", "false": "n"}}}
            )
            # La cause est nommée : la réserve de JEV-COR-1 portait sur un
            # fail-open silencieux du test nominal.
            if r3.get("bypassed"):
                cause = str(r3.get("error") or "fail-open sans motif exposé")
            else:
                cause = "" if "ok" in r3.get("answers", {}) else "réponse reçue sans le champ attendu"
            verdict(bool(not r3["bypassed"] and "ok" in r3.get("answers", {})), "Mode ACTIVE Nominal", cause)
            print("Réponses :", r3.get("answers"), f"({r3.get('latencyMs')}ms)")

        print("")
        print(f"BILAN : {verts} vert(s), {rouges} rouge(s), {sautes} sauté(s).")
        if rouges > 0:
            print("EXIT 1 : au moins un test a échoué. Un banc rouge ne rend pas 0.")
            sys.exit(1)
