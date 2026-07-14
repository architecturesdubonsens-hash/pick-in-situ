"""
Worker RunPod Serverless — BC-Archi ODM v37 (conversion HEIC→JPEG + E57/FBX, livrables BIM)
Photos depuis Supabase Storage → conversion HEIC → ODM → LAZ + E57 + GLB + FBX → Supabase Storage
Image : ghcr.io (sans rate limit) + Docker Hub

Env vars RunPod requises :
  SUPABASE_URL   https://fnfrusblyzndbzckkfir.supabase.co
  SUPABASE_KEY   service_role key

POURQUOI handler async (v33) :
  Le SDK RunPod exécute le handler sur SA boucle asyncio (rp_job.run_job appelle
  handler(job) directement). Un handler synchrone qui bloque plusieurs minutes
  (ODM) gèle cette boucle → le long-poll « job-take » et le suivi du job côté
  plateforme s'arrêtent → RunPod juge le worker bloqué et réassigne le job
  (« job timed out after 1 retries », container stoppé à ~35-50s).
  Solution : handler async qui déporte tout le traitement bloquant dans un thread
  d'exécuteur (run_in_executor). La boucle reste libre, le job va à son terme.

v37 (06/07/2026) — Conversion HEIC iPhone :
  ODM 3.6.0 ne supporte pas le HEIC → "Not enough supported images" immédiat,
  même avec 66 photos valides. Conversion automatique HEIC/HEIF → JPEG via
  pillow-heif (préserve l'EXIF GPS/orientation/focale) AVANT lancement ODM.
  Garde-fou : échoue avec un message clair si plus aucun format ODM après conversion.
"""

import runpod, os, subprocess, shutil, requests, json, glob, tempfile, threading, time, asyncio
from pathlib import Path

_START = time.time()
print("[BC-ARCHI] Worker ODM démarré v37 (HEIC→JPEG, E57 + FBX, livrables BIM)", flush=True)


def _read_int(path):
    try:
        v = Path(path).read_text().strip()
        return int(v) if v.isdigit() else None
    except Exception:
        return None


def start_memory_monitor(interval=3):
    """Thread daemon : logge usage mémoire réel + compteur OOM kernel + disque.
    But : départager OOM (usage qui grimpe / oom_kill++) vs arrêt RunPod (usage bas)."""
    def loop():
        while True:
            cur = _read_int("/sys/fs/cgroup/memory.current")
            # memory.events contient oom_kill <n>
            oom = "?"
            try:
                for line in Path("/sys/fs/cgroup/memory.events").read_text().splitlines():
                    if line.startswith("oom_kill"):
                        oom = line.split()[1]
                    if line.startswith("oom "):
                        oom = f"{oom}/oom={line.split()[1]}"
            except Exception:
                pass
            try:
                u = shutil.disk_usage("/tmp")
                disk = f"{u.free / 2**30:.1f}Go libre"
            except Exception:
                disk = "?"
            cur_g = f"{cur / 2**30:.2f}Go" if cur else "?"
            print(f"[BC-ARCHI][mon] mem.current={cur_g} oom_kill={oom} /tmp={disk}", flush=True)
            time.sleep(interval)
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t

SUPA_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPA_KEY = os.environ.get("SUPABASE_KEY", "")

PRESETS = {
    # Relevé bâtiment : nuage de points dense uniquement, pas d'orthophoto
    "batiment": [
        # Anti-nappes (02/07) : relevé façade en 2 passes → 2 chaînes SfM faiblement liées,
        # écartées de ~2 m par le GPS téléphone → façade dédoublée en bandes de profondeur.
        # Correctif : appariement quasi-exhaustif + plus de features + GPS moins contraignant.
        # 40 (07/07) : tour complet de bâtiment en ~66 photos — à 24 voisins la
        # boucle ne se referme pas (dérive en colimaçon), les façades opposées
        # doivent s'apparier directement
        "--matcher-neighbors", "40",
        # DSPSIFT (défaut) et non sift : sift force le chemin GPU pypopsift (absent) →
        # extraction CPU 1 image/fois, glaciale sur 30+ photos → réassignation en boucle.
        # DSPSIFT s'extrait en parallèle et donne de meilleures features.
        "--feature-quality", "high",     # brique répétitive : medium ratait des correspondances inter-passes
        "--min-num-features", "12000",   # + de features pour désambiguïser la texture répétitive
        "--gps-accuracy", "20",          # GPS tél. ±2-5 m : ne pas laisser le BA écarteler les passes
        # Rolling shutter iPhone : lecture capteur ligne à ligne + marche pendant
        # la prise = courbure accumulée sur un tour complet (colimaçon)
        "--rolling-shutter",
        "--pc-quality", "high",
        "--pc-las",
        # Anti-fantômes ciel/flare (07/07) : le ciel lumineux + flare solaire créent de
        # faux appariements → nappes bleues et "voiles" au-dessus du bâtiment.
        "--sky-removal",                 # masque IA du ciel par photo avant reconstruction
        "--auto-boundary",               # coupe les artefacts lointains hors emprise des prises
        "--skip-orthophoto",
        "--skip-3dmodel",
        # conc 4 rétabli : le kill ~140s était le SDK runpod 1.7.3 (bail non renouvelé),
        # pas un OOM — prouvé par sleep/busy 300s tués à ~140s puis OK en SDK 1.10.0.
        "--max-concurrency", "4",
        "--optimize-disk-space",
    ],
    # Relevé bâtiment rapide : qualité medium pour tests (plus rapide)
    "batiment_rapide": [
        "--matcher-neighbors", "16",  # voisins GPS (évite le Delaunay sur GPS coplanaire)
        "--feature-quality", "medium",
        "--pc-quality", "high",
        "--pc-las",
        "--sky-removal",
        "--auto-boundary",
        "--skip-orthophoto",
        "--skip-3dmodel",
        "--max-concurrency", "4",
    ],
    "fast": [
        "--matcher-neighbors", "16",
        "--fast-orthophoto",
        "--orthophoto-resolution", "5",
        "--feature-quality", "low",
        "--pc-las",
        "--max-concurrency", "4",
    ],
    "standard": [
        "--matcher-neighbors", "16",
        "--orthophoto-resolution", "2",
        "--feature-quality", "medium",
        "--pc-quality", "medium",
        "--pc-las",
        "--max-concurrency", "4",
    ],
    "quality": [
        "--matcher-neighbors", "16",
        "--orthophoto-resolution", "1",
        "--feature-quality", "high",
        "--pc-quality", "high",
        "--pc-las",
        "--max-concurrency", "4",
    ],
    # Relevé OBJET : prise de vue en révolution 360° autour d'un objet/détail.
    # Géométrie radicalement différente de la façade → réglages dédiés :
    "objet": [
        # quasi-exhaustif : autour d'un petit objet le GPS téléphone est quasi constant,
        # donc la sélection de voisins par GPS est dégénérée. 0 déclencherait le Delaunay
        # (crash sur GPS coplanaire) → on force un grand N = appariement de toutes les paires.
        "--matcher-neighbors", "200",
        "--feature-quality", "ultra",     # objet proche, détails fins → features max
        "--min-num-features", "16000",
        "--pc-quality", "high",
        "--pc-las",
        "--use-3dmesh",                    # maillage 3D complet : l'objet est vu de tous côtés
        "--mesh-octree-depth", "12",       # (le 2.5D suppose une scène ~plane vue de dessus → faux ici)
        "--mesh-size", "300000",
        "--skip-orthophoto",               # orthophoto d'un objet = sans objet
        "--gps-accuracy", "100",           # neutralise le GPS téléphone (dégénéré autour d'un objet)
        "--max-concurrency", "4",
        "--optimize-disk-space",
    ],
}

