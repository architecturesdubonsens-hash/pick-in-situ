// Parser Apple RoomPlan → plan 2D SVG

export interface RoomPlanWall {
  id: string;
  transform: number[]; // matrice 4x4 colonne-major
  dimensions: { width: number; height: number; length: number };
  confidence: number;
}

export interface RoomPlanOpening {
  id: string;
  type: "door" | "window" | "opening" | "doorFrame";
  transform: number[];
  dimensions: { width: number; height: number };
}

export interface RoomPlanSection {
  id: string;
  walls: RoomPlanWall[];
  openings: RoomPlanOpening[];
}

export interface RoomPlan {
  version: string;
  sections: RoomPlanSection[];
  captureDate: string;
}

function transformToXZ(t: number[]) {
  return { x: t[12], z: t[14] };
}

export function roomPlanToSVG(roomplan: RoomPlan, scale = 80): string {
  const wallRects: string[] = [];
  const openingRects: string[] = [];

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const section of roomplan.sections) {
    for (const wall of section.walls) {
      const { x, z } = transformToXZ(wall.transform);
      const len = wall.dimensions.length * scale;
      const thick = (wall.dimensions.width || 0.2) * scale;
      const angle = Math.atan2(wall.transform[8], wall.transform[0]) * (180 / Math.PI);
      const sx = x * scale, sz = z * scale;

      minX = Math.min(minX, sx - len / 2 - thick);
      minZ = Math.min(minZ, sz - thick);
      maxX = Math.max(maxX, sx + len / 2 + thick);
      maxZ = Math.max(maxZ, sz + thick);

      wallRects.push(
        `<rect x="${-len / 2}" y="${-thick / 2}" width="${len}" height="${thick}" ` +
        `fill="#1e3a5f" transform="translate(${sx},${sz}) rotate(${angle})"/>`
      );
    }

    for (const op of section.openings) {
      const { x, z } = transformToXZ(op.transform);
      const len = op.dimensions.width * scale;
      const angle = Math.atan2(op.transform[8], op.transform[0]) * (180 / Math.PI);
      const sx = x * scale, sz = z * scale;
      const color = op.type === "window" ? "#93c5fd" : "#F97316";

      openingRects.push(
        `<rect x="${-len / 2}" y="-6" width="${len}" height="12" ` +
        `fill="${color}" opacity="0.85" transform="translate(${sx},${sz}) rotate(${angle})"/>`
      );
    }
  }

  const pad = 50;
  const vw = maxX - minX + pad * 2;
  const vh = maxZ - minZ + pad * 2;
  const ox = -minX + pad;
  const oz = -minZ + pad;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <g transform="translate(${ox},${oz})">
    ${wallRects.join("\n    ")}
    ${openingRects.join("\n    ")}
  </g>
  <rect x="10" y="${vh - 56}" width="14" height="14" fill="#1e3a5f"/>
  <text x="28" y="${vh - 45}" font-size="11" fill="#1e3a5f" font-family="sans-serif">Mur</text>
  <rect x="68" y="${vh - 56}" width="14" height="14" fill="#F97316" opacity="0.85"/>
  <text x="86" y="${vh - 45}" font-size="11" fill="#1e3a5f" font-family="sans-serif">Porte</text>
  <rect x="136" y="${vh - 56}" width="14" height="14" fill="#93c5fd" opacity="0.85"/>
  <text x="154" y="${vh - 45}" font-size="11" fill="#1e3a5f" font-family="sans-serif">Fenêtre</text>
</svg>`;
}
