// Types retournés par Gemini
export interface FacadeElement {
  type: "window" | "door" | "garage" | "balcony" | "column" | "arch" | "cornice" | "pillar" | "chimney";
  label: string;
  x: number;      // bord gauche, fraction [0-1] de la largeur facade
  y: number;      // bord haut, fraction [0-1] de la hauteur facade
  width: number;  // fraction de la largeur
  height: number; // fraction de la hauteur
}

export interface FacadeData {
  facade: {
    aspect_ratio: number;
    floors: number;
    style: string;
    notes: string;
  };
  elements: FacadeElement[];
}

// ─── Couleurs SVG par type ────────────────────────────────────────────────────
export const SVG_COLOR: Record<string, string> = {
  window:  "#00e5ff",
  door:    "#f97316",
  garage:  "#f97316",
  balcony: "#4ade80",
  column:  "#cbd5e1",
  arch:    "#cbd5e1",
  cornice: "#94a3b8",
  pillar:  "#94a3b8",
  chimney: "#f1a340",
};

// ─── Calques DXF par type ─────────────────────────────────────────────────────
const DXF_LAYER: Record<string, { name: string; color: number }> = {
  window:  { name: "FENETRES",  color: 4  },  // cyan
  door:    { name: "PORTES",    color: 30 },  // orange
  garage:  { name: "PORTES",    color: 30 },
  balcony: { name: "BALCONS",   color: 3  },  // vert
  column:  { name: "ELEMENTS",  color: 8  },
  arch:    { name: "ELEMENTS",  color: 8  },
  cornice: { name: "ELEMENTS",  color: 8  },
  pillar:  { name: "ELEMENTS",  color: 8  },
  chimney: { name: "ELEMENTS",  color: 8  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// GÉNÉRATEUR SVG (blueprint dark style)
// ═══════════════════════════════════════════════════════════════════════════════
export function generateBlueprintSVG(data: FacadeData, realWidthM?: number): string {
  const VW = 1000;
  const VH = Math.round(VW / data.facade.aspect_ratio);
  const PAD = 60;

  const fw = VW - PAD * 2;  // largeur zone facade
  const fh = VH - PAD * 2;  // hauteur zone facade
  const fx = PAD;
  const fy = PAD;

  const scaleBar = realWidthM
    ? `<g transform="translate(${fx},${VH - 18})">
        <line x1="0" y1="0" x2="${fw}" y2="0" stroke="#ffffff" stroke-width="1.5"/>
        <line x1="0" y1="-4" x2="0" y2="4" stroke="#ffffff" stroke-width="1.5"/>
        <line x1="${fw}" y1="-4" x2="${fw}" y2="4" stroke="#ffffff" stroke-width="1.5"/>
        <text x="${fw / 2}" y="-7" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="monospace">${realWidthM.toFixed(2)} m</text>
      </g>`
    : "";

  const floorLines = Array.from({ length: data.facade.floors - 1 }, (_, i) => {
    const yf = fy + fh * ((i + 1) / data.facade.floors);
    return `<line x1="${fx}" y1="${yf}" x2="${fx + fw}" y2="${yf}" stroke="#1e3a5f" stroke-width="1" stroke-dasharray="6,4"/>`;
  }).join("\n");

  const elements = data.elements.map((el) => {
    const ex = fx + el.x * fw;
    const ey = fy + el.y * fh;
    const ew = el.width * fw;
    const eh = el.height * fh;
    const color = SVG_COLOR[el.type] ?? "#ffffff";
    return `<rect x="${ex.toFixed(1)}" y="${ey.toFixed(1)}" width="${ew.toFixed(1)}" height="${eh.toFixed(1)}"
      fill="none" stroke="${color}" stroke-width="1.5"/>
<title>${el.label}</title>`;
  }).join("\n");

  // Légende
  const legendItems = [...new Set(data.elements.map((e) => e.type))];
  const legend = legendItems.map((type, i) => {
    const color = SVG_COLOR[type] ?? "#ffffff";
    const labels: Record<string, string> = {
      window: "Fenêtre", door: "Porte", garage: "Garage",
      balcony: "Balcon", column: "Colonne", arch: "Arc",
      cornice: "Corniche", pillar: "Pilier", chimney: "Cheminée",
    };
    return `<rect x="${fx + i * 110}" y="18" width="12" height="12" fill="${color}"/>
<text x="${fx + i * 110 + 16}" y="28" fill="#94a3b8" font-size="11" font-family="monospace">${labels[type] ?? type}</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" style="background:#0a1628;width:100%;height:100%;">
  <!-- Grille -->
  <defs>
    <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M20 0L0 0 0 20" fill="none" stroke="#111e33" stroke-width="0.5"/>
    </pattern>
  </defs>
  <rect width="${VW}" height="${VH}" fill="url(#grid)"/>

  <!-- Légende -->
  ${legend}

  <!-- Niveaux -->
  ${floorLines}

  <!-- Façade outline -->
  <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="#0d1f3c" stroke="#ffffff" stroke-width="2"/>

  <!-- Éléments architecturaux -->
  ${elements}

  <!-- Barre d'échelle -->
  ${scaleBar}

  <!-- Titre -->
  <text x="${fx}" y="${VH - 5}" fill="#334155" font-size="10" font-family="monospace">${data.facade.style} · ${data.facade.floors} niveaux · ${data.facade.notes}</text>
</svg>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GÉNÉRATEUR DXF (calques ArchiCAD/AutoCAD compatibles, unités mm, échelle 1:50)
// ═══════════════════════════════════════════════════════════════════════════════
export function generateDXF(data: FacadeData, realWidthM = 10): string {
  const SCALE = 20;  // 1:50 → 1m réel = 20mm en dessin
  const W = realWidthM;
  const H = realWidthM / data.facade.aspect_ratio;

  const dxfW = W * SCALE;
  const dxfH = H * SCALE;

  // Couches uniques présentes
  const layerSet = new Set<string>(["MURS", "FENETRES", "PORTES", "BALCONS", "ELEMENTS", "COTATIONS"]);

  function poly(x1: number, y1: number, x2: number, y2: number, layer: string): string {
    // DXF Y=0 en bas, SVG Y=0 en haut → inverser Y
    const dyf1 = (dxfH - y2 * SCALE);  // bottom of element in DXF
    const dyf2 = (dxfH - y1 * SCALE);  // top of element in DXF
    const dxf1 = x1 * SCALE;
    const dxf2 = x2 * SCALE;
    return `0\nLWPOLYLINE\n8\n${layer}\n90\n4\n70\n1\n` +
      `10\n${dxf1.toFixed(3)}\n20\n${dyf1.toFixed(3)}\n` +
      `10\n${dxf2.toFixed(3)}\n20\n${dyf1.toFixed(3)}\n` +
      `10\n${dxf2.toFixed(3)}\n20\n${dyf2.toFixed(3)}\n` +
      `10\n${dxf1.toFixed(3)}\n20\n${dyf2.toFixed(3)}\n`;
  }

  function layerDef(name: string, color: number): string {
    return `0\nLAYER\n2\n${name}\n70\n0\n62\n${color}\n6\nCONTINUOUS\n`;
  }

  const layerDefs = [
    layerDef("MURS", 7),
    layerDef("FENETRES", 4),
    layerDef("PORTES", 30),
    layerDef("BALCONS", 3),
    layerDef("ELEMENTS", 8),
    layerDef("COTATIONS", 2),
  ].join("");

  // Lignes de niveaux (tiretés)
  const floorLines = Array.from({ length: data.facade.floors - 1 }, (_, i) => {
    const yFrac = (i + 1) / data.facade.floors;
    const yDxf = (dxfH - yFrac * dxfH).toFixed(3);
    return `0\nLINE\n8\nCOTATIONS\n6\nDASHED\n10\n0\n20\n${yDxf}\n30\n0\n11\n${dxfW.toFixed(3)}\n21\n${yDxf}\n31\n0\n`;
  }).join("");

  // Éléments
  const elementEntities = data.elements.map((el) => {
    const layer = DXF_LAYER[el.type]?.name ?? "ELEMENTS";
    const x1 = el.x * W;
    const x2 = (el.x + el.width) * W;
    const y1 = el.y * H;       // fraction from top
    const y2 = (el.y + el.height) * H;
    return poly(x1, y1, x2, y2, layer) +
      `0\nTEXT\n8\n${layer}\n10\n${(x1 * SCALE).toFixed(3)}\n20\n${(dxfH - y1 * SCALE + 1).toFixed(3)}\n30\n0\n40\n2\n1\n${el.label}\n`;
  }).join("");

  return `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n4\n9\n$MEASUREMENT\n70\n1\n0\nENDSEC\n` +
    `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${layerSet.size}\n${layerDefs}0\nENDTAB\n0\nENDSEC\n` +
    `0\nSECTION\n2\nENTITIES\n` +
    poly(0, 0, W, H, "MURS") +
    floorLines +
    elementEntities +
    `0\nENDSEC\n0\nEOF\n`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DXF DEPUIS PROJECTION GLB (lignes 3D projetées sur un plan 2D)
// Chaque segment = { ax, ay, bx, by } en mètres dans le repère de la vue
// ═══════════════════════════════════════════════════════════════════════════════
export interface Seg2D { ax: number; ay: number; bx: number; by: number }

export function generateProjectionDXF(
  segments: Seg2D[],
  viewLabel: string,
  realW: number,
  realH: number,
  elements?: FacadeElement[],
  sectionSegs?: Seg2D[]
): string {
  const SCALE = 20; // 1:50 → mm

  function dxfLine(s: Seg2D, layer: string) {
    return `0\nLINE\n8\n${layer}\n` +
      `10\n${(s.ax * SCALE).toFixed(3)}\n20\n${((realH - s.ay) * SCALE).toFixed(3)}\n30\n0\n` +
      `11\n${(s.bx * SCALE).toFixed(3)}\n21\n${((realH - s.by) * SCALE).toFixed(3)}\n31\n0\n`;
  }

  function dxfRect(x1m: number, y1m: number, x2m: number, y2m: number, layer: string, label: string) {
    // y1m = top (SVG), y2m = bottom (SVG) → invertir pour DXF
    const ax = (x1m * SCALE).toFixed(3); const bx = (x2m * SCALE).toFixed(3);
    const ay = ((realH - y2m) * SCALE).toFixed(3); const by = ((realH - y1m) * SCALE).toFixed(3);
    return `0\nLWPOLYLINE\n8\n${layer}\n90\n4\n70\n1\n` +
      `10\n${ax}\n20\n${ay}\n10\n${bx}\n20\n${ay}\n10\n${bx}\n20\n${by}\n10\n${ax}\n20\n${by}\n` +
      `0\nTEXT\n8\n${layer}\n10\n${ax}\n20\n${by}\n30\n0\n40\n2\n1\n${label}\n`;
  }

  const hasElements = elements && elements.length > 0;
  const hasPoche = sectionSegs && sectionSegs.length > 0;
  const layerCount = 2 + (hasElements ? 2 : 0) + (hasPoche ? 1 : 0);
  const extraLayers = (hasElements
    ? `0\nLAYER\n2\nFENETRES\n70\n0\n62\n4\n6\nCONTINUOUS\n` +
      `0\nLAYER\n2\nPORTES\n70\n0\n62\n30\n6\nCONTINUOUS\n`
    : "") + (hasPoche
    ? `0\nLAYER\n2\nPOCHE\n70\n0\n62\n250\n6\nCONTINUOUS\n`
    : "");
  const layerDefs =
    `0\nLAYER\n2\nGEOMETRIE\n70\n0\n62\n8\n6\nCONTINUOUS\n` +
    `0\nLAYER\n2\nCOTATIONS\n70\n0\n62\n2\n6\nCONTINUOUS\n` +
    extraLayers;

  const border =
    `0\nLINE\n8\nCOTATIONS\n10\n0\n20\n0\n30\n0\n11\n${(realW * SCALE).toFixed(3)}\n21\n0\n31\n0\n` +
    `0\nLINE\n8\nCOTATIONS\n10\n${(realW * SCALE).toFixed(3)}\n20\n0\n30\n0\n11\n${(realW * SCALE).toFixed(3)}\n21\n${(realH * SCALE).toFixed(3)}\n31\n0\n` +
    `0\nLINE\n8\nCOTATIONS\n10\n${(realW * SCALE).toFixed(3)}\n20\n${(realH * SCALE).toFixed(3)}\n30\n0\n11\n0\n21\n${(realH * SCALE).toFixed(3)}\n31\n0\n` +
    `0\nLINE\n8\nCOTATIONS\n10\n0\n20\n${(realH * SCALE).toFixed(3)}\n30\n0\n11\n0\n21\n0\n31\n0\n`;

  const title = `0\nTEXT\n8\nCOTATIONS\n10\n2\n20\n-8\n30\n0\n40\n4\n1\n${viewLabel} 1:50\n`;

  const elementEntities = (elements ?? []).map((el) => {
    const layer = (el.type === "window" || el.type === "arch") ? "FENETRES" : "PORTES";
    return dxfRect(el.x * realW, el.y * realH, (el.x + el.width) * realW, (el.y + el.height) * realH, layer, el.label);
  }).join("");

  const pocheEntities = (sectionSegs ?? []).map((s) => dxfLine(s, "POCHE")).join("");
  const entities = segments.map((s) => dxfLine(s, "GEOMETRIE")).join("") + pocheEntities + border + title + elementEntities;

  return `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n4\n9\n$MEASUREMENT\n70\n1\n0\nENDSEC\n` +
    `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${layerCount}\n${layerDefs}0\nENDTAB\n0\nENDSEC\n` +
    `0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}
