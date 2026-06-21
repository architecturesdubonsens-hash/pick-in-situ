# Pick In Situ

Application de relevé LiDAR pour architectes — scan terrain iPhone → plan 2D + modèle 3D → export ArchiCAD.

## Vision

Workflow complet de relevé d'existant :
1. **Scan** : iPhone avec LiDAR → Apple RoomPlan API → données structurées
2. **Sync** : upload automatique vers cloud (Supabase)
3. **View** : viewer web 3D interactif (glTF) + plan 2D généré
4. **Export** : DXF pour ArchiCAD, PDF plan coté, IFC

## Stack technique

### iOS (capture)
- Swift / SwiftUI
- Apple RoomPlan (iOS 16+, iPhone 12 Pro+ LiDAR requis)
- Export : `roomplan.json` (murs/ouvertures structurés) + `mesh.glb` (maillage 3D)
- Upload Supabase Storage

### Web (visualisation + export)
- Next.js 14 (App Router) + TypeScript
- Three.js — viewer glTF 3D interactif
- Génération plan 2D SVG depuis roomplan.json
- Export DXF (dxf-writer) + PDF (pdfkit)

### Backend
- Supabase : auth, storage, base de données
- Edge functions : post-traitement meshes, génération exports

## Structure projet

```
pick in situ/
├── PROJET.md              ← ce fichier
├── web/                   ← Next.js app (viewer + dashboard)
│   ├── app/
│   ├── components/
│   └── lib/
├── ios/                   ← iOS SwiftUI app (specs + code)
│   └── specs/
└── supabase/              ← migrations + edge functions
```

## Schéma de données Supabase

```sql
-- Chantiers (projets de relevé)
chantiers (id, nom, adresse, created_at, user_id)

-- Scans (un chantier peut avoir plusieurs scans)
scans (id, chantier_id, nom, created_at, status)

-- Artifacts (fichiers générés par scan)
artifacts (id, scan_id, type, path, created_at)
-- types : 'roomplan_json' | 'mesh_glb' | 'floorplan_svg' | 'export_dxf' | 'export_pdf'
```

## Roadmap MVP

- [x] Structure projet
- [ ] Schéma Supabase
- [ ] Web viewer Three.js (charge un .glb)
- [ ] Parser roomplan.json → plan 2D SVG
- [ ] Page dashboard chantiers
- [ ] iOS app RoomPlan (Xcode sur Mac requis)
- [ ] Upload scan → Supabase Storage
- [ ] Export DXF
