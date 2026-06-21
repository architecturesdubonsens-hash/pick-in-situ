"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { supabase } from "@/lib/supabase";
import { generateProjectionDXF, type Seg2D, type FacadeData, type FacadeElement, SVG_COLOR } from "@/lib/blueprint";
import type { ScanLayer } from "@/components/ViewerMulti";

// ── Types ──────────────────────────────────────────────────────────────────────
type ViewKey = "plan" | "nord" | "sud" | "est" | "ouest";
type ScanType = "interieur" | "exterieur";

interface TaggedSeg {
  a: THREE.Vector3;
  b: THREE.Vector3;
  layer: string;
  isSection?: boolean;
}

interface ViewMeta {
  label: (type: ScanType) => string;
  icon: string;
  canEnrich: boolean;
  project: (v: THREE.Vector3) => { u: number; v: number };
  dims: (size: THREE.Vector3) => { w: number; h: number };
}

const VIEWS: Record<ViewKey, ViewMeta> = {
  plan:  {
    label: () => "Plan",
    icon: "⬛", canEnrich: false,
    project: (v) => ({ u: v.x, v: v.z }),
    dims: (s) => ({ w: s.x, h: s.z }),
  },
  nord:  {
    label: (t) => t === "interieur" ? "Façade int. Nord" : "Façade ext. Nord",
    icon: "⬆", canEnrich: true,
    project: (v) => ({ u: v.x, v: -v.y }),
    dims: (s) => ({ w: s.x, h: s.y }),
  },
  sud:   {
    label: (t) => t === "interieur" ? "Façade int. Sud" : "Façade ext. Sud",
    icon: "⬇", canEnrich: true,
    project: (v) => ({ u: -v.x, v: -v.y }),
    dims: (s) => ({ w: s.x, h: s.y }),
  },
  est:   {
    label: (t) => t === "interieur" ? "Façade int. Est" : "Façade ext. Est",
    icon: "➡", canEnrich: true,
    project: (v) => ({ u: -v.z, v: -v.y }),
    dims: (s) => ({ w: s.z, h: s.y }),
  },
  ouest: {
    label: (t) => t === "interieur" ? "Façade int. Ouest" : "Façade ext. Ouest",
    icon: "⬅", canEnrich: true,
    project: (v) => ({ u: v.z, v: -v.y }),
    dims: (s) => ({ w: s.z, h: s.y }),
  },
};

// ── Extraction arêtes (avec calque) ──────────────────────────────────────────

function getLayerName(obj: THREE.Object3D): string {
  let node: THREE.Object3D | null = obj;
  while (node) {
    const n = node.name?.trim();
    if (n && n !== "Scene" && n !== "RootNode" && n !== "Mesh") return n;
    node = node.parent;
  }
  return "Géométrie";
}

function extractEdgeSegments(scene: THREE.Object3D): TaggedSeg[] {
  const segs: TaggedSeg[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const layer = getLayerName(mesh);
    const edges = new THREE.EdgesGeometry(mesh.geometry, 15);
    const pos = edges.attributes.position;
    const mat = mesh.matrixWorld;
    for (let i = 0; i < pos.count; i += 2) {
      segs.push({
        a: new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat),
        b: new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(mat),
        layer,
      });
    }
    edges.dispose();
  });
  return segs;
}

// ── Cross-section plan (triangle × plan horizontal) ───────────────────────────

function extractCrossSection(scenes: THREE.Object3D[], cutY: number): TaggedSeg[] {
  const segs: TaggedSeg[] = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  for (const scene of scenes) {
    scene.updateMatrixWorld(true);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const layer = getLayerName(mesh);
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const idx = geo.index;
      const mat = mesh.matrixWorld;
      const triCount = idx ? idx.count / 3 : pos.count / 3;

      for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx.getX(t * 3)     : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        v[0].fromBufferAttribute(pos, i0).applyMatrix4(mat);
        v[1].fromBufferAttribute(pos, i1).applyMatrix4(mat);
        v[2].fromBufferAttribute(pos, i2).applyMatrix4(mat);

        const above = v.map((p) => p.y >= cutY);
        const n = above.filter(Boolean).length;
        if (n === 0 || n === 3) continue;

        const lerp = (a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 => {
          const t2 = (cutY - a.y) / (b.y - a.y);
          return new THREE.Vector3(a.x + t2 * (b.x - a.x), cutY, a.z + t2 * (b.z - a.z));
        };

        const pts: THREE.Vector3[] = [];
        if (above[0] !== above[1]) pts.push(lerp(v[0], v[1]));
        if (above[1] !== above[2]) pts.push(lerp(v[1], v[2]));
        if (above[2] !== above[0]) pts.push(lerp(v[2], v[0]));
        if (pts.length === 2) segs.push({ a: pts[0], b: pts[1], layer, isSection: true });
      }
    });
  }
  return segs;
}