# Variante bardage métallique / surfaces sombres (RAL foncés, laquage réfléchissant) :
# mêmes réglages que batiment, mais plus de features — après débouchage des ombres la
# texture reste pauvre, il faut aider le matching à s'accrocher aux micro-détails.
_sombre = list(PRESETS["batiment"])
_sombre[_sombre.index("--min-num-features") + 1] = "20000"
PRESETS["batiment_sombre"] = _sombre


def pretraiter_surfaces_sombres(photos):
    """Débouchage numérique des photos avant ODM (façades sombres/réfléchissantes).

    Équivalent automatisé du flux Lightroom « ombres + / clarté + / hautes lumières − » :
    sur le canal L (LAB, préserve les couleurs) : courbe tonale globale IDENTIQUE pour
    toutes les photos (levée d'ombres gamma 0.8 + compression des hautes lumières = reflets
    du ciel sur le laquage), puis CLAHE (micro-contraste local) pour donner de la matière
    au matching SIFT sur les surfaces uniformes type bardage RAL 7022.

    L'EXIF (GPS !) est retransplanté dans le JPEG réécrit — sans lui, le matching par
    voisins GPS et le géoréférencement s'effondrent. Non bloquant : toute erreur laisse
    la photo d'origine en place.
    """
    try:
        import cv2, numpy as np, piexif
    except ImportError as e:
        print(f"[BC-ARCHI] ⚠ prétraitement ignoré (dépendance manquante : {e})", flush=True)
        return

    # Courbe tonale globale (construite une fois, appliquée à l'identique partout)
    x = np.arange(256) / 255.0
    y = np.power(x, 0.8)                     # levée d'ombres
    knee = 0.82
    m = y > knee
    y[m] = knee + (y[m] - knee) * 0.65       # compression hautes lumières (reflets)
    lut = np.clip(y * 255.0, 0, 255).astype(np.uint8)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))

    t0, n_ok = time.time(), 0
    for p in photos:
        if p.suffix.lower() not in (".jpg", ".jpeg"):
            continue
        try:
            img = cv2.imread(str(p))
            if img is None:
                raise RuntimeError("lecture cv2 impossible")
            lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
            l, a, b = cv2.split(lab)
            l = cv2.LUT(l, lut)
            l = clahe.apply(l)
            out = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)

            tmp = p.parent / (p.stem + "_pretraite.jpg")
            cv2.imwrite(str(tmp), out, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
            try:
                piexif.transplant(str(p), str(tmp))   # EXIF/GPS d'origine → JPEG traité
            except Exception:
                pass  # photo sans EXIF : rien à transplanter
            tmp.replace(p)
            n_ok += 1
        except Exception as e:
            print(f"[BC-ARCHI] ⚠ prétraitement {p.name} : {e} (photo d'origine conservée)", flush=True)
    print(f"[BC-ARCHI] ✓ prétraitement surfaces sombres : {n_ok}/{len(photos)} photos "
          f"en {time.time()-t0:.0f}s", flush=True)


def supa_headers():
    return {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}


def update_status(releve_id, statut, extra=None):
    if not releve_id:
        return
    body = {"statut": statut, "updated_at": "now()"}
    if extra:
        body.update(extra)
    try:
        requests.patch(
            f"{SUPA_URL}/rest/v1/releves?id=eq.{releve_id}",
            headers={**supa_headers(), "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=body, timeout=10
        )
    except Exception as e:
        print(f"[BC-ARCHI] update_status erreur : {e}", flush=True)


def convert_heic_to_jpeg(photos_dir):
    """Convertit les HEIC/HEIF en JPEG (ODM ne supporte pas HEIC).
    Préserve TOUTES les métadonnées EXIF (GPS, orientation, focale, date) via
    pillow-heif qui les conserve dans img.info['exif'] puis exif=... au save.
    Supprime les HEIC originaux après conversion réussie."""
    heic_files = [p for p in photos_dir.glob("*.*")
                  if p.suffix.lower() in (".heic", ".heif")]
    if not heic_files:
        return 0

    print(f"[BC-ARCHI] ⚠ {len(heic_files)} photo(s) HEIC/HEIF détectée(s) — conversion JPEG en cours...", flush=True)

    # pillow-heif est le seul chemin qui préserve l'EXIF de bout en bout.
    try:
        from pillow_heif import register_heif_opener
        from PIL import Image, ImageOps
        register_heif_opener()
        print("[BC-ARCHI] Conversion via pillow-heif (EXIF GPS préservé)", flush=True)
    except ImportError:
        # Fallback ImageMagick/ffmpeg : perte EXIF GPS possible — avertir.
        print("[BC-ARCHI] ⚠ pillow-heif indisponible — fallback ImageMagick/ffmpeg "
              "(EXIF GPS NON préservé, install pillow-heif pour le garder)", flush=True)
        converted = 0
        for heic in heic_files:
            out_jpg = heic.with_suffix(".jpg")
            try:
                if shutil.which("magick"):
                    subprocess.run(["magick", str(heic), str(out_jpg)], check=True, timeout=30)
                elif shutil.which("convert"):
                    subprocess.run(["convert", str(heic), str(out_jpg)], check=True, timeout=30)
                elif shutil.which("ffmpeg"):
                    subprocess.run(["ffmpeg", "-y", "-i", str(heic), "-q:v", "2", str(out_jpg)],
                                   check=True, timeout=30, capture_output=True)
                else:
                    raise RuntimeError("Aucun convertisseur HEIC trouvé ( pillow-heif / ImageMagick / ffmpeg )")
                heic.unlink()
                converted += 1
            except Exception as e:
                print(f"[BC-ARCHI] ✗ Conversion {heic.name} échouée : {e} (fichier conservé)", flush=True)
        return converted

    # Chemin principal : pillow-heif
    converted = 0
    for heic in heic_files:
        out_jpg = heic.with_suffix(".jpg")
        try:
            img = Image.open(heic)
            # 1. Appliquer l'orientation EXIF (sinon photo paysage/portrait retournée)
            img = ImageOps.exif_transpose(img)
            # 2. Récupérer le blob EXIF brut (contient GPS, focale, date, etc.)
            exif_bytes = img.info.get("exif")
            # 3. Sauver en JPEG en réinjectant l'EXIF complet
            save_kwargs = {"format": "JPEG", "quality": 95}
            if exif_bytes:
                save_kwargs["exif"] = exif_bytes
            img.save(str(out_jpg), **save_kwargs)
            img.close()

            heic.unlink()  # Supprimer le HEIC original
            converted += 1
            print(f"[BC-ARCHI] ✓ {heic.name} → {out_jpg.name} "
                  f"({'EXIF GPS préservé' if exif_bytes else 'sans EXIF'})", flush=True)
        except Exception as e:
            print(f"[BC-ARCHI] ✗ Conversion {heic.name} échouée : {e} (fichier conservé)", flush=True)

    print(f"[BC-ARCHI] Conversion HEIC : {converted}/{len(heic_files)} réussie(s)", flush=True)
    return converted


def purge_photos_source(releve_id):
    """Supprime les photos sources du bucket après un job réussi : elles pèsent
    ~94 % du stockage (re-fournissables depuis l'iPhone) alors que seuls les
    livrables ont de la valeur. Non bloquant — un échec de purge n'affecte pas
    le job. Conservées en cas d'échec du job (permet la relance)."""
    listed = requests.post(
        f"{SUPA_URL}/storage/v1/object/list/releves",
        headers={**supa_headers(), "Content-Type": "application/json"},
        json={"prefix": f"{releve_id}/photos/", "limit": 1000},
        timeout=30,
    )
    listed.raise_for_status()
    names = [f"{releve_id}/photos/{o['name']}" for o in listed.json() if o.get("name")]
    if not names:
        return 0
    for i in range(0, len(names), 200):
        requests.delete(
            f"{SUPA_URL}/storage/v1/object/releves",
            headers={**supa_headers(), "Content-Type": "application/json"},
            json={"prefixes": names[i:i + 200]},
            timeout=60,
        ).raise_for_status()
    print(f"[BC-ARCHI] ✓ purge : {len(names)} photos sources supprimées du bucket", flush=True)
    return len(names)


def download_photos(releve_id, dest_dir):
    """Télécharge toutes les photos du bucket releves/{releve_id}/photos/"""
    r = requests.post(
        f"{SUPA_URL}/storage/v1/object/list/releves",
        headers={**supa_headers(), "Content-Type": "application/json"},
        json={"prefix": f"{releve_id}/photos/", "limit": 500},
        timeout=30
    )
    r.raise_for_status()
    items = r.json()
    if not items:
        raise RuntimeError(f"Aucune photo trouvée pour le relevé {releve_id}")

    photos_dir = Path(dest_dir) / "images"
    photos_dir.mkdir(parents=True, exist_ok=True)

    for item in items:
        name = item.get("name", "")
        if not name:
            continue
        file_path = f"{releve_id}/photos/{name}"
        dl = requests.get(
            f"{SUPA_URL}/storage/v1/object/releves/{file_path}",
            headers=supa_headers(), timeout=60, stream=True
        )
        dl.raise_for_status()
        out = photos_dir / name
        with open(out, "wb") as f:
            for chunk in dl.iter_content(65536):
                f.write(chunk)
        print(f"[BC-ARCHI] ✓ {name}", flush=True)

    # Conversion automatique HEIC → JPEG (iPhone)
    convert_heic_to_jpeg(photos_dir)

    return list(photos_dir.glob("*.*"))


def log_resources(tag=""):
    """Diagnostic : RAM hôte, limite cgroup, type de mount /tmp, disque dispo.
    Sert à départager OOM / timeout / disque plein sur RunPod Serverless."""
    prefix = f"[BC-ARCHI][diag{' ' + tag if tag else ''}]"
    # RAM vue par le process (= hôte, ce que lit OpenSfM)
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith(("MemTotal", "MemAvailable")):
                print(f"{prefix} {line.strip()}", flush=True)
    except Exception as e:
        print(f"{prefix} meminfo indispo : {e}", flush=True)
    # Limite mémoire réelle du conteneur (cgroup v2 puis v1)
    for cg in ("/sys/fs/cgroup/memory.max",
               "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            if Path(cg).exists():
                val = Path(cg).read_text().strip()
                if val.isdigit():
                    val = f"{val} ({int(val) / 2**30:.1f} Go)"
                print(f"{prefix} cgroup {cg} = {val}", flush=True)
        except Exception:
            pass
    # /tmp est-il un tmpfs (= en RAM) ? + disque dispo sur les chemins candidats
    try:
        for line in Path("/proc/mounts").read_text().splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[1] in ("/tmp", "/", "/runpod-volume", "/workspace"):
                print(f"{prefix} mount {parts[1]} type={parts[2]}", flush=True)
    except Exception:
        pass
    for p in ("/tmp", "/", "/runpod-volume", "/workspace"):
        try:
            if Path(p).exists():
                u = shutil.disk_usage(p)
                print(f"{prefix} {p}: total={u.total / 2**30:.1f}Go "
                      f"libre={u.free / 2**30:.1f}Go", flush=True)
        except Exception:
            pass


def run_odm(project_path, project_name, options):
    # ODM 3.x : run.py --project-path <parent_dir> <dataset_name> [flags]
    # Photos attendues à project_path/project_name/images/
    # Sorties dans project_path/project_name/odm_orthophoto/, odm_georeferencing/, etc.
    # v35 — nice -n 15 : dé-priorise ODM (et ses enfants type dem2mesh) au niveau noyau
    # pour laisser le process worker.py (et le heartbeat/probe du SDK RunPod) obtenir
    # du temps CPU même quand ODM sature les cœurs avec --max-concurrency.
    # Hypothèse : le worker est tué par une liveness probe locale (Kubelet) qui timeout
    # faute de réponse quand le CPU est 100% pris par ODM — pas un crash applicatif.
    cmd = [
        "nice", "-n", "15",
        "python3", "/code/run.py",
        "--project-path", str(project_path),
        project_name,
    ] + options

    print(f"[BC-ARCHI] ODM : {' '.join(cmd)}", flush=True)
    # Le handler tourne dans un thread d'exécuteur (cf. handler async v33) : on peut
    # bloquer ici sans geler la boucle asyncio de RunPod. subprocess.run suffit.
    # v37 : capture stdout+stderr dans un fichier log ODM pour diagnostic post-mortem.
    odm_log_path = Path(project_path) / project_name / "odm_output.log"
    odm_log_path.parent.mkdir(parents=True, exist_ok=True)
    odm_tail = []  # dernières 40 lignes (pour l'erreur RunPod)
    # Relais de progression : la sortie ODM part dans un fichier, donc sans ceci
    # les logs RunPod sont muets pendant tout le traitement (vécu 08/07 : job de
    # 5h+ indiagnosticable, 500 lignes de moniteur mémoire et rien d'autre).
    # Toutes les 60 s, la dernière ligne du log ODM est relayée sur stdout.
    stop_relay = threading.Event()
    def _relay():
        last = ""
        while not stop_relay.wait(60):
            try:
                lines = odm_log_path.read_text(errors="replace").splitlines()
                cur = lines[-1].strip() if lines else ""
                if cur and cur != last:
                    last = cur
                    print(f"[BC-ARCHI][odm] {cur[:300]}", flush=True)
            except Exception:
                pass
    relay_t = threading.Thread(target=_relay, daemon=True)
    # Watchdog : timeout dur sur le sous-processus ODM — 40 min. Un run normal
    # fait 13-17 min ; au-delà de 40 min quelque chose patine et chaque minute
    # se facture. Piloté par ODM_TIMEOUT_S (env) si besoin de plus.
    odm_timeout = int(os.environ.get("ODM_TIMEOUT_S", "2400"))
    try:
        relay_t.start()
        with odm_log_path.open("w") as logf:
            proc = subprocess.run(cmd, stdout=logf, stderr=subprocess.STDOUT, text=True,
                                  timeout=odm_timeout)
        # Relire les dernières lignes du log
        lines = odm_log_path.read_text().splitlines()
        odm_tail = lines[-40:] if len(lines) > 40 else lines
    except subprocess.TimeoutExpired:
        try:
            lines = odm_log_path.read_text(errors="replace").splitlines()
            odm_tail = lines[-40:] if len(lines) > 40 else lines
        except Exception:
            odm_tail = []
        raise RuntimeError(
            f"ODM interrompu par watchdog après {odm_timeout}s (étape probablement "
            f"bloquée — chaque minute se facture)\nDernières lignes ODM :\n" + "\n".join(odm_tail))
    except Exception:
        proc = subprocess.run(cmd, stdout=None, stderr=subprocess.STDOUT, text=True)
    finally:
        stop_relay.set()

    if proc.returncode != 0:
        # returncode < 0 = process tué par un signal (-9 = SIGKILL = OOM killer le plus souvent)
        if proc.returncode < 0:
            import signal as _sig
            sig = -proc.returncode
            try:
                signame = _sig.Signals(sig).name
            except ValueError:
                signame = f"SIG{sig}"
            log_resources("après crash ODM")
            raise RuntimeError(f"ODM tué par signal {sig} ({signame}) — -9/SIGKILL = OOM probable\n"
                               f"Logs ODM (dernières lignes) :\n" + "\n".join(odm_tail))
        raise RuntimeError(f"ODM a échoué (code {proc.returncode}) — {len(options)} flags\n"
                           f"Logs ODM (dernières lignes) :\n" + "\n".join(odm_tail))
    return proc


def auto_level(laz_path):
    """Auto-nivellement : sans point de calage, le GPS téléphone laisse un dévers
    (roulis/tangage) de plusieurs degrés — mesuré 4,45° sur relevé réel 07/07/2026.
    Détection RANSAC du plan du sol dans la tranche basse du nuage (percentiles
    1-15 en Z), raffinement moindres carrés, rotation autour du centroïde pour
    remettre ce plan à l'horizontale. Itère (max 3) car l'estimateur RANSAC a une
    variance de ~1° sur un sol partiel de relevé façade. Réécrit le LAZ en place.
    Garde-fous : inliers >= 10 %, correction initiale seulement si dévers dans
    [0.3°, 8°] (au-delà : pente réelle ou sol mal détecté → ne pas toucher).
    Retourne (R 3x3 cumulée ou None, dévers_initial_degrés)."""
    import laspy
    import numpy as np

    def detect_plane(pts, rng):
        sub = pts[rng.choice(len(pts), min(400000, len(pts)), replace=False)]
        z1, z15 = np.percentile(sub[:, 2], [1, 15])
        ground = sub[(sub[:, 2] >= z1) & (sub[:, 2] <= z15)]
        if len(ground) < 5000:
            return None, 0.0, 0.0
        best_inl, best_n, best_pt = 0, None, None
        for _ in range(500):
            s3 = ground[rng.choice(len(ground), 3, replace=False)]
            nv = np.cross(s3[1] - s3[0], s3[2] - s3[0])
            norm = np.linalg.norm(nv)
            if norm < 1e-9:
                continue
            nv = nv / norm
            if abs(nv[2]) < 0.85:      # candidat trop vertical = mur, pas le sol
                continue
            d = np.abs((ground - s3[0]) @ nv)
            inl = int((d < 0.05).sum())
            if inl > best_inl:
                best_inl, best_n, best_pt = inl, (nv if nv[2] > 0 else -nv), s3[0]
        # 7 % : un relevé façade n'a qu'une bande de sol étroite (9,5 % mesuré
        # sur relevé réel avec sky-removal) — 10 % faisait sauter la correction
        if best_n is None or best_inl < len(ground) * 0.07:
            return None, 0.0, 0.0
        d = np.abs((ground - best_pt) @ best_n)
        inliers = ground[d < 0.05]
        c = inliers.mean(axis=0)
        _, _, vt = np.linalg.svd(inliers - c, full_matrices=False)
        nrm = vt[2]
        if nrm[2] < 0:
            nrm = -nrm
        tilt = float(np.degrees(np.arccos(np.clip(nrm[2], -1.0, 1.0))))
        return nrm, tilt, best_inl / len(ground)

    def rotation_to_z(nrm):
        zax = np.array([0.0, 0.0, 1.0])
        axis = np.cross(nrm, zax)
        sn = np.linalg.norm(axis)
        if sn < 1e-12:
            return np.eye(3)
        axis = axis / sn
        ang = np.arccos(np.clip(nrm[2], -1.0, 1.0))
        K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
        return np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * (K @ K)

    las = laspy.read(str(laz_path))
    pts = np.column_stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)])
    if len(pts) < 50000:
        return None, 0.0
    rng = np.random.default_rng(0)
    ctr = pts.mean(axis=0)

    nrm, tilt0, ratio = detect_plane(pts, rng)
    if nrm is None:
        print("[BC-ARCHI] auto-level : sol non fiable — pas de correction", flush=True)
        return None, 0.0
    if tilt0 < 0.3 or tilt0 > 8.0:
        print(f"[BC-ARCHI] auto-level : dévers {tilt0:.2f}° hors plage [0.3–8] — pas de correction", flush=True)
        return None, tilt0

    # Raffinement déterministe : le RANSAC 3-points a ~1° de variance sur un sol
    # partiel — on verrouille le plan dominant par ajustements SVD successifs sur
    # ses propres inliers, seuil décroissant 8 → 3 cm (convergence stable).
    sub = pts[rng.choice(len(pts), min(600000, len(pts)), replace=False)]
    point_on_plane = sub[np.abs(((sub - ctr) @ nrm)
                                - np.median((sub - ctr) @ nrm)) < 10.0].mean(axis=0)
    # point d'ancrage : médiane des distances signées de la tranche basse
    z1, z15 = np.percentile(sub[:, 2], [1, 15])
    band = sub[(sub[:, 2] >= z1) & (sub[:, 2] <= z15)]
    dist = (band - band.mean(axis=0)) @ nrm
    anchor = band.mean(axis=0) + nrm * np.median(dist)
    plane_n = nrm
    for seuil in (0.08, 0.05, 0.03, 0.03):
        d = np.abs((band - anchor) @ plane_n)
        inl = band[d < seuil]
        if len(inl) < 3000:
            break
        c = inl.mean(axis=0)
        _, _, vt = np.linalg.svd(inl - c, full_matrices=False)
        plane_n = vt[2] if vt[2][2] > 0 else -vt[2]
        anchor = c
    tilt_fin = float(np.degrees(np.arccos(np.clip(plane_n[2], -1.0, 1.0))))
    if tilt_fin < 0.2 or tilt_fin > 5.0:
        print(f"[BC-ARCHI] auto-level : dévers raffiné {tilt_fin:.2f}° hors plage [0.2–5] — pas de correction", flush=True)
        return None, tilt_fin

    R_total = rotation_to_z(plane_n)

    # ── Contre-contrôle par l'aplomb des façades (07/07) ─────────────────────
    # Un faux plan de sol (rampe, gravats, plancher) peut passer les seuils et
    # "corriger" un nuage déjà droit en le penchant (vécu : 6,81° appliqués à
    # tort). Les murs d'un bâtiment sont d'aplomb : la correction n'est admise
    # que si elle rend le mur dominant PLUS vertical (|nz| façade en baisse).
    wall_n, wall_inl = None, 0
    for _ in range(400):
        s3 = sub[rng.choice(len(sub), 3, replace=False)]
        nv = np.cross(s3[1] - s3[0], s3[2] - s3[0])
        norm = np.linalg.norm(nv)
        if norm < 1e-9:
            continue
        nv = nv / norm
        if abs(nv[2]) > 0.30:          # candidat pas assez vertical = pas un mur
            continue
        d = np.abs((sub - s3[0]) @ nv)
        w_inl = int((d < 0.06).sum())
        if w_inl > wall_inl:
            wall_inl, wall_n = w_inl, nv
    if wall_n is not None and wall_inl > len(sub) * 0.05:
        nz_avant = abs(float(wall_n[2]))
        nz_apres = abs(float((R_total @ wall_n)[2]))
        if nz_apres > nz_avant + 0.005:
            print(f"[BC-ARCHI] auto-level REJETÉ : la correction penche la façade "
                  f"dominante (|nz| {nz_avant:.3f} → {nz_apres:.3f}) — faux plan de sol probable "
                  f"(dévers candidat {tilt_fin:.2f}°)", flush=True)
            return None, tilt_fin
        print(f"[BC-ARCHI] auto-level validé par l'aplomb façade "
              f"(|nz| {nz_avant:.3f} → {nz_apres:.3f})", flush=True)
    work = (pts - ctr) @ R_total.T + ctr
    las.x = work[:, 0]
    las.y = work[:, 1]
    las.z = work[:, 2]
    las.write(str(laz_path))
    print(f"[BC-ARCHI] ✓ auto-level : dévers {tilt_fin:.2f}° corrigé "
          f"(plan sol raffiné, {len(inl)} inliers)", flush=True)
    return R_total, tilt_fin


