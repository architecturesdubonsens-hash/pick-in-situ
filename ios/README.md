# Pick In Situ — iOS App

App de capture LiDAR utilisant Apple RoomPlan.

## Prérequis matériel

- iPhone 12 Pro / 12 Pro Max ou plus récent avec LiDAR
- iOS 16.0 minimum
- Mac avec Xcode 15+

## Créer le projet Xcode

1. Ouvrir Xcode → New Project → App
2. Product Name : `PickInSitu`
3. Team : ton compte développeur Apple
4. Interface : SwiftUI
5. Language : Swift
6. Minimum Deployments : iOS 16.0

## Ajouter les fichiers source

Glisser-déposer le dossier `Sources/` dans le navigateur Xcode (cocher "Copy items if needed").

## Configurer le projet

### Info.plist — permissions requises
Ajouter ces clés dans Info.plist :

```xml
<key>NSCameraUsageDescription</key>
<string>Nécessaire pour le scan LiDAR de la pièce</string>

<key>NSLocationWhenInUseUsageDescription</key>
<string>Optionnel — pour géolocaliser le chantier</string>
```

### Config.swift — Supabase
Remplir `Sources/Config/Config.swift` avec les clés Supabase :
- `supabaseURL` : URL du projet Supabase
- `supabaseAnonKey` : clé anon publique

### Framework RoomPlan
Automatiquement disponible via `import RoomPlan` sur iOS 16+.
Pas de dépendance externe à ajouter.

## Structure de l'app

```
PickInSituApp          ← point d'entrée
  └── DashboardView    ← liste des chantiers
        └── CaptureView       ← scan LiDAR en temps réel (RoomCaptureView)
              └── CaptureResultView  ← résumé + upload Supabase
```

## Pipeline de données

```
RoomCaptureSession (LiDAR)
  ↓
RoomBuilder.capturedRoom(from:)   ← post-traitement Apple
  ↓
RoomPlanSerializer.serialize()    ← → roomplan.json (format Pick In Situ v1.0)
CapturedRoom.export(to:)          ← → mesh.usdz
  ↓
SupabaseUploader                  ← upload Storage + insert table "scans"
  ↓
Web viewer (Next.js)              ← lit roomplan.json + mesh.usdz
```

## Format roomplan.json

Compatible avec le parser TypeScript `web/lib/roomplan.ts`.
Contient : version, captureDate, sections[] avec walls[], openings[], objects[].
Chaque élément a : transform (matrice 4×4 colonne-major), dimensions (m), confidence.

## Schéma Supabase minimal

```sql
create table chantiers (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  adresse text,
  user_id uuid references auth.users,
  created_at timestamptz default now()
);

create table scans (
  id uuid primary key,
  chantier_id uuid references chantiers(id),
  nom text,
  status text default 'ready',
  roomplan_path text,
  mesh_path text,
  captured_at timestamptz default now()
);
```

Storage bucket `scans` en accès public (ou RLS selon besoin).
