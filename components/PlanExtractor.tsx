"use client";

import { useEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { supabase } from "@/lib/supabase";
import { generateProjectionDXF, type Seg2D, type FacadeData, type FacadeElement, SVG_COLOR } from "@/lib/blueprint";
import type { ScanLayer } from "@/components/ViewerMulti";

// ── Types ──────────────────────────────────────────────────────────────────────
type ViewKey = "plan" | "nord" | "sud" | "est" | "ouest";
type AnyView = ViewKey | "coupe";
type ScanType = "interieur" | "exterieur";
type CutPhase = "off" | "p1" | "p2" | "dir";

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

// ── Vues orthographiques ──────────────────────────────────────────────────────

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

// ── Catégories de calques ─────────────────────────────────────────────────────

const LAYER_CATS = [
  {
    key: "structure",
    label: "Structure",
    keywords: ["wall", "mur", "floor", "sol", "plafond", "ceiling", "slab", "dalle",
      "beam", "poteau", "colonne", "struct", "concrete", "beton", "béton", "fondation"],
  },
  {
    key: "menuiserie",
    label: "Menuiserie",
    keywords: ["door", "porte", "window", "fenetre", "fenêtre", "vitrage", "glazing", "menuiserie", "volet"],
  },
  {
    key: "mobilier",
    label: "Mobilier",
    keywords: ["furniture", "meuble", "chair", "chaise", "table", "bed", "lit",
      "desk", "bureau", "canape", "canapé", "sofa", "mobilier", "armoire", "buffet"],
  },
  {
    key: "equipement",
    label: "Équipement",
    keywords: ["kitchen", "cuisine", "bathroom", "bain", "sink", "toilet",
      "equipment", "equipement", "sanitaire", "appareil", "radiateur", "clim"],
  },
];

function categorizeLayer(name: string): string {
  const lower = name.toLowerCase();
  for (const cat of LAYER_CATS) {
    if (cat.keywords.some((k) => lower.includes(k))) return cat.key;
  }
  return "autre";
}

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

// ── Section plan horizontal (triangle × plan horizontal) ─────────────────────

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

// ── Section verticale (triangle × plan vertical) ──────────────────────────────

function extractVerticalSection(
  scenes: THREE.Object3D[],
  p1: { x: number; z: number },
  p2: { x: number; z: number },
  lookSign: 1 | -1
): TaggedSeg[] {
  const segs: TaggedSeg[] = [];
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return segs;

  // Normale du plan de coupe (perpendiculaire à la ligne dans XZ, orientée vers lookSign)
  const nx = (-dz / len) * lookSign;
  const nz = (dx / len) * lookSign;

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

        // Distance signée au plan de coupe
        const d = [
          nx * (v[0].x - p1.x) + nz * (v[0].z - p1.z),
          nx * (v[1].x - p1.x) + nz * (v[1].z - p1.z),
          nx * (v[2].x - p1.x) + nz * (v[2].z - p1.z),
        ];
        const above = d.map((di) => di >= 0);
        const n2 = above.filter(Boolean).length;
        if (n2 === 0 || n2 === 3) continue;

        const lerpV = (a: THREE.Vector3, b: THREE.Vector3, da: number, db: number): THREE.Vector3 => {
          const t2 = da / (da - db);
          return new THREE.Vector3(a.x + t2 * (b.x - a.x), a.y + t2 * (b.y - a.y), a.z + t2 * (b.z - a.z));
        };

        const pts: THREE.Vector3[] = [];
        if (above[0] !== above[1]) pts.push(lerpV(v[0], v[1], d[0], d[1]));
        if (above[1] !== above[2]) pts.push(lerpV(v[1], v[2], d[1], d[2]));
        if (above[2] !== above[0]) pts.push(lerpV(v[2], v[0], d[2], d[0]));
        if (pts.length === 2) segs.push({ a: pts[0], b: pts[1], layer, isSection: true });
      }
    });
  }
  return segs;
}

