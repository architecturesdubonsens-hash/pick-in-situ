"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { supabase } from "@/lib/supabase";
import { generateProjectionDXF, type Seg2D } from "@/lib/blueprint";
import type { ScanLayer } from "@/components/ViewerMulti";

// ── Types ──────────────────────────────────────────────────────────────────────
type ViewKey = "plan" | "nord" | "sud" | "est" | "ouest";

interface ViewMeta {
  label: string;
  icon: string;
  // Quelle paire d'axes 3D → (u, v) en mètres dans la vue
  project: (v: THREE.Vector3, box: THREE.Box3) => { u: number; v: number };
  // Dimensions réelles de la vue (w, h) en mètres
  dims: (size: THREE.Vector3) => { w: number; h: number };
}

const VIEWS: Record<ViewKey, ViewMeta> = {
  plan: {
    label: "Plan", icon: "⬛",
    project: (v) => ({ u: v.x, v: v.z }),
    dims: (s) => ({ w: s.x, h: s.z }),
  },
  nord: {
    label: "Façade Nord", icon: "⬆",
    project: (v) => ({ u: v.x, v: -v.y }),
    dims: (s) => ({ w: s.x, h: s.y }),
  },
  sud: {
    label: "Façade Sud", icon: "⬇",
    project: (v) => ({ u: -v.x, v: -v.y }),
    dims: (s) => ({ w: s.x, h: s.y }),
  },
  est: {
    label: "Façade Est", icon: "➡",
    project: (v) => ({ u: -v.z, v: -v.y }),
    dims: (s) => ({ w: s.z, h: s.y }),
  },
  ouest: {
    label: "Façade Ouest", icon: "⬅",
    project: (v) => ({ u: v.z, v: -v.y }),
    dims: (s) => ({ w: s.z, h: s.y }),
  },
};

// ── Helpers SVG / DXF ─────────────────────────────────────────────────────────

interface Seg3D { a: THREE.Vector3; b: THREE.Vector3 }

function segsToSVG(segs: Seg3D[], view: ViewMeta, box: THREE.Box3, svgW = 1000): string {
  const size = box.getSize(new THREE.Vector3());
  const { w, h } = view.dims(size);
  if (w === 0 || h === 0) return "";

  const svgH = Math.round(svgW * h / w);
  const pad = 40;
  const scaleX = (svgW - pad * 2) / w;
  const scaleY = (svgH - pad * 2) / h;

  const minPt = view.project(box.min, box);
  const maxPt = view.project(box.max, box);
  const uMin = Math.min(minPt.u, maxPt.u);
  const vMin = Math.min(minPt.v, maxPt.v);

  const lines = segs.map(({ a, b }) => {
    const pa = view.project(a, box);
    const pb = view.project(b, box);
    const x1 = ((pa.u - uMin) * scaleX + pad).toFixed(1);
    const y1 = ((pa.v - vMin) * scaleY + pad).toFixed(1);
    const x2 = ((pb.u - uMin) * scaleX + pad).toFixed(1);
    const y2 = ((pb.v - vMin) * scaleY + pad).toFixed(1);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#00e5ff" stroke-width="0.8" stroke-linecap="round"/>`;
  }).join("\n");

  // Barre d'échelle : 1 m réel
  const barPx = scaleX.toFixed(1);
  const scaleBar = `
    <line x1="${pad}" y1="${svgH - 16}" x2="${(pad + scaleX).toFixed(1)}" y2="${svgH - 16}" stroke="#ffffff" stroke-width="1.5"/>
    <line x1="${pad}" y1="${svgH - 20}" x2="${pad}" y2="${svgH - 12}" stroke="#ffffff" stroke-width="1.5"/>
    <line x1="${(pad + scaleX).toFixed(1)}" y1="${svgH - 20}" x2="${(pad + scaleX).toFixed(1)}" y2="${svgH - 12}" stroke="#ffffff" stroke-width="1.5"/>
    <text x="${(pad + scaleX / 2).toFixed(1)}" y="${svgH - 4}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="monospace">1 m</text>`;

  const label = `<text x="${pad}" y="22" fill="#334155" font-size="12" font-family="monospace">${view.label} — ${w.toFixed(2)} × ${h.toFixed(2)} m</text>`;

  // Grille légère
  const grid = `<defs><pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse">
    <path d="M20 0L0 0 0 20" fill="none" stroke="#111e33" stroke-width="0.4"/></pattern></defs>
  <rect width="${svgW}" height="${svgH}" fill="url(#g)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" style="background:#0a1628;width:100%;height:100%;">
  ${grid}
  ${label}
  ${lines}
  ${scaleBar}
</svg>`;
}

