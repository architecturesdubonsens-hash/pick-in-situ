/**
 * bim-export.ts — Export de la maquette scan-to-BIM (PickInSitu)
 *
 * • buildBimIFC   → fichier IFC4 (STEP/SPF) 100 % navigateur, sans dépendance :
 *     IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey
 *     IfcWallStandardCase (avec IfcOpeningElement percés), IfcSlab .FLOOR. (dalles
 *     polygonales), IfcSlab .ROOF. (pans inclinés, placement 3D orienté).
 * • buildBimPlanDXF → plan DXF (calques MURS / OUVERTURES / DALLES / TOITS).
 *
 * Repère : Three.js est Y-up MAIN DROITE (x, y=haut, z) ; IFC est Z-up main
 * droite. Le mapping (x,y,z)→(x,z,y) est un MIROIR (det −1 : maquette
 * symétrique dans ArchiCAD). Le mapping correct est la rotation pure
 * (x, y, z)_monde → (x, −z, y)_IFC, appliquée aux points ET aux directions.
 */

export interface MurEx {
  id: string; ax: number; az: number; bx: number; bz: number;
  epaisseur: number; hauteur: number; base_y: number; decalage: number;
}
export interface OuvertureEx {
  id: string; mur_id: string; pos: number; largeur: number; hauteur: number; allege: number;
}
export interface DalleEx { id: string; points: [number, number][]; epaisseur: number; base_y: number; }
export interface ToitEx {
  id: string; p1: [number, number, number]; p2: [number, number, number];
  p3: [number, number, number]; epaisseur: number;
}
export interface BimModel {
  murs: MurEx[]; ouvertures: OuvertureEx[]; dalles: DalleEx[]; toits: ToitEx[];
}

// ─── Écrivain STEP ────────────────────────────────────────────────────────────

class StepWriter {
  lines: string[] = [];
  id = 0;
  add(txt: string) { this.id += 1; this.lines.push(`#${this.id}=${txt};`); return this.id; }
  ref(id: number) { return `#${id}`; }
}

const F = (v: number) => {
  const s = String(Math.round(v * 1e5) / 1e5);
  return s.includes(".") || s.includes("e") ? s : s + ".";
};
const T = (s: string) =>
  `'${String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")
    .replace(/[^\x20-\x7E]/g, (c) => "\\X2\\" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") + "\\X0\\")}'`;

const GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
function ifcGuid() {
  let s = GUID_CHARS[Math.floor(Math.random() * 4)];
  for (let i = 0; i < 21; i++) s += GUID_CHARS[Math.floor(Math.random() * 64)];
  return s;
}

// Placement local absolu, rotation autour de l'axe Z (IFC) d'angle `angleRad`
function placementZ(w: StepWriter, x: number, y: number, z: number, angleRad = 0) {
  const pt = w.add(`IFCCARTESIANPOINT((${F(x)},${F(y)},${F(z)}))`);
  let axis: number;
  if (Math.abs(angleRad) > 1e-9) {
    const dirX = w.add(`IFCDIRECTION((${F(Math.cos(angleRad))},${F(Math.sin(angleRad))},0.))`);
    const dirZ = w.add(`IFCDIRECTION((0.,0.,1.))`);
    axis = w.add(`IFCAXIS2PLACEMENT3D(${w.ref(pt)},${w.ref(dirZ)},${w.ref(dirX)})`);
  } else {
    axis = w.add(`IFCAXIS2PLACEMENT3D(${w.ref(pt)},$,$)`);
  }
  return w.add(`IFCLOCALPLACEMENT($,${w.ref(axis)})`);
}

// Placement local absolu 3D orienté (axe Z + direction X arbitraires) — pour toitures
function placement3D(
  w: StepWriter, p: [number, number, number],
  axisZ: [number, number, number], refX: [number, number, number]
) {
  const pt = w.add(`IFCCARTESIANPOINT((${F(p[0])},${F(p[1])},${F(p[2])}))`);
  const dZ = w.add(`IFCDIRECTION((${F(axisZ[0])},${F(axisZ[1])},${F(axisZ[2])}))`);
  const dX = w.add(`IFCDIRECTION((${F(refX[0])},${F(refX[1])},${F(refX[2])}))`);
  const axis = w.add(`IFCAXIS2PLACEMENT3D(${w.ref(pt)},${w.ref(dZ)},${w.ref(dX)})`);
  return w.add(`IFCLOCALPLACEMENT($,${w.ref(axis)})`);
}