// ── SVG ───────────────────────────────────────────────────────────────────────

function segsToSVG(
  edgeSegs: TaggedSeg[],
  sectionSegs: TaggedSeg[],
  view: ViewMeta,
  box: THREE.Box3,
  scanType: ScanType,
  visibleLayers: Set<string>,
  elements?: FacadeElement[],
  svgW = 1000
): string {
  const filteredEdge = edgeSegs.filter((s) => visibleLayers.has(s.layer));
  const filteredSection = sectionSegs.filter((s) => visibleLayers.has(s.layer));

  const size = box.getSize(new THREE.Vector3());
  const { w, h } = view.dims(size);
  if (w === 0 || h === 0) return "";

  const svgH = Math.round(svgW * h / w);
  const pad = 40;
  const innerW = svgW - pad * 2;
  const innerH = svgH - pad * 2;
  const scaleX = innerW / w;
  const scaleY = innerH / h;

  const pts = [box.min, box.max].map((p) => view.project(p));
  const uMin = Math.min(...pts.map((p) => p.u));
  const vMin = Math.min(...pts.map((p) => p.v));

  const project = (seg: TaggedSeg) => {
    const pa = view.project(seg.a);
    const pb = view.project(seg.b);
    return {
      x1: ((pa.u - uMin) * scaleX + pad).toFixed(1),
      y1: ((pa.v - vMin) * scaleY + pad).toFixed(1),
      x2: ((pb.u - uMin) * scaleX + pad).toFixed(1),
      y2: ((pb.v - vMin) * scaleY + pad).toFixed(1),
    };
  };

  // Poché : sections rendues en trait épais (visible sur fond sombre)
  const poche = filteredSection.map((s) => {
    const { x1, y1, x2, y2 } = project(s);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#334155" stroke-width="14" stroke-linecap="butt"/>`;
  }).join("\n");

  // Contour poché (filet fin cyan par-dessus)
  const pocheOutline = filteredSection.map((s) => {
    const { x1, y1, x2, y2 } = project(s);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="1" stroke-linecap="butt"/>`;
  }).join("\n");

  // Arêtes géométriques
  const lines = filteredEdge.map((s) => {
    const { x1, y1, x2, y2 } = project(s);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#00e5ff" stroke-width="0.7" stroke-linecap="round"/>`;
  }).join("\n");

  // Overlay Gemini
  const overlay = (elements ?? []).map((el) => {
    const color = SVG_COLOR[el.type] ?? "#ffffff";
    const ex = (el.x * innerW + pad).toFixed(1);
    const ey = (el.y * innerH + pad).toFixed(1);
    const ew = (el.width * innerW).toFixed(1);
    const eh = (el.height * innerH).toFixed(1);
    const tx = (el.x * innerW + pad + 2).toFixed(1);
    const ty = (el.y * innerH + pad - 3).toFixed(1);
    return `<rect x="${ex}" y="${ey}" width="${ew}" height="${eh}" fill="${color}22" stroke="${color}" stroke-width="1.8" stroke-dasharray="5,3"/>
<text x="${tx}" y="${ty}" fill="${color}" font-size="9" font-family="monospace" opacity="0.9">${el.label}</text>`;
  }).join("\n");

  const scaleBar = `
    <line x1="${pad}" y1="${svgH - 16}" x2="${(pad + scaleX).toFixed(1)}" y2="${svgH - 16}" stroke="#ffffff" stroke-width="1.5"/>
    <line x1="${pad}" y1="${svgH - 20}" x2="${pad}" y2="${svgH - 12}" stroke="#ffffff" stroke-width="1.5"/>
    <line x1="${(pad + scaleX).toFixed(1)}" y1="${svgH - 20}" x2="${(pad + scaleX).toFixed(1)}" y2="${svgH - 12}" stroke="#ffffff" stroke-width="1.5"/>
    <text x="${(pad + scaleX / 2).toFixed(1)}" y="${svgH - 4}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="monospace">1 m</text>`;

  const viewLabel = view.label(scanType);
  const enrichNote = elements?.length ? ` · ${elements.length} éléments` : "";
  const label = `<text x="${pad}" y="22" fill="#334155" font-size="11" font-family="monospace">${viewLabel} — ${w.toFixed(2)} × ${h.toFixed(2)} m${enrichNote}</text>`;

  const grid = `<defs><pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse">
    <path d="M20 0L0 0 0 20" fill="none" stroke="#111e33" stroke-width="0.4"/></pattern></defs>
  <rect width="${svgW}" height="${svgH}" fill="url(#g)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" style="background:#0a1628;width:100%;height:100%;">
  ${grid}${poche}${pocheOutline}${lines}${overlay}${scaleBar}${label}
</svg>`;
}

