"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { supabase, db } from "@/lib/supabase";

export interface ScanLayer {
  id: string;
  nom: string;
  meshPath: string | null;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  angle: number;  // degrés
}

interface Props {
  chantierNom: string;
  chantierId?: string;
  scans: ScanLayer[];
}

interface ScanOffset {
  id: string;
  x: number;
  y: number;
  z: number;
  angle: number;
}

// ── Outil Mur (scan-to-BIM) ───────────────────────────────────────────────────
interface Mur {
  id: string;
  ax: number; az: number;
  bx: number; bz: number;
  epaisseur: number;
  hauteur: number;
  base_y: number;
}

function murMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xf97316, transparent: true, opacity: 0.55, roughness: 0.6,
    depthWrite: false,
  });
}

function poserMurMesh(mesh: THREE.Mesh, m: Mur) {
  const dx = m.bx - m.ax, dz = m.bz - m.az;
  const len = Math.max(0.05, Math.hypot(dx, dz));
  mesh.geometry.dispose();
  mesh.geometry = new THREE.BoxGeometry(len, m.hauteur, m.epaisseur);
  mesh.position.set((m.ax + m.bx) / 2, m.base_y + m.hauteur / 2, (m.az + m.bz) / 2);
  mesh.rotation.y = -Math.atan2(dz, dx);
}