// Filtre les arêtes sur le côté visible d'un plan de coupe
function filterSegsForSection(
  segs: TaggedSeg[],
  p1: { x: number; z: number },
  p2: { x: number; z: number },
  lookSign: 1 | -1
): TaggedSeg[] {
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return segs;
  const nx = (-dz / len) * lookSign;
  const nz = (dx / len) * lookSign;
  return segs.filter((s) => {
    const da = nx * (s.a.x - p1.x) + nz * (s.a.z - p1.z);
    const db = nx * (s.b.x - p1.x) + nz * (s.b.z - p1.z);
    return da >= -0.02 && db >= -0.02;
  });
}

// ViewMeta pour une coupe libre (projection 2D le long de la ligne P1→P2)
function makeCoupeViewMeta(
  p1: { x: number; z: number },
  p2: { x: number; z: number }
): ViewMeta {
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  const ex = dx / len;
  const ez = dz / len;
  return {
    label: () => "✂ Coupe",
    icon: "✂",
    canEnrich: false,
    project: (v) => ({ u: ex * (v.x - p1.x) + ez * (v.z - p1.z), v: -v.y }),
    dims: (s) => ({ w: len, h: s.y }),
  };
}

// ── Coordonnées SVG plan ←→ monde ─────────────────────────────────────────────

function getPlanSvgParams(box: THREE.Box3) {
  const size = box.getSize(new THREE.Vector3());
  const { w, h } = VIEWS.plan.dims(size);
  const svgW = 1000;
  const svgH = Math.round(svgW * h / w);
  const pad = 40;
  const scaleX = (svgW - pad * 2) / w;
  const scaleY = (svgH - pad * 2) / h;
  const pts = [box.min, box.max].map((p) => VIEWS.plan.project(p));
  const uMin = Math.min(...pts.map((p) => p.u));
  const vMin = Math.min(...pts.map((p) => p.v));
  return { svgW, svgH, pad, scaleX, scaleY, uMin, vMin };
}

function planSvgCoordToWorld(svgX: number, svgY: number, box: THREE.Box3): { x: number; z: number } {
  const { pad, scaleX, scaleY, uMin, vMin } = getPlanSvgParams(box);
  return { x: (svgX - pad) / scaleX + uMin, z: (svgY - pad) / scaleY + vMin };
}

function worldToSvgCoord(x: number, z: number, box: THREE.Box3): { x: number; y: number } {
  const { pad, scaleX, scaleY, uMin, vMin } = getPlanSvgParams(box);
  return { x: (x - uMin) * scaleX + pad, y: (z - vMin) * scaleY + pad };
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

  const poche = filteredSection.map((s) => {
    const { x1, y1, x2, y2 } = project(s);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#334155" stroke-width="14" stroke-linecap="butt"/>`;
  }).join("\n");

  const pocheOutline = filteredSection.map((s) => {
    const { x1, y1, x2, y2 } = project(s);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="1" stroke-linecap="butt"/>`;
  }).join("\n");

  const lines = filteredEdge.map((s) => {
    const { x1, y1, x2, y2 } = project(s);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#00e5ff" stroke-width="0.7" stroke-linecap="round"/>`;
  }).join("\n");

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

  return generateProjectionDXF(filteredEdge.map(toSeg2D), view.label(scanType), w, h, elements, filteredSection.map(toSeg2D));
}

// ── Composant principal ───────────────────────────────────────────────────────

interface Props { scans: ScanLayer[]; chantierNom: string }