// ── DXF ───────────────────────────────────────────────────────────────────────

function segsToDXFStr(
  edgeSegs: TaggedSeg[],
  sectionSegs: TaggedSeg[],
  view: ViewMeta,
  box: THREE.Box3,
  scanType: ScanType,
  visibleLayers: Set<string>,
  elements?: FacadeElement[]
): string {
  const filteredEdge = edgeSegs.filter((s) => visibleLayers.has(s.layer));
  const filteredSection = sectionSegs.filter((s) => visibleLayers.has(s.layer));
  const size = box.getSize(new THREE.Vector3());
  const { w, h } = view.dims(size);
  const pts = [box.min, box.max].map((p) => view.project(p));
  const uMin = Math.min(...pts.map((p) => p.u));
  const vMin = Math.min(...pts.map((p) => p.v));

  const toSeg2D = (s: TaggedSeg): Seg2D => {
    const pa = view.project(s.a);
    const pb = view.project(s.b);
    return {
      ax: pa.u - uMin,
      ay: -(pa.v - vMin) + h,
      bx: pb.u - uMin,
      by: -(pb.v - vMin) + h,
    };
  };

  const segs2d = filteredEdge.map(toSeg2D);
  const section2d = filteredSection.map(toSeg2D);

  return generateProjectionDXF(segs2d, view.label(scanType), w, h, elements, section2d);
}

// ── Composant principal ───────────────────────────────────────────────────────

interface Props { scans: ScanLayer[]; chantierNom: string }

