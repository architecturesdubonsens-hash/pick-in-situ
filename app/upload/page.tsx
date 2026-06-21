"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRequireAuth } from "@/hooks/useRequireAuth";

export default function UploadPage() {
  const { loading: authLoading } = useRequireAuth();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [nomChantier, setNomChantier] = useState("");
  const [nomScan, setNomScan] = useState("");
  const [adresse, setAdresse] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith(".glb") || f.name.endsWith(".gltf"))) {
      setFile(f);
      if (!nomScan) setNomScan(f.name.replace(/\.(glb|gltf)$/, ""));
    } else {
      setError("Fichier non supporté — utilisez un .glb ou .gltf (export Polycam)");
    }
  }, [nomScan]);

  async function handleUpload() {
    if (!file || !nomChantier.trim()) return;
    setError(null);
    setProgress(0);

    try {
      // 1. Créer ou retrouver le chantier
      setProgress(10);
      const { data: chantier, error: ce } = await supabase
        .from("chantiers")
        .insert({ nom: nomChantier.trim(), adresse: adresse.trim() || null })
        .select("id")
        .single();
      if (ce) throw new Error(`Chantier : ${ce.message}`);

      // 2. Créer le scan (status processing)
      setProgress(20);
      const scanNom = nomScan.trim() || file.name;
      const { data: scan, error: se } = await supabase
        .from("scans")
        .insert({ chantier_id: chantier.id, nom: scanNom, status: "processing" })
        .select("id")
        .single();
      if (se) throw new Error(`Scan : ${se.message}`);

      // 3. Upload du fichier glTF vers Supabase Storage
      setProgress(35);
      const ext = file.name.endsWith(".glb") ? "glb" : "gltf";
      const meshPath = `${chantier.id}/${scan.id}/mesh.${ext}`;
      const { error: ue } = await supabase.storage
        .from("pis-scans")
        .upload(meshPath, file, { contentType: "model/gltf-binary", upsert: true });
      if (ue) throw new Error(`Upload : ${ue.message}`);

      // 4. Mettre à jour le scan avec le chemin et status ready
      setProgress(85);
      const { error: upe } = await supabase
        .from("scans")
        .update({ mesh_path: meshPath, status: "ready" })
        .eq("id", scan.id);
      if (upe) throw new Error(`Update : ${upe.message}`);

      setProgress(100);
      router.push(`/scan/${scan.id}`);

    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
    }
  }

  const ready = file && nomChantier.trim() && progress === null;

  if (authLoading) return <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">Chargement…</div>;

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-bold mb-1" style={{ color: "var(--navy)" }}>
        Importer un scan
      </h1>
      <p className="text-slate-500 text-sm mb-8">
        Exportez votre scan depuis Polycam au format <strong>glTF / GLB</strong>, puis déposez-le ici.
      </p>

      {/* Zone drop */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className="cursor-pointer rounded-2xl border-2 border-dashed transition-colors p-10 text-center mb-6"
        style={{
          borderColor: dragging ? "var(--orange)" : file ? "var(--navy)" : "#cbd5e1",
          background: dragging ? "#fff7ed" : file ? "#f0f4f8" : "white",
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".glb,.gltf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) { setFile(f); if (!nomScan) setNomScan(f.name.replace(/\.(glb|gltf)$/, "")); }
          }}
        />
        {file ? (
          <div>
            <div className="text-4xl mb-2">🧊</div>
            <p className="font-semibold text-slate-800">{file.name}</p>
            <p className="text-slate-400 text-sm mt-1">
              {(file.size / 1024 / 1024).toFixed(1)} MB · glTF
            </p>
          </div>
        ) : (
          <div>
            <div className="text-4xl mb-3 opacity-30">📂</div>
            <p className="text-slate-600 font-medium">
              Déposez votre fichier .glb ici
            </p>
            <p className="text-slate-400 text-sm mt-1">ou cliquez pour parcourir</p>
          </div>
        )}
      </div>

      {/* Formulaire */}
      <div className="grid gap-4 mb-6">
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">
            Nom du chantier *
          </label>
          <input
            value={nomChantier}
            onChange={(e) => setNomChantier(e.target.value)}
            placeholder="Ex : Appartement Lyon 3e"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
            style={{ "--tw-ring-color": "var(--orange)" } as React.CSSProperties}
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">
            Adresse
          </label>
          <input
            value={adresse}
            onChange={(e) => setAdresse(e.target.value)}
            placeholder="Ex : 12 rue de la Paix, Lyon 69003"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">
            Nom du scan
          </label>
          <input
            value={nomScan}
            onChange={(e) => setNomScan(e.target.value)}
            placeholder="Ex : RDC salon-cuisine"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
          />
        </div>
      </div>

      {/* Erreur */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Progression */}
      {progress !== null && (
        <div className="mb-4">
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>Upload en cours…</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${progress}%`, background: "var(--orange)" }}
            />
          </div>
        </div>
      )}

      {/* Bouton */}
      <button
        onClick={handleUpload}
        disabled={!ready}
        className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-opacity"
        style={{
          background: "var(--navy)",
          opacity: ready ? 1 : 0.4,
          cursor: ready ? "pointer" : "not-allowed",
        }}
      >
        Importer et visualiser →
      </button>

      <p className="text-center text-xs text-slate-400 mt-4">
        Export Polycam : onglet Partager → Format → glTF · Qualité → Medium ou High
      </p>
    </div>
  );
}