export default function ViewerMulti({ chantierNom, chantierId, scans }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const meshMapRef = useRef<Map<string, THREE.Group>>(new Map());
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  // ── Murs BIM ──
  const [murs, setMurs] = useState<Mur[]>([]);
  const [murMode, setMurMode] = useState(false);
  const [murDraft, setMurDraft] = useState<THREE.Vector3 | null>(null);
  const murModeRef = useRef(false);
  const murDraftRef = useRef<THREE.Vector3 | null>(null);
  const mursRef = useRef<Mur[]>([]);
  const murMeshMapRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const draftMarkerRef = useRef<THREE.Mesh | null>(null);
  useEffect(() => { murModeRef.current = murMode; }, [murMode]);
  useEffect(() => { murDraftRef.current = murDraft; }, [murDraft]);
  useEffect(() => { mursRef.current = murs; }, [murs]);

  const [offsets, setOffsets] = useState<ScanOffset[]>(
    scans.map((s) => ({ id: s.id, x: s.offsetX, y: s.offsetY, z: s.offsetZ ?? 0, angle: s.angle }))
  );
  // Copie locale : permet de retirer une pièce supprimée sans recharger la page
  const [layers, setLayers] = useState<ScanLayer[]>(scans);
  const [selected, setSelected] = useState<string | null>(scans[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set(scans.map((s) => s.id)));

  // Supprime un scan : ligne en base + fichier mesh du storage + retrait de la scène
  async function supprimerScan(s: ScanLayer) {
    if (deleting) return;
    if (!confirm(`Supprimer « ${s.nom} » de ce chantier ?\nLe fichier 3D sera effacé définitivement.`)) return;
    setDeleting(s.id);
    try {
      const { error } = await db.from("scans").delete().eq("id", s.id);
      if (error) throw new Error(error.message);
      if (s.meshPath) await supabase.storage.from("pis-scans").remove([s.meshPath]);
      const group = meshMapRef.current.get(s.id);
      if (group && sceneRef.current) sceneRef.current.remove(group);
      meshMapRef.current.delete(s.id);
      setLayers((prev) => prev.filter((l) => l.id !== s.id));
      if (selected === s.id) setSelected(null);
    } catch (e) {
      alert(`Suppression impossible : ${(e as Error).message}`);
    } finally {
      setDeleting(null);
    }
  }

  const getOffset = useCallback(
    (id: string) => offsets.find((o) => o.id === id) ?? { id, x: 0, y: 0, z: 0, angle: 0 },
    [offsets]
  );

  // Applique l'offset 3D à un mesh chargé
  function applyOffset(group: THREE.Group, off: ScanOffset) {
    group.position.set(off.x, off.z, off.y);
    group.rotation.y = (off.angle * Math.PI) / 180;
  }

  // Met à jour offset state + mesh 3D
  function updateOffset(id: string, key: "x" | "y" | "z" | "angle", val: number) {
    setOffsets((prev) => {
      const next = prev.map((o) => (o.id === id ? { ...o, [key]: val } : o));
      const updated = next.find((o) => o.id === id)!;
      const mesh = meshMapRef.current.get(id);
      if (mesh) applyOffset(mesh, updated);
      return next;
    });
    setSaved(false);
  }

  // ── Murs : chargement + CRUD ──
  useEffect(() => {
    if (!chantierId) return;
    db.from("bim_murs").select("*").eq("chantier_id", chantierId)
      .then(({ data }) => { if (data) setMurs(data as Mur[]); });
  }, [chantierId]);

  // Synchronise les meshes de murs avec l'état
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const vivants = new Set(murs.map((m) => m.id));
    for (const [id, mesh] of murMeshMapRef.current) {
      if (!vivants.has(id)) { scene.remove(mesh); mesh.geometry.dispose(); murMeshMapRef.current.delete(id); }
    }
    for (const m of murs) {
      let mesh = murMeshMapRef.current.get(m.id);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), murMaterial());
        murMeshMapRef.current.set(m.id, mesh);
        scene.add(mesh);
      }
      poserMurMesh(mesh, m);
    }
  }, [murs]);

  async function creerMur(a: THREE.Vector3, b: THREE.Vector3) {
    if (!chantierId) return;
    const row = { chantier_id: chantierId, ax: a.x, az: a.z, bx: b.x, bz: b.z,
                  epaisseur: 0.2, hauteur: 2.7, base_y: 0 };
    const { data, error } = await db.from("bim_murs").insert(row).select("*").single();
    if (error) { alert(`Mur non enregistré : ${error.message}`); return; }
    setMurs((prev) => [...prev, data as Mur]);
  }

  function majMur(id: string, patch: Partial<Mur>) {
    setMurs((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    db.from("bim_murs").update(patch).eq("id", id).then(({ error }) => {
      if (error) console.warn("[bim_murs] update:", error.message);
    });
  }

  async function supprimerMur(id: string) {
    await db.from("bim_murs").delete().eq("id", id);
    setMurs((prev) => prev.filter((m) => m.id !== id));
  }

  // Accrochage : sommet du triangle touché (niv. 2) puis extrémités de murs (niv. 4)
  function snapPick(hit: THREE.Intersection): THREE.Vector3 {
    let p = hit.point.clone();
    const mesh = hit.object as THREE.Mesh;
    if (mesh.isMesh && hit.face) {
      const pos = (mesh.geometry as THREE.BufferGeometry).attributes.position;
      let bd = 0.15;
      for (const idx of [hit.face.a, hit.face.b, hit.face.c]) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, idx).applyMatrix4(mesh.matrixWorld);
        const d = v.distanceTo(hit.point);
        if (d < bd) { bd = d; p = v; }
      }
    }
    let bw = 0.25;
    for (const m of mursRef.current) {
      for (const [ex, ez] of [[m.ax, m.az], [m.bx, m.bz]] as const) {
        const d = Math.hypot(p.x - ex, p.z - ez);
        if (d < bw) { bw = d; p = new THREE.Vector3(ex, p.y, ez); }
      }
    }
    return p;
  }

  function poserPointMur(p: THREE.Vector3) {
    const scene = sceneRef.current;
    const draft = murDraftRef.current;
    if (!draft) {
      setMurDraft(p);
      if (scene) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0xf97316, depthTest: false })
        );
        marker.renderOrder = 3;
        marker.position.copy(p);
        scene.add(marker);
        draftMarkerRef.current = marker;
      }
      return;
    }
    if (draft.distanceTo(p) > 0.05) creerMur(draft, p);
    annulerDraft();
  }

  function annulerDraft() {
    setMurDraft(null);
    if (draftMarkerRef.current && sceneRef.current) {
      sceneRef.current.remove(draftMarkerRef.current);
      draftMarkerRef.current.geometry.dispose();
      draftMarkerRef.current = null;
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { annulerDraft(); setMurMode(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Init Three.js
  useEffect(() => {
    if (!canvasRef.current) return;
    const container = canvasRef.current;
    const w = container.clientWidth;
    const h = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);
    sceneRef.current = scene;

    // Lumières
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 1);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    // Grille sol
    const grid = new THREE.GridHelper(40, 40, 0xc0c0c0, 0xe0e0e0);
    scene.add(grid);

    // Caméra
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 200);
    camera.position.set(0, 8, 12);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    cameraRef.current = camera;
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Pick outil Mur : clic (pas drag) → raycast sur les scans → point accroché
    let downPos: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { downPos = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!murModeRef.current || !downPos) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      downPos = null;
      if (moved > 5 || e.button !== 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, camera);
      const cibles = [...meshMapRef.current.values()];
      const hit = ray.intersectObjects(cibles, true)[0];
      if (hit) poserPointMur(snapPick(hit));
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    // Charger chaque GLB
    const loader = new GLTFLoader();
    const COLORS = [0x1e3a5f, 0xf97316, 0x10b981, 0x8b5cf6, 0xef4444, 0x3b82f6];

    scans.forEach((scan, idx) => {
      if (!scan.meshPath) {
        setLoadingIds((prev) => { const s = new Set(prev); s.delete(scan.id); return s; });
        return;
      }
      const url = supabase.storage.from("pis-scans").getPublicUrl(scan.meshPath).data.publicUrl;
      loader.load(
        url,
        (gltf) => {
          const group = gltf.scene;
          // Teinte légère pour distinguer les pièces — SAUF si le mesh est texturé
          // (relevé photogrammétrique BC-Archi) : on garde sa vraie texture photo.
          group.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              const orig = mesh.material as THREE.MeshStandardMaterial;
              const aTexture = !!(orig && !Array.isArray(orig) && orig.map);
              if (aTexture) {
                // Mesh photogrammétrique : la texture photo contient déjà l'éclairage
                // réel → matériau non-éclairé (sinon faces à l'ombre de la lumière 3D
                // = pans tout noirs), double face (normales photogrammétrie incertaines).
                mesh.material = new THREE.MeshBasicMaterial({
                  map: orig.map,
                  side: THREE.DoubleSide,
                });
              } else {
                mesh.material = new THREE.MeshStandardMaterial({
                  color: COLORS[idx % COLORS.length],
                  transparent: true,
                  opacity: 0.85,
                  roughness: 0.7,
                });
              }
            }
          });
          const off = offsets.find((o) => o.id === scan.id) ?? { id: scan.id, x: 0, y: 0, z: 0, angle: 0 };
          applyOffset(group, off);
          scene.add(group);
          meshMapRef.current.set(scan.id, group);
          setLoadingIds((prev) => { const s = new Set(prev); s.delete(scan.id); return s; });
        },
        undefined,
        () => {
          setLoadingIds((prev) => { const s = new Set(prev); s.delete(scan.id); return s; });
        }
      );
    });

    // Render loop
    let raf: number;
    function animate() {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // Resize
    function onResize() {
      const nw = container.clientWidth;
      const nh = container.clientHeight;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      meshMapRef.current.clear();
      murMeshMapRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sauvegarder les offsets en base
  async function saveOffsets() {
    setSaving(true);
    await Promise.all(
      offsets.map((o) =>
        db
          .from("scans")
          .update({ offset_x: o.x, offset_y: o.y, offset_z: o.z, offset_angle: o.angle })
          .eq("id", o.id)
      )
    );
    setSaving(false);
    setSaved(true);
  }

  const selOff = selected ? getOffset(selected) : null;
  const selScan = layers.find((s) => s.id === selected);

  return (
    <div className="flex h-full" style={{ minHeight: 520 }}>
      {/* Sidebar */}
      <div className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-y-auto">
        <div className="p-4 border-b border-slate-100">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Pièces — {layers.length}
          </p>
          <div className="flex flex-col gap-1">
            {layers.map((s, i) => {
              const DOTS = ["🔵", "🟠", "🟢", "🟣", "🔴", "🔵"];
              return (
                <div
                  key={s.id}
                  onClick={() => setSelected(s.id)}
                  className="group flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-left transition-colors cursor-pointer"
                  style={selected === s.id
                    ? { background: "var(--navy)", color: "white" }
                    : { color: "#475569" }}
                >
                  <span>{DOTS[i % DOTS.length]}</span>
                  <span className="truncate flex-1">{s.nom}</span>
                  {loadingIds.has(s.id) && <span className="text-xs opacity-50">…</span>}
                  <button
                    onClick={(e) => { e.stopPropagation(); supprimerScan(s); }}
                    disabled={!!deleting}
                    title="Supprimer cette pièce"
                    className="opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity text-xs"
                  >
                    {deleting === s.id ? "…" : "🗑"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Murs BIM */}
        {chantierId && (
          <div className="p-4 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              🧱 Murs — {murs.length}
            </p>
            <button
              onClick={() => { if (murMode) { annulerDraft(); setMurMode(false); } else setMurMode(true); }}
              className="w-full py-1.5 rounded-lg text-xs font-medium border transition-colors mb-2"
              style={murMode
                ? { background: "#f97316", color: "white", borderColor: "#f97316" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}>
              {murMode ? (murDraft ? "Cliquez le 2e point…" : "Cliquez le 1er point…") : "＋ Tracer un mur"}
            </button>
            <div className="flex flex-col gap-1.5">
              {murs.map((m, i) => {
                const len = Math.hypot(m.bx - m.ax, m.bz - m.az);
                return (
                  <div key={m.id} className="group border border-slate-100 rounded-lg px-2 py-1.5">
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <span className="font-medium">Mur {i + 1}</span>
                      <span className="font-mono text-slate-400">{len.toFixed(2)} m</span>
                      <button onClick={() => supprimerMur(m.id)}
                        className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                        title="Supprimer">🗑</button>
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-[10px] text-slate-400">ép.</span>
                      <input type="number" min={0.05} max={1} step={0.01} value={m.epaisseur}
                        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majMur(m.id, { epaisseur: v }); }}
                        className="w-14 border border-slate-200 rounded px-1 py-0.5 text-[11px] font-mono"/>
                      <span className="text-[10px] text-slate-400 ml-1">h.</span>
                      <input type="number" min={0.3} max={12} step={0.05} value={m.hauteur}
                        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majMur(m.id, { hauteur: v }); }}
                        className="w-14 border border-slate-200 rounded px-1 py-0.5 text-[11px] font-mono"/>
                      <span className="text-[10px] text-slate-400">m</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Contrôles de la pièce sélectionnée */}
        {selOff && selScan && (
          <div className="p-4 flex flex-col gap-4 flex-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Position · {selScan.nom}
            </p>

            {(["x", "y", "z", "angle"] as const).map((key) => {
              const labels = { x: "X (m)", y: "Y (m)", z: "Z — hauteur (m)", angle: "Rotation (°)" };
              const mins = { x: -20, y: -20, z: -10, angle: -180 };
              const maxs = { x: 20, y: 20, z: 10, angle: 180 };
              const steps = { x: 0.1, y: 0.1, z: 0.05, angle: 1 };
              return (
                <div key={key}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500">{labels[key]}</span>
                    <span className="font-mono text-slate-700">{selOff[key].toFixed(key === "angle" ? 0 : key === "z" ? 2 : 2)}</span>
                  </div>
                  <input
                    type="range"
                    min={mins[key]}
                    max={maxs[key]}
                    step={steps[key]}
                    value={selOff[key]}
                    onChange={(e) => updateOffset(selOff.id, key, parseFloat(e.target.value))}
                    className="w-full accent-orange-500"
                  />
                  <input
                    type="number"
                    min={mins[key]}
                    max={maxs[key]}
                    step={steps[key]}
                    value={selOff[key]}
                    onChange={(e) => updateOffset(selOff.id, key, parseFloat(e.target.value) || 0)}
                    className="mt-1 w-full border border-slate-200 rounded px-2 py-1 text-xs font-mono"
                  />
                </div>
              );
            })}

            <button
              onClick={() => { updateOffset(selOff.id, "x", 0); updateOffset(selOff.id, "y", 0); updateOffset(selOff.id, "z", 0); updateOffset(selOff.id, "angle", 0); }}
              className="text-xs text-slate-400 hover:text-slate-600 underline mt-auto"
            >
              Remettre à zéro
            </button>
          </div>
        )}

        {/* Bouton sauvegarder */}
        <div className="p-4 border-t border-slate-100">
          <button
            onClick={saveOffsets}
            disabled={saving}
            className="w-full py-2 rounded-lg text-white text-sm font-medium transition-opacity"
            style={{ background: saved ? "#10b981" : "var(--navy)", opacity: saving ? 0.6 : 1 }}
          >
            {saving ? "Sauvegarde…" : saved ? "✓ Sauvegardé" : "Sauvegarder les positions"}
          </button>
        </div>
      </div>

      {/* Canvas 3D */}
      <div className="relative flex-1">
        <div ref={canvasRef} className="w-full h-full" />
        {loadingIds.size > 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-white/80 backdrop-blur px-4 py-2 rounded-full text-sm text-slate-500">
              Chargement {scans.length - loadingIds.size}/{scans.length} pièces…
            </div>
          </div>
        )}
        <div className="absolute top-3 right-3 bg-white/80 backdrop-blur text-xs text-slate-400 px-2 py-1 rounded pointer-events-none">
          {chantierNom}
        </div>
        {murMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            {murDraft
              ? "🧱 Cliquez le 2e point du mur sur le scan (Échap : annuler)"
              : "🧱 Cliquez le 1er point du mur sur le scan — accrochage sommets et extrémités de murs"}
          </div>
        )}
      </div>
    </div>
  );
}
