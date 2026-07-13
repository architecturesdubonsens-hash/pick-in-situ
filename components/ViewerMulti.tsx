"use client";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { supabase, db } from "@/lib/supabase";
import { buildBimIFC, buildBimPlanDXF } from "@/lib/bim-export";

export interface ScanLayer {
  id: string;
  nom: string;
  meshPath: string | null;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  angle: number;   // degrés (lacet)
  tiltX?: number;  // radians — mise à niveau (assiette)
  tiltZ?: number;
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
  tx: number; // assiette (radians, axes monde X et Z)
  tz: number;
}

// ── Outil Mesure ──────────────────────────────────────────────────────────────
interface Mesure {
  id: string;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  d: number;
}

function etiquetteMesure(text: string) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 80;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(37, 99, 235, 0.9)";
  ctx.fillRect(4, 8, 248, 64);
  ctx.font = "bold 40px system-ui, sans-serif";
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 41);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(0.75, 0.24, 1);
  spr.renderOrder = 4;
  return spr;
}

// ── Outils BIM (scan-to-BIM) ──────────────────────────────────────────────────
interface Mur {
  id: string;
  ax: number; az: number;
  bx: number; bz: number;
  epaisseur: number;
  hauteur: number;
  base_y: number;
  decalage: number; // 0 = ligne tracée sur l'axe ; ±0.5 = ligne sur un nu (× épaisseur)
}

interface Ouverture {
  id: string;
  mur_id: string;
  pos: number;     // centre, distance le long de l'axe depuis l'extrémité A
  largeur: number;
  hauteur: number;
  allege: number;  // depuis la base du mur (0 = porte)
}

interface Dalle {
  id: string;
  points: [number, number][]; // polygone [x, z]
  epaisseur: number;
  base_y: number;             // niveau fini supérieur
}

interface Toit {
  id: string;
  p1: [number, number, number]; // égout 1
  p2: [number, number, number]; // égout 2
  p3: [number, number, number]; // faîtage
  epaisseur: number;
}

interface Ancre {
  id: string;
  x: number; y: number; z: number;
}

function murMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xf97316, transparent: true, opacity: 0.55, roughness: 0.6,
    depthWrite: false, side: THREE.DoubleSide,
  });
}

function bimMaterial(color: number) {
  return new THREE.MeshStandardMaterial({
    color, transparent: true, opacity: 0.5, roughness: 0.6,
    depthWrite: false, side: THREE.DoubleSide,
  });
}

// Profil du haut du mur (hauteur locale échantillonnée le long de l'axe) quand une
// ou plusieurs toitures le recoupent → pignons/rampants automatiques. Renvoie null
// si aucune toiture ne le coupe (mur à sommet plat = chemin rapide).
function murTopProfile(
  m: Mur, len: number, dirx: number, dirz: number,
  nx: number, nz: number, off: number, roofs: Toit[]
): { x: number; y: number }[] | null {
  if (!roofs.length) return null;
  const Ax = m.ax + nx * off, Az = m.az + nz * off;
  const infos = roofs.map((t) => {
    const { p1, e, s } = toitVecteurs(t);
    let n = new THREE.Vector3().crossVectors(e, s).normalize();
    if (n.y < 0) n.negate();
    return { p1x: p1.x, p1y: p1.y, p1z: p1.z, ex: e.x, ez: e.z, sx: s.x, sz: s.z,
             nx: n.x, ny: n.y, nz: n.z, det: e.x * s.z - e.z * s.x };
  });
  const N = Math.min(160, Math.max(8, Math.ceil(len / 0.12)));
  const prof: { x: number; y: number }[] = [];
  let cut = false;
  for (let i = 0; i <= N; i++) {
    const X = (len * i) / N;
    const wx = Ax + dirx * X, wz = Az + dirz * X;
    let top = m.hauteur;
    for (const inf of infos) {
      if (Math.abs(inf.det) < 1e-6 || Math.abs(inf.ny) < 1e-4) continue;
      const rx = wx - inf.p1x, rz = wz - inf.p1z;
      const a = (rx * inf.sz - rz * inf.sx) / inf.det;
      const b = (inf.ex * rz - inf.ez * rx) / inf.det;
      if (a < -0.15 || a > 1.15 || b < -0.15 || b > 1.15) continue;
      const roofY = inf.p1y - (inf.nx * rx + inf.nz * rz) / inf.ny;
      const localTop = roofY - m.base_y;
      if (localTop < top) top = localTop;
    }
    top = Math.max(0.1, top);
    if (top < m.hauteur - 1e-3) cut = true;
    prof.push({ x: X, y: top });
  }
  return cut ? prof : null;
}

function topAtX(prof: { x: number; y: number }[] | null, hauteur: number, x: number) {
  if (!prof || !prof.length) return hauteur;
  for (let i = 1; i < prof.length; i++) {
    if (x <= prof[i].x) {
      const t = (x - prof[i - 1].x) / Math.max(1e-6, prof[i].x - prof[i - 1].x);
      return prof[i - 1].y + t * (prof[i].y - prof[i - 1].y);
    }
  }
  return prof[prof.length - 1].y;
}

// Élévation du mur (longueur × hauteur) avec les ouvertures en trous, extrudée
// sur l'épaisseur — géométrie locale : X = axe, Y = hauteur (0 à h), Z = épaisseur
function murGeometry(m: Mur, len: number, ouvertures: Ouverture[], prof: { x: number; y: number }[] | null) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(len, 0);
  if (prof && prof.length) {
    for (let i = prof.length - 1; i >= 0; i--) shape.lineTo(prof[i].x, prof[i].y);
  } else {
    shape.lineTo(len, m.hauteur); shape.lineTo(0, m.hauteur);
  }
  shape.closePath();
  for (const o of ouvertures) {
    const x0 = Math.max(0.01, o.pos - o.largeur / 2);
    const x1 = Math.min(len - 0.01, o.pos + o.largeur / 2);
    const y0 = Math.max(0, o.allege);
    // plafonne le haut de l'ouverture sous le rampant à cet endroit
    const topLim = Math.min(topAtX(prof, m.hauteur, o.pos - o.largeur / 2),
                            topAtX(prof, m.hauteur, o.pos + o.largeur / 2)) - 0.02;
    const y1 = Math.min(topLim, o.allege + o.hauteur);
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) continue;
    const trou = new THREE.Path();
    trou.moveTo(x0, y0); trou.lineTo(x1, y0); trou.lineTo(x1, y1);
    trou.lineTo(x0, y1); trou.closePath();
    shape.holes.push(trou);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: m.epaisseur, bevelEnabled: false });
  g.translate(-len / 2, 0, -m.epaisseur / 2);
  return g;
}

function poserMurMesh(mesh: THREE.Mesh, m: Mur, ouvertures: Ouverture[], roofs: Toit[]) {
  const dx = m.bx - m.ax, dz = m.bz - m.az;
  const len = Math.max(0.05, Math.hypot(dx, dz));
  // Décalage perpendiculaire : la ligne tracée est l'axe (0) ou un nu (±0.5 × ép.)
  const off = (m.decalage ?? 0) * m.epaisseur;
  const nx = -dz / len, nz = dx / len;
  const dirx = dx / len, dirz = dz / len;
  const prof = murTopProfile(m, len, dirx, dirz, nx, nz, off, roofs);
  mesh.geometry.dispose();
  mesh.geometry = murGeometry(m, len, ouvertures, prof);
  mesh.position.set((m.ax + m.bx) / 2 + nx * off, m.base_y, (m.az + m.bz) / 2 + nz * off);
  mesh.rotation.y = -Math.atan2(dz, dx);
}

// Jonctions de murs : plans de coupe d'onglet (miter) aux angles où deux murs
// partagent une extrémité. On coupe chaque mur le long de la bissectrice → les
// deux corps se rejoignent proprement sans altérer géométrie/ouvertures/toiture.
function murMiterPlanes(m: Mur, murs: Mur[]): THREE.Plane[] {
  const planes: THREE.Plane[] = [];
  const ends: [number, number, number, number][] = [
    [m.ax, m.az, m.bx, m.bz], // coin A → direction vers B
    [m.bx, m.bz, m.ax, m.az], // coin B → direction vers A
  ];
  for (const [cx, cz, ox, oz] of ends) {
    const uW = new THREE.Vector2(ox - cx, oz - cz);
    if (uW.lengthSq() < 1e-6) continue;
    uW.normalize();
    // voisin partageant ce coin
    let uN: THREE.Vector2 | null = null;
    for (const n of murs) {
      if (n.id === m.id) continue;
      for (const [nx, nz, nox, noz] of [
        [n.ax, n.az, n.bx, n.bz], [n.bx, n.bz, n.ax, n.az],
      ] as [number, number, number, number][]) {
        if (Math.hypot(nx - cx, nz - cz) < 0.08) {
          const c = new THREE.Vector2(nox - nx, noz - nz);
          if (c.lengthSq() > 1e-6) { uN = c.normalize(); break; }
        }
      }
      if (uN) break;
    }
    if (!uN) continue;
    const b = uW.clone().add(uN);
    if (b.lengthSq() < 1e-4) continue;   // murs colinéaires opposés : pas de coupe
    b.normalize();
    const nm = new THREE.Vector2(-b.y, b.x);
    if (nm.dot(uW) < 0) nm.negate();     // garder le corps du mur courant
    const normal3 = new THREE.Vector3(nm.x, 0, nm.y);
    planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(normal3, new THREE.Vector3(cx, 0, cz)));
  }
  return planes;
}

// Dalle : polygone au sol extrudé vers le bas depuis son niveau fini supérieur
function dalleGeometry(d: Dalle) {
  const shape = new THREE.Shape();
  d.points.forEach(([x, z], i) => (i ? shape.lineTo(x, z) : shape.moveTo(x, z)));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: d.epaisseur, bevelEnabled: false });
  g.rotateX(Math.PI / 2); // plan XY → horizontal, extrusion vers le bas
  return g;
}

function aireDalle(points: [number, number][]) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i], [x2, z2] = points[(i + 1) % points.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

// Pan de toiture : parallélogramme égout p1-p2 → faîtage p3, prisme d'épaisseur ep
function toitVecteurs(t: Toit) {
  const p1 = new THREE.Vector3(t.p1[0], t.p1[1], t.p1[2]);
  const p2 = new THREE.Vector3(t.p2[0], t.p2[1], t.p2[2]);
  const p3 = new THREE.Vector3(t.p3[0], t.p3[1], t.p3[2]);
  const e = p2.clone().sub(p1);                       // direction d'égout
  const el = e.clone().normalize();
  const s = p3.clone().sub(p1);                       // rampant : composante ⊥ à l'égout
  s.sub(el.clone().multiplyScalar(s.dot(el)));
  return { p1, p2, e, s };
}

function toitGeometry(t: Toit) {
  const { p1, p2, e, s } = toitVecteurs(t);
  let n = new THREE.Vector3().crossVectors(e, s).normalize();
  if (n.y < 0) n.negate();
  const c0 = p1, c1 = p2, c2 = p2.clone().add(s), c3 = p1.clone().add(s);
  const down = n.clone().multiplyScalar(-t.epaisseur);
  const [b0, b1, b2, b3] = [c0, c1, c2, c3].map((c) => c.clone().add(down));
  const v: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
    v.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    tri(a, b, c); tri(a, c, d);
  };
  quad(c0, c1, c2, c3);                     // dessus
  quad(b3, b2, b1, b0);                     // dessous
  quad(c0, b0, b1, c1); quad(c1, b1, b2, c2);
  quad(c2, b2, b3, c3); quad(c3, b3, b0, c0);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

// Fenêtre flottante déplaçable (palette de propriétés) — apparaît à la sélection
function FloatingPanel({ pos, setPos, title, accent, onClose, children }: {
  pos: { x: number; y: number };
  setPos: (p: { x: number; y: number }) => void;
  title: string;
  accent: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const off = useRef({ dx: 0, dy: 0 });
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - off.current.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - off.current.dy));
      setPos({ x, y });
    };
    const up = () => { dragging.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [setPos]);
  return (
    <div className="fixed z-30 w-60 bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden"
      style={{ left: pos.x, top: pos.y }}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-move select-none text-white"
        style={{ background: accent }}
        onPointerDown={(e) => { dragging.current = true; off.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }; }}
      >
        <span className="text-xs font-semibold flex-1 truncate">{title}</span>
        <button onClick={onClose} className="text-white/80 hover:text-white text-sm leading-none">✕</button>
      </div>
      <div className="p-3 flex flex-col gap-2">{children}</div>
    </div>
  );
}

// Champ numérique compact (défini au niveau module → garde le focus à la frappe)
function NumField({ label, value, onChange, min, max, step = 0.01, unit = "m" }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
      <span className="w-14 shrink-0">{label}</span>
      <input type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
        className="flex-1 min-w-0 border border-slate-200 rounded px-1.5 py-1 text-[11px] font-mono" />
      <span className="text-slate-400 w-3">{unit}</span>
    </label>
  );
}