def convert_e57(laz_path, e57_path):
    """LAZ → E57 (livrable BIM ArchiCAD/Revit).
    1) PDAL si son writer e57 est présent (le plus simple/robuste).
    2) sinon laspy (lecture LAZ) + pye57 (écriture E57)."""
    # 1) PDAL
    try:
        drv = subprocess.run(["pdal", "--drivers"], capture_output=True, text=True, timeout=30).stdout
        if "writers.e57" in drv:
            subprocess.run(["pdal", "translate", str(laz_path), str(e57_path)], check=True)
            print(f"[BC-ARCHI] ✓ E57 (via PDAL) : {e57_path}", flush=True)
            return
    except Exception as e:
        print(f"[BC-ARCHI] E57 : PDAL indisponible ({e}), bascule pye57", flush=True)

    # 2) laspy + pye57
    import laspy, numpy as np, pye57
    las = laspy.read(str(laz_path))
    data = {
        "cartesianX": np.asarray(las.x, dtype=np.float64),
        "cartesianY": np.asarray(las.y, dtype=np.float64),
        "cartesianZ": np.asarray(las.z, dtype=np.float64),
    }
    # Couleurs RGB si présentes. LAZ stocke souvent le RGB sur 16 bits (0-65535) ;
    # E57/BIM attend du 8 bits (0-255). On ne divise que si les valeurs dépassent 255.
    if hasattr(las, "red"):
        r, g, b = np.asarray(las.red), np.asarray(las.green), np.asarray(las.blue)
        if max(int(r.max()), int(g.max()), int(b.max())) > 255:
            r, g, b = r >> 8, g >> 8, b >> 8
        data["colorRed"]   = r.astype(np.uint8)
        data["colorGreen"] = g.astype(np.uint8)
        data["colorBlue"]  = b.astype(np.uint8)
    e57 = pye57.E57(str(e57_path), mode="w")
    e57.write_scan_raw(data)
    e57.close()
    print(f"[BC-ARCHI] ✓ E57 (via pye57, {len(data['cartesianX'])} pts) : {e57_path}", flush=True)


