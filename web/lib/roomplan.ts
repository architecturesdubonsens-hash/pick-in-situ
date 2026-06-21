// Parser pour le format roomplan.json d'Apple RoomPlan
// Transforme les données structurées de scan LiDAR en plan 2D SVG

export interface RoomPlanWall {
  id: string
  transform: number[] // matrice 4x4
  dimensions: { width: number; height: number; length: number }
  confidence: number
}

export interface RoomPlanOpening {
  id: string
  type: 'door' | 'window' | 'opening' | 'doorFrame'
  transform: number[]
  dimensions: { width: number; height: number }
  wall: string // wall id
}

export interface RoomPlanObject {
  id: string
  category: string // 'chair' | 'table' | 'sofa' | 'bed' | 'storage' | ...
  transform: number[]
  dimensions: { width: number; height: number; length: number }
}

export interface RoomPlanSection {
  id: string
  walls: RoomPlanWall[]
  openings: RoomPlanOpening[]
  objects: RoomPlanObject[]
}

export interface RoomPlan {
  version: string
  sections: RoomPlanSection[]
  captureDate: string
}

// Extrait les points 2D depuis une matrice de transformation 4x4 (colonne-major)
export function transformToPoint2D(transform: number[]): { x: number; y: number } {
  return { x: transform[12], y: transform[14] } // X et Z = plan horizontal
}

// Génère un SVG plan 2D depuis un roomplan.json
export function roomPlanToSVG(roomplan: RoomPlan, scale = 100): string {
  const walls: string[] = []
  const openings: string[] = []
  const labels: string[] = []

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (const section of roomplan.sections) {
    for (const wall of section.walls) {
      const pos = transformToPoint2D(wall.transform)
      const len = wall.dimensions.length * scale
      const w = (wall.dimensions.width || 0.2) * scale

      // Angle depuis la matrice de rotation
      const angle = Math.atan2(wall.transform[8], wall.transform[0]) * (180 / Math.PI)

      const x = pos.x * scale
      const y = pos.y * scale

      minX = Math.min(minX, x - len / 2 - w)
      minY = Math.min(minY, y - w)
      maxX = Math.max(maxX, x + len / 2 + w)
      maxY = Math.max(maxY, y + w)

      walls.push(
        `<rect x="${-len / 2}" y="${-w / 2}" width="${len}" height="${w}" ` +
        `fill="#1e3a5f" transform="translate(${x},${y}) rotate(${angle})" />`
      )
    }

    for (const opening of section.openings) {
      const pos = transformToPoint2D(opening.transform)
      const len = opening.dimensions.width * scale
      const x = pos.x * scale
      const y = pos.y * scale
      const angle = Math.atan2(opening.transform[8], opening.transform[0]) * (180 / Math.PI)

      const color = opening.type === 'window' ? '#93c5fd' : '#F97316'
      openings.push(
        `<rect x="${-len / 2}" y="-5" width="${len}" height="10" ` +
        `fill="${color}" opacity="0.8" transform="translate(${x},${y}) rotate(${angle})" />`
      )
    }
  }

  const padding = 50
  const vw = maxX - minX + padding * 2
  const vh = maxY - minY + padding * 2
  const ox = -minX + padding
  const oy = -minY + padding

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <g transform="translate(${ox},${oy})">
    ${walls.join('\n    ')}
    ${openings.join('\n    ')}
    ${labels.join('\n    ')}
  </g>
  <!-- Légende -->
  <rect x="10" y="${vh - 60}" width="16" height="16" fill="#1e3a5f"/>
  <text x="30" y="${vh - 47}" font-size="12" fill="#1e3a5f" font-family="sans-serif">Mur</text>
  <rect x="70" y="${vh - 60}" width="16" height="16" fill="#F97316" opacity="0.8"/>
  <text x="90" y="${vh - 47}" font-size="12" fill="#1e3a5f" font-family="sans-serif">Porte</text>
  <rect x="140" y="${vh - 60}" width="16" height="16" fill="#93c5fd" opacity="0.8"/>
  <text x="160" y="${vh - 47}" font-size="12" fill="#1e3a5f" font-family="sans-serif">Fenêtre</text>
</svg>`
}