// Rectangle (dimX × dimY, centre cx,cy) extrudé de `h` selon +Z local
function rectExtrude(w: StepWriter, ctx: number, dimX: number, dimY: number, h: number,
                     cx: number, cy: number, dirZ: readonly [number, number, number] = [0, 0, 1]) {
  const pos2d = w.add(`IFCAXIS2PLACEMENT2D(${w.ref(w.add(`IFCCARTESIANPOINT((${F(cx)},${F(cy)}))`))},$)`);
  const profil = w.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${w.ref(pos2d)},${F(dimX)},${F(dimY)})`);
  const posE = w.add(`IFCAXIS2PLACEMENT3D(${w.ref(w.add(`IFCCARTESIANPOINT((0.,0.,0.))`))},$,$)`);
  const dir = w.add(`IFCDIRECTION((${F(dirZ[0])},${F(dirZ[1])},${F(dirZ[2])}))`);
  const corps = w.add(`IFCEXTRUDEDAREASOLID(${w.ref(profil)},${w.ref(posE)},${w.ref(dir)},${F(h)})`);
  const rep = w.add(`IFCSHAPEREPRESENTATION(${w.ref(ctx)},'Body','SweptSolid',(${w.ref(corps)}))`);
  return w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${w.ref(rep)}))`);
}

// ─── Générateur IFC ───────────────────────────────────────────────────────────