def convert_copc(laz_path, copc_path):
    """LAZ → COPC (Cloud Optimized Point Cloud) via PDAL, pour viewer web Potree.
    pdal n'est pas dans le PATH du worker → on le cherche dans les chemins ODM.
    L'extension .copc.laz déclenche automatiquement le writer copc de PDAL."""
    pdal_bin = None
    for c in ("pdal",
              "/code/SuperBuild/install/bin/pdal",
              "/usr/bin/pdal", "/usr/local/bin/pdal"):
        if shutil.which(c) or Path(c).exists():
            pdal_bin = c
            break
    if not pdal_bin:
        raise RuntimeError("pdal introuvable pour la conversion COPC")
    subprocess.run(
        [pdal_bin, "translate", str(laz_path), str(copc_path), "--writers.copc.forward=all"],
        check=True,
    )
    if not Path(copc_path).exists():
        raise RuntimeError("PDAL n'a pas produit le COPC")
    print(f"[BC-ARCHI] ✓ COPC (via {pdal_bin}) : {copc_path}", flush=True)


def _find_pdal():
    for c in ("pdal", "/code/SuperBuild/install/bin/pdal", "/usr/bin/pdal", "/usr/local/bin/pdal"):
        if shutil.which(c) or Path(c).exists():
            return c
    return None


