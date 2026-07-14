# Image GPU (CUDA) : pypopsift pour SIFT GPU + OpenMVS CUDA pour la reconstruction dense.
# L'image :latest est CPU-only → SIFT et DensifyPointCloud saturaient le CPU et tuaient le worker.
FROM opendronemap/odm:gpu

# ── CORRECTIF driver 580.xx (support RunPod, 02/07/2026) ──────────────────────
# L'image de base porte un NVIDIA_REQUIRE_CUDA (cuda>=12.9, brands 535/550/560/565/570)
# qui N'INCLUT PAS le driver 580.xx. Les hôtes RunPod migrent vers le 580.xx → le
# runtime NVIDIA refuse le conteneur à l'init CUDA et le tue silencieusement, au même
# temps mural, indépendamment du code et du cold/warm. Symptôme observé : jobs courts OK
# (hôte 570.xx), jobs plus longs tués (hôte 580.xx) → "job timed out after 1 retries".
# Le driver 580.xx est rétro-compatible avec le runtime CUDA 12.9 : on désactive le check
# de contrainte plutôt que d'attendre un rebuild ODM sur CUDA 12.8/13.0.
ENV NVIDIA_DISABLE_REQUIRE=1

# Convertisseurs Python.
# laspy[lazrs] : lecture LAZ  |  pye57 : écriture E57 (wheel manylinux, libE57Format embarquée)
# trimesh : OBJ → GLB  |  piexif : retransplantation EXIF/GPS après prétraitement photos
# pillow-heif : conversion HEIC iPhone → JPEG en préservant l'EXIF GPS (ODM ne lit pas HEIC)
# (cv2/numpy déjà fournis par l'image ODM)
RUN pip3 install --no-cache-dir \
    runpod==1.10.0 \
    requests==2.31.0 \
    laspy[lazrs]==2.5.4 \
    trimesh==4.4.0 \
    numpy \
    pye57 \
    piexif==1.1.3 \
    pillow-heif \
    pillow

# Blender headless : OBJ → FBX (textures embarquées) pour ArchiCAD/Revit.
# Installé via apt (gère les dépendances runtime libGL/libX*). Mode --background,
# Blender embarque son propre Python (pas de conflit avec le venv ODM).
RUN apt-get update && apt-get install -y --no-install-recommends blender \
    && rm -rf /var/lib/apt/lists/*

COPY worker.py /worker.py

ENTRYPOINT ["python3", "-u", "/worker.py"]