export function buildBimIFC(model: BimModel, nomProjet = "Relevé"): string {
  const w = new StepWriter();

  const ptO = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
  const axM = w.add(`IFCAXIS2PLACEMENT3D(${w.ref(ptO)},$,$)`);
  const ctx = w.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${w.ref(axM)},$)`);
  const uL = w.add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`);
  const uA = w.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
  const uV = w.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
  const unites = w.add(`IFCUNITASSIGNMENT((${w.ref(uL)},${w.ref(uA)},${w.ref(uV)}))`);

  const projet = w.add(`IFCPROJECT('${ifcGuid()}',$,${T(nomProjet)},$,$,$,$,(${w.ref(ctx)}),${w.ref(unites)})`);
  const pSite = placementZ(w, 0, 0, 0);
  const site = w.add(`IFCSITE('${ifcGuid()}',$,'Site',$,$,${w.ref(pSite)},$,$,.ELEMENT.,$,$,$,$,$)`);
  const pBat = placementZ(w, 0, 0, 0);
  const bat = w.add(`IFCBUILDING('${ifcGuid()}',$,${T("Bâtiment — " + nomProjet)},$,$,${w.ref(pBat)},$,$,.ELEMENT.,$,$,$)`);
  const pSto = placementZ(w, 0, 0, 0);
  const storey = w.add(`IFCBUILDINGSTOREY('${ifcGuid()}',$,'Relevé',$,$,${w.ref(pSto)},$,$,.ELEMENT.,0.)`);
  w.add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${w.ref(projet)},(${w.ref(site)}))`);
  w.add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${w.ref(site)},(${w.ref(bat)}))`);
  w.add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${w.ref(bat)},(${w.ref(storey)}))`);

  const contenu: number[] = [];

  // ── Murs (+ percements) ──
  for (const m of model.murs) {
    const dx = m.bx - m.ax, dz = m.bz - m.az;
    const len = Math.hypot(dx, dz);
    if (len < 0.02) continue;
    const off = (m.decalage ?? 0) * m.epaisseur;   // décalage perpendiculaire du corps
    // IFC XY = (monde x, −monde z) ; Z = hauteur monde. L'axe du mur devient
    // (dx, −dz) → angle atan2(−dz, dx) ; la perpendiculaire monde du décalage
    // correspond à −Y local IFC, d'où cy = −off dans les profils.
    const place = placementZ(w, m.ax, -m.az, m.base_y, Math.atan2(-dz, dx));
    const forme = rectExtrude(w, ctx, len, m.epaisseur, m.hauteur, len / 2, -off);
    const mur = w.add(`IFCWALL('${ifcGuid()}',$,${T("Mur")},$,$,${w.ref(place)},${w.ref(forme)},$,.SOLIDWALL.)`);
    contenu.push(mur);

    for (const o of model.ouvertures.filter((x) => x.mur_id === m.id)) {
      const pOuv = placementZ(w, m.ax + (dx / len) * o.pos, -(m.az + (dz / len) * o.pos),
                              m.base_y + o.allege, Math.atan2(-dz, dx));
      const fOuv = rectExtrude(w, ctx, o.largeur, m.epaisseur + 0.2, o.hauteur, 0, -off);
      const op = w.add(`IFCOPENINGELEMENT('${ifcGuid()}',$,${T("Baie")},$,$,${w.ref(pOuv)},${w.ref(fOuv)},$,.OPENING.)`);
      w.add(`IFCRELVOIDSELEMENT('${ifcGuid()}',$,$,$,${w.ref(mur)},${w.ref(op)})`);
    }
  }

  // ── Dalles (polygone au sol, extrudé vers le bas) ──
  for (const d of model.dalles) {
    if (d.points.length < 3) continue;
    const pts = d.points.map(([x, z]) => w.add(`IFCCARTESIANPOINT((${F(x)},${F(-z)}))`));
    const poly = w.add(`IFCPOLYLINE((${[...pts, pts[0]].map((p) => w.ref(p)).join(",")}))`);
    const profil = w.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${w.ref(poly)})`);
    const posE = w.add(`IFCAXIS2PLACEMENT3D(${w.ref(w.add(`IFCCARTESIANPOINT((0.,0.,${F(d.base_y)}))`))},$,$)`);
    const dirBas = w.add(`IFCDIRECTION((0.,0.,-1.))`);
    const corps = w.add(`IFCEXTRUDEDAREASOLID(${w.ref(profil)},${w.ref(posE)},${w.ref(dirBas)},${F(d.epaisseur)})`);
    const rep = w.add(`IFCSHAPEREPRESENTATION(${w.ref(ctx)},'Body','SweptSolid',(${w.ref(corps)}))`);
    const forme = w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${w.ref(rep)}))`);
    const place = placementZ(w, 0, 0, 0);
    const dalle = w.add(`IFCSLAB('${ifcGuid()}',$,${T("Dalle")},$,$,${w.ref(place)},${w.ref(forme)},$,.FLOOR.)`);
    contenu.push(dalle);
  }

  // ── Toits (pan incliné, placement 3D orienté sur le rampant) ──
  for (const t of model.toits) {
    const p1 = t.p1, p2 = t.p2, p3 = t.p3;
    const e: [number, number, number] = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const eLen = Math.hypot(e[0], e[1], e[2]);
    if (eLen < 0.05) continue;
    const el: [number, number, number] = [e[0] / eLen, e[1] / eLen, e[2] / eLen];
    let s: [number, number, number] = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    const sd = s[0] * el[0] + s[1] * el[1] + s[2] * el[2];
    s = [s[0] - sd * el[0], s[1] - sd * el[1], s[2] - sd * el[2]];
    const sLen = Math.hypot(s[0], s[1], s[2]);
    if (sLen < 0.05) continue;
    // normale monde = e × s
    let n: [number, number, number] = [
      e[1] * s[2] - e[2] * s[1], e[2] * s[0] - e[0] * s[2], e[0] * s[1] - e[1] * s[0],
    ];
    const nLen = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nLen, n[1] / nLen, n[2] / nLen];
    // Si la normale pointe vers le bas on la retourne pour que la face p1p2p3
    // reste la face SUPÉRIEURE — mais le Y local (n × el) se retourne alors
    // aussi : le profil doit couvrir [−sLen, 0] au lieu de [0, sLen], sinon le
    // pan part du mauvais côté de l'égout (toit « détaché » constaté).
    let flip = false;
    if (n[1] < 0) { n = [-n[0], -n[1], -n[2]]; flip = true; }
    // Y-up monde → Z-up IFC : rotation pure (x,y,z) → (x,−z,y)
    const map3 = (v: [number, number, number]): [number, number, number] => [v[0], -v[2], v[1]];
    const place = placement3D(w, map3(p1), map3(n), map3(el));
    // profil rectangle |e| × |s|, extrudé de l'épaisseur vers −Z local (sous le rampant)
    const forme = rectExtrude(w, ctx, eLen, sLen, t.epaisseur, eLen / 2, flip ? -sLen / 2 : sLen / 2, [0, 0, -1]);
    const toit = w.add(`IFCSLAB('${ifcGuid()}',$,${T("Pan de toiture")},$,$,${w.ref(place)},${w.ref(forme)},$,.ROOF.)`);
    contenu.push(toit);
  }

  if (contenu.length)
    w.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',$,$,$,(${contenu.map((i) => w.ref(i)).join(",")}),${w.ref(storey)})`);

  const horo = new Date().toISOString().slice(0, 19);
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME(${T(nomProjet + ".ifc")},'${horo}',(''),('PickInSitu'),'pickinsitu-bim-v1','pickinsitu-bim-v1','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${w.lines.join("\n")}
ENDSEC;
END-ISO-10303-21;
`;
}

// ─── Générateur DXF (plan) ────────────────────────────────────────────────────

export function buildBimPlanDXF(model: BimModel): string {
  const S = 100; // mètres → centimètres (cohérent avec les autres exports DXF)
  const N = (v: number) => (v * S).toFixed(3);

  // Les paires reçues sont (x, z) monde Three.js (Y-up main droite) : vu de
  // dessus, le plan papier correct est (x, −z) — sans quoi le plan est en miroir.
  const lwpoly = (layer: string, pts: [number, number][]) =>
    `0\nLWPOLYLINE\n8\n${layer}\n90\n${pts.length}\n70\n1\n` +
    pts.map(([x, y]) => `10\n${N(x)}\n20\n${N(-y)}\n`).join("");
  const line = (layer: string, a: [number, number], b: [number, number]) =>
    `0\nLINE\n8\n${layer}\n10\n${N(a[0])}\n20\n${N(-a[1])}\n30\n0\n11\n${N(b[0])}\n21\n${N(-b[1])}\n31\n0\n`;

  let ent = "";
  // Murs : empreinte rectangulaire (nu selon décalage) — plan = (monde x, monde z)
  for (const m of model.murs) {
    const dx = m.bx - m.ax, dz = m.bz - m.az;
    const len = Math.hypot(dx, dz);
    if (len < 0.02) continue;
    const ux = dx / len, uz = dz / len;   // axe
    const px = -uz, pz = ux;              // perpendiculaire
    const off = (m.decalage ?? 0) * m.epaisseur, h = m.epaisseur / 2;
    const cAx = m.ax + px * off, cAz = m.az + pz * off;
    const cBx = m.bx + px * off, cBz = m.bz + pz * off;
    ent += lwpoly("MURS", [
      [cAx + px * h, cAz + pz * h], [cBx + px * h, cBz + pz * h],
      [cBx - px * h, cBz - pz * h], [cAx - px * h, cAz - pz * h],
    ]);
    for (const o of model.ouvertures.filter((x) => x.mur_id === m.id)) {
      const ox = m.ax + ux * o.pos + px * off, oz = m.az + uz * o.pos + pz * off;
      ent += line("OUVERTURES", [ox + px * h, oz + pz * h], [ox - px * h, oz - pz * h]);
    }
  }
  for (const d of model.dalles) {
    if (d.points.length < 3) continue;
    ent += lwpoly("DALLES", d.points);
  }
  for (const t of model.toits) {
    const a: [number, number] = [t.p1[0], t.p1[2]];
    const b: [number, number] = [t.p2[0], t.p2[2]];
    const sx = t.p3[0] - t.p1[0], sz = t.p3[2] - t.p1[2];
    ent += lwpoly("TOITS", [a, b, [b[0] + sx, b[1] + sz], [a[0] + sx, a[1] + sz]]);
  }

  const layerDefs =
    `0\nLAYER\n2\nMURS\n70\n0\n62\n8\n6\nCONTINUOUS\n` +
    `0\nLAYER\n2\nOUVERTURES\n70\n0\n62\n4\n6\nCONTINUOUS\n` +
    `0\nLAYER\n2\nDALLES\n70\n0\n62\n30\n6\nCONTINUOUS\n` +
    `0\nLAYER\n2\nTOITS\n70\n0\n62\n250\n6\nCONTINUOUS\n`;

  return `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n5\n9\n$MEASUREMENT\n70\n1\n0\nENDSEC\n` +
    `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n4\n${layerDefs}0\nENDTAB\n0\nENDSEC\n` +
    `0\nSECTION\n2\nENTITIES\n${ent}0\nENDSEC\n0\nEOF\n`;
}