def convert_web_laz(laz_path, web_path):
    """LAZ (LAS 1.4 ODM) → LAZ LAS 1.2 pour le viewer web (loaders.gl ne lit que ≤ 1.3).
    Format de point 3 (XYZ + RGB) conservé."""
    pdal_bin = _find_pdal()
    if not pdal_bin:
        raise RuntimeError("pdal introuvable pour le LAZ web")
    subprocess.run(
        [pdal_bin, "translate", str(laz_path), str(web_path),
         "--writers.las.minor_version=2", "--writers.las.dataformat_id=3",
         "--writers.las.forward=all"],
        check=True,
    )
    if not Path(web_path).exists():
        raise RuntimeError("PDAL n'a pas produit le LAZ web")
    print(f"[BC-ARCHI] ✓ LAZ web 1.2 (via {pdal_bin}) : {web_path}", flush=True)


def convert_gltf(obj_path, glb_path, R_level=None):
    """OBJ → GLB via trimesh (Python pur, pas de CLI externe).
    - Chargé en Scene (PAS force='mesh') : conserve matériaux + textures dans le GLB.
    - ODM est Z-up (UTM local), glTF est Y-up → rotation -90° autour de X, sinon le
      bâtiment arrive debout sur la tranche dans les viewers (PickInSitu, VizInSitu).
    - Recentrage : centre XZ à l'origine, sol à Y=0 — les coordonnées locales ODM
      sont décalées de dizaines de mètres. Le géoréférencement reste porté par le
      LAZ/E57 et patch.json ; le GLB est le livrable visualisation."""
    import numpy as np, trimesh
    scene = trimesh.load(str(obj_path))
    if not isinstance(scene, trimesh.Scene):
        scene = trimesh.Scene(scene)
    if R_level is not None:
        # même redressement que le nuage (auto-level), appliqué autour du centre
        # du mesh — la rotation seule suffit, le GLB est recentré juste après
        ctr = scene.bounds.mean(axis=0)
        M = np.eye(4)
        M[:3, :3] = R_level
        M[:3, 3] = ctr - R_level @ ctr
        scene.apply_transform(M)
    scene.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, (1, 0, 0)))
    b = scene.bounds
    scene.apply_transform(trimesh.transformations.translation_matrix(
        [-(b[0][0] + b[1][0]) / 2, -b[0][1], -(b[0][2] + b[1][2]) / 2]))
    scene.export(str(glb_path))
    print(f"[BC-ARCHI] ✓ GLB (Y-up, recentré, textures) : {glb_path}", flush=True)