function segsToDXF(segs: Seg3D[], view: ViewMeta, box: THREE.Box3): string {
  const size = box.getSize(new THREE.Vector3());
  const { w, h } = view.dims(size);
  const minPt = view.project(box.min, box);
  const maxPt = view.project(box.max, box);
  const uMin = Math.min(minPt.u, maxPt.u);
  const vMin = Math.min(minPt.v, maxPt.v);

  const segs2d: Seg2D[] = segs.map(({ a, b }) => {
    const pa = view.project(a, box);
    const pb = view.project(b, box);
    return {
      ax: pa.u - uMin,
      ay: -(pa.v - vMin) + h,  // inverser v pour DXF (Y=0 en bas)
      bx: pb.u - uMin,
      by: -(pb.v - vMin) + h,
    };
  });

  return generateProjectionDXF(segs2d, view.label, w, h);
}

// ── Extraction des arêtes depuis un GLB chargé ────────────────────────────────

function extractEdgeSegments(gltf: { scene: THREE.Object3D }): Seg3D[] {
  const segs: Seg3D[] = [];
  gltf.scene.updateMatrixWorld(true);

  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const edges = new THREE.EdgesGeometry(mesh.geometry, 15); // 15° = arêtes significatives
    const pos = edges.attributes.position;
    const mat = mesh.matrixWorld;

    for (let i = 0; i < pos.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(mat);
      segs.push({ a, b });
    }
    edges.dispose();
  });

  return segs;
}

// ── Composant principal ───────────────────────────────────────────────────────

interface Props {
  scans: ScanLayer[];
  chantierNom: string;
}