export default function PlanExtractor({ scans, chantierNom }: Props) {
  const [activeView, setActiveView] = useState<ViewKey>("plan");
  const [scanType, setScanType] = useState<ScanType>("interieur");

  // Géométrie
  const [edgeSegs, setEdgeSegs] = useState<TaggedSeg[]>([]);
  const [sectionSegs, setSectionSegs] = useState<TaggedSeg[]>([]);
  const [box, setBox] = useState<THREE.Box3 | null>(null);
  const scenesRef = useRef<THREE.Object3D[]>([]);

  // Calques
  const [allLayers, setAllLayers] = useState<string[]>([]);
  const [visibleLayers, setVisibleLayers] = useState<Set<string>>(new Set());
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);

  // Plan cross-section
  const [cutHeight, setCutHeight] = useState(1.0);

  // UI
  const [loading, setLoading] = useState(true);
  const [loadMsg, setLoadMsg] = useState("Chargement…");
  const [error, setError] = useState<string | null>(null);
  const [enrichments, setEnrichments] = useState<Partial<Record<ViewKey, FacadeElement[]>>>({});
  const [enrichPanel, setEnrichPanel] = useState(false);

  // Photo
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // ── Chargement GLBs ────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const ready = scans.filter((s) => s.meshPath);
      if (!ready.length) { setError("Aucun scan disponible."); setLoading(false); return; }

      const loader = new GLTFLoader();
      const allEdge: TaggedSeg[] = [];
      const combined = new THREE.Box3();
      const scenes: THREE.Object3D[] = [];

      for (let i = 0; i < ready.length; i++) {
        if (cancelled) return;
        const scan = ready[i];
        setLoadMsg(`${i + 1}/${ready.length} — ${scan.nom}`);
        try {
          const url = supabase.storage.from("pis-scans").getPublicUrl(scan.meshPath!).data.publicUrl;
          const gltf = await new Promise<{ scene: THREE.Object3D }>((res, rej) =>
            loader.load(url, res, undefined, rej)
          );
          gltf.scene.position.set(scan.offsetX, 0, scan.offsetY);
          gltf.scene.rotation.y = (scan.angle * Math.PI) / 180;
          gltf.scene.updateMatrixWorld(true);
          allEdge.push(...extractEdgeSegments(gltf.scene));
          combined.union(new THREE.Box3().setFromObject(gltf.scene));
          scenes.push(gltf.scene);
        } catch { console.warn("Échec chargement", scan.nom); }
      }

      if (cancelled) return;
      if (!allEdge.length) { setError("Aucune arête extraite."); setLoading(false); return; }

      // Calques
      const layerSet = new Set(allEdge.map((s) => s.layer));
      const layers = [...layerSet].sort();

      // Section initiale
      const initCutY = combined.min.y + 1.0;
      const initSection = extractCrossSection(scenes, initCutY);

      scenesRef.current = scenes;
      setEdgeSegs(allEdge);
      setSectionSegs(initSection);
      setBox(combined);
      setAllLayers(layers);
      setVisibleLayers(new Set(layers));
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Recompute cross-section quand cutHeight change ──────────────────────────

  useEffect(() => {
    if (!box || !scenesRef.current.length) return;
    const timer = setTimeout(() => {
      const cutY = box.min.y + cutHeight;
      setSectionSegs(extractCrossSection(scenesRef.current, cutY));
    }, 300);
    return () => clearTimeout(timer);
  }, [cutHeight, box]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const dl = useCallback((blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }, []);

  const currentSVG = (!loading && !error && box && edgeSegs.length)
    ? segsToSVG(edgeSegs, activeView === "plan" ? sectionSegs : [], VIEWS[activeView], box, scanType, visibleLayers, enrichments[activeView])
    : null;

  const downloadSVG = useCallback(() => {
    if (!currentSVG) return;
    dl(new Blob([currentSVG], { type: "image/svg+xml" }), `${chantierNom}_${activeView}.svg`);
  }, [currentSVG, chantierNom, activeView, dl]);

  const downloadDXF = useCallback(() => {
    if (!box || !edgeSegs.length) return;
    const dxf = segsToDXFStr(edgeSegs, activeView === "plan" ? sectionSegs : [], VIEWS[activeView], box, scanType, visibleLayers, enrichments[activeView]);
    dl(new Blob([dxf], { type: "application/dxf" }), `${chantierNom}_${activeView}.dxf`);
  }, [edgeSegs, sectionSegs, box, activeView, scanType, visibleLayers, enrichments, chantierNom, dl]);

  const downloadAllDXF = useCallback(async () => {
    if (!box || !edgeSegs.length) return;
    for (const key of Object.keys(VIEWS) as ViewKey[]) {
      const dxf = segsToDXFStr(edgeSegs, key === "plan" ? sectionSegs : [], VIEWS[key], box, scanType, visibleLayers, enrichments[key]);
      dl(new Blob([dxf], { type: "application/dxf" }), `${chantierNom}_${key}.dxf`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }, [edgeSegs, sectionSegs, box, scanType, visibleLayers, enrichments, chantierNom, dl]);

  // ── Gemini ─────────────────────────────────────────────────────────────────

  function loadPhoto(f: File) {
    setPhotoFile(f);
    setAnalyzeError(null);
    const reader = new FileReader();
    reader.onload = (e) => setPhotoPreview(e.target?.result as string);
    reader.readAsDataURL(f);
  }

  async function analyzePhoto() {
    if (!photoFile || !photoPreview || !box) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const size = box.getSize(new THREE.Vector3());
      const { w, h } = VIEWS[activeView].dims(size);
      const note = `Largeur : ${w.toFixed(2)} m, hauteur : ${h.toFixed(2)} m`;
      const base64 = photoPreview.split(",")[1];
      const res = await fetch("/api/facade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType: photoFile.type, measureNote: note }),
      });
      const json = await res.json() as { ok?: boolean; data?: FacadeData; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Erreur API");
      setEnrichments((prev) => ({ ...prev, [activeView]: json.data!.elements }));
      setEnrichPanel(false);
    } catch (e) {
      setAnalyzeError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const activeViewMeta = VIEWS[activeView];
  const hasEnrichment = !!enrichments[activeView]?.length;
  const hiddenCount = allLayers.length - visibleLayers.size;

  return (
    <div className="flex flex-col h-full">

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-white shrink-0 flex-wrap gap-y-1">

        {/* Type de relevé */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {(["interieur", "exterieur"] as ScanType[]).map((t) => (
            <button
              key={t}
              onClick={() => setScanType(t)}
              className="px-2.5 py-1.5 text-xs font-medium transition-colors"
              style={scanType === t ? { background: "#475569", color: "white" } : { color: "#94a3b8" }}
              title={t === "interieur" ? "Relevé intérieur" : "Relevé extérieur"}
            >
              {t === "interieur" ? "Int." : "Ext."}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-slate-200 mx-1" />

        {/* Vues */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {(Object.keys(VIEWS) as ViewKey[]).map((key) => (
            <button key={key} onClick={() => { setActiveView(key); setEnrichPanel(false); }}
              className="px-2.5 py-1.5 text-xs font-medium transition-colors"
              style={activeView === key ? { background: "var(--navy)", color: "white" } : { color: "#64748b" }}
              title={VIEWS[key].label(scanType)}
            >
              {VIEWS[key].icon} {VIEWS[key].label(scanType).replace(/Façade (int\.|ext\.) /, "")}
            </button>
          ))}
        </div>

        {/* Calques */}
        {!loading && !error && allLayers.length > 0 && (
          <button
            onClick={() => setLayerPanelOpen((v) => !v)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={layerPanelOpen
              ? { background: "var(--navy)", color: "white", borderColor: "var(--navy)" }
              : hiddenCount > 0
                ? { borderColor: "#f97316", color: "#f97316" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}
          >
            ≡ Calques{hiddenCount > 0 ? ` (${hiddenCount} masqué${hiddenCount > 1 ? "s" : ""})` : ""}
          </button>
        )}

        {/* Hauteur de coupe (plan uniquement) */}
        {activeView === "plan" && !loading && !error && box && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 bg-slate-50">
            <span className="text-xs text-slate-400">✂</span>
            <input
              type="range"
              min={0.2}
              max={2.5}
              step={0.1}
              value={cutHeight}
              onChange={(e) => setCutHeight(parseFloat(e.target.value))}
              className="w-20 accent-cyan-500"
            />
            <input
              type="number"
              min={0.2}
              max={2.5}
              step={0.05}
              value={cutHeight}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v >= 0.2 && v <= 2.5) setCutHeight(v);
              }}
              className="w-14 border border-slate-200 rounded px-1.5 py-0.5 text-xs font-mono text-slate-700 bg-white text-right focus:outline-none focus:border-cyan-400"
            />
            <span className="text-xs text-slate-400">m</span>
          </div>
        )}

        {/* Enrichissement Gemini */}
        {activeViewMeta.canEnrich && !loading && !error && (
          <button
            onClick={() => setEnrichPanel((v) => !v)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={enrichPanel
              ? { background: "var(--navy)", color: "white", borderColor: "var(--navy)" }
              : hasEnrichment
                ? { borderColor: "#10b981", color: "#10b981" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}
          >
            {hasEnrichment ? `✓ ${enrichments[activeView]!.length} éléments` : "📷 Enrichir"}
          </button>
        )}

        <div className="flex-1" />
        <button onClick={downloadSVG} disabled={!currentSVG}
          className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">
          ↓ SVG
        </button>
        <button onClick={downloadDXF} disabled={!box}
          className="px-3 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--navy)" }}>
          ↓ DXF
        </button>
        <button onClick={downloadAllDXF} disabled={!box}
          className="px-3 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--orange)" }}>
          ↓ DXF ×5
        </button>
      </div>

      {/* ── Corps ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* Panel calques (gauche) */}
        {layerPanelOpen && (
          <div className="w-56 shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-y-auto">
            <div className="p-3 border-b border-slate-100 flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-600">Calques GLB</p>
              <div className="flex gap-1">
                <button
                  onClick={() => setVisibleLayers(new Set(allLayers))}
                  className="text-xs text-slate-400 hover:text-slate-600 px-1"
                  title="Tout afficher"
                >
                  ✓ tout
                </button>
                <button
                  onClick={() => setVisibleLayers(new Set())}
                  className="text-xs text-slate-400 hover:text-slate-600 px-1"
                  title="Tout masquer"
                >
                  ✗ tout
                </button>
              </div>
            </div>
            <div className="p-2 flex flex-col gap-0.5 flex-1">
              {allLayers.map((layer) => {
                const visible = visibleLayers.has(layer);
                return (
                  <label
                    key={layer}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(e) => {
                        setVisibleLayers((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(layer);
                          else next.delete(layer);
                          return next;
                        });
                      }}
                      className="accent-cyan-500 w-3.5 h-3.5 flex-shrink-0"
                    />
                    <span
                      className="text-xs truncate"
                      style={{ color: visible ? "#334155" : "#94a3b8" }}
                      title={layer}
                    >
                      {layer}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Zone blueprint */}
        <div className="flex-1 relative" style={{ background: "#0a1628" }}>
          {loading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
              <div className="w-8 h-8 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin mb-3" />
              <p className="text-sm font-mono">{loadMsg}</p>
            </div>
          ) : error ? (
            <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">{error}</div>
          ) : currentSVG ? (
            <div className="w-full h-full overflow-auto" dangerouslySetInnerHTML={{ __html: currentSVG }} />
          ) : null}

          {!loading && !error && (
            <div className="absolute top-3 right-3 bg-black/30 backdrop-blur text-xs text-slate-400 px-2 py-1 rounded font-mono pointer-events-none">
              {activeViewMeta.label(scanType)}
            </div>
          )}
        </div>

        {/* Panel enrichissement (droite) */}
        {enrichPanel && (
          <div className="w-72 shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-y-auto">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--navy)" }}>
                  Enrichir — {activeViewMeta.label(scanType)}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">Photo → Gemini → éléments</p>
              </div>
              <button onClick={() => setEnrichPanel(false)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
            </div>

            <div className="p-4 flex flex-col gap-4 flex-1">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) loadPhoto(f); }}
                onClick={() => fileRef.current?.click()}
                className="cursor-pointer rounded-xl border-2 border-dashed border-slate-200 overflow-hidden text-center"
                style={{ minHeight: 120, background: photoPreview ? undefined : "#f8fafc" }}
              >
                <input ref={fileRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) loadPhoto(f); }} />
                {photoPreview
                  ? <img src={photoPreview} alt="" className="w-full object-cover max-h-48" />
                  : <div className="flex flex-col items-center justify-center py-8 text-slate-400">
                      <span className="text-2xl opacity-30 mb-1">🏢</span>
                      <span className="text-xs">Photo de la {activeViewMeta.label(scanType).toLowerCase()}</span>
                    </div>
                }
              </div>

              {box && (() => {
                const size = box.getSize(new THREE.Vector3());
                const { w, h } = activeViewMeta.dims(size);
                return (
                  <div className="bg-slate-50 rounded-lg px-3 py-2 text-xs text-slate-500">
                    <p className="font-medium text-slate-600 mb-1">Dimensions transmises :</p>
                    <p>Largeur : <span className="font-mono text-slate-700">{w.toFixed(2)} m</span></p>
                    <p>Hauteur : <span className="font-mono text-slate-700">{h.toFixed(2)} m</span></p>
                  </div>
                );
              })()}

              {analyzeError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{analyzeError}</p>
              )}

              {hasEnrichment && (
                <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700">
                  ✓ {enrichments[activeView]!.length} éléments — overlay actif
                  <button
                    onClick={() => setEnrichments((p) => { const n = { ...p }; delete n[activeView]; return n; })}
                    className="ml-2 text-green-500 underline"
                  >
                    effacer
                  </button>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-slate-100">
              <button
                onClick={analyzePhoto}
                disabled={!photoFile || analyzing}
                className="w-full py-2.5 rounded-xl text-white text-sm font-semibold transition-opacity"
                style={{ background: "var(--orange)", opacity: !photoFile || analyzing ? 0.4 : 1 }}
              >
                {analyzing
                  ? <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block" />
                      Gemini…
                    </span>
                  : "Analyser →"
                }
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Info bar ──────────────────────────────────────────────────────────── */}
      {!loading && !error && box && (
        <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-1.5 text-xs text-slate-400 flex gap-4 flex-wrap">
          {(() => {
            const s = box.getSize(new THREE.Vector3());
            return <>
              <span>{edgeSegs.length.toLocaleString()} arêtes</span>
              {activeView === "plan" && sectionSegs.length > 0 && (
                <span className="text-cyan-600">{sectionSegs.length.toLocaleString()} seg. poché ✂ {cutHeight.toFixed(1)} m</span>
              )}
              <span>{s.x.toFixed(2)} × {s.z.toFixed(2)} m (plan)</span>
              <span>H {s.y.toFixed(2)} m</span>
              <span>{scans.length} pièce{scans.length > 1 ? "s" : ""}</span>
              {hiddenCount > 0 && <span className="text-orange-500">{hiddenCount} calque{hiddenCount > 1 ? "s" : ""} masqué{hiddenCount > 1 ? "s" : ""}</span>}
              {hasEnrichment && <span className="text-green-600">· {enrichments[activeView]!.length} éléments Gemini</span>}
            </>;
          })()}
        </div>
      )}
    </div>
  );
}