def convert_fbx(obj_path, fbx_path, R_level=None):
    """OBJ → FBX via Blender headless, textures embarquées (livrable BIM ArchiCAD/Revit).
    Blender embarque son propre Python : on l'appelle en sous-processus --background."""
    # Rotation d'auto-nivellement (repère ODM Z-up) appliquée autour du centre
    # de la géométrie avant export — cohérence avec le LAZ/E57/GLB nivelés
    level_code = ""
    if R_level is not None:
        r = [[float(v) for v in row] for row in R_level]
        level_code = (
            "import mathutils\n"
            f"_R = mathutils.Matrix((({r[0][0]}, {r[0][1]}, {r[0][2]}, 0.0),"
            f" ({r[1][0]}, {r[1][1]}, {r[1][2]}, 0.0),"
            f" ({r[2][0]}, {r[2][1]}, {r[2][2]}, 0.0), (0.0, 0.0, 0.0, 1.0)))\n"
            "_objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']\n"
            "if _objs:\n"
            "    _pts = [o.matrix_world @ mathutils.Vector(c) for o in _objs for c in o.bound_box]\n"
            "    _ctr = sum(_pts, mathutils.Vector()) / len(_pts)\n"
            "    _T1 = mathutils.Matrix.Translation(-_ctr)\n"
            "    _T2 = mathutils.Matrix.Translation(_ctr)\n"
            "    for o in _objs: o.matrix_world = _T2 @ _R @ _T1 @ o.matrix_world\n"
        )
    script = (
        "import bpy\n"
        "def _imp(p):\n"
        "    try: bpy.ops.wm.obj_import(filepath=p)\n"            # Blender 3.3+
        "    except AttributeError: bpy.ops.import_scene.obj(filepath=p)\n"  # legacy
        "bpy.ops.wm.read_factory_settings(use_empty=True)\n"
        f"_imp(r'{obj_path}')\n"
        + level_code +
        f"bpy.ops.export_scene.fbx(filepath=r'{fbx_path}', path_mode='COPY', embed_textures=True)\n"
    )
    sp = Path(tempfile.gettempdir()) / "fbx_export.py"
    sp.write_text(script)
    subprocess.run(
        ["blender", "--background", "--factory-startup", "--python", str(sp)],
        check=True, timeout=600,
    )
    if not Path(fbx_path).exists():
        raise RuntimeError("Blender n'a pas produit le FBX")
    print(f"[BC-ARCHI] ✓ FBX : {fbx_path}", flush=True)


def upload_file(local_path, storage_path):
    """Upload vers Supabase Storage bucket releves"""
    mime = "application/octet-stream"
    ext = Path(local_path).suffix.lower()
    mimes = {".tif": "image/tiff", ".json": "application/json",
             ".laz": "application/octet-stream", ".e57": "application/octet-stream",
             ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
             ".obj": "model/obj", ".png": "image/png"}
    mime = mimes.get(ext, mime)

    with open(local_path, "rb") as f:
        data = f.read()

    r = requests.post(
        f"{SUPA_URL}/storage/v1/object/releves/{storage_path}",
        headers={**supa_headers(), "Content-Type": mime, "x-upsert": "true"},
        data=data, timeout=300
    )
    if not r.ok:
        raise RuntimeError(f"Upload {storage_path} : {r.status_code} {r.text[:200]}")
    print(f"[BC-ARCHI] ↑ {storage_path}", flush=True)


def _diag(job):
    """Mode diagnostic : aucun appel ODM. Discrimine la cause du kill ~90-150s :
    - sleep : 0 CPU, 0 GPU → si tué, c'est un timer de vie du conteneur
    - busy  : CPU saturé, 0 GPU → si tué (et sleep survit), c'est l'éviction sous charge CPU
    Logge chaque 5s pour horodater précisément l'arrêt dans les logs worker."""
    inp = job.get("input", {})
    mode = inp.get("diag")
    secs = int(inp.get("seconds", 300))
    print(f"[BC-ARCHI][diag] mode={mode} durée={secs}s", flush=True)
    log_resources("diag start")
    start_memory_monitor()
    t0 = time.time()
    x = 0
    while time.time() - t0 < secs:
        if mode == "busy":
            for _ in range(3_000_000):
                x += 1
        else:
            time.sleep(5)
        print(f"[BC-ARCHI][diag] {mode} t={int(time.time()-t0)}s vivant", flush=True)
    print(f"[BC-ARCHI][diag] SURVÉCU {secs}s — pas de kill", flush=True)
    return {"diag": mode, "seconds": secs, "survived": True}