export default function PlanExtractor({ scans, chantierNom }: Props) {
  const [activeView, setActiveView] = useState<ViewKey>("plan");
  const [svgs, setSvgs] = useState<Partial<Record<ViewKey, string>>>({});
  const [segsRef, setSegsRef] = useState<Seg3D[]>([]);
  const [boxRef, setBoxRef] = useState<THREE.Box3 | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadMsg, setLoadMsg] = useState("Chargement des maillages…");
  const [error, setError] = useState<string | null>(null);

  // Charger tous les GLBs et extraire les arêtes
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const readyScans = scans.filter((s) => s.meshPath);
      if (readyScans.length === 0) { setError("Aucun scan avec maillage disponible."); setLoading(false); return; }

      const loader = new GLTFLoader();
      const allSegs: Seg3D[] = [];
      const combinedBox = new THREE.Box3();

      for (let i = 0; i < readyScans.length; i++) {
        if (cancelled) return;
        const scan = readyScans[i];
        setLoadMsg(`Chargement pièce ${i + 1}/${readyScans.length} : ${scan.nom}…`);

        try {
          const url = supabase.storage.from("pis-scans").getPublicUrl(scan.meshPath!).data.publicUrl;
          const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) =>
            loader.load(url, resolve, undefined, reject)
          );

          // Appliquer l'offset de la pièce dans la scène assemblée
          const group = gltf.scene;
          group.position.set(scan.offsetX, 0, scan.offsetY);
          group.rotation.y = (scan.angle * Math.PI) / 180;
          group.updateMatrixWorld(true);

          const segs = extractEdgeSegments({ scene: group });
          allSegs.push(...segs);

          // Mettre à jour la bounding box globale
          const box = new THREE.Box3().setFromObject(group);
          combinedBox.union(box);

        } catch {
          console.warn(`Impossible de charger ${scan.nom}`);
        }
      }

      if (cancelled) return;
      if (allSegs.length === 0) { setError("Aucune arête extraite."); setLoading(false); return; }

      setSegsRef(allSegs);
      setBoxRef(combinedBox);
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Générer SVG à la demande (lazy, mis en cache)
  useEffect(() => {
    if (!boxRef || segsRef.length === 0) return;
    if (svgs[activeView]) return; // déjà calculé

    const svg = segsToSVG(segsRef, VIEWS[activeView], boxRef);
    setSvgs((prev) => ({ ...prev, [activeView]: svg }));
  }, [activeView, boxRef, segsRef, svgs]);

  const downloadSVG = useCallback(() => {
    const svg = svgs[activeView];
    if (!svg) return;
    dl(new Blob([svg], { type: "image/svg+xml" }), `${chantierNom}_${activeView}.svg`);
  }, [svgs, activeView, chantierNom]);

  const downloadDXF = useCallback(() => {
    if (!boxRef || segsRef.length === 0) return;
    const dxf = segsToDXF(segsRef, VIEWS[activeView], boxRef);
    dl(new Blob([dxf], { type: "application/dxf" }), `${chantierNom}_${activeView}.dxf`);
  }, [segsRef, boxRef, activeView, chantierNom]);

  const downloadAllDXF = useCallback(async () => {
    if (!boxRef || segsRef.length === 0) return;
    // Télécharge les 5 vues en séquence
    for (const key of Object.keys(VIEWS) as ViewKey[]) {
      const dxf = segsToDXF(segsRef, VIEWS[key], boxRef);
      dl(new Blob([dxf], { type: "application/dxf" }), `${chantierNom}_${key}.dxf`);
      await new Promise((r) => setTimeout(r, 200)); // évite les popups bloqués
    }
  }, [segsRef, boxRef, chantierNom]);

  function dl(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  const currentSVG = svgs[activeView];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-white shrink-0 flex-wrap">
        {/* Onglets vues */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {(Object.keys(VIEWS) as ViewKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setActiveView(key)}
              disabled={loading}
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={activeView === key
                ? { background: "var(--navy)", color: "white" }
                : { color: "#64748b" }}
              title={VIEWS[key].label}
            >
              {VIEWS[key].icon} {VIEWS[key].label.replace("Façade ", "")}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Exports */}
        <button
          onClick={downloadSVG}
          disabled={!currentSVG}
          className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          ↓ SVG
        </button>
        <button
          onClick={downloadDXF}
          disabled={!boxRef}
          className="px-3 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--navy)" }}
        >
          ↓ DXF vue
        </button>
        <button
          onClick={downloadAllDXF}
          disabled={!boxRef}
          className="px-3 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--orange)" }}
        >
          ↓ DXF × 5 vues
        </button>
      </div>

      {/* Zone de rendu */}
      <div className="flex-1 min-h-0 relative" style={{ background: "#0a1628" }}>
        {loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
            <div className="w-8 h-8 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin mb-3" />
            <p className="text-sm">{loadMsg}</p>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">{error}</div>
        ) : !currentSVG ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
            Calcul de la projection…
          </div>
        ) : (
          <div
            className="w-full h-full overflow-auto"
            dangerouslySetInnerHTML={{ __html: currentSVG }}
          />
        )}

        {/* Badge vue active */}
        {!loading && !error && (
          <div className="absolute top-3 right-3 bg-white/10 backdrop-blur text-xs text-slate-400 px-2 py-1 rounded pointer-events-none font-mono">
            {VIEWS[activeView].label}
          </div>
        )}
      </div>

      {/* Info barre */}
      {!loading && !error && boxRef && (
        <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-1.5 text-xs text-slate-400 flex gap-4">
          {(() => {
            const s = boxRef.getSize(new THREE.Vector3());
            return (
              <>
                <span>{segsRef.length.toLocaleString()} arêtes</span>
                <span>{s.x.toFixed(2)} × {s.z.toFixed(2)} m (plan)</span>
                <span>hauteur {s.y.toFixed(2)} m</span>
                <span>{scans.length} pièce{scans.length > 1 ? "s" : ""} assemblée{scans.length > 1 ? "s" : ""}</span>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