export default function PlanExtractor({ scans, chantierNom }: Props) {
  const [activeView, setActiveView] = useState<AnyView>("plan");
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

  // Outil coupe libre
  const [cutPhase, setCutPhase] = useState<CutPhase>("off");
  const [cutP1, setCutP1] = useState<{ x: number; z: number } | null>(null);
  const [cutP2, setCutP2] = useState<{ x: number; z: number } | null>(null);
  const [coupeEdgeSegs, setCoupeEdgeSegs] = useState<TaggedSeg[]>([]);
  const [coupeSectionSegs, setCoupeSectionSegs] = useState<TaggedSeg[]>([]);
  const [coupeMeta, setCoupeMeta] = useState<ViewMeta | null>(null);
  const overlaySvgRef = useRef<SVGSVGElement>(null);

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
          // Appliquer offset X/Y (plan) + Z (hauteur)
          gltf.scene.position.set(scan.offsetX, scan.offsetZ ?? 0, scan.offsetY);
          gltf.scene.rotation.y = (scan.angle * Math.PI) / 180;
          gltf.scene.updateMatrixWorld(true);
          allEdge.push(...extractEdgeSegments(gltf.scene));
          combined.union(new THREE.Box3().setFromObject(gltf.scene));
          scenes.push(gltf.scene);
        } catch { console.warn("Échec chargement", scan.nom); }
      }

      if (cancelled) return;
      if (!allEdge.length) { setError("Aucune arête extraite."); setLoading(false); return; }

      const layerSet = new Set(allEdge.map((s) => s.layer));
      const layers = [...layerSet].sort();
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

  function getActiveView(): ViewMeta | null {
    if (activeView === "coupe") return coupeMeta;
    return VIEWS[activeView as ViewKey];
  }

  const activeViewMeta = getActiveView();

  const currentSVG = (!loading && !error && box && edgeSegs.length && activeViewMeta)
    ? activeView === "coupe"
      ? segsToSVG(coupeEdgeSegs, coupeSectionSegs, activeViewMeta, box, scanType, visibleLayers)
      : segsToSVG(
          edgeSegs,
          activeView === "plan" ? sectionSegs : [],
          activeViewMeta,
          box, scanType, visibleLayers,
          activeView !== "plan" && activeView !== "coupe" ? enrichments[activeView as ViewKey] : undefined
        )
    : null;

  const downloadSVG = useCallback(() => {
    if (!currentSVG) return;
    dl(new Blob([currentSVG], { type: "image/svg+xml" }), `${chantierNom}_${activeView}.svg`);
  }, [currentSVG, chantierNom, activeView, dl]);

  const downloadDXF = useCallback(() => {
    if (!box || !edgeSegs.length || !activeViewMeta) return;
    const edg = activeView === "coupe" ? coupeEdgeSegs : edgeSegs;
    const sec = activeView === "coupe" ? coupeSectionSegs : activeView === "plan" ? sectionSegs : [];
    const dxf = segsToDXFStr(edg, sec, activeViewMeta, box, scanType, visibleLayers,
      activeView !== "plan" && activeView !== "coupe" ? enrichments[activeView as ViewKey] : undefined);
    dl(new Blob([dxf], { type: "application/dxf" }), `${chantierNom}_${activeView}.dxf`);
  }, [edgeSegs, coupeEdgeSegs, sectionSegs, coupeSectionSegs, box, activeView, activeViewMeta, scanType, visibleLayers, enrichments, chantierNom, dl]);

  const downloadAllDXF = useCallback(async () => {
    if (!box || !edgeSegs.length) return;
    for (const key of Object.keys(VIEWS) as ViewKey[]) {
      const dxf = segsToDXFStr(edgeSegs, key === "plan" ? sectionSegs : [], VIEWS[key], box, scanType, visibleLayers, enrichments[key]);
      dl(new Blob([dxf], { type: "application/dxf" }), `${chantierNom}_${key}.dxf`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }, [edgeSegs, sectionSegs, box, scanType, visibleLayers, enrichments, chantierNom, dl]);

  // ── Outil coupe libre ──────────────────────────────────────────────────────

  function handleOverlayClick(e: ReactMouseEvent<SVGSVGElement>) {
    if (cutPhase !== "p1" && cutPhase !== "p2") return;
    if (!box) return;
    const svg = overlaySvgRef.current;
    if (!svg) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(e.clientX, e.clientY);
    const svgPt = pt.matrixTransform(ctm.inverse());
    const world = planSvgCoordToWorld(svgPt.x, svgPt.y, box);

    if (cutPhase === "p1") {
      setCutP1(world);
      setCutPhase("p2");
    } else if (cutPhase === "p2") {
      setCutP2(world);
      setCutPhase("dir");
    }
  }

  function handleDirectionChoice(lookSign: 1 | -1) {
    if (!cutP1 || !cutP2 || !scenesRef.current.length || !box) return;
    const meta = makeCoupeViewMeta(cutP1, cutP2);
    const filteredEdge = filterSegsForSection(edgeSegs, cutP1, cutP2, lookSign);
    const secSegs = extractVerticalSection(scenesRef.current, cutP1, cutP2, lookSign);
    setCoupeMeta(meta);
    setCoupeEdgeSegs(filteredEdge);
    setCoupeSectionSegs(secSegs);
    setCutPhase("off");
    setCutP1(null);
    setCutP2(null);
    setActiveView("coupe");
  }

  function cancelCut() {
    setCutPhase("off");
    setCutP1(null);
    setCutP2(null);
  }

  // ── Gemini ─────────────────────────────────────────────────────────────────

  function loadPhoto(f: File) {
    setPhotoFile(f);
    setAnalyzeError(null);
    const reader = new FileReader();
    reader.onload = (e) => setPhotoPreview(e.target?.result as string);
    reader.readAsDataURL(f);
  }

  async function analyzePhoto() {
    if (!photoFile || !photoPreview || !box || !activeViewMeta) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const size = box.getSize(new THREE.Vector3());
      const { w, h } = activeViewMeta.dims(size);
      const note = `Largeur : ${w.toFixed(2)} m, hauteur : ${h.toFixed(2)} m`;
      const base64 = photoPreview.split(",")[1];
      const res = await fetch("/api/facade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType: photoFile.type, measureNote: note }),
      });
      const json = await res.json() as { ok?: boolean; data?: FacadeData; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Erreur API");
      if (activeView !== "coupe") {
        setEnrichments((prev) => ({ ...prev, [activeView]: json.data!.elements }));
      }
      setEnrichPanel(false);
    } catch (e) {
      setAnalyzeError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const hasEnrichment = activeView !== "coupe" && !!enrichments[activeView as ViewKey]?.length;
  const hiddenCount = allLayers.length - visibleLayers.size;

  // Overlay SVG pour le tracé de coupe sur le plan
  const planOverlay = activeView === "plan" && box && cutPhase !== "off" ? (() => {
    const { svgW, svgH } = getPlanSvgParams(box);
    const sp1 = cutP1 ? worldToSvgCoord(cutP1.x, cutP1.z, box) : null;
    const sp2 = cutP2 ? worldToSvgCoord(cutP2.x, cutP2.z, box) : null;

    let dirButtons = null;
    if (cutPhase === "dir" && sp1 && sp2) {
      const dx = sp2.x - sp1.x;
      const dy = sp2.y - sp1.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const px = len > 0 ? (-dy / len) * 44 : 44;
      const py = len > 0 ? (dx / len) * 44 : 0;
      const mx = (sp1.x + sp2.x) / 2;
      const my = (sp1.y + sp2.y) / 2;
      dirButtons = (
        <>
          <g onClick={(e) => { e.stopPropagation(); handleDirectionChoice(1); }} style={{ cursor: "pointer" }}>
            <circle cx={mx + px} cy={my + py} r="20" fill="#1e3a5f" stroke="#f97316" strokeWidth="2"/>
            <text x={mx + px} y={my + py + 5} textAnchor="middle" fontSize="17" fill="white" style={{ pointerEvents: "none", userSelect: "none" }}>◀</text>
          </g>
          <g onClick={(e) => { e.stopPropagation(); handleDirectionChoice(-1); }} style={{ cursor: "pointer" }}>
            <circle cx={mx - px} cy={my - py} r="20" fill="#1e3a5f" stroke="#f97316" strokeWidth="2"/>
            <text x={mx - px} y={my - py + 5} textAnchor="middle" fontSize="17" fill="white" style={{ pointerEvents: "none", userSelect: "none" }}>▶</text>
          </g>
        </>
      );
    }

    return (
      <svg
        ref={overlaySvgRef}
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "all", cursor: cutPhase === "p1" || cutPhase === "p2" ? "crosshair" : "default" }}
        onClick={handleOverlayClick}
      >
        {(cutPhase === "p1" || cutPhase === "p2") && (
          <rect x={0} y={0} width={svgW} height={svgH} fill="transparent"/>
        )}
        {sp1 && <circle cx={sp1.x} cy={sp1.y} r="7" fill="#f97316" stroke="white" strokeWidth="2"/>}
        {sp1 && <text x={sp1.x + 10} y={sp1.y - 6} fill="#f97316" fontSize="12" fontFamily="monospace" style={{ pointerEvents: "none" }}>P1</text>}
        {sp1 && sp2 && (
          <line x1={sp1.x} y1={sp1.y} x2={sp2.x} y2={sp2.y} stroke="#f97316" strokeWidth="2" strokeDasharray="8,4"/>
        )}
        {sp2 && <circle cx={sp2.x} cy={sp2.y} r="7" fill="#f97316" stroke="white" strokeWidth="2"/>}
        {sp2 && <text x={sp2.x + 10} y={sp2.y - 6} fill="#f97316" fontSize="12" fontFamily="monospace" style={{ pointerEvents: "none" }}>P2</text>}
        {dirButtons}
      </svg>
    );
  })() : null;

  // Groupement des calques par catégorie
  const layersByCategory: Record<string, string[]> = {};
  for (const layer of allLayers) {
    const cat = categorizeLayer(layer);
    if (!layersByCategory[cat]) layersByCategory[cat] = [];
    layersByCategory[cat].push(layer);
  }
  const catOrder = [...LAYER_CATS.map((c) => c.key), "autre"];

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
            <button key={key} onClick={() => { setActiveView(key); setEnrichPanel(false); cancelCut(); }}
              className="px-2.5 py-1.5 text-xs font-medium transition-colors"
              style={activeView === key ? { background: "var(--navy)", color: "white" } : { color: "#64748b" }}
              title={VIEWS[key].label(scanType)}
            >
              {VIEWS[key].icon} {VIEWS[key].label(scanType).replace(/Façade (int\.|ext\.) /, "")}
            </button>
          ))}
          {coupeMeta && (
            <button
              onClick={() => { setActiveView("coupe"); setEnrichPanel(false); cancelCut(); }}
              className="px-2.5 py-1.5 text-xs font-medium transition-colors border-l border-slate-200"
              style={activeView === "coupe" ? { background: "#f97316", color: "white" } : { color: "#f97316" }}
            >
              ✂ Coupe
            </button>
          )}
        </div>

        {/* Outil coupe libre (plan uniquement) */}
        {activeView === "plan" && !loading && !error && (
          <button
            onClick={() => {
              if (cutPhase !== "off") { cancelCut(); }
              else { setCutPhase("p1"); }
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={cutPhase !== "off"
              ? { background: "#f97316", color: "white", borderColor: "#f97316" }
              : coupeMeta
                ? { borderColor: "#f97316", color: "#f97316" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}
            title="Tracer un plan de coupe"
          >
            {cutPhase === "p1" ? "✂ Clic P1…" : cutPhase === "p2" ? "✂ Clic P2…" : cutPhase === "dir" ? "✂ Choisir sens ◀▶" : "✂ Coupe libre"}
          </button>
        )}

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
            <span className="text-xs text-slate-400">h</span>
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
        {activeViewMeta?.canEnrich && !loading && !error && (
          <button
            onClick={() => setEnrichPanel((v) => !v)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={enrichPanel
              ? { background: "var(--navy)", color: "white", borderColor: "var(--navy)" }
              : hasEnrichment
                ? { borderColor: "#10b981", color: "#10b981" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}
          >
            {hasEnrichment ? `✓ ${enrichments[activeView as ViewKey]!.length} éléments` : "📷 Enrichir"}
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

        {/* Panel calques (gauche) — groupé par catégorie */}
        {layerPanelOpen && (
          <div className="w-60 shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-y-auto">
            <div className="p-3 border-b border-slate-100 flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-600">Calques</p>
              <div className="flex gap-1">
                <button onClick={() => setVisibleLayers(new Set(allLayers))}
                  className="text-xs text-slate-400 hover:text-slate-600 px-1" title="Tout afficher">
                  ✓ tout
                </button>
                <button onClick={() => setVisibleLayers(new Set())}
                  className="text-xs text-slate-400 hover:text-slate-600 px-1" title="Tout masquer">
                  ✗ tout
                </button>
              </div>
            </div>
            <div className="p-2 flex flex-col gap-3 flex-1">
              {catOrder.filter((catKey) => layersByCategory[catKey]?.length).map((catKey) => {
                const catMeta = LAYER_CATS.find((c) => c.key === catKey);
                const catLabel = catMeta?.label ?? "Autre";
                const catLayers = layersByCategory[catKey] ?? [];
                const allVisible = catLayers.every((l) => visibleLayers.has(l));
                const someVisible = catLayers.some((l) => visibleLayers.has(l));
                return (
                  <div key={catKey}>
                    {/* En-tête catégorie */}
                    <div className="flex items-center justify-between px-2 py-1 mb-0.5">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{catLabel}</span>
                      <button
                        onClick={() => {
                          setVisibleLayers((prev) => {
                            const next = new Set(prev);
                            if (allVisible) catLayers.forEach((l) => next.delete(l));
                            else catLayers.forEach((l) => next.add(l));
                            return next;
                          });
                        }}
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={allVisible ? { color: "#64748b" } : someVisible ? { color: "#f97316" } : { color: "#cbd5e1" }}
                        title={allVisible ? "Masquer le groupe" : "Afficher le groupe"}
                      >
                        {allVisible ? "✓" : someVisible ? "~" : "✗"}
                      </button>
                    </div>
                    {/* Calques */}
                    <div className="flex flex-col gap-0.5">
                      {catLayers.map((layer) => {
                        const visible = visibleLayers.has(layer);
                        return (
                          <label key={layer} className="flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer hover:bg-slate-50 ml-2">
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
                            <span className="text-xs truncate" style={{ color: visible ? "#334155" : "#94a3b8" }} title={layer}>
                              {layer}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
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
            <div className="w-full h-full overflow-auto relative">
              <div className="w-full h-full" dangerouslySetInnerHTML={{ __html: currentSVG }} />
              {planOverlay}
            </div>
          ) : null}

          {!loading && !error && (
            <div className="absolute top-3 right-3 bg-black/30 backdrop-blur text-xs text-slate-400 px-2 py-1 rounded font-mono pointer-events-none">
              {activeViewMeta?.label(scanType) ?? ""}
            </div>
          )}

          {/* Aide outil coupe */}
          {cutPhase !== "off" && (
            <div className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full font-mono pointer-events-none">
              {cutPhase === "p1" && "Cliquez pour placer le point P1 de la coupe"}
              {cutPhase === "p2" && "Cliquez pour placer le point P2 de la coupe"}
              {cutPhase === "dir" && "Choisissez le sens d'observation ◀ ▶"}
            </div>
          )}
        </div>

        {/* Panel enrichissement (droite) */}
        {enrichPanel && activeViewMeta?.canEnrich && (
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
                  ✓ {enrichments[activeView as ViewKey]!.length} éléments — overlay actif
                  <button
                    onClick={() => setEnrichments((p) => { const n = { ...p }; delete n[activeView as ViewKey]; return n; })}
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
              {activeView === "coupe" && (
                <span className="text-orange-500">{coupeSectionSegs.length.toLocaleString()} seg. coupe · {coupeEdgeSegs.length.toLocaleString()} arêtes visibles</span>
              )}
              <span>{s.x.toFixed(2)} × {s.z.toFixed(2)} m (plan)</span>
              <span>H {s.y.toFixed(2)} m</span>
              <span>{scans.length} pièce{scans.length > 1 ? "s" : ""}</span>
              {hiddenCount > 0 && <span className="text-orange-500">{hiddenCount} calque{hiddenCount > 1 ? "s" : ""} masqué{hiddenCount > 1 ? "s" : ""}</span>}
              {hasEnrichment && <span className="text-green-600">· {enrichments[activeView as ViewKey]!.length} éléments Gemini</span>}
            </>;
          })()}
        </div>
      )}
    </div>
  );
}