def _process(job):
    inp = job.get("input", {})
    if inp.get("diag"):
        return _diag(job)
    releve_id = inp.get("releve_id")
    options_in = inp.get("options", {})
    preset = options_in.get("preset", "standard")
    want_pc   = options_in.get("pc",   True)
    want_mesh = options_in.get("mesh", False)
    want_e57  = options_in.get("e57",  True)   # E57 si nuage de points (BIM)
    want_gltf = options_in.get("gltf", True)   # GLB si maillage (web/VizInSitu)
    want_fbx  = options_in.get("fbx",  True)   # FBX si maillage (BIM ArchiCAD/Revit)
    want_copc = options_in.get("copc", True)   # COPC (nuage cloud-optimisé) pour viewer web Potree

    print(f"[BC-ARCHI] Job {job.get('id')} — relevé {releve_id} — preset {preset}", flush=True)
    log_resources("démarrage job")
    start_memory_monitor()  # logge [mon] mem.current/oom_kill toutes les 3s

    # /workspace = volume disque RunPod (pas tmpfs) — évite l'OOM sur /tmp en RAM
    workspace = Path("/workspace") if Path("/workspace").exists() else Path(tempfile.gettempdir())
    job_id = job.get("id", "local")
    tmpdir = workspace / f"odm_{job_id}"
    tmpdir.mkdir(parents=True, exist_ok=True)

    try:
        project_name = f"odm_{releve_id[:8]}" if releve_id else "odm_test"
        project_path = tmpdir

        # ── 1. Téléchargement des photos ──────────────────────────────────────
        update_status(releve_id, "downloading")
        photos = download_photos(releve_id, project_path / project_name)
        print(f"[BC-ARCHI] {len(photos)} photos téléchargées", flush=True)

        # ── 1ter. Garde-fou : ne lancer ODM que s'il reste des formats supportés.
        # ODM accepte jpg/jpeg/png/tif/tiff (+ raw via darktable). Si après conversion
        # HEIC→JPEG il ne reste que des formats exotiques, ODM sortira
        # "Not enough supported images" — on échoue ici avec un message explicite.
        ODM_SUPPORTED = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
        supported = [p for p in photos if p.suffix.lower() in ODM_SUPPORTED]
        if not supported:
            exts = sorted({p.suffix.lower() for p in photos})
            raise RuntimeError(
                f"Aucune image au format supporté par ODM ({sorted(ODM_SUPPORTED)}). "
                f"Formats reçus : {exts}. "
                f"Si ce sont des HEIC, la conversion a échoué — vérifier pillow-heif dans le Dockerfile."
            )
        if len(supported) < len(photos):
            print(f"[BC-ARCHI] ⚠ {len(photos) - len(supported)} fichier(s) ignoré(s) "
                  f"(format non supporté par ODM)", flush=True)

        # ── 1bis. Prétraitement optionnel (façades sombres / bardage réfléchissant) ──
        # Déclenché par options.pretraitement = "sombre" ou par le preset batiment_sombre.
        pretraitement = options_in.get("pretraitement") or (
            "sombre" if preset == "batiment_sombre" else None)
        if pretraitement in ("sombre", True):
            pretraiter_surfaces_sombres(photos)

        # ── 2. Options ODM ────────────────────────────────────────────────────
        odm_opts = list(PRESETS.get(preset, PRESETS["standard"]))

        # Fermeture de boucle (08/07, après explosion de coût) : un ancien bloc forçait
        # matcher-neighbors=len(photos) + matcher-type=bruteforce dès ≤ 90 photos. Prétendu
        # « négligeable », en réalité RUINEUX : bruteforce = appariement EXACT O(features²)
        # par paire ; à --min-num-features 12000 cela fait 1,4e8 comparaisons/paire contre
        # ~1e5 en FLANN (défaut ODM) → facteur ~1000×. C'est ce qui bloquait `match_features`
        # 40 min+ à mémoire constante (CPU-bound, job de 3600 s+ facturé).
        # La fermeture de boucle réellement validée vient de --matcher-neighbors 40 +
        # --rolling-shutter (déjà dans le preset) : les photos début/fin, prises au même
        # endroit, sont sélectionnées comme voisines par PROXIMITÉ GPS, pas par leur rang.
        # 40 voisins en FLANN referme la boucle pour un coût normal. On ne force donc plus
        # ni l'exhaustif ni le bruteforce.

        # Prise en charge du modèle de caméra sphérique (panoramas 360° natifs)
        if options_in.get("projection") == "spherical":
            if "--camera-projection" not in odm_opts:
                odm_opts += ["--camera-projection", "spherical"]

        # Le .laz est généré automatiquement dans odm_georeferencing/ — pas de flag nécessaire
        if want_mesh or want_gltf or want_fbx:
            # Maillage demandé : le 2.5D (hypothèse scène ~plane vue du dessus) sort
            # en lasagnes sur une façade → maillage 3D complet à la place.
            if "--skip-3dmodel" in odm_opts:
                odm_opts.remove("--skip-3dmodel")
            if "--use-3dmesh" not in odm_opts:
                odm_opts += ["--use-3dmesh"]

        # ── 3. Traitement ODM ─────────────────────────────────────────────────
        update_status(releve_id, "processing")
        avertissement = None
        try:
            run_odm(project_path, project_name, odm_opts)
        except RuntimeError as e_odm:
            # OpenMVS peut partir en allocation dégénérée (code 134, "Insufficient
            # memory ... To") pendant la densification en --pc-quality high sur
            # certaines géométries (observé 07/07/2026, 66 photos façade iPhone).
            # Échelle de repli (07/07 soir) : d'abord PRÉSERVER la définition —
            # l'OOM vient de la densification parallèle, on retente high en
            # concurrence 1 (plus lent, même densité). Medium seulement en dernier
            # recours — avant ça, la HD était dégradée en douce à chaque OOM.
            msg = str(e_odm)
            degradable = ("Insufficient memory" in msg or "code 134" in msg)
            if not (degradable and "--pc-quality" in odm_opts
                    and odm_opts[odm_opts.index("--pc-quality") + 1] == "high"):
                raise
            if "--rerun-from" not in odm_opts:
                odm_opts += ["--rerun-from", "openmvs"]   # SfM conservé, redensifie
            try:
                if "--max-concurrency" in odm_opts:
                    odm_opts[odm_opts.index("--max-concurrency") + 1] = "1"
                print("[BC-ARCHI] ⚠ OpenMVS OOM en pc-quality high — retry en "
                      "concurrence 1, définition high conservée", flush=True)
                run_odm(project_path, project_name, odm_opts)
                avertissement = ("densification relancée en concurrence 1 (mémoire) — "
                                 "définition high conservée")
            except RuntimeError:
                print("[BC-ARCHI] ⚠ OOM persistant même en concurrence 1 — "
                      "dernier recours : pc-quality medium", flush=True)
                odm_opts[odm_opts.index("--pc-quality") + 1] = "medium"
                run_odm(project_path, project_name, odm_opts)
                avertissement = ("pc-quality dégradé high → medium : densification "
                                 "OpenMVS en échec mémoire répété sur ce jeu de photos")

        odm_out = project_path / project_name / "odm_orthophoto"
        odm_geo = project_path / project_name / "odm_georeferencing"
        # ODM génère le texturé 2.5D dans odm_texturing_25d, le 3D dans odm_texturing
        odm_tex_25d = project_path / project_name / "odm_texturing_25d"
        odm_tex_3d  = project_path / project_name / "odm_texturing"
        odm_tex = odm_tex_25d if odm_tex_25d.exists() else odm_tex_3d

        fichiers = {}

        # ── 4. Conversions & upload ───────────────────────────────────────────
        update_status(releve_id, "uploading")

        # Orthophoto
        ortho = odm_out / "odm_orthophoto.tif"
        if ortho.exists():
            upload_file(ortho, f"{releve_id}/odm_orthophoto/odm_orthophoto.tif")
            fichiers["orthophoto"] = f"{releve_id}/odm_orthophoto/odm_orthophoto.tif"

        # Nuage de points LAZ
        laz = odm_geo / "odm_georeferenced_model.laz"

        # Auto-nivellement (presets bâtiment) : corrige le dévers GPS avant toutes
        # les conversions — le LAZ réécrit alimente E57/COPC/web, R est propagé
        # au GLB/FBX pour garder des livrables cohérents (l'OBJ brut reste tel quel)
        R_level = None
        if laz.exists() and preset.startswith("batiment") and options_in.get("auto_level", True):
            try:
                R_level, tilt_deg = auto_level(laz)
                if R_level is not None:
                    fichiers_meta_devers = round(tilt_deg, 2)
                else:
                    fichiers_meta_devers = None
            except Exception as e:
                print(f"[BC-ARCHI] ⚠ auto-level ignoré : {e}", flush=True)
                fichiers_meta_devers = None
        else:
            fichiers_meta_devers = None

        if laz.exists() and (want_pc or want_e57 or want_copc):
            upload_file(laz, f"{releve_id}/pointcloud/points.laz")
            fichiers["laz"] = f"{releve_id}/pointcloud/points.laz"

            # Conversion E57
            if want_e57:
                e57_path = Path(tmpdir) / "points.e57"
                try:
                    convert_e57(laz, e57_path)
                    upload_file(e57_path, f"{releve_id}/pointcloud/points.e57")
                    fichiers["e57"] = f"{releve_id}/pointcloud/points.e57"
                except Exception as e:
                    print(f"[BC-ARCHI] ⚠ E57 ignoré : {e}", flush=True)

            # Conversion COPC (nuage cloud-optimisé, gros nuages futurs) — non bloquant
            if want_copc:
                copc_path = Path(tmpdir) / "points.copc.laz"
                try:
                    convert_copc(laz, copc_path)
                    upload_file(copc_path, f"{releve_id}/pointcloud/points.copc.laz")
                    fichiers["copc"] = f"{releve_id}/pointcloud/points.copc.laz"
                except Exception as e:
                    print(f"[BC-ARCHI] ⚠ COPC ignoré : {e}", flush=True)

            # LAZ web LAS 1.2 pour le viewer Three.js/loaders.gl (ne lit que ≤ 1.3).
            # Hors du bloc want_copc : le viewer en dépend même sans COPC demandé
            # (bug corrigé 04/07 — copc:false supprimait aussi le nuage web).
            web_path = Path(tmpdir) / "points_web.laz"
            try:
                convert_web_laz(laz, web_path)
                upload_file(web_path, f"{releve_id}/pointcloud/points_web.laz")
                fichiers["web_laz"] = f"{releve_id}/pointcloud/points_web.laz"
            except Exception as e:
                print(f"[BC-ARCHI] ⚠ LAZ web ignoré : {e}", flush=True)

        # Maillage OBJ → GLB — non bloquant : le LAZ (livrable principal) est déjà
        # uploadé. Un échec ici (mime refusé, conversion…) ne doit pas faire échouer
        # tout le job, sinon le nuage de points livré est perdu côté statut.
        obj_candidates = list(odm_tex.glob("*.obj")) if odm_tex.exists() else []
        if obj_candidates and (want_mesh or want_gltf or want_fbx):
          try:
            obj = obj_candidates[0]
            upload_file(obj, f"{releve_id}/mesh/mesh.obj")
            fichiers["obj"] = f"{releve_id}/mesh/mesh.obj"

            if want_gltf:
                glb_path = Path(tmpdir) / "mesh.glb"
                try:
                    convert_gltf(obj, glb_path, R_level)
                    upload_file(glb_path, f"{releve_id}/mesh/mesh.glb")
                    fichiers["glb"] = f"{releve_id}/mesh/mesh.glb"
                except Exception as e:
                    print(f"[BC-ARCHI] ⚠ GLB ignoré : {e}", flush=True)

            if want_fbx:
                fbx_path = Path(tmpdir) / "mesh.fbx"
                try:
                    convert_fbx(obj, fbx_path, R_level)
                    upload_file(fbx_path, f"{releve_id}/mesh/mesh.fbx")
                    fichiers["fbx"] = f"{releve_id}/mesh/mesh.fbx"
                except Exception as e:
                    print(f"[BC-ARCHI] ⚠ FBX ignoré : {e}", flush=True)
          except Exception as e:
            print(f"[BC-ARCHI] ⚠ Maillage ignoré (non bloquant) : {e}", flush=True)

        # Patch JSON (métadonnées pour CapInSitu/VizInSitu)
        patch = {
            "releve_id": releve_id,
            "preset": preset,
            "nb_photos": len(photos),
            "fichiers": fichiers,
        }
        patch_path = Path(tmpdir) / "patch.json"
        patch_path.write_text(json.dumps(patch, ensure_ascii=False, indent=2))
        upload_file(patch_path, f"{releve_id}/patch.json")
        fichiers["patch"] = f"{releve_id}/patch.json"

        # ── 5. Finalisation ───────────────────────────────────────────────────
        # Traçabilité qualité : preset + pc-quality réellement exécuté + avertissement
        # éventuel (repli OOM) — sinon une dégradation high→medium est invisible.
        pc_q = (odm_opts[odm_opts.index("--pc-quality") + 1]
                if "--pc-quality" in odm_opts else None)
        update_status(releve_id, "completed", {
            "fichiers": fichiers, "nb_photos": len(photos),
            "options": {"preset": preset, "pc_quality": pc_q,
                        "avertissement": avertissement},
        })

        # Purge des photos sources (jamais bloquant, et opt-out par job)
        if options_in.get("purge_photos", True):
            try:
                purge_photos_source(releve_id)
            except Exception as e:
                print(f"[BC-ARCHI] ⚠ purge photos ignorée : {e}", flush=True)

        result = {
            "status": "completed",
            "releve_id": releve_id,
            "nb_photos": len(photos),
            "fichiers": fichiers,
        }
        if avertissement:
            result["avertissement"] = avertissement
        if fichiers_meta_devers:
            result["devers_corrige_deg"] = fichiers_meta_devers
        return result

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def handler(job):
    # Handler async : RunPod l'appelle sur sa boucle asyncio. On déporte tout le
    # traitement bloquant (ODM = plusieurs minutes) dans un thread d'exécuteur pour
    # que la boucle reste libre — sinon le long-poll job-take se fige et la plateforme
    # réassigne le job (« job timed out after 1 retries »). run_in_executor (et non
    # asyncio.to_thread) pour rester compatible Python 3.8 de l'image ODM.
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _process, job)


print("[BC-ARCHI] Lancement runpod.serverless...", flush=True)
runpod.serverless.start({"handler": handler})
