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
  scans: ScanLayer[];
}

interface ScanOffset {
  id: string;
  x: number;
  y: number;
  z: number;
  angle: number;
}

export default function ViewerMulti({ chantierNom, scans }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const meshMapRef = useRef<Map<string, THREE.Group>>(new Map());

  const [offsets, setOffsets] = useState<ScanOffset[]>(
    scans.map((s) => ({ id: s.id, x: s.offsetX, y: s.offsetY, z: s.offsetZ ?? 0, angle: s.angle }))
  );
  const [selected, setSelected] = useState<string | null>(scans[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set(scans.map((s) => s.id)));

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

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

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
          // Teinte légère pour distinguer les pièces
          group.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mat = new THREE.MeshStandardMaterial({
                color: COLORS[idx % COLORS.length],
                transparent: true,
                opacity: 0.85,
                roughness: 0.7,
              });
              (child as THREE.Mesh).material = mat;
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
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      meshMapRef.current.clear();
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
  const selScan = scans.find((s) => s.id === selected);

  return (
    <div className="flex h-full" style={{ minHeight: 520 }}>
      {/* Sidebar */}
      <div className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-y-auto">
        <div className="p-4 border-b border-slate-100">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Pièces — {scans.length}
          </p>
          <div className="flex flex-col gap-1">
            {scans.map((s, i) => {
              const DOTS = ["🔵", "🟠", "🟢", "🟣", "🔴", "🔵"];
              return (
                <button
                  key={s.id}
                  onClick={() => setSelected(s.id)}
                  className="flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-left transition-colors"
                  style={selected === s.id
                    ? { background: "var(--navy)", color: "white" }
                    : { color: "#475569" }}
                >
                  <span>{DOTS[i % DOTS.length]}</span>
                  <span className="truncate">{s.nom}</span>
                  {loadingIds.has(s.id) && <span className="ml-auto text-xs opacity-50">…</span>}
                </button>
              );
            })}
          </div>
        </div>

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
      </div>
    </div>
  );
}