export default function ViewerMulti({ chantierNom, chantierId, scans }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const meshMapRef = useRef<Map<string, THREE.Group>>(new Map());
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  // ── Murs BIM ──
  const [murs, setMurs] = useState<Mur[]>([]);
  const [murMode, setMurMode] = useState(false);
  const [murDraft, setMurDraft] = useState<THREE.Vector3 | null>(null);
  const murModeRef = useRef(false);
  const murDraftRef = useRef<THREE.Vector3 | null>(null);
  const mursRef = useRef<Mur[]>([]);
  const murMeshMapRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const draftMarkerRef = useRef<THREE.Mesh | null>(null);
  const [murSel, setMurSel] = useState<string | null>(null);
  const [murAlign, setMurAlign] = useState<"axe" | "face">("axe");
  const [murBaseY, setMurBaseY] = useState(0);
  const [pipette, setPipette] = useState(false);
  const [murPending, setMurPending] = useState<{ a: THREE.Vector3; b: THREE.Vector3 } | null>(null);
  const murSelRef = useRef<string | null>(null);
  const murAlignRef = useRef<"axe" | "face">("axe");
  const murBaseYRef = useRef(0);
  const pipetteRef = useRef(false);
  const murPendingRef = useRef<{ a: THREE.Vector3; b: THREE.Vector3 } | null>(null);
  const pendingMeshRef = useRef<THREE.Mesh | null>(null);

  // ── Ouvertures / Dalles / Toits ──
  const [ouvertures, setOuvertures] = useState<Ouverture[]>([]);
  const [ouvMode, setOuvMode] = useState(false);
  const [dalles, setDalles] = useState<Dalle[]>([]);
  const [dalleMode, setDalleMode] = useState(false);
  const [dalleDraft, setDalleDraft] = useState<THREE.Vector3[]>([]);
  const [toits, setToits] = useState<Toit[]>([]);
  const [toitMode, setToitMode] = useState(false);
  const [toitDraft, setToitDraft] = useState<THREE.Vector3[]>([]);
  const ouvModeRef = useRef(false);
  const dalleModeRef = useRef(false);
  const dalleDraftRef = useRef<THREE.Vector3[]>([]);
  const toitModeRef = useRef(false);
  const toitDraftRef = useRef<THREE.Vector3[]>([]);
  const dalleMarkersRef = useRef<THREE.Mesh[]>([]);
  const dalleLineRef = useRef<THREE.Line | null>(null);
  const toitMarkersRef = useRef<THREE.Mesh[]>([]);
  const dalleMeshMapRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const toitMeshMapRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const ouverturesRef = useRef<Ouverture[]>([]);
  const toitsRef = useRef<Toit[]>([]);
  useEffect(() => { ouvModeRef.current = ouvMode; }, [ouvMode]);
  useEffect(() => { dalleModeRef.current = dalleMode; }, [dalleMode]);
  useEffect(() => { dalleDraftRef.current = dalleDraft; }, [dalleDraft]);
  useEffect(() => { toitModeRef.current = toitMode; }, [toitMode]);
  useEffect(() => { toitDraftRef.current = toitDraft; }, [toitDraft]);
  useEffect(() => { ouverturesRef.current = ouvertures; }, [ouvertures]);
  useEffect(() => { toitsRef.current = toits; }, [toits]);

  // ── Ancres (points d'accroche posés sur le scan) + poignées d'extrémité ──
  const [ancres, setAncres] = useState<Ancre[]>([]);
  const [ancreMode, setAncreMode] = useState(false);
  const ancreModeRef = useRef(false);
  const ancresRef = useRef<Ancre[]>([]);
  const ancreMeshMapRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const [ancreSel, setAncreSel] = useState<string | null>(null);
  // ── Palette contextuelle (pet palette façon ArchiCAD) ──
  // Clic simple (sans glisser) sur une poignée d'extrémité ou le corps d'un mur
  // sélectionné → mini-fenêtre d'outils près du curseur. Certains outils « arment »
  // une contrainte pour le prochain drag (dans l'axe, perpendiculaire).
  const [palette, setPalette] = useState<{
    kind: "node" | "edge"; murId: string; end?: "a" | "b";
    sx: number; sy: number; wp: { x: number; y: number; z: number };
  } | null>(null);
  const [armedOp, setArmedOp] = useState<"axe" | "perp" | null>(null);
  const armedOpRef = useRef<"axe" | "perp" | null>(null);
  useEffect(() => { armedOpRef.current = armedOp; }, [armedOp]);
  // Repère visuel d'accrochage (losange coloré par type de cible)
  const snapMarkerRef = useRef<THREE.Mesh | null>(null);
  const handleMeshesRef = useRef<THREE.Mesh[]>([]);
  const murRefLineRef = useRef<THREE.Line | null>(null);
  const [ouvSel, setOuvSel] = useState<string | null>(null);
  const ouvSelRef = useRef<string | null>(null);
  const ouvHandlesRef = useRef<THREE.Mesh[]>([]);
  useEffect(() => { ouvSelRef.current = ouvSel; }, [ouvSel]);
  useEffect(() => { ancreModeRef.current = ancreMode; }, [ancreMode]);
  useEffect(() => { ancresRef.current = ancres; }, [ancres]);

  // ── UI : accordéon (une catégorie ouverte à la fois) + sélection dalle/toit ──
  const [openCat, setOpenCat] = useState<string | null>("murs");
  const [dalleSel, setDalleSel] = useState<string | null>(null);
  const [toitSel, setToitSel] = useState<string | null>(null);
  const [panelPos, setPanelPos] = useState({ x: 300, y: 96 });
  // Transparence du scan : rend le mesh photogrammétrique translucide pour
  // atteindre les poignées d'édition (murs/toits/ouvertures) masquées par l'objet.
  const [scanOpacity, setScanOpacity] = useState(1);
  // sélectionner un mur (clic 3D ou liste) ouvre la section Murs
  useEffect(() => { if (murSel) setOpenCat("murs"); }, [murSel]);

  // Sélection mutuellement exclusive (un seul élément → une seule fenêtre flottante)
  const selMur = (id: string | null) => { setMurSel(id); setOuvSel(null); setDalleSel(null); setToitSel(null); };
  const selDalle = (id: string | null) => { setDalleSel(id); setMurSel(null); setToitSel(null); };
  const selToit = (id: string | null) => { setToitSel(id); setMurSel(null); setDalleSel(null); };
  const deselectAll = () => { setMurSel(null); setDalleSel(null); setToitSel(null); };

  // ── Mesures (10 dernières) + mise à niveau ──
  const [mesures, setMesures] = useState<Mesure[]>([]);
  const [mesureMode, setMesureMode] = useState(false);
  const [mesureDraft, setMesureDraft] = useState<THREE.Vector3 | null>(null);
  const [niveauMode, setNiveauMode] = useState(false);
  const [niveauDraft, setNiveauDraft] = useState<{ p: THREE.Vector3; scanId: string } | null>(null);
  const mesureModeRef = useRef(false);
  const mesureDraftRef = useRef<THREE.Vector3 | null>(null);
  const niveauModeRef = useRef(false);
  const niveauDraftRef = useRef<{ p: THREE.Vector3; scanId: string } | null>(null);
  const mesureMarkerRef = useRef<THREE.Mesh | null>(null);
  const niveauMarkerRef = useRef<THREE.Mesh | null>(null);
  const mesureGroupMapRef = useRef<Map<string, THREE.Group>>(new Map());
  useEffect(() => { mesureModeRef.current = mesureMode; }, [mesureMode]);
  useEffect(() => { mesureDraftRef.current = mesureDraft; }, [mesureDraft]);
  useEffect(() => { niveauModeRef.current = niveauMode; }, [niveauMode]);
  useEffect(() => { niveauDraftRef.current = niveauDraft; }, [niveauDraft]);

  useEffect(() => { murModeRef.current = murMode; }, [murMode]);
  useEffect(() => { murDraftRef.current = murDraft; }, [murDraft]);
  useEffect(() => { mursRef.current = murs; }, [murs]);
  useEffect(() => { murSelRef.current = murSel; }, [murSel]);
  useEffect(() => { murAlignRef.current = murAlign; }, [murAlign]);
  useEffect(() => { murBaseYRef.current = murBaseY; }, [murBaseY]);
  useEffect(() => { pipetteRef.current = pipette; }, [pipette]);
  useEffect(() => { murPendingRef.current = murPending; }, [murPending]);

  const [offsets, setOffsets] = useState<ScanOffset[]>(
    scans.map((s) => ({ id: s.id, x: s.offsetX, y: s.offsetY, z: s.offsetZ ?? 0,
                        angle: s.angle, tx: s.tiltX ?? 0, tz: s.tiltZ ?? 0 }))
  );
  const offsetsRef = useRef<ScanOffset[]>([]);
  useEffect(() => { offsetsRef.current = offsets; }, [offsets]);
  // Copie locale : permet de retirer une pièce supprimée sans recharger la page
  const [layers, setLayers] = useState<ScanLayer[]>(scans);
  const [selected, setSelected] = useState<string | null>(scans[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set(scans.map((s) => s.id)));

  // Applique la transparence courante à tous les meshes de scan. Re-tourne quand
  // un scan finit de charger (loadingIds) pour couvrir les meshes ajoutés après coup.
  useEffect(() => {
    const apply = (mat: THREE.Material) => {
      const m = mat as THREE.Material & { opacity: number; transparent: boolean; depthWrite: boolean };
      const base = (m.userData.baseOpacity as number | undefined) ?? m.opacity;
      m.userData.baseOpacity = base;
      m.opacity = base * scanOpacity;
      m.transparent = m.opacity < 0.999;
      // Translucide → ne pas écrire la profondeur : les poignées et la maquette BIM
      // situées derrière le mesh redeviennent visibles et cliquables.
      m.depthWrite = scanOpacity >= 0.999;
      m.needsUpdate = true;
    };
    for (const g of meshMapRef.current.values()) {
      g.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (Array.isArray(mesh.material)) mesh.material.forEach(apply);
        else apply(mesh.material);
      });
    }
  }, [scanOpacity, loadingIds]);

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
    (id: string) => offsets.find((o) => o.id === id) ?? { id, x: 0, y: 0, z: 0, angle: 0, tx: 0, tz: 0 },
    [offsets]
  );

  // Applique l'offset 3D à un mesh chargé : position + lacet, puis assiette
  // (mise à niveau) appliquée dans le repère monde
  function applyOffset(group: THREE.Group, off: ScanOffset) {
    group.position.set(off.x, off.z, off.y);
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (off.angle * Math.PI) / 180);
    const qt = new THREE.Quaternion().setFromEuler(new THREE.Euler(off.tx ?? 0, 0, off.tz ?? 0));
    group.quaternion.copy(qt).multiply(qy);
  }

  // Met à jour offset state + mesh 3D
  function updateOffset(id: string, key: "x" | "y" | "z" | "angle" | "tx" | "tz", val: number) {
    setOffsets((prev) => {
      const next = prev.map((o) => (o.id === id ? { ...o, [key]: val } : o));
      const updated = next.find((o) => o.id === id)!;
      const mesh = meshMapRef.current.get(id);
      if (mesh) applyOffset(mesh, updated);
      return next;
    });
    setSaved(false);
  }

  // ── Éléments BIM : chargement + CRUD ──
  useEffect(() => {
    if (!chantierId) return;
    db.from("bim_murs").select("*").eq("chantier_id", chantierId)
      .then(({ data }) => {
        if (!data) return;
        setMurs(data as Mur[]);
        const ids = (data as Mur[]).map((m) => m.id);
        if (ids.length)
          db.from("bim_ouvertures").select("*").in("mur_id", ids)
            .then(({ data: o }) => { if (o) setOuvertures(o as Ouverture[]); });
      });
    db.from("bim_dalles").select("*").eq("chantier_id", chantierId)
      .then(({ data }) => { if (data) setDalles(data as Dalle[]); });
    db.from("bim_toits").select("*").eq("chantier_id", chantierId)
      .then(({ data }) => { if (data) setToits(data as Toit[]); });
    db.from("bim_ancres").select("*").eq("chantier_id", chantierId)
      .then(({ data }) => { if (data) setAncres(data as Ancre[]); });
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
        mesh.userData.murId = m.id;
        murMeshMapRef.current.set(m.id, mesh);
        scene.add(mesh);
      }
      poserMurMesh(mesh, m, ouvertures.filter((o) => o.mur_id === m.id), toits);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const sel = m.id === murSel;
      mat.color.setHex(sel ? 0x2563eb : 0xf97316);
      mat.opacity = sel ? 0.75 : 0.55;
      mat.clippingPlanes = murMiterPlanes(m, murs);   // jonctions d'onglet
      mat.clipShadows = true;
    }
  }, [murs, murSel, ouvertures, toits]);

  // Synchronise les meshes de dalles et de toits
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const vivantes = new Set(dalles.map((d) => d.id));
    for (const [id, mesh] of dalleMeshMapRef.current) {
      if (!vivantes.has(id)) { scene.remove(mesh); mesh.geometry.dispose(); dalleMeshMapRef.current.delete(id); }
    }
    for (const d of dalles) {
      let mesh = dalleMeshMapRef.current.get(d.id);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.BufferGeometry(), bimMaterial(0x64748b));
        dalleMeshMapRef.current.set(d.id, mesh);
        scene.add(mesh);
      }
      mesh.geometry.dispose();
      mesh.geometry = dalleGeometry(d);
      mesh.position.set(0, d.base_y, 0);
    }
  }, [dalles]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const vivants = new Set(toits.map((t) => t.id));
    for (const [id, mesh] of toitMeshMapRef.current) {
      if (!vivants.has(id)) { scene.remove(mesh); mesh.geometry.dispose(); toitMeshMapRef.current.delete(id); }
    }
    for (const t of toits) {
      let mesh = toitMeshMapRef.current.get(t.id);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.BufferGeometry(), bimMaterial(0xb91c1c));
        toitMeshMapRef.current.set(t.id, mesh);
        scene.add(mesh);
      }
      mesh.geometry.dispose();
      mesh.geometry = toitGeometry(t); // géométrie en coordonnées monde
    }
  }, [toits]);

  // Marqueurs d'ancres (octaèdres magenta, toujours visibles). L'ancre sélectionnée
  // passe en cyan et grossit pour signaler qu'elle est saisissable/déplaçable.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const vivantes = new Set(ancres.map((a) => a.id));
    for (const [id, mesh] of ancreMeshMapRef.current) {
      if (!vivantes.has(id)) { scene.remove(mesh); mesh.geometry.dispose(); ancreMeshMapRef.current.delete(id); }
    }
    for (const a of ancres) {
      let mesh = ancreMeshMapRef.current.get(a.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.07),
          new THREE.MeshBasicMaterial({ color: 0xd946ef, depthTest: false })
        );
        mesh.renderOrder = 4;
        ancreMeshMapRef.current.set(a.id, mesh);
        scene.add(mesh);
      }
      const sel = a.id === ancreSel;
      mesh.userData = { ancreId: a.id, baseScale: sel ? 1.6 : 1 };
      mesh.position.set(a.x, a.y, a.z);
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(sel ? 0x06b6d4 : 0xd946ef);
    }
  }, [ancres, ancreSel]);

  // Poignées d'édition du mur sélectionné, façon ArchiCAD : ligne de référence au
  // pied (bleue), poignées d'extrémité jaunes, poignée de hauteur verte au sommet.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const h of handleMeshesRef.current) { scene.remove(h); h.geometry.dispose(); }
    handleMeshesRef.current = [];
    if (murRefLineRef.current) {
      scene.remove(murRefLineRef.current);
      murRefLineRef.current.geometry.dispose();
      murRefLineRef.current = null;
    }
    const m = murs.find((x) => x.id === murSel);
    if (!m) return;
    // Ligne de référence + poignées recentrées sur l'AXE DU CORPS du mur : si le mur
    // est tracé sur un nu (decalage ±0.5), la ligne brute tombe sur la face opposée
    // à celle qu'on regarde → on ajoute la normale × décalage pour coller au volume.
    const _dx = m.bx - m.ax, _dz = m.bz - m.az;
    const _len = Math.max(0.05, Math.hypot(_dx, _dz));
    const _off = (m.decalage ?? 0) * m.epaisseur;
    const _ox = (-_dz / _len) * _off, _oz = (_dx / _len) * _off;
    const A = new THREE.Vector3(m.ax + _ox, m.base_y, m.az + _oz);
    const B = new THREE.Vector3(m.bx + _ox, m.base_y, m.bz + _oz);
    const refLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([A, B]),
      new THREE.LineBasicMaterial({ color: 0x2563eb, depthTest: false })
    );
    refLine.renderOrder = 4;
    scene.add(refLine);
    murRefLineRef.current = refLine;
    // Poignées d'extrémité (jaunes) au pied de la ligne de référence
    for (const end of ["a", "b"] as const) {
      const h = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false })
      );
      h.renderOrder = 5;
      h.userData = { handleKind: end, murId: m.id };
      h.position.copy(end === "a" ? A : B);
      scene.add(h);
      handleMeshesRef.current.push(h);
    }
    // Poignée de hauteur (verte) au sommet, milieu de la ligne de référence
    const hh = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.16),
      new THREE.MeshBasicMaterial({ color: 0x10b981, depthTest: false })
    );
    hh.renderOrder = 5;
    hh.userData = { handleKind: "h", murId: m.id };
    hh.position.set((m.ax + m.bx) / 2 + _ox, m.base_y + m.hauteur, (m.az + m.bz) / 2 + _oz);
    scene.add(hh);
    handleMeshesRef.current.push(hh);
  }, [murSel, murs]);

  // Poignées de l'ouverture sélectionnée : déplacer (orange, angle inf. droit),
  // largeur (cyan, nu gauche), hauteur (verte, linteau) — sur la face du mur.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const h of ouvHandlesRef.current) { scene.remove(h); h.geometry.dispose(); }
    ouvHandlesRef.current = [];
    const o = ouvSel ? ouvertures.find((x) => x.id === ouvSel) : null;
    const m = o ? murs.find((x) => x.id === o.mur_id) : null;
    if (!o || !m || m.id !== murSel) return;
    const dx = m.bx - m.ax, dz = m.bz - m.az;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len, px = -uz, pz = ux;
    const off = (m.decalage ?? 0) * m.epaisseur;
    const P = (a: number, u: number) =>
      new THREE.Vector3(m.ax + ux * a + px * off, u, m.az + uz * a + pz * off);
    const defs = [
      { sub: "move", color: 0xf97316, p: P(o.pos + o.largeur / 2, m.base_y + o.allege) },
      { sub: "w", color: 0x06b6d4, p: P(o.pos - o.largeur / 2, m.base_y + o.allege + o.hauteur / 2) },
      { sub: "h", color: 0x10b981, p: P(o.pos, m.base_y + o.allege + o.hauteur) },
    ];
    for (const d of defs) {
      const h = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 14, 14),
        new THREE.MeshBasicMaterial({ color: d.color, depthTest: false })
      );
      h.renderOrder = 6;
      h.userData = { ouvHandle: d.sub, ouvId: o.id, murId: m.id };
      h.position.copy(d.p);
      scene.add(h);
      ouvHandlesRef.current.push(h);
    }
  }, [ouvSel, murSel, ouvertures, murs]);

  async function creerMur(a: THREE.Vector3, b: THREE.Vector3, decalage: number) {
    if (!chantierId) return;
    const row = { chantier_id: chantierId, ax: a.x, az: a.z, bx: b.x, bz: b.z,
                  epaisseur: 0.2, hauteur: 2.7, base_y: murBaseYRef.current, decalage };
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
    await db.from("bim_murs").delete().eq("id", id); // cascade sur bim_ouvertures
    setMurs((prev) => prev.filter((m) => m.id !== id));
    setOuvertures((prev) => prev.filter((o) => o.mur_id !== id));
    setMurSel((s) => (s === id ? null : s));
  }

  // Divise un mur au point (px,pz) projeté sur son axe → deux murs A→P et P→B ;
  // les ouvertures suivent le tronçon où elles se trouvent (pos recalée sur le 2e).
  async function diviserMur(m: Mur, px: number, pz: number) {
    if (!chantierId) return;
    const dx = m.bx - m.ax, dz = m.bz - m.az;
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-4) return;
    let t = ((px - m.ax) * dx + (pz - m.az) * dz) / l2;
    t = Math.min(0.95, Math.max(0.05, t));
    const cx = m.ax + t * dx, cz = m.az + t * dz;
    const cut = t * Math.sqrt(l2);
    const base = { chantier_id: chantierId, epaisseur: m.epaisseur, hauteur: m.hauteur,
                   base_y: m.base_y, decalage: m.decalage };
    const { data: m1, error: e1 } = await db.from("bim_murs")
      .insert({ ...base, ax: m.ax, az: m.az, bx: cx, bz: cz }).select("*").single();
    const { data: m2, error: e2 } = await db.from("bim_murs")
      .insert({ ...base, ax: cx, az: cz, bx: m.bx, bz: m.bz }).select("*").single();
    if (e1 || e2 || !m1 || !m2) { alert(`Division impossible : ${(e1 ?? e2)?.message}`); return; }
    const ouvs = ouverturesRef.current.filter((o) => o.mur_id === m.id);
    for (const o of ouvs) {
      if (o.pos <= cut) await db.from("bim_ouvertures").update({ mur_id: (m1 as Mur).id }).eq("id", o.id);
      else await db.from("bim_ouvertures").update({ mur_id: (m2 as Mur).id, pos: o.pos - cut }).eq("id", o.id);
    }
    await db.from("bim_murs").delete().eq("id", m.id);
    setMurs((prev) => [...prev.filter((x) => x.id !== m.id), m1 as Mur, m2 as Mur]);
    setOuvertures((prev) => prev.map((o) => o.mur_id !== m.id ? o
      : o.pos <= cut ? { ...o, mur_id: (m1 as Mur).id }
      : { ...o, mur_id: (m2 as Mur).id, pos: o.pos - cut }));
    setMurSel((m1 as Mur).id);
    setOuvSel(null);
  }

  // Perce une ouverture centrée sur un point du mur (réutilise la logique du mode
  // ouverture : clic = angle inférieur droit de la baie par défaut 1,00 × 1,15).
  function ouvertureAuPoint(m: Mur, wp: { x: number; y: number; z: number }) {
    const len = Math.hypot(m.bx - m.ax, m.bz - m.az);
    const LARG = 1.0, HAUT = 1.15;
    if (len < LARG + 0.06) { alert("Mur trop court pour une ouverture d'1 m."); return; }
    const along = ((wp.x - m.ax) * (m.bx - m.ax) + (wp.z - m.az) * (m.bz - m.az)) / len;
    let pos = along - LARG / 2;
    pos = Math.round(Math.min(Math.max(pos, LARG / 2 + 0.02), len - LARG / 2 - 0.02) * 100) / 100;
    let allege = wp.y - m.base_y;
    allege = Math.round(Math.min(Math.max(allege, 0), Math.max(0, m.hauteur - HAUT - 0.02)) * 100) / 100;
    creerOuverture(m.id, pos, allege);
  }

  // ── Ouvertures : CRUD ──
  async function creerOuverture(murId: string, pos: number, allege: number) {
    const row = { mur_id: murId, pos, largeur: 1.0, hauteur: 1.15, allege };
    const { data, error } = await db.from("bim_ouvertures").insert(row).select("*").single();
    if (error) { alert(`Ouverture non enregistrée : ${error.message}`); return; }
    setOuvertures((prev) => [...prev, data as Ouverture]);
    setOuvSel((data as Ouverture).id);
  }

  function majOuverture(id: string, patch: Partial<Ouverture>) {
    setOuvertures((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
    db.from("bim_ouvertures").update(patch).eq("id", id).then(({ error }) => {
      if (error) console.warn("[bim_ouvertures] update:", error.message);
    });
  }

  // Change la largeur en gardant fixe le nu droit (ancrage angle inférieur droit)
  function majOuvertureLargeur(o: Ouverture, largeur: number) {
    const droit = o.pos + o.largeur / 2;      // nu droit conservé
    majOuverture(o.id, { largeur, pos: droit - largeur / 2 });
  }

  async function supprimerOuverture(id: string) {
    await db.from("bim_ouvertures").delete().eq("id", id);
    setOuvertures((prev) => prev.filter((o) => o.id !== id));
    setOuvSel((s) => (s === id ? null : s));
  }

  // ── Dalles : CRUD + tracé polygonal ──
  async function creerDalle(pts: [number, number][]) {
    if (!chantierId) return;
    const row = { chantier_id: chantierId, points: pts, epaisseur: 0.2, base_y: murBaseYRef.current };
    const { data, error } = await db.from("bim_dalles").insert(row).select("*").single();
    if (error) { alert(`Dalle non enregistrée : ${error.message}`); return; }
    setDalles((prev) => [...prev, data as Dalle]);
  }

  function majDalle(id: string, patch: Partial<Dalle>) {
    setDalles((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    db.from("bim_dalles").update(patch).eq("id", id).then(({ error }) => {
      if (error) console.warn("[bim_dalles] update:", error.message);
    });
  }

  async function supprimerDalle(id: string) {
    await db.from("bim_dalles").delete().eq("id", id);
    setDalles((prev) => prev.filter((d) => d.id !== id));
    setDalleSel((s) => (s === id ? null : s));
  }

  function majDalleLigne(draft: THREE.Vector3[]) {
    const scene = sceneRef.current;
    if (!scene) return;
    if (dalleLineRef.current) {
      scene.remove(dalleLineRef.current);
      dalleLineRef.current.geometry.dispose();
      dalleLineRef.current = null;
    }
    if (draft.length >= 2) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(draft),
        new THREE.LineBasicMaterial({ color: 0x64748b, depthTest: false })
      );
      line.renderOrder = 3;
      scene.add(line);
      dalleLineRef.current = line;
    }
  }

  function annulerDalleDraft() {
    setDalleDraft([]);
    const scene = sceneRef.current;
    for (const m of dalleMarkersRef.current) {
      if (scene) scene.remove(m);
      m.geometry.dispose();
    }
    dalleMarkersRef.current = [];
    majDalleLigne([]);
  }

  function finirDalle() {
    const draft = dalleDraftRef.current;
    if (draft.length >= 3) {
      creerDalle(draft.map((v) => [Math.round(v.x * 100) / 100, Math.round(v.z * 100) / 100]));
    }
    annulerDalleDraft();
    setDalleMode(false);
  }

  function poserPointDalle(p: THREE.Vector3) {
    const draft = dalleDraftRef.current;
    // re-clic près du 1er sommet (≥ 3 points) → fermeture du polygone
    if (draft.length >= 3 && Math.hypot(p.x - draft[0].x, p.z - draft[0].z) < 0.3) {
      finirDalle();
      return;
    }
    const next = [...draft, p.clone()];
    setDalleDraft(next);
    const marker = creerMarqueur(p, 0x64748b, 0.04);
    if (marker) dalleMarkersRef.current.push(marker);
    majDalleLigne(next);
  }

  // ── Toits : CRUD + tracé 3 clics ──
  async function creerToit(pts: THREE.Vector3[]) {
    if (!chantierId) return;
    const r = (v: THREE.Vector3): [number, number, number] =>
      [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100];
    const row = { chantier_id: chantierId, p1: r(pts[0]), p2: r(pts[1]), p3: r(pts[2]), epaisseur: 0.2 };
    const { data, error } = await db.from("bim_toits").insert(row).select("*").single();
    if (error) { alert(`Toit non enregistré : ${error.message}`); return; }
    setToits((prev) => [...prev, data as Toit]);
  }

  function majToit(id: string, patch: Partial<Toit>) {
    setToits((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    db.from("bim_toits").update(patch).eq("id", id).then(({ error }) => {
      if (error) console.warn("[bim_toits] update:", error.message);
    });
  }

  async function supprimerToit(id: string) {
    await db.from("bim_toits").delete().eq("id", id);
    setToits((prev) => prev.filter((t) => t.id !== id));
    setToitSel((s) => (s === id ? null : s));
  }

  function annulerToitDraft() {
    setToitDraft([]);
    const scene = sceneRef.current;
    for (const m of toitMarkersRef.current) {
      if (scene) scene.remove(m);
      m.geometry.dispose();
    }
    toitMarkersRef.current = [];
  }

  function poserPointToit(p: THREE.Vector3) {
    const next = [...toitDraftRef.current, p.clone()];
    if (next.length >= 3) {
      creerToit(next);
      annulerToitDraft();
      setToitMode(false);
      return;
    }
    setToitDraft(next);
    const marker = creerMarqueur(p, 0xb91c1c, 0.04);
    if (marker) toitMarkersRef.current.push(marker);
  }

  // ── Ancres : CRUD ──
  async function creerAncre(p: THREE.Vector3) {
    if (!chantierId) return;
    const row = { chantier_id: chantierId, x: p.x, y: p.y, z: p.z };
    const { data, error } = await db.from("bim_ancres").insert(row).select("*").single();
    if (error) { alert(`Ancre non enregistrée : ${error.message}`); return; }
    setAncres((prev) => [...prev, data as Ancre]);
  }

  async function supprimerAncre(id: string) {
    await db.from("bim_ancres").delete().eq("id", id);
    setAncres((prev) => prev.filter((a) => a.id !== id));
    setAncreSel((prev) => (prev === id ? null : prev));
  }

  async function majAncre(id: string, x: number, y: number, z: number) {
    setAncres((prev) => prev.map((a) => (a.id === id ? { ...a, x, y, z } : a)));
    const { error } = await db.from("bim_ancres").update({ x, y, z }).eq("id", id);
    if (error) alert(`Ancre non mise à jour : ${error.message}`);
  }

  // Accrochage planimétrique (x,z) d'un point d'extrémité de mur en cours d'édition :
  // ancres → extrémités d'autres murs → projection sur segment d'un autre mur (jonction T)
  type SnapType = "ancre" | "sommet" | "milieu" | "arete" | "scan";
  function snapXZ(x: number, z: number, excludeId: string): { x: number; z: number; snap: boolean; type?: SnapType } {
    let bx = x, bz = z, snap = false;
    let type: SnapType | undefined;
    let bd = 0.3;
    for (const a of ancresRef.current) {
      const d = Math.hypot(x - a.x, z - a.z);
      if (d < bd) { bd = d; bx = a.x; bz = a.z; snap = true; type = "ancre"; }
    }
    for (const m of mursRef.current) {
      if (m.id === excludeId) continue;
      for (const [ex, ez] of [[m.ax, m.az], [m.bx, m.bz]] as const) {
        const d = Math.hypot(x - ex, z - ez);
        if (d < bd) { bd = d; bx = ex; bz = ez; snap = true; type = "sommet"; }
      }
      // milieu du segment (comme les points chauds ArchiCAD)
      const mx = (m.ax + m.bx) / 2, mz = (m.az + m.bz) / 2;
      const dm = Math.hypot(x - mx, z - mz);
      if (dm < bd) { bd = dm; bx = mx; bz = mz; snap = true; type = "milieu"; }
    }
    if (snap) return { x: bx, z: bz, snap, type };
    // aucune extrémité proche : projeter sur le segment d'un autre mur (jonction en T)
    let bt = 0.2;
    for (const m of mursRef.current) {
      if (m.id === excludeId) continue;
      const dx = m.bx - m.ax, dz = m.bz - m.az;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-6) continue;
      let t = ((x - m.ax) * dx + (z - m.az) * dz) / l2;
      t = Math.min(1, Math.max(0, t));
      const px = m.ax + t * dx, pz = m.az + t * dz;
      const d = Math.hypot(x - px, z - pz);
      if (d < bt) { bt = d; bx = px; bz = pz; snap = true; type = "arete"; }
    }
    return { x: bx, z: bz, snap, type };
  }

  // Accrochage au sommet du triangle touché uniquement (sans les murs) — utilisé
  // pendant le drag d'une poignée pour ne pas coller à l'extrémité d'origine
  function meshVertexSnap(hit: THREE.Intersection): THREE.Vector3 {
    let p = hit.point.clone();
    for (const a of ancresRef.current) {
      if (new THREE.Vector3(a.x, a.y, a.z).distanceTo(hit.point) < 0.3)
        return new THREE.Vector3(a.x, a.y, a.z);
    }
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
    return p;
  }

  // Accrochage : sommet du triangle touché (niv. 2) puis extrémités de murs (niv. 4)
  function snapPickInfo(hit: THREE.Intersection): { p: THREE.Vector3; type?: SnapType } {
    let p = hit.point.clone();
    let type: SnapType | undefined;
    // Ancres : points d'accroche délibérés → priorité absolue (dans un rayon de 30 cm)
    for (const a of ancresRef.current) {
      if (new THREE.Vector3(a.x, a.y, a.z).distanceTo(hit.point) < 0.3)
        return { p: new THREE.Vector3(a.x, a.y, a.z), type: "ancre" };
    }
    const mesh = hit.object as THREE.Mesh;
    if (mesh.isMesh && hit.face) {
      const pos = (mesh.geometry as THREE.BufferGeometry).attributes.position;
      let bd = 0.15;
      for (const idx of [hit.face.a, hit.face.b, hit.face.c]) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, idx).applyMatrix4(mesh.matrixWorld);
        const d = v.distanceTo(hit.point);
        if (d < bd) { bd = d; p = v; type = "scan"; }
      }
    }
    let bw = 0.25;
    for (const m of mursRef.current) {
      for (const [ex, ez] of [[m.ax, m.az], [m.bx, m.bz]] as const) {
        const d = Math.hypot(p.x - ex, p.z - ez);
        if (d < bw) { bw = d; p = new THREE.Vector3(ex, p.y, ez); type = "sommet"; }
      }
    }
    return { p, type };
  }

  function snapPick(hit: THREE.Intersection): THREE.Vector3 {
    return snapPickInfo(hit).p;
  }

  // Repère d'accrochage : losange filaire coloré selon le type de cible
  const SNAP_COLORS: Record<SnapType, number> = {
    ancre: 0xd946ef, sommet: 0xfacc15, milieu: 0xf97316, arete: 0x2563eb, scan: 0x10b981,
  };
  function setSnapMarker(p: THREE.Vector3 | null, type?: SnapType) {
    const scene = sceneRef.current;
    if (!scene) return;
    if (!p || !type) { if (snapMarkerRef.current) snapMarkerRef.current.visible = false; return; }
    let mk = snapMarkerRef.current;
    if (!mk) {
      mk = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.1),
        new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false, wireframe: true })
      );
      mk.renderOrder = 7;
      snapMarkerRef.current = mk;
      scene.add(mk);
    }
    (mk.material as THREE.MeshBasicMaterial).color.setHex(SNAP_COLORS[type]);
    mk.position.copy(p);
    mk.visible = true;
  }

  // ── Outils Mesure + Mise à niveau ──

  function creerMarqueur(p: THREE.Vector3, color: number, r = 0.05) {
    const scene = sceneRef.current;
    if (!scene) return null;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 16),
      new THREE.MeshBasicMaterial({ color, depthTest: false })
    );
    m.renderOrder = 3;
    m.position.copy(p);
    scene.add(m);
    return m;
  }

  function retirerMarqueurRef(ref: { current: THREE.Mesh | null }) {
    if (ref.current && sceneRef.current) {
      sceneRef.current.remove(ref.current);
      ref.current.geometry.dispose();
      ref.current = null;
    }
  }

  function annulerMesureDraft() {
    setMesureDraft(null);
    retirerMarqueurRef(mesureMarkerRef);
  }

  function annulerNiveauDraft() {
    setNiveauDraft(null);
    retirerMarqueurRef(niveauMarkerRef);
  }

  function poserPointMesure(p: THREE.Vector3) {
    const draft = mesureDraftRef.current;
    if (!draft) {
      setMesureDraft(p);
      mesureMarkerRef.current = creerMarqueur(p, 0x2563eb, 0.035);
      return;
    }
    const d = draft.distanceTo(p);
    if (d > 0.01) {
      const m: Mesure = { id: crypto.randomUUID(),
        ax: draft.x, ay: draft.y, az: draft.z, bx: p.x, by: p.y, bz: p.z, d };
      setMesures((prev) => [...prev, m].slice(-10));
    }
    annulerMesureDraft();
    // le mode reste actif : on peut enchaîner les mesures (Échap pour sortir)
  }

  // Retrouve la pièce (scan) à laquelle appartient l'objet touché par le raycast
  function scanIdFromObject(obj: THREE.Object3D): string | null {
    for (const [id, g] of meshMapRef.current) {
      let o: THREE.Object3D | null = obj;
      while (o) { if (o === g) return id; o = o.parent; }
    }
    return null;
  }

  // Mise à niveau : les 2 points cliqués sont censés être à la même altitude →
  // rotation du scan (autour du milieu du segment) qui rend le segment horizontal
  function appliquerNiveau(scanId: string, p1: THREE.Vector3, p2: THREE.Vector3) {
    const d = new THREE.Vector3().subVectors(p2, p1);
    if (Math.hypot(d.x, d.z) < 0.2) {
      alert("Segment trop court ou trop vertical pour caler le niveau — cliquez 2 points éloignés d'une même ligne horizontale.");
      return;
    }
    const off = offsetsRef.current.find((o) => o.id === scanId);
    if (!off) return;
    const dh = new THREE.Vector3(d.x, 0, d.z).normalize();
    const qd = new THREE.Quaternion().setFromUnitVectors(d.clone().normalize(), dh);
    // pivot : milieu du segment cliqué (il ne bouge pas)
    const c = p1.clone().add(p2).multiplyScalar(0.5);
    const P = new THREE.Vector3(off.x, off.z, off.y);
    const Pn = c.clone().add(P.clone().sub(c).applyQuaternion(qd));
    // nouvelle assiette = correction ∘ assiette courante (le lacet ne change pas)
    const qt = new THREE.Quaternion().setFromEuler(new THREE.Euler(off.tx ?? 0, 0, off.tz ?? 0));
    const e = new THREE.Euler().setFromQuaternion(qd.multiply(qt), "XYZ");
    setOffsets((prev) => {
      const next = prev.map((o) => o.id === scanId
        ? { ...o, x: Pn.x, y: Pn.z, z: Pn.y, tx: e.x, tz: e.z }
        : o);
      const g = meshMapRef.current.get(scanId);
      const u = next.find((o) => o.id === scanId);
      if (g && u) applyOffset(g, u);
      return next;
    });
    setSaved(false);
  }

  // Un seul outil actif à la fois
  function activerMode(mode: "mur" | "mesure" | "niveau" | "pipette" | "ouverture" | "dalle" | "toit" | "ancre" | null) {
    annulerDraft();
    annulerMesureDraft();
    annulerNiveauDraft();
    annulerDalleDraft();
    annulerToitDraft();
    setMurMode(mode === "mur");
    setMesureMode(mode === "mesure");
    setNiveauMode(mode === "niveau");
    setPipette(mode === "pipette");
    setOuvMode(mode === "ouverture");
    setDalleMode(mode === "dalle");
    setToitMode(mode === "toit");
    setAncreMode(mode === "ancre");
  }

  function poserPointMur(p: THREE.Vector3) {
    const scene = sceneRef.current;
    const pending = murPendingRef.current;
    if (pending) {
      // 3e clic : de quel côté du nu tracé se trouve le corps du mur
      const dx = pending.b.x - pending.a.x, dz = pending.b.z - pending.a.z;
      const cross = dx * (p.z - pending.a.z) - dz * (p.x - pending.a.x);
      creerMur(pending.a, pending.b, cross > 0 ? 0.5 : -0.5);
      annulerDraft();
      return;
    }
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
    if (draft.distanceTo(p) > 0.05) {
      if (murAlignRef.current === "face") {
        // La ligne tracée est un nu : lame fine en aperçu, en attente du clic de côté
        setMurPending({ a: draft.clone(), b: p.clone() });
        if (scene) {
          const prev = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), murMaterial());
          poserMurMesh(prev, { id: "", ax: draft.x, az: draft.z, bx: p.x, bz: p.z,
            epaisseur: 0.04, hauteur: 2.7, base_y: murBaseYRef.current, decalage: 0 }, [], []);
          scene.add(prev);
          pendingMeshRef.current = prev;
        }
        retirerMarqueur();
        setMurDraft(null);
        return;
      }
      creerMur(draft, p, 0);
    }
    annulerDraft();
  }

  function retirerMarqueur() {
    if (draftMarkerRef.current && sceneRef.current) {
      sceneRef.current.remove(draftMarkerRef.current);
      draftMarkerRef.current.geometry.dispose();
      draftMarkerRef.current = null;
    }
  }

  function annulerDraft() {
    setMurDraft(null);
    setMurPending(null);
    retirerMarqueur();
    if (pendingMeshRef.current && sceneRef.current) {
      sceneRef.current.remove(pendingMeshRef.current);
      pendingMeshRef.current.geometry.dispose();
      pendingMeshRef.current = null;
    }
  }

  // Synchronise les visuels de mesures (2 sphères + ligne + étiquette) avec l'état
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const vivantes = new Set(mesures.map((m) => m.id));
    for (const [id, g] of mesureGroupMapRef.current) {
      if (!vivantes.has(id)) {
        scene.remove(g);
        g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
        });
        mesureGroupMapRef.current.delete(id);
      }
    }
    for (const m of mesures) {
      if (mesureGroupMapRef.current.has(m.id)) continue;
      const g = new THREE.Group();
      const a = new THREE.Vector3(m.ax, m.ay, m.az);
      const b = new THREE.Vector3(m.bx, m.by, m.bz);
      for (const p of [a, b]) {
        const s = new THREE.Mesh(
          new THREE.SphereGeometry(0.03, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0x2563eb, depthTest: false })
        );
        s.renderOrder = 3;
        s.position.copy(p);
        g.add(s);
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0x2563eb, depthTest: false })
      );
      line.renderOrder = 3;
      g.add(line);
      const lbl = etiquetteMesure(`${m.d.toFixed(2)} m`);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      lbl.position.set(mid.x, mid.y + 0.12, mid.z);
      g.add(lbl);
      scene.add(g);
      mesureGroupMapRef.current.set(m.id, g);
    }
  }, [mesures]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { activerMode(null); setMurSel(null); setOuvSel(null); setDalleSel(null); setToitSel(null); setAncreSel(null); setPalette(null); setArmedOp(null); }
      if (e.key === "Enter" && dalleModeRef.current && dalleDraftRef.current.length >= 3) finirDalle();
    };
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
    renderer.localClippingEnabled = true;   // coupes d'onglet des murs (miter)
    container.appendChild(renderer.domElement);

    cameraRef.current = camera;
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;  // 0.05 rendait zoom/orbite très mous
    controls.zoomSpeed = 1.6;
    controls.zoomToCursor = true;   // zoom centré sur le curseur
    controlsRef.current = controls;

    // Mémorise le cadrage de la vue par chantier (retrouvé au retour sur l'app)
    const viewKey = chantierId ? `pis-cam-${chantierId}` : null;
    const saveView = () => {
      if (!viewKey) return;
      const c = camera.position, t = controls.target;
      try {
        localStorage.setItem(viewKey, JSON.stringify([c.x, c.y, c.z, t.x, t.y, t.z]));
      } catch { /* quota / mode privé */ }
    };
    controls.addEventListener("end", saveView);

    // Interactions murs : tracé (clics), pipette niveau 0, sélection + déplacement (drag)
    const makeRay = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, camera);
      return ray;
    };
    // Picking « écran » pour les petites cibles (poignées, ancres) : au lieu d'exiger
    // que le rayon 3D touche la géométrie (quelques px à l'écran, quasi imprenable),
    // on projette chaque cible et on prend la plus proche du clic dans un rayon en px.
    const pickScreen = (e: PointerEvent, objs: THREE.Object3D[], tolPx = 18): THREE.Object3D | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      let best: THREE.Object3D | null = null;
      let bd = tolPx;
      for (const o of objs) {
        const v = o.position.clone().project(camera);
        if (v.z < -1 || v.z > 1) continue;   // hors du frustum (derrière la caméra…)
        const sx = rect.left + ((v.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - v.y) / 2) * rect.height;
        const d = Math.hypot(e.clientX - sx, e.clientY - sy);
        if (d < bd) { bd = d; best = o; }
      }
      return best;
    };
    let downPos: { x: number; y: number } | null = null;
    type WallDrag =
      | { kind: "move"; id: string; orig: Mur; start: THREE.Vector3; base: THREE.Vector3;
          plane: THREE.Plane; dx: number; dz: number; moved: boolean; op?: "perp" | null }
      | { kind: "end"; id: string; orig: Mur; end: "a" | "b"; hy: number;
          curX: number; curZ: number; moved: boolean; op?: "axe" | null }
      | { kind: "height"; id: string; orig: Mur; plane: THREE.Plane; curH: number; moved: boolean }
      | { kind: "ouv"; id: string; mur: Mur; sub: "move" | "w" | "h"; plane: THREE.Plane;
          cur: { pos: number; allege: number; largeur: number; hauteur: number }; moved: boolean }
      | { kind: "ancre"; id: string; y0: number; cur: THREE.Vector3; moved: boolean };
    let drag: WallDrag | null = null;
    const rnd = (v: number) => Math.round(v * 100) / 100;

    const onDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
      setPalette(null);   // tout nouveau clic dans la vue ferme la palette
      // Édition : drag d'une poignée ou déplacement du mur sélectionné (hors modes outils)
      if (murModeRef.current || pipetteRef.current || mesureModeRef.current
          || niveauModeRef.current || ouvModeRef.current || dalleModeRef.current
          || toitModeRef.current || ancreModeRef.current || e.button !== 0) return;
      const selId = murSelRef.current;
      const mur = selId ? (mursRef.current.find((m) => m.id === selId) ?? null) : null;
      // Poignées du mur sélectionné (prioritaires sur tout le reste)
      if (mur) {
        // 0) poignée d'ouverture (prioritaire quand une baie est sélectionnée)
        if (ouvSelRef.current && ouvHandlesRef.current.length) {
          const oHit = pickScreen(e, ouvHandlesRef.current);
          if (oHit) {
            const sub = oHit.userData.ouvHandle as "move" | "w" | "h";
            const oId = oHit.userData.ouvId as string;
            const o = ouverturesRef.current.find((x) => x.id === oId);
            if (o) {
              const dx = mur.bx - mur.ax, dz = mur.bz - mur.az;
              const len = Math.hypot(dx, dz) || 1;
              const px = -dz / len, pz = dx / len, off = (mur.decalage ?? 0) * mur.epaisseur;
              const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
                new THREE.Vector3(px, 0, pz),
                new THREE.Vector3(mur.ax + px * off, 0, mur.az + pz * off));
              drag = { kind: "ouv", id: oId, mur: { ...mur }, sub, plane,
                       cur: { pos: o.pos, allege: o.allege, largeur: o.largeur, hauteur: o.hauteur }, moved: false };
              controls.enabled = false;
              return;
            }
          }
        }
        // 1) poignée prioritaire (extrémité jaune ou hauteur verte)
        const hHit = pickScreen(e, handleMeshesRef.current);
        if (hHit) {
          const kind = hHit.userData.handleKind as "a" | "b" | "h";
          if (kind === "h") {
            // plan vertical passant par la poignée, face à la caméra → drag en hauteur
            const p0 = hHit.position.clone();
            const nrm = camera.position.clone().sub(p0); nrm.y = 0;
            if (nrm.lengthSq() < 1e-6) nrm.set(0, 0, 1);
            nrm.normalize();
            drag = { kind: "height", id: mur.id, orig: { ...mur },
                     plane: new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, p0),
                     curH: mur.hauteur, moved: false };
          } else {
            drag = { kind: "end", id: mur.id, orig: { ...mur }, end: kind, hy: hHit.position.y,
                     curX: kind === "a" ? mur.ax : mur.bx, curZ: kind === "a" ? mur.az : mur.bz,
                     moved: false, op: armedOpRef.current === "axe" ? "axe" : null };
            setArmedOp(null);
          }
          controls.enabled = false;
          return;
        }
      }
      // 2) ancre : sélection + déplacement (indépendant de la sélection de mur)
      const aHit = pickScreen(e, [...ancreMeshMapRef.current.values()]);
      if (aHit) {
        const aId = aHit.userData.ancreId as string;
        const a = ancresRef.current.find((x) => x.id === aId);
        if (a) {
          setAncreSel(aId);
          drag = { kind: "ancre", id: aId, y0: a.y, cur: new THREE.Vector3(a.x, a.y, a.z), moved: false };
          controls.enabled = false;
          return;
        }
      }
      // 3) déplacement du corps du mur sélectionné
      if (!mur) return;
      const mesh = murMeshMapRef.current.get(mur.id);
      if (!mesh) return;
      const hit = makeRay(e).intersectObject(mesh)[0];
      if (!hit) return;
      drag = {
        kind: "move", id: mur.id, orig: { ...mur }, start: hit.point.clone(), base: mesh.position.clone(),
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y),
        dx: 0, dz: 0, moved: false, op: armedOpRef.current === "perp" ? "perp" : null,
      };
      setArmedOp(null);
      controls.enabled = false;
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) {
        // Survol en mode tracé (mur/dalle/toit/ancre) : afficher le repère d'accroche
        if (murModeRef.current || dalleModeRef.current || toitModeRef.current || ancreModeRef.current) {
          const hov = makeRay(e).intersectObjects([...meshMapRef.current.values()], true)[0];
          if (hov) { const info = snapPickInfo(hov); setSnapMarker(info.type ? info.p : null, info.type); }
          else setSnapMarker(null);
        } else if (!pipetteRef.current && !mesureModeRef.current && !niveauModeRef.current
                   && !ouvModeRef.current) {
          // Hors mode outil : curseur « main » au survol d'une cible saisissable
          // (poignées du mur/de la baie sélectionnés, ancres) — feedback indispensable
          // pour savoir qu'on peut attraper avant de cliquer.
          const grabbables = [
            ...(murSelRef.current ? handleMeshesRef.current : []),
            ...(ouvSelRef.current ? ouvHandlesRef.current : []),
            ...ancreMeshMapRef.current.values(),
          ];
          renderer.domElement.style.cursor = pickScreen(e, grabbables) ? "grab" : "";
        }
        return;
      }
      if (drag.moved) renderer.domElement.style.cursor = "grabbing";
      // Anti-jitter : tant que le pointeur n'a pas bougé d'au moins 4 px écran,
      // on reste en « clic simple » (Chrome émet parfois un pointermove immobile
      // entre down et up, ce qui volait le clic → la palette ne s'ouvrait jamais).
      if (!drag.moved && downPos
          && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) < 4) return;
      const ray = makeRay(e);
      if (drag.kind === "ancre") {
        const ad = drag;
        // L'ancre suit la surface du scan sous le curseur ; hors scan, on la garde
        // sur le plan horizontal de son altitude d'origine.
        const hit = ray.intersectObjects([...meshMapRef.current.values()], true)[0];
        const np = new THREE.Vector3();
        if (hit) np.copy(hit.point);
        else if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -ad.y0), np)) return;
        if (!ad.moved && np.distanceTo(ad.cur) < 0.01) return;
        ad.moved = true;
        ad.cur.copy(np);
        const mesh = ancreMeshMapRef.current.get(ad.id);
        if (mesh) mesh.position.copy(np);
        return;
      }
      if (drag.kind === "move") {
        const p = new THREE.Vector3();
        if (!ray.ray.intersectPlane(drag.plane, p)) return;
        drag.dx = p.x - drag.start.x;
        drag.dz = p.z - drag.start.z;
        if (drag.op === "perp") {
          // Contrainte perpendiculaire : ne garder que la composante normale au mur
          const wx = drag.orig.bx - drag.orig.ax, wz = drag.orig.bz - drag.orig.az;
          const wl = Math.hypot(wx, wz) || 1;
          const nx = -wz / wl, nz = wx / wl;
          const dot = drag.dx * nx + drag.dz * nz;
          drag.dx = nx * dot; drag.dz = nz * dot;
        }
        if (!drag.moved && Math.hypot(drag.dx, drag.dz) < 0.01) return;
        drag.moved = true;
        const mesh = murMeshMapRef.current.get(drag.id);
        if (mesh) mesh.position.set(drag.base.x + drag.dx, drag.base.y, drag.base.z + drag.dz);
        return;
      }
      if (drag.kind === "height") {
        const hd = drag;
        const p = new THREE.Vector3();
        if (!ray.ray.intersectPlane(hd.plane, p)) return;
        const newH = Math.min(12, Math.max(0.3, p.y - hd.orig.base_y));
        hd.curH = Math.round(newH * 100) / 100;
        hd.moved = true;
        const tmp: Mur = { ...hd.orig, hauteur: hd.curH };
        const mesh = murMeshMapRef.current.get(hd.id);
        if (mesh) poserMurMesh(mesh, tmp,
          ouverturesRef.current.filter((o) => o.mur_id === hd.id), toitsRef.current);
        const top = handleMeshesRef.current.find((hh) => hh.userData.handleKind === "h");
        if (top) top.position.y = hd.orig.base_y + hd.curH;
        return;
      }
      if (drag.kind === "ouv") {
        const od = drag;
        const p = new THREE.Vector3();
        if (!ray.ray.intersectPlane(od.plane, p)) return;
        const m = od.mur;
        const dx = m.bx - m.ax, dz = m.bz - m.az;
        const len = Math.hypot(dx, dz) || 1;
        const ux = dx / len, uz = dz / len, px = -uz, pz = ux;
        const off = (m.decalage ?? 0) * m.epaisseur;
        const along = (p.x - m.ax) * ux + (p.z - m.az) * uz;
        const up = p.y;
        const c = od.cur;
        if (od.sub === "move") {
          c.pos = rnd(Math.min(Math.max(along - c.largeur / 2, c.largeur / 2 + 0.02), len - c.largeur / 2 - 0.02));
          c.allege = rnd(Math.min(Math.max(up - m.base_y, 0), Math.max(0, m.hauteur - c.hauteur - 0.02)));
        } else if (od.sub === "w") {
          const right = c.pos + c.largeur / 2;
          let largeur = Math.max(0.2, right - along);
          largeur = Math.min(largeur, right - 0.02);            // nu gauche ≥ 2 cm du bord A
          c.largeur = rnd(largeur);
          c.pos = rnd(right - c.largeur / 2);
        } else {
          c.hauteur = rnd(Math.min(Math.max(up - (m.base_y + c.allege), 0.2), m.hauteur - c.allege - 0.02));
        }
        od.moved = true;
        const mesh = murMeshMapRef.current.get(m.id);
        const baies = ouverturesRef.current.filter((o) => o.mur_id === m.id)
          .map((o) => (o.id === od.id ? { ...o, ...c } : o));
        if (mesh) poserMurMesh(mesh, m, baies, toitsRef.current);
        const P = (a: number, u: number): [number, number, number] =>
          [m.ax + ux * a + px * off, u, m.az + uz * a + pz * off];
        for (const h of ouvHandlesRef.current) {
          const s = h.userData.ouvHandle as string;
          const pt = s === "move" ? P(c.pos + c.largeur / 2, m.base_y + c.allege)
            : s === "w" ? P(c.pos - c.largeur / 2, m.base_y + c.allege + c.hauteur / 2)
            : P(c.pos, m.base_y + c.allege + c.hauteur);
          h.position.set(pt[0], pt[1], pt[2]);
        }
        return;
      }
      // Extrémité : suit la surface du scan (accrochée) ou le plan horizontal de la poignée
      const ed = drag;
      let x: number, z: number;
      const hit = ray.intersectObjects([...meshMapRef.current.values()], true)[0];
      if (hit) { const sp = meshVertexSnap(hit); x = sp.x; z = sp.z; }
      else {
        const gp = new THREE.Vector3();
        if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -ed.hy), gp)) return;
        x = gp.x; z = gp.z;
      }
      let s = snapXZ(x, z, ed.id);
      if (ed.op === "axe") {
        // Contrainte « dans l'axe » : projeter sur la droite d'origine du mur
        const ax0 = ed.orig.ax, az0 = ed.orig.az;
        const ddx = ed.orig.bx - ax0, ddz = ed.orig.bz - az0;
        const l2 = ddx * ddx + ddz * ddz;
        if (l2 > 1e-6) {
          const t = ((s.x - ax0) * ddx + (s.z - az0) * ddz) / l2;
          s = { x: ax0 + t * ddx, z: az0 + t * ddz, snap: s.snap, type: s.type };
        }
      }
      setSnapMarker(s.snap ? new THREE.Vector3(s.x, ed.hy, s.z) : null, s.type);
      ed.curX = s.x; ed.curZ = s.z; ed.moved = true;
      const tmp: Mur = { ...ed.orig,
        ...(ed.end === "a" ? { ax: s.x, az: s.z } : { bx: s.x, bz: s.z }) };
      const mesh = murMeshMapRef.current.get(ed.id);
      if (mesh) poserMurMesh(mesh, tmp,
        ouverturesRef.current.filter((o) => o.mur_id === ed.id), toitsRef.current);
      const h = handleMeshesRef.current.find((hh) => hh.userData.handleKind === ed.end);
      if (h) h.position.set(s.x, ed.hy, s.z);
      if (murRefLineRef.current) {
        const A = ed.end === "a" ? new THREE.Vector3(s.x, ed.orig.base_y, s.z)
                                 : new THREE.Vector3(ed.orig.ax, ed.orig.base_y, ed.orig.az);
        const B = ed.end === "b" ? new THREE.Vector3(s.x, ed.orig.base_y, s.z)
                                 : new THREE.Vector3(ed.orig.bx, ed.orig.base_y, ed.orig.bz);
        murRefLineRef.current.geometry.setFromPoints([A, B]);
      }
    };

    const onUp = (e: PointerEvent) => {
      setSnapMarker(null);
      renderer.domElement.style.cursor = "";
      if (drag) {
        controls.enabled = true;
        const d = drag;
        drag = null;
        downPos = null;
        if (!d.moved) {
          // Clic simple (sans glisser) sur une poignée d'extrémité ou le corps du
          // mur sélectionné → palette contextuelle d'outils près du curseur.
          const rect = renderer.domElement.getBoundingClientRect();
          if (d.kind === "end") {
            setPalette({ kind: "node", murId: d.id, end: d.end,
              sx: e.clientX - rect.left, sy: e.clientY - rect.top,
              wp: { x: d.curX, y: d.hy, z: d.curZ } });
          } else if (d.kind === "move") {
            setPalette({ kind: "edge", murId: d.id,
              sx: e.clientX - rect.left, sy: e.clientY - rect.top,
              wp: { x: d.start.x, y: d.start.y, z: d.start.z } });
          }
          return;
        }
        if (d.kind === "end") {
          majMur(d.id, d.end === "a" ? { ax: d.curX, az: d.curZ } : { bx: d.curX, bz: d.curZ });
          return;
        }
        if (d.kind === "height") {
          majMur(d.id, { hauteur: d.curH });
          return;
        }
        if (d.kind === "ouv") {
          majOuverture(d.id, { pos: d.cur.pos, allege: d.cur.allege, largeur: d.cur.largeur, hauteur: d.cur.hauteur });
          return;
        }
        if (d.kind === "ancre") {
          majAncre(d.id, d.cur.x, d.cur.y, d.cur.z);
          return;
        }
        let { dx, dz } = d;
        // Accrochage au lâcher : extrémité déplacée proche d'une extrémité d'un autre mur
        let best: { ddx: number; ddz: number } | null = null;
        let bd = 0.25;
        const ends: [number, number][] = [
          [d.orig.ax + dx, d.orig.az + dz], [d.orig.bx + dx, d.orig.bz + dz],
        ];
        for (const [ex, ez] of ends)
          for (const m of mursRef.current) {
            if (m.id === d.id) continue;
            for (const [ox, oz] of [[m.ax, m.az], [m.bx, m.bz]] as const) {
              const dist = Math.hypot(ex - ox, ez - oz);
              if (dist < bd) { bd = dist; best = { ddx: ox - ex, ddz: oz - ez }; }
            }
          }
        if (best) { dx += best.ddx; dz += best.ddz; }
        majMur(d.id, { ax: d.orig.ax + dx, az: d.orig.az + dz,
                       bx: d.orig.bx + dx, bz: d.orig.bz + dz });
        return;
      }
      if (!downPos) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      downPos = null;
      if (moved > 5 || e.button !== 0) return;
      const ray = makeRay(e);
      const cibles = [...meshMapRef.current.values()];
      // Ancre : le point cliqué sur le scan devient une cible d'accroche (mode actif)
      if (ancreModeRef.current) {
        const hit = ray.intersectObjects(cibles, true)[0];
        if (hit) creerAncre(snapPick(hit));
        return;
      }
      // Pipette : le point cliqué sur le scan définit le niveau 0
      if (pipetteRef.current) {
        const hit = ray.intersectObjects(cibles, true)[0];
        if (hit) setMurBaseY(Math.round(snapPick(hit).y * 100) / 100);
        setPipette(false);
        return;
      }
      // Mesure : 2 clics accrochés → distance (l'outil reste actif)
      if (mesureModeRef.current) {
        const hit = ray.intersectObjects(cibles, true)[0];
        if (hit) poserPointMesure(snapPick(hit));
        return;
      }
      // Ouverture : clic sur un mur → percement centré sur le point cliqué
      if (ouvModeRef.current) {
        const hit = ray.intersectObjects([...murMeshMapRef.current.values()])[0];
        if (!hit) return;
        const murId = hit.object.userData.murId as string;
        const m = mursRef.current.find((x) => x.id === murId);
        if (!m) return;
        const len = Math.hypot(m.bx - m.ax, m.bz - m.az);
        const LARG = 1.0, HAUT = 1.15;
        // Ancrage sur l'angle INFÉRIEUR DROIT : le clic = nu droit + bas de la baie
        const along = ((hit.point.x - m.ax) * (m.bx - m.ax) + (hit.point.z - m.az) * (m.bz - m.az)) / len;
        let pos = along - LARG / 2;
        pos = Math.round(Math.min(Math.max(pos, LARG / 2 + 0.02), len - LARG / 2 - 0.02) * 100) / 100;
        let allege = hit.point.y - m.base_y;
        allege = Math.round(Math.min(Math.max(allege, 0), Math.max(0, m.hauteur - HAUT - 0.02)) * 100) / 100;
        creerOuverture(murId, pos, allege);
        setMurSel(murId);   // affiche la fenêtre de propriétés du mur percé
        // La baie créée est sélectionnée (mode édition, poignées actives) → on sort
        // du mode ajout : sinon chaque clic d'édition perçait une nouvelle baie.
        setOuvMode(false);
        return;
      }
      // Dalle : clics des sommets au sol, fermeture par re-clic du 1er point ou Entrée
      if (dalleModeRef.current) {
        const hit = ray.intersectObjects(cibles, true)[0];
        if (hit) poserPointDalle(snapPick(hit));
        return;
      }
      // Toit : 3 clics — égout 1, égout 2, faîtage
      if (toitModeRef.current) {
        const hit = ray.intersectObjects(cibles, true)[0];
        if (hit) poserPointToit(snapPick(hit));
        return;
      }
      // Mise à niveau : 2 clics sur une ligne censée être horizontale
      if (niveauModeRef.current) {
        const hit = ray.intersectObjects(cibles, true)[0];
        if (!hit) return;
        const p = snapPick(hit);
        const nd = niveauDraftRef.current;
        if (!nd) {
          const sid = scanIdFromObject(hit.object);
          if (!sid) return;
          setNiveauDraft({ p, scanId: sid });
          niveauMarkerRef.current = creerMarqueur(p, 0x10b981);
        } else {
          appliquerNiveau(nd.scanId, nd.p, p);
          annulerNiveauDraft();
          setNiveauMode(false);
        }
        return;
      }
      if (murModeRef.current) {
        const hit = ray.intersectObjects(cibles, true)[0];
        if (murPendingRef.current) {
          // 3e clic (côté du corps) : hors scan, on retombe sur le plan du niveau 0
          let p = hit ? hit.point : null;
          if (!p) {
            const gp = new THREE.Vector3();
            const plan = new THREE.Plane(new THREE.Vector3(0, 1, 0), -murBaseYRef.current);
            if (ray.ray.intersectPlane(plan, gp)) p = gp;
          }
          if (p) poserPointMur(p);
        } else if (hit) {
          poserPointMur(snapPick(hit));
        }
        return;
      }
      // Sélection d'un mur au clic (pour l'éditer / le déplacer)
      const wallHit = ray.intersectObjects([...murMeshMapRef.current.values()])[0];
      const newSel = wallHit ? ((wallHit.object.userData.murId as string) ?? null) : null;
      setMurSel((prev) => { if (prev !== newSel) setOuvSel(null); return newSel; });
      setDalleSel(null);
      setToitSel(null);
      setAncreSel(null);   // clic hors ancre → désélectionne l'ancre courante
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
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
          const off = offsets.find((o) => o.id === scan.id)
            ?? { id: scan.id, x: 0, y: 0, z: 0, angle: 0, tx: 0, tz: 0 };
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
      // Poignées et ancres à taille écran ~constante : leur géométrie fait ~10 cm
      // monde, invisible et imprenable dès qu'on recule. On compense par la
      // distance caméra (facteur 0.11 ≈ 12 px à 1 rad de fov vertical).
      for (const h of [...handleMeshesRef.current, ...ouvHandlesRef.current,
                       ...ancreMeshMapRef.current.values()]) {
        const base = (h.userData.baseScale as number | undefined) ?? h.scale.x;
        if (h.userData.baseScale === undefined) h.userData.baseScale = base;
        const d = camera.position.distanceTo(h.position);
        h.scale.setScalar(base * Math.min(4, Math.max(1, d * 0.11)));
      }
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
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      meshMapRef.current.clear();
      murMeshMapRef.current.clear();
      mesureGroupMapRef.current.clear();
      dalleMeshMapRef.current.clear();
      toitMeshMapRef.current.clear();
      ancreMeshMapRef.current.clear();
      handleMeshesRef.current = [];
      ouvHandlesRef.current = [];
      murRefLineRef.current = null;
      controlsRef.current = null;
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
          .update({ offset_x: o.x, offset_y: o.y, offset_z: o.z, offset_angle: o.angle,
                    tilt_x: o.tx, tilt_z: o.tz })
          .eq("id", o.id)
      )
    );
    setSaving(false);
    setSaved(true);
  }

  // Cadre la vue sur l'ensemble des scans chargés (ou restaure le cadrage mémorisé)
  const didFrameRef = useRef(false);
  function cadrerVue(force = false) {
    const cam = cameraRef.current, controls = controlsRef.current;
    if (!cam || !controls) return;
    const box = new THREE.Box3();
    for (const g of meshMapRef.current.values()) box.expandByObject(g);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z) * 0.7 + 1.5;
    cam.position.set(c.x + r, c.y + r * 0.8, c.z + r);
    controls.target.copy(c);
    controls.update();
    if (force && chantierId) {
      try { localStorage.setItem(`pis-cam-${chantierId}`, JSON.stringify(
        [cam.position.x, cam.position.y, cam.position.z, c.x, c.y, c.z])); } catch { /* ignore */ }
    }
  }

  // Au premier chargement complet : restaure le cadrage mémorisé, sinon cadre auto
  useEffect(() => {
    if (didFrameRef.current || loadingIds.size > 0) return;
    const cam = cameraRef.current, controls = controlsRef.current;
    if (!cam || !controls) return;
    didFrameRef.current = true;
    const key = chantierId ? `pis-cam-${chantierId}` : null;
    if (key) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const a = JSON.parse(raw) as number[];
          cam.position.set(a[0], a[1], a[2]);
          controls.target.set(a[3], a[4], a[5]);
          controls.update();
          return;
        }
      } catch { /* ignore */ }
    }
    cadrerVue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingIds, chantierId]);

  // Auto-sauvegarde de la position/assiette des scans (débattue), sans clic manuel
  const firstOffsetsRef = useRef(true);
  useEffect(() => {
    if (firstOffsetsRef.current) { firstOffsetsRef.current = false; return; }
    const t = setTimeout(() => { saveOffsets(); }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsets]);

  // Export de la maquette BIM (IFC4 / DXF plan)
  function telecharger(nom: string, contenu: string, mime: string) {
    const blob = new Blob([contenu], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = nom;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function modeleBim() {
    return { murs, ouvertures, dalles, toits };
  }
  const bimVide = murs.length + dalles.length + toits.length === 0;
  const nomFichier = (chantierNom || "releve").replace(/[^\w\-]+/g, "_");
  function exporterIFC() {
    telecharger(`${nomFichier}.ifc`, buildBimIFC(modeleBim(), chantierNom || "Relevé"), "application/x-step");
  }
  function exporterDXF() {
    telecharger(`${nomFichier}_plan.dxf`, buildBimPlanDXF(modeleBim()), "application/dxf");
  }

  // Blocage de l'inclinaison verticale de la vue (garde l'angle de site courant)
  const [vertLock, setVertLock] = useState(false);
  function toggleVertLock() {
    const c = controlsRef.current;
    setVertLock((v) => {
      const nv = !v;
      if (c) {
        if (nv) { const a = c.getPolarAngle(); c.minPolarAngle = a; c.maxPolarAngle = a; }
        else { c.minPolarAngle = 0; c.maxPolarAngle = Math.PI; }
      }
      return nv;
    });
  }

  const selOff = selected ? getOffset(selected) : null;
  const selScan = layers.find((s) => s.id === selected);

  // Entête d'une section repliable (accordéon)
  function sectionHeader(k: string, icon: string, label: string, count: number) {
    const open = openCat === k;
    return (
      <button
        onClick={() => setOpenCat(open ? null : k)}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-slate-50 transition-colors"
      >
        <span className="text-sm">{icon}</span>
        <span className="flex-1 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
        <span className="text-[11px] font-mono text-slate-400 bg-slate-100 rounded px-1.5 py-0.5 min-w-[22px] text-center">{count}</span>
        <span className={`text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
    );
  }

  return (
    <div className="flex h-full" style={{ minHeight: 520 }}>
      {/* Sidebar */}
      <div className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-y-auto">
        {/* Barre d'outils vue/scan toujours visible */}
        <div className="flex gap-1 p-2 border-b border-slate-100">
          <button
            onClick={() => activerMode(niveauMode ? null : "niveau")}
            title="Caler l'horizontalité : cliquez 2 points qui devraient être à la même altitude (assise, gouttière) — le scan pivote pour les mettre de niveau"
            className="flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={niveauMode
              ? { background: "#10b981", color: "white", borderColor: "#10b981" }
              : { borderColor: "#e2e8f0", color: "#64748b" }}>
            ⟂ Niveau
          </button>
          <button
            onClick={toggleVertLock}
            title="Bloquer l'inclinaison verticale de la vue (l'orbite reste à l'angle de site courant)"
            className="flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={vertLock
              ? { background: "var(--navy)", color: "white", borderColor: "var(--navy)" }
              : { borderColor: "#e2e8f0", color: "#64748b" }}>
            {vertLock ? "🔒" : "🔓"} Vertic.
          </button>
          <button
            onClick={() => cadrerVue(true)}
            title="Recadrer la vue sur la maquette"
            className="px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={{ borderColor: "#e2e8f0", color: "#64748b" }}>
            ⤢
          </button>
        </div>

        {/* Transparence du scan : dégage les poignées d'édition masquées par le mesh */}
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-slate-100">
          <span
            title="Rendre le scan translucide pour atteindre les poignées d'édition (murs, toitures, ouvertures) masquées par le mesh"
            className="text-xs text-slate-500 whitespace-nowrap select-none">
            👁 Scan
          </span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={scanOpacity}
            onChange={(e) => setScanOpacity(parseFloat(e.target.value))}
            className="flex-1 accent-orange-500"
          />
          <span className="text-[11px] font-mono text-slate-400 w-9 text-right select-none">
            {Math.round(scanOpacity * 100)}%
          </span>
        </div>
        <div className="border-b border-slate-100">
          {sectionHeader("pieces", "🧩", "Pièces", layers.length)}
          {openCat === "pieces" && (
          <div className="px-4 pb-4">
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
          )}
        </div>

        {/* Ancres */}
        {chantierId && (
          <div className="border-b border-slate-100">
            {sectionHeader("ancres", "📍", "Ancres", ancres.length)}
            {openCat === "ancres" && (
            <div className="px-4 pb-4">
            <button
              onClick={() => activerMode(ancreMode ? null : "ancre")}
              title="Cliquez des points caractéristiques du scan (coins, arêtes). Les murs s'y accrochent en priorité (rayon 30 cm)."
              className="w-full py-1.5 rounded-lg text-xs font-medium border transition-colors"
              style={ancreMode
                ? { background: "#d946ef", color: "white", borderColor: "#d946ef" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}>
              {ancreMode ? "Cliquez un point du scan…" : "＋ Poser des ancres"}
            </button>
            {ancres.length > 0 && (
              <div className="flex flex-col gap-1 mt-2">
                {ancres.map((a, i) => {
                  const sel = a.id === ancreSel;
                  return (
                  <div key={a.id}
                    onClick={() => setAncreSel(sel ? null : a.id)}
                    title="Sélectionner l'ancre (puis glissez-la dans la vue 3D pour la déplacer)"
                    className={`group flex items-center gap-2 text-xs border rounded px-2 py-1 cursor-pointer ${
                      sel ? "border-cyan-400 bg-cyan-50 text-cyan-700" : "border-slate-100 text-slate-600 hover:bg-slate-50"}`}>
                    <span className={sel ? "text-cyan-500" : "text-fuchsia-500"}>◆</span>
                    <span className="text-slate-400">{i + 1}.</span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {a.x.toFixed(1)}, {a.z.toFixed(1)}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); supprimerAncre(a.id); }}
                      className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                      title="Supprimer l'ancre">🗑</button>
                  </div>
                  );
                })}
              </div>
            )}
            </div>
            )}
          </div>
        )}

        {/* Mesures */}
        <div className="border-b border-slate-100">
          {sectionHeader("mesures", "📏", "Mesures", mesures.length)}
          {openCat === "mesures" && (
          <div className="px-4 pb-4">
          <button
            onClick={() => activerMode(mesureMode ? null : "mesure")}
            className="w-full py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={mesureMode
              ? { background: "#2563eb", color: "white", borderColor: "#2563eb" }
              : { borderColor: "#e2e8f0", color: "#64748b" }}>
            {mesureMode ? (mesureDraft ? "Cliquez le 2e point…" : "Cliquez le 1er point…") : "＋ Mesurer"}
          </button>
          {mesures.length > 0 && (
            <div className="flex flex-col gap-1 mt-2">
              {mesures.map((m, i) => (
                <div key={m.id}
                  className="group flex items-center gap-2 text-xs text-slate-600 border border-slate-100 rounded px-2 py-1">
                  <span className="text-slate-400">{i + 1}.</span>
                  <span className="font-mono">{m.d.toFixed(2)} m</span>
                  <button
                    onClick={() => setMesures((prev) => prev.filter((x) => x.id !== m.id))}
                    className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                    title="Supprimer cette mesure">🗑</button>
                </div>
              ))}
              <button onClick={() => setMesures([])}
                className="text-[10px] text-slate-400 hover:text-slate-600 underline self-start mt-1">
                Tout effacer
              </button>
            </div>
          )}
          </div>
          )}
        </div>

        {/* Murs BIM */}
        {chantierId && (
          <div className="border-b border-slate-100">
            {sectionHeader("murs", "🧱", "Murs", murs.length)}
            {openCat === "murs" && (
            <div className="px-4 pb-4">
            {/* Niveau 0 : altitude de la base des nouveaux murs */}
            <div className="flex items-center gap-1 mb-2 text-[11px] text-slate-500">
              <span>Niveau 0</span>
              <input type="number" step={0.01} value={murBaseY}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setMurBaseY(v); }}
                className="w-16 border border-slate-200 rounded px-1 py-0.5 text-[11px] font-mono"/>
              <span>m</span>
              <button onClick={() => activerMode(pipette ? null : "pipette")}
                title="Cliquer un point du scan (sol fini) pour caler le niveau 0"
                className="ml-auto px-1.5 py-0.5 rounded border text-[11px] transition-colors"
                style={pipette
                  ? { background: "#f97316", color: "white", borderColor: "#f97316" }
                  : { borderColor: "#e2e8f0", color: "#64748b" }}>🎯</button>
            </div>
            {/* Ligne tracée : axe du mur ou nu (face ext./int.) */}
            <div className="flex gap-1 mb-2">
              {(["axe", "face"] as const).map((a) => (
                <button key={a} onClick={() => setMurAlign(a)}
                  title={a === "axe"
                    ? "La ligne cliquée est l'axe du mur"
                    : "La ligne cliquée est un nu (face ext. ou int.) — un 3e clic indique de quel côté est le mur"}
                  className="flex-1 py-1 rounded border text-[11px] transition-colors"
                  style={murAlign === a
                    ? { background: "var(--navy)", color: "white", borderColor: "var(--navy)" }
                    : { borderColor: "#e2e8f0", color: "#64748b" }}>
                  {a === "axe" ? "Axe" : "Nu (face)"}
                </button>
              ))}
            </div>
            <button
              onClick={() => activerMode(murMode ? null : "mur")}
              className="w-full py-1.5 rounded-lg text-xs font-medium border transition-colors mb-2"
              style={murMode
                ? { background: "#f97316", color: "white", borderColor: "#f97316" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}>
              {murMode
                ? (murPending ? "Cliquez le côté du mur…" : murDraft ? "Cliquez le 2e point…" : "Cliquez le 1er point…")
                : "＋ Tracer un mur"}
            </button>
            {murs.length > 0 && (
              <button
                onClick={() => activerMode(ouvMode ? null : "ouverture")}
                title="Cliquez sur un mur à l'endroit de l'ouverture (fenêtre 100×115 par défaut, modifiable ensuite)"
                className="w-full py-1.5 rounded-lg text-xs font-medium border transition-colors mb-2"
                style={ouvMode
                  ? { background: "#f97316", color: "white", borderColor: "#f97316" }
                  : { borderColor: "#e2e8f0", color: "#64748b" }}>
                {ouvMode ? "Cliquez sur un mur…" : "🚪 ＋ Ouverture"}
              </button>
            )}
            <div className="flex flex-col gap-1.5">
              {murs.map((m, i) => {
                const len = Math.hypot(m.bx - m.ax, m.bz - m.az);
                const sel = murSel === m.id;
                return (
                  <div key={m.id} onClick={() => selMur(sel ? null : m.id)}
                    className="group flex items-center gap-2 border rounded-lg px-2 py-1.5 text-xs text-slate-600 cursor-pointer transition-colors"
                    style={sel ? { borderColor: "#2563eb", background: "#eff6ff" } : { borderColor: "#f1f5f9" }}>
                    <span className="font-medium">Mur {i + 1}</span>
                    <span className="font-mono text-slate-400">{len.toFixed(2)} m</span>
                    {ouvertures.some((o) => o.mur_id === m.id) && (
                      <span className="text-[10px] text-orange-400">🚪 {ouvertures.filter((o) => o.mur_id === m.id).length}</span>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); supprimerMur(m.id); }}
                      className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                      title="Supprimer">🗑</button>
                  </div>
                );
              })}
            </div>
            </div>
            )}
          </div>
        )}

        {/* Dalles */}
        {chantierId && (
          <div className="border-b border-slate-100">
            {sectionHeader("dalles", "⬜", "Dalles", dalles.length)}
            {openCat === "dalles" && (
            <div className="px-4 pb-4">
            <button
              onClick={() => activerMode(dalleMode ? null : "dalle")}
              title="Cliquez les sommets du polygone au sol — fermez en recliquant le 1er point (ou Entrée). Niveau fini = Niveau 0 des murs."
              className="w-full py-1.5 rounded-lg text-xs font-medium border transition-colors mb-2"
              style={dalleMode
                ? { background: "#64748b", color: "white", borderColor: "#64748b" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}>
              {dalleMode ? `Sommet ${dalleDraft.length + 1}… (Entrée : fermer)` : "＋ Tracer une dalle"}
            </button>
            <div className="flex flex-col gap-1.5">
              {dalles.map((d, i) => {
                const sel = dalleSel === d.id;
                return (
                <div key={d.id} onClick={() => selDalle(sel ? null : d.id)}
                  className="group flex items-center gap-2 border rounded-lg px-2 py-1.5 text-xs text-slate-600 cursor-pointer transition-colors"
                  style={sel ? { borderColor: "#2563eb", background: "#eff6ff" } : { borderColor: "#f1f5f9" }}>
                  <span className="font-medium">Dalle {i + 1}</span>
                  <span className="font-mono text-slate-400">{aireDalle(d.points).toFixed(1)} m²</span>
                  <button onClick={(e) => { e.stopPropagation(); supprimerDalle(d.id); }}
                    className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                    title="Supprimer">🗑</button>
                </div>
                );
              })}
            </div>
            </div>
            )}
          </div>
        )}

        {/* Toits */}
        {chantierId && (
          <div className="border-b border-slate-100">
            {sectionHeader("toits", "🏠", "Toits", toits.length)}
            {openCat === "toits" && (
            <div className="px-4 pb-4">
            <button
              onClick={() => activerMode(toitMode ? null : "toit")}
              title="3 clics sur le scan : les 2 extrémités de l'égout, puis un point du faîtage — le pan s'aligne sur la pente"
              className="w-full py-1.5 rounded-lg text-xs font-medium border transition-colors mb-2"
              style={toitMode
                ? { background: "#b91c1c", color: "white", borderColor: "#b91c1c" }
                : { borderColor: "#e2e8f0", color: "#64748b" }}>
              {toitMode
                ? ["Cliquez l'égout (1er point)…", "Cliquez l'égout (2e point)…", "Cliquez le faîtage…"][toitDraft.length]
                : "＋ Pan de toiture (3 clics)"}
            </button>
            <div className="flex flex-col gap-1.5">
              {toits.map((t, i) => {
                const { e: ev, s: sv } = toitVecteurs(t);
                const aire = ev.length() * sv.length();
                const pente = sv.length() > 0.01
                  ? Math.round(Math.atan2(Math.abs(t.p3[1] - (t.p1[1] + t.p2[1]) / 2), Math.hypot(sv.x, sv.z)) * 180 / Math.PI)
                  : 0;
                const sel = toitSel === t.id;
                return (
                  <div key={t.id} onClick={() => selToit(sel ? null : t.id)}
                    className="group flex items-center gap-2 border rounded-lg px-2 py-1.5 text-xs text-slate-600 cursor-pointer transition-colors"
                    style={sel ? { borderColor: "#2563eb", background: "#eff6ff" } : { borderColor: "#f1f5f9" }}>
                    <span className="font-medium">Pan {i + 1}</span>
                    <span className="font-mono text-slate-400">{aire.toFixed(1)} m² · {pente}°</span>
                    <button onClick={(e) => { e.stopPropagation(); supprimerToit(t.id); }}
                      className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                      title="Supprimer">🗑</button>
                  </div>
                );
              })}
            </div>
            </div>
            )}
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
              onClick={() => { (["x", "y", "z", "angle", "tx", "tz"] as const).forEach((k) => updateOffset(selOff.id, k, 0)); }}
              className="text-xs text-slate-400 hover:text-slate-600 underline mt-auto"
            >
              Remettre à zéro
            </button>
          </div>
        )}

        {/* Export de la maquette BIM */}
        {chantierId && (
          <div className="p-4 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              ⬇ Export maquette
            </p>
            <div className="flex gap-1">
              <button
                onClick={exporterIFC}
                disabled={bimVide}
                title="Exporter la maquette (murs, ouvertures, dalles, toitures) au format IFC4 — ouvrable dans ArchiCAD, Revit, BIMcollab…"
                className="flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40"
                style={{ borderColor: "#e2e8f0", color: "#334155" }}>
                IFC
              </button>
              <button
                onClick={exporterDXF}
                disabled={bimVide}
                title="Exporter le plan (empreintes murs/dalles/toits, baies) au format DXF"
                className="flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40"
                style={{ borderColor: "#e2e8f0", color: "#334155" }}>
                DXF plan
              </button>
            </div>
            {bimVide && <p className="text-[10px] text-slate-400 mt-1">Tracez des murs pour activer l&apos;export.</p>}
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
            {murPending
              ? "🧱 Cliquez du côté du corps du mur (à l'intérieur si vous avez tracé le nu extérieur)"
              : murDraft
              ? "🧱 Cliquez le 2e point du mur sur le scan (Échap : annuler)"
              : `🧱 Cliquez le 1er point ${murAlign === "face" ? "du nu" : "de l'axe"} du mur — accrochage sommets et extrémités`}
          </div>
        )}
        {pipette && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            🎯 Cliquez un point du scan (sol fini) pour caler le niveau 0
          </div>
        )}
        {mesureMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            {mesureDraft
              ? "📏 Cliquez le 2e point (Échap : annuler)"
              : "📏 Cliquez le 1er point de la mesure — accrochage sommets, Échap pour sortir"}
          </div>
        )}
        {niveauMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            {niveauDraft
              ? "⟂ Cliquez le 2e point de la même ligne horizontale (Échap : annuler)"
              : "⟂ Cliquez 2 points qui devraient être à la même altitude (assise, gouttière, faîtage…)"}
          </div>
        )}
        {ouvMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            🚪 Cliquez sur un mur orange à l&apos;endroit de l&apos;ouverture — dimensions modifiables ensuite (Échap : sortir)
          </div>
        )}
        {dalleMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            {dalleDraft.length >= 3
              ? "⬜ Sommet suivant, ou fermez : re-clic du 1er point / Entrée (Échap : annuler)"
              : `⬜ Cliquez le sommet ${dalleDraft.length + 1} du polygone au sol (3 minimum)`}
          </div>
        )}
        {toitMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            {["🏠 Cliquez la 1re extrémité de l'égout (bas de pente)",
              "🏠 Cliquez la 2e extrémité de l'égout",
              "🏠 Cliquez un point du faîtage (haut de pente)"][toitDraft.length]}
          </div>
        )}
        {ancreMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            📍 Cliquez des points caractéristiques du scan (coins, arêtes) — les murs s&apos;y accrocheront (Échap : sortir)
          </div>
        )}
        {!murMode && !pipette && !mesureMode && !niveauMode && !ouvMode && !dalleMode && !toitMode && !ancreMode && ouvSel && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            🚪 Poignées : <span className="text-orange-300">orange</span> = déplacer · <span className="text-cyan-300">cyan</span> = largeur · <span className="text-emerald-300">verte</span> = hauteur
          </div>
        )}
        {!murMode && !pipette && !mesureMode && !niveauMode && !ouvMode && !dalleMode && !toitMode && !ancreMode && murSel && !ouvSel && !ancreSel && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            ↔ Glissez le corps pour déplacer · <span className="text-yellow-300">poignées jaunes</span> = longueur/ajuster (accrochage ancres/murs) · <span className="text-emerald-300">verte</span> = hauteur · Échap : désélectionner
          </div>
        )}
        {!murMode && !pipette && !mesureMode && !niveauMode && !ouvMode && !dalleMode && !toitMode && !ancreMode && ancreSel && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            📍 <span className="text-cyan-300">Ancre sélectionnée</span> — glissez-la pour la déplacer (elle suit la surface du scan) · Échap : désélectionner
          </div>
        )}
        {armedOp && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            {armedOp === "axe"
              ? "∥ Glissez une poignée jaune — déplacement contraint dans l'axe du mur"
              : "⊥ Glissez le corps du mur — déplacement perpendiculaire uniquement"} · Échap : annuler
          </div>
        )}

        {/* Palette contextuelle façon ArchiCAD : clic simple sur une poignée (nœud)
            ou le corps (arête) du mur sélectionné → choix de l'opération */}
        {palette && (() => {
          const pm = murs.find((m) => m.id === palette.murId);
          if (!pm) return null;
          const btn = "flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 rounded transition-colors whitespace-nowrap";
          return (
            <div
              className="absolute z-20 bg-white rounded-xl shadow-xl border border-slate-200 p-1 flex flex-col"
              style={{ left: Math.max(8, Math.min(palette.sx, 1200)), top: Math.max(8, palette.sy - 8),
                       transform: "translate(-50%, -100%)" }}>
              {palette.kind === "node" ? (
                <>
                  <button className={btn} title="Déplacer librement l'extrémité (drag classique de la poignée)"
                    onClick={() => { setArmedOp(null); setPalette(null); }}>
                    ✥ <span>Déplacer libre</span>
                  </button>
                  <button className={btn} title="Le prochain drag de la poignée reste sur la droite du mur (allonger / raccourcir sans dévier)"
                    onClick={() => { setArmedOp("axe"); setPalette(null); }}>
                    ∥ <span>Dans l&apos;axe</span>
                  </button>
                </>
              ) : (
                <>
                  <button className={btn} title="Déplacer librement le mur (drag classique du corps)"
                    onClick={() => { setArmedOp(null); setPalette(null); }}>
                    ✥ <span>Déplacer</span>
                  </button>
                  <button className={btn} title="Le prochain drag du corps ne bouge le mur que perpendiculairement à son axe"
                    onClick={() => { setArmedOp("perp"); setPalette(null); }}>
                    ⊥ <span>Perpendiculaire</span>
                  </button>
                  <button className={btn} title="Couper le mur en deux au point cliqué (les ouvertures suivent leur tronçon)"
                    onClick={() => { diviserMur(pm, palette.wp.x, palette.wp.z); setPalette(null); }}>
                    ✂ <span>Diviser ici</span>
                  </button>
                  <button className={btn} title="Percer une baie 1,00 × 1,15 m centrée sur le point cliqué"
                    onClick={() => { ouvertureAuPoint(pm, palette.wp); setPalette(null); }}>
                    ▢ <span>Ouverture ici</span>
                  </button>
                </>
              )}
            </div>
          );
        })()}

        {/* Fenêtre flottante de propriétés de l'élément sélectionné */}
        {(() => {
          const mSel = murSel ? murs.find((m) => m.id === murSel) : null;
          const dSel = dalleSel ? dalles.find((d) => d.id === dalleSel) : null;
          const tSel = toitSel ? toits.find((t) => t.id === toitSel) : null;
          if (!mSel && !dSel && !tSel) return null;
          const num = (arr: { id: string }[], id: string) => arr.findIndex((x) => x.id === id) + 1;
          const baies = mSel ? ouvertures.filter((o) => o.mur_id === mSel.id) : [];
          const title = mSel ? `🧱 Mur ${num(murs, mSel.id)}`
            : dSel ? `⬜ Dalle ${num(dalles, dSel.id)}` : `🏠 Pan ${num(toits, tSel!.id)}`;
          const accent = mSel ? "#2563eb" : dSel ? "#64748b" : "#b91c1c";
          return (
            <FloatingPanel pos={panelPos} setPos={setPanelPos} title={title} accent={accent} onClose={deselectAll}>
              {mSel && (<>
                <NumField label="Épaisseur" value={mSel.epaisseur} min={0.05} max={1}
                  onChange={(v) => majMur(mSel.id, { epaisseur: v })} />
                <NumField label="Hauteur" value={mSel.hauteur} min={0.3} max={12} step={0.05}
                  onChange={(v) => majMur(mSel.id, { hauteur: v })} />
                <NumField label="Base (niv.)" value={mSel.base_y} step={0.01}
                  onChange={(v) => majMur(mSel.id, { base_y: v })} />
                {mSel.decalage !== 0 && (
                  <button onClick={() => majMur(mSel.id, { decalage: -mSel.decalage })}
                    className="text-[11px] text-slate-500 hover:text-slate-800 underline self-start">
                    ⇄ Basculer le corps de l&apos;autre côté du nu
                  </button>
                )}
                <div className="border-t border-slate-100 pt-2 mt-1">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-semibold text-slate-500">Ouvertures — {baies.length}</span>
                    <button onClick={() => activerMode(ouvMode ? null : "ouverture")}
                      className="text-[11px] px-2 py-0.5 rounded border transition-colors"
                      style={ouvMode
                        ? { background: "#f97316", color: "white", borderColor: "#f97316" }
                        : { borderColor: "#e2e8f0", color: "#64748b" }}>
                      {ouvMode ? "cliquez le mur…" : "🚪 ＋"}
                    </button>
                  </div>
                  <div className="flex flex-col gap-2 max-h-52 overflow-y-auto">
                    {baies.map((o, j) => {
                      const oSel = ouvSel === o.id;
                      return (
                      <div key={o.id} className="rounded-lg p-2 flex flex-col gap-1 border"
                        style={oSel ? { borderColor: "#f97316", background: "#fff7ed" } : { borderColor: "#ffedd5" }}>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 cursor-pointer"
                          onClick={() => { setOuvSel(oSel ? null : o.id); if (ouvMode) activerMode(null); }}>
                          <span className="font-medium">🚪 {j + 1}</span>
                          {oSel && <span className="text-[9px] text-orange-500">poignées 3D actives</span>}
                          <button onClick={(e) => { e.stopPropagation(); supprimerOuverture(o.id); }}
                            className="ml-auto text-slate-300 hover:text-red-500" title="Supprimer">🗑</button>
                        </div>
                        <NumField label="Largeur" value={o.largeur} min={0.2} max={6} step={0.05}
                          onChange={(v) => majOuvertureLargeur(o, v)} />
                        <NumField label="Hauteur" value={o.hauteur} min={0.2} max={6} step={0.05}
                          onChange={(v) => majOuverture(o.id, { hauteur: v })} />
                        <NumField label="Allège" value={o.allege} min={0} step={0.05}
                          onChange={(v) => majOuverture(o.id, { allege: v })} />
                        <NumField label="Position" value={o.pos} min={0} step={0.05}
                          onChange={(v) => majOuverture(o.id, { pos: v })} />
                      </div>
                      );
                    })}
                    {baies.length === 0 && (
                      <p className="text-[10px] text-slate-400">« 🚪 ＋ » puis cliquez le mur à l&apos;angle inférieur droit de la baie.</p>
                    )}
                  </div>
                </div>
                <button onClick={() => supprimerMur(mSel.id)}
                  className="text-[11px] text-red-500 hover:text-red-700 self-start mt-1">🗑 Supprimer le mur</button>
              </>)}

              {dSel && (<>
                <NumField label="Épaisseur" value={dSel.epaisseur} min={0.05} max={1}
                  onChange={(v) => majDalle(dSel.id, { epaisseur: v })} />
                <NumField label="Niveau" value={dSel.base_y} step={0.01}
                  onChange={(v) => majDalle(dSel.id, { base_y: v })} />
                <p className="text-[10px] text-slate-400">{aireDalle(dSel.points).toFixed(1)} m² · {dSel.points.length} sommets</p>
                <button onClick={() => supprimerDalle(dSel.id)}
                  className="text-[11px] text-red-500 hover:text-red-700 self-start mt-1">🗑 Supprimer la dalle</button>
              </>)}

              {tSel && (<>
                <NumField label="Épaisseur" value={tSel.epaisseur} min={0.05} max={1}
                  onChange={(v) => majToit(tSel.id, { epaisseur: v })} />
                <button onClick={() => supprimerToit(tSel.id)}
                  className="text-[11px] text-red-500 hover:text-red-700 self-start mt-1">🗑 Supprimer le pan</button>
              </>)}
            </FloatingPanel>
          );
        })()}
      </div>
    </div>
  );
}
