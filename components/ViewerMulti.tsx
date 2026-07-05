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
  const handleMeshesRef = useRef<THREE.Mesh[]>([]);
  useEffect(() => { ancreModeRef.current = ancreMode; }, [ancreMode]);
  useEffect(() => { ancresRef.current = ancres; }, [ancres]);

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

  // Marqueurs d'ancres (octaèdres magenta, toujours visibles)
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
      mesh.position.set(a.x, a.y, a.z);
    }
  }, [ancres]);

  // Poignées d'extrémité du mur sélectionné (sphères cyan draggables)
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const h of handleMeshesRef.current) { scene.remove(h); h.geometry.dispose(); }
    handleMeshesRef.current = [];
    const m = murs.find((x) => x.id === murSel);
    if (!m) return;
    const hy = m.base_y + Math.min(m.hauteur, 1.2);
    for (const end of ["a", "b"] as const) {
      const h = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x06b6d4, depthTest: false })
      );
      h.renderOrder = 5;
      h.userData = { handleEnd: end, murId: m.id };
      h.position.set(end === "a" ? m.ax : m.bx, hy, end === "a" ? m.az : m.bz);
      scene.add(h);
      handleMeshesRef.current.push(h);
    }
  }, [murSel, murs]);

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
  }

  // ── Ouvertures : CRUD ──
  async function creerOuverture(murId: string, pos: number, allege: number) {
    const row = { mur_id: murId, pos, largeur: 1.0, hauteur: 1.15, allege };
    const { data, error } = await db.from("bim_ouvertures").insert(row).select("*").single();
    if (error) { alert(`Ouverture non enregistrée : ${error.message}`); return; }
    setOuvertures((prev) => [...prev, data as Ouverture]);
  }

  function majOuverture(id: string, patch: Partial<Ouverture>) {
    setOuvertures((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
    db.from("bim_ouvertures").update(patch).eq("id", id).then(({ error }) => {
      if (error) console.warn("[bim_ouvertures] update:", error.message);
    });
  }

  async function supprimerOuverture(id: string) {
    await db.from("bim_ouvertures").delete().eq("id", id);
    setOuvertures((prev) => prev.filter((o) => o.id !== id));
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
  }

  // Accrochage planimétrique (x,z) d'un point d'extrémité de mur en cours d'édition :
  // ancres → extrémités d'autres murs → projection sur segment d'un autre mur (jonction T)
  function snapXZ(x: number, z: number, excludeId: string): { x: number; z: number; snap: boolean } {
    let bx = x, bz = z, snap = false;
    let bd = 0.3;
    for (const a of ancresRef.current) {
      const d = Math.hypot(x - a.x, z - a.z);
      if (d < bd) { bd = d; bx = a.x; bz = a.z; snap = true; }
    }
    for (const m of mursRef.current) {
      if (m.id === excludeId) continue;
      for (const [ex, ez] of [[m.ax, m.az], [m.bx, m.bz]] as const) {
        const d = Math.hypot(x - ex, z - ez);
        if (d < bd) { bd = d; bx = ex; bz = ez; snap = true; }
      }
    }
    if (snap) return { x: bx, z: bz, snap };
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
      if (d < bt) { bt = d; bx = px; bz = pz; snap = true; }
    }
    return { x: bx, z: bz, snap };
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
  function snapPick(hit: THREE.Intersection): THREE.Vector3 {
    let p = hit.point.clone();
    // Ancres : points d'accroche délibérés → priorité absolue (dans un rayon de 30 cm)
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
    let bw = 0.25;
    for (const m of mursRef.current) {
      for (const [ex, ez] of [[m.ax, m.az], [m.bx, m.bz]] as const) {
        const d = Math.hypot(p.x - ex, p.z - ez);
        if (d < bw) { bw = d; p = new THREE.Vector3(ex, p.y, ez); }
      }
    }
    return p;
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
      if (e.key === "Escape") { activerMode(null); setMurSel(null); }
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
    container.appendChild(renderer.domElement);

    cameraRef.current = camera;
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

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
    let downPos: { x: number; y: number } | null = null;
    type WallDrag =
      | { kind: "move"; id: string; orig: Mur; start: THREE.Vector3; base: THREE.Vector3;
          plane: THREE.Plane; dx: number; dz: number; moved: boolean }
      | { kind: "end"; id: string; orig: Mur; end: "a" | "b"; hy: number;
          curX: number; curZ: number; moved: boolean };
    let drag: WallDrag | null = null;

    const onDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
      // Édition : drag d'une poignée ou déplacement du mur sélectionné (hors modes outils)
      if (murModeRef.current || pipetteRef.current || mesureModeRef.current
          || niveauModeRef.current || ouvModeRef.current || dalleModeRef.current
          || toitModeRef.current || ancreModeRef.current || e.button !== 0) return;
      const selId = murSelRef.current;
      if (!selId) return;
      const mur = mursRef.current.find((m) => m.id === selId);
      if (!mur) return;
      // 1) poignée d'extrémité prioritaire
      const hHit = makeRay(e).intersectObjects(handleMeshesRef.current)[0];
      if (hHit) {
        const end = hHit.object.userData.handleEnd as "a" | "b";
        drag = { kind: "end", id: selId, orig: { ...mur }, end, hy: hHit.object.position.y,
                 curX: end === "a" ? mur.ax : mur.bx, curZ: end === "a" ? mur.az : mur.bz, moved: false };
        controls.enabled = false;
        return;
      }
      // 2) déplacement du corps
      const mesh = murMeshMapRef.current.get(selId);
      if (!mesh) return;
      const hit = makeRay(e).intersectObject(mesh)[0];
      if (!hit) return;
      drag = {
        kind: "move", id: selId, orig: { ...mur }, start: hit.point.clone(), base: mesh.position.clone(),
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y),
        dx: 0, dz: 0, moved: false,
      };
      controls.enabled = false;
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const ray = makeRay(e);
      if (drag.kind === "move") {
        const p = new THREE.Vector3();
        if (!ray.ray.intersectPlane(drag.plane, p)) return;
        drag.dx = p.x - drag.start.x;
        drag.dz = p.z - drag.start.z;
        if (!drag.moved && Math.hypot(drag.dx, drag.dz) < 0.01) return;
        drag.moved = true;
        const mesh = murMeshMapRef.current.get(drag.id);
        if (mesh) mesh.position.set(drag.base.x + drag.dx, drag.base.y, drag.base.z + drag.dz);
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
      const s = snapXZ(x, z, ed.id);
      ed.curX = s.x; ed.curZ = s.z; ed.moved = true;
      const tmp: Mur = { ...ed.orig,
        ...(ed.end === "a" ? { ax: s.x, az: s.z } : { bx: s.x, bz: s.z }) };
      const mesh = murMeshMapRef.current.get(ed.id);
      if (mesh) poserMurMesh(mesh, tmp,
        ouverturesRef.current.filter((o) => o.mur_id === ed.id), toitsRef.current);
      const h = handleMeshesRef.current.find((hh) => hh.userData.handleEnd === ed.end);
      if (h) h.position.set(s.x, ed.hy, s.z);
    };

    const onUp = (e: PointerEvent) => {
      if (drag) {
        controls.enabled = true;
        const d = drag;
        drag = null;
        downPos = null;
        if (!d.moved) return;
        if (d.kind === "end") {
          majMur(d.id, d.end === "a" ? { ax: d.curX, az: d.curZ } : { bx: d.curX, bz: d.curZ });
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
        let pos = ((hit.point.x - m.ax) * (m.bx - m.ax) + (hit.point.z - m.az) * (m.bz - m.az)) / len;
        pos = Math.round(Math.min(Math.max(pos, LARG / 2 + 0.05), len - LARG / 2 - 0.05) * 100) / 100;
        let allege = hit.point.y - m.base_y - HAUT / 2;
        allege = Math.round(Math.min(Math.max(allege, 0), Math.max(0, m.hauteur - HAUT - 0.05)) * 100) / 100;
        creerOuverture(murId, pos, allege);
        return; // le mode reste actif pour enchaîner
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
      setMurSel(wallHit ? ((wallHit.object.userData.murId as string) ?? null) : null);
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
          <button
            onClick={() => activerMode(niveauMode ? null : "niveau")}
            title="Le scan photogrammétrique peut être légèrement penché : cliquez 2 points qui devraient être à la même altitude (assise de briques, gouttière…) — le scan pivote pour les mettre de niveau"
            className="w-full mt-2 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            style={niveauMode
              ? { background: "#10b981", color: "white", borderColor: "#10b981" }
              : { borderColor: "#e2e8f0", color: "#64748b" }}>
            {niveauMode ? (niveauDraft ? "Cliquez le 2e point…" : "Cliquez le 1er point…") : "⟂ Mettre à niveau"}
          </button>
        </div>

        {/* Ancres */}
        {chantierId && (
          <div className="p-4 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              📍 Ancres — {ancres.length}
            </p>
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
                {ancres.map((a, i) => (
                  <div key={a.id}
                    className="group flex items-center gap-2 text-xs text-slate-600 border border-slate-100 rounded px-2 py-1">
                    <span className="text-fuchsia-500">◆</span>
                    <span className="text-slate-400">{i + 1}.</span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {a.x.toFixed(1)}, {a.z.toFixed(1)}
                    </span>
                    <button onClick={() => supprimerAncre(a.id)}
                      className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                      title="Supprimer l'ancre">🗑</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Mesures */}
        <div className="p-4 border-b border-slate-100">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            📏 Mesures — {mesures.length}
          </p>
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

        {/* Murs BIM */}
        {chantierId && (
          <div className="p-4 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              🧱 Murs — {murs.length}
            </p>
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
                  <div key={m.id} onClick={() => setMurSel(m.id)}
                    className="group border rounded-lg px-2 py-1.5 cursor-pointer transition-colors"
                    style={sel ? { borderColor: "#2563eb", background: "#eff6ff" } : { borderColor: "#f1f5f9" }}>
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <span className="font-medium">Mur {i + 1}</span>
                      <span className="font-mono text-slate-400">{len.toFixed(2)} m</span>
                      {m.decalage !== 0 && (
                        <button onClick={(e) => { e.stopPropagation(); majMur(m.id, { decalage: -m.decalage }); }}
                          title="Basculer le corps du mur de l'autre côté du nu tracé"
                          className="text-[11px] opacity-50 hover:opacity-100">⇄</button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); supprimerMur(m.id); }}
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
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-[10px] text-slate-400">base</span>
                      <input type="number" step={0.01} value={m.base_y}
                        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majMur(m.id, { base_y: v }); }}
                        className="w-14 border border-slate-200 rounded px-1 py-0.5 text-[11px] font-mono"/>
                      <span className="text-[10px] text-slate-400">m</span>
                    </div>
                    {ouvertures.filter((o) => o.mur_id === m.id).map((o, j) => (
                      <div key={o.id} className="group/ouv ml-1 mt-1 border-l-2 border-orange-200 pl-1.5">
                        <div className="flex items-center gap-1 text-[10px] text-slate-500">
                          <span>🚪 {j + 1}</span>
                          <span className="text-slate-400">l.</span>
                          <input type="number" min={0.2} max={6} step={0.05} value={o.largeur}
                            onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majOuverture(o.id, { largeur: v }); }}
                            className="w-11 border border-slate-200 rounded px-1 py-0.5 text-[10px] font-mono"/>
                          <span className="text-slate-400">h.</span>
                          <input type="number" min={0.2} max={6} step={0.05} value={o.hauteur}
                            onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majOuverture(o.id, { hauteur: v }); }}
                            className="w-11 border border-slate-200 rounded px-1 py-0.5 text-[10px] font-mono"/>
                          <button onClick={(e) => { e.stopPropagation(); supprimerOuverture(o.id); }}
                            className="ml-auto opacity-0 group-hover/ouv:opacity-70 hover:!opacity-100 text-[10px]"
                            title="Supprimer l'ouverture">🗑</button>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 text-[10px] text-slate-400">
                          <span>allège</span>
                          <input type="number" min={0} step={0.05} value={o.allege}
                            onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majOuverture(o.id, { allege: v }); }}
                            className="w-11 border border-slate-200 rounded px-1 py-0.5 text-[10px] font-mono"/>
                          <span>pos.</span>
                          <input type="number" min={0} step={0.05} value={o.pos}
                            onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majOuverture(o.id, { pos: v }); }}
                            className="w-11 border border-slate-200 rounded px-1 py-0.5 text-[10px] font-mono"/>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Dalles */}
        {chantierId && (
          <div className="p-4 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              ⬜ Dalles — {dalles.length}
            </p>
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
              {dalles.map((d, i) => (
                <div key={d.id} className="group border border-slate-100 rounded-lg px-2 py-1.5">
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <span className="font-medium">Dalle {i + 1}</span>
                    <span className="font-mono text-slate-400">{aireDalle(d.points).toFixed(1)} m²</span>
                    <button onClick={() => supprimerDalle(d.id)}
                      className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                      title="Supprimer">🗑</button>
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-[10px] text-slate-400">ép.</span>
                    <input type="number" min={0.05} max={1} step={0.01} value={d.epaisseur}
                      onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majDalle(d.id, { epaisseur: v }); }}
                      className="w-14 border border-slate-200 rounded px-1 py-0.5 text-[11px] font-mono"/>
                    <span className="text-[10px] text-slate-400 ml-1">niv.</span>
                    <input type="number" step={0.01} value={d.base_y}
                      onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majDalle(d.id, { base_y: v }); }}
                      className="w-14 border border-slate-200 rounded px-1 py-0.5 text-[11px] font-mono"/>
                    <span className="text-[10px] text-slate-400">m</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Toits */}
        {chantierId && (
          <div className="p-4 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              🏠 Toits — {toits.length}
            </p>
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
                return (
                  <div key={t.id} className="group border border-slate-100 rounded-lg px-2 py-1.5">
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <span className="font-medium">Pan {i + 1}</span>
                      <span className="font-mono text-slate-400">{aire.toFixed(1)} m² · {pente}°</span>
                      <button onClick={() => supprimerToit(t.id)}
                        className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-xs"
                        title="Supprimer">🗑</button>
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-[10px] text-slate-400">ép.</span>
                      <input type="number" min={0.05} max={1} step={0.01} value={t.epaisseur}
                        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) majToit(t.id, { epaisseur: v }); }}
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
              onClick={() => { (["x", "y", "z", "angle", "tx", "tz"] as const).forEach((k) => updateOffset(selOff.id, k, 0)); }}
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
        {!murMode && !pipette && !mesureMode && !niveauMode && !ouvMode && !dalleMode && !toitMode && !ancreMode && murSel && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur text-xs text-white px-3 py-1.5 rounded-full pointer-events-none">
            ↔ Glissez le corps pour déplacer · les <span className="text-cyan-300">poignées cyan</span> pour allonger/ajuster (accrochage ancres, murs) · Échap : désélectionner
          </div>
        )}
      </div>
    </div>
  );
}
