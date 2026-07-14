"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase, db, type Chantier } from "@/lib/supabase";
import { useRequireAuth } from "@/hooks/useRequireAuth";

// Relevés photogrammétriques BC-Archi (bc-archi-v2.vercel.app) — autre projet Supabase.
// Lecture seule avec la clé anon publique : on liste les relevés terminés qui ont un
// mesh GLB, on télécharge le GLB puis il suit le circuit d'upload normal (pis-scans).
const BC_SUPA_URL = "https://fnfrusblyzndbzckkfir.supabase.co";
const BC_SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuZnJ1c2JseXpuZGJ6Y2trZmlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MzA4NDcsImV4cCI6MjA4MzEwNjg0N30.LBIKt0VPkd6gAhBVFuqLDx8f1236yc4W7WKOUuHK3Ts";

interface ReleveBC {
  id: string;
  nom: string;
  created_at: string;
  fichiers: { glb?: string } | null;
}

export default function UploadPage() {
  const { loading: authLoading } = useRequireAuth();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [nomScan, setNomScan] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Chantier : existant ou nouveau
  const [chantiers, setChantiers] = useState<Chantier[]>([]);
  const [chantierId, setChantierId] = useState<string>("__new__");
  const [nomChantier, setNomChantier] = useState("");
  const [adresse, setAdresse] = useState("");

  // Import depuis un relevé photogrammétrique BC-Archi
  const [bcOpen, setBcOpen] = useState(false);
  const [bcReleves, setBcReleves] = useState<ReleveBC[]>([]);
  const [bcLoading, setBcLoading] = useState(false);
  const [bcDownloading, setBcDownloading] = useState<string | null>(null);

  async function openBcList() {
    setBcOpen(!bcOpen);
    if (bcReleves.length || bcLoading) return;
    setBcLoading(true);
    try {
      const r = await fetch(
        `${BC_SUPA_URL}/rest/v1/releves?select=id,nom,created_at,fichiers&statut=eq.completed&order=created_at.desc&limit=50`,
        { headers: { apikey: BC_SUPA_ANON, Authorization: `Bearer ${BC_SUPA_ANON}` } }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = (await r.json()) as ReleveBC[];
      setBcReleves(rows.filter((x) => x.fichiers?.glb));
    } catch (e) {
      setError(`Relevés BC-Archi inaccessibles : ${(e as Error).message}`);
    } finally {
      setBcLoading(false);
    }
  }

  async function importFromBc(rel: ReleveBC) {
    if (!rel.fichiers?.glb || bcDownloading) return;
    setBcDownloading(rel.id);
    setError(null);
    try {
      const r = await fetch(
        `${BC_SUPA_URL}/storage/v1/object/authenticated/releves/${rel.fichiers.glb}`,
        { headers: { apikey: BC_SUPA_ANON, Authorization: `Bearer ${BC_SUPA_ANON}` } }
      );
      if (!r.ok) throw new Error(`téléchargement GLB : HTTP ${r.status}`);
      const blob = await r.blob();
      const f = new File([blob], `releve-bc-${rel.id.slice(0, 8)}.glb`, { type: "model/gltf-binary" });
      setFile(f);
      if (!nomScan) setNomScan(rel.nom || `Relevé extérieur ${rel.id.slice(0, 8)}`);
      setBcOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBcDownloading(null);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    db
      .from("chantiers")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => setChantiers((data as Chantier[]) ?? []));
  }, [authLoading]);

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
    if (!file) return;
    if (chantierId === "__new__" && !nomChantier.trim()) return;
    setError(null);
    setProgress(0);

    try {
      let finalChantierId = chantierId;

      // Créer le chantier si besoin
      if (chantierId === "__new__") {
        setProgress(10);
        const { data: c, error: ce } = await db
          .from("chantiers")
          .insert({ nom: nomChantier.trim(), adresse: adresse.trim() || null })
          .select("id")
          .single();
        if (ce) throw new Error(`Chantier : ${ce.message}`);
        finalChantierId = c.id;
      }

      // Créer le scan
      setProgress(20);
      const scanNom = nomScan.trim() || file.name;
      const { data: scan, error: se } = await db
        .from("scans")
        .insert({ chantier_id: finalChantierId, nom: scanNom, status: "processing" })
        .select("id")
        .single();
      if (se) throw new Error(`Scan : ${se.message}`);

      // Upload glTF
      setProgress(35);
      const ext = file.name.endsWith(".glb") ? "glb" : "gltf";
      const meshPath = `${finalChantierId}/${scan.id}/mesh.${ext}`;
      const { error: ue } = await supabase.storage
        .from("pis-scans")
        .upload(meshPath, file, { contentType: "model/gltf-binary", upsert: true });
      if (ue) throw new Error(`Upload : ${ue.message}`);

      // Mettre à jour le scan
      setProgress(85);
      await db.from("scans").update({ mesh_path: meshPath, status: "ready" }).eq("id", scan.id);

      setProgress(100);
      router.push(`/chantier/${finalChantierId}`);

    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
    }
  }

  const isNewChantier = chantierId === "__new__";
  const ready = file && (isNewChantier ? nomChantier.trim() : true) && progress === null;

  if (authLoading) return (
    <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">Chargement…</div>
  );

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-bold mb-1" style={{ color: "var(--navy)" }}>
        Importer un scan
      </h1>
      <p className="text-slate-500 text-sm mb-8">
        Exportez depuis <strong>Polycam</strong> ou <strong>Scaniverse</strong> (gratuit) au format <strong>glTF / GLB</strong>, puis déposez-le ici —
        ou récupérez directement le maillage d&apos;un relevé photogrammétrique BC-Archi.
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
            <p className="text-slate-400 text-sm mt-1">{(file.size / 1024 / 1024).toFixed(1)} MB · glTF</p>
          </div>
        ) : (
          <div>
            <div className="text-4xl mb-3 opacity-30">📂</div>
            <p className="text-slate-600 font-medium">Déposez votre fichier .glb ici</p>
            <p className="text-slate-400 text-sm mt-1">ou cliquez pour parcourir</p>
          </div>
        )}
      </div>

      {/* Source alternative : relevé photogrammétrique */}
      <div className="mb-6">
        <a
          href="/photo-releve.html"
          target="_blank"
          rel="noopener"
          className="block text-sm font-medium underline-offset-2 hover:underline mb-2"
          style={{ color: "var(--navy)" }}
        >
          📷 …ou créer un relevé photogrammétrique à partir de photos →
        </a>
        <button
          onClick={openBcList}
          className="text-sm font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--navy)" }}
        >
          📡 …ou importer le mesh d&apos;un relevé photogrammétrique existant {bcOpen ? "▴" : "▾"}
        </button>
        {bcOpen && (
          <div className="mt-3 border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-64 overflow-y-auto bg-white">
            {bcLoading && <div className="p-4 text-sm text-slate-400">Chargement des relevés…</div>}
            {!bcLoading && bcReleves.length === 0 && (
              <div className="p-4 text-sm text-slate-400">
                Aucun relevé terminé avec maillage GLB. (Le maillage doit être activé dans les options du relevé.)
              </div>
            )}
            {bcReleves.map((rel) => (
              <button
                key={rel.id}
                onClick={() => importFromBc(rel)}
                disabled={!!bcDownloading}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
              >
                <span>
                  <span className="font-medium text-slate-800">{rel.nom || rel.id.slice(0, 8)}</span>
                  <span className="text-slate-400 ml-2 text-xs">
                    {new Date(rel.created_at).toLocaleDateString("fr-FR")} · {rel.id.slice(0, 8)}…
                  </span>
                </span>
                <span className="text-xs" style={{ color: "var(--orange)" }}>
                  {bcDownloading === rel.id ? "Téléchargement…" : "Importer →"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Formulaire */}
      <div className="grid gap-4 mb-6">

        {/* Chantier : existant ou nouveau */}
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">
            Chantier *
          </label>
          <select
            value={chantierId}
            onChange={(e) => setChantierId(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm bg-white"
          >
            <option value="__new__">+ Nouveau chantier</option>
            {chantiers.map((c) => (
              <option key={c.id} value={c.id}>{c.nom}{c.adresse ? ` — ${c.adresse}` : ""}</option>
            ))}
          </select>
        </div>

        {/* Champs nouveau chantier */}
        {isNewChantier && (
          <>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                Nom du chantier *
              </label>
              <input
                value={nomChantier}
                onChange={(e) => setNomChantier(e.target.value)}
                placeholder="Ex : Appartement Lyon 3e"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
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
          </>
        )}

        {/* Nom du scan */}
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">
            Nom de la pièce / du scan
          </label>
          <input
            value={nomScan}
            onChange={(e) => setNomScan(e.target.value)}
            placeholder="Ex : Salon-cuisine RDC"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
      )}

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

      <button
        onClick={handleUpload}
        disabled={!ready}
        className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-opacity"
        style={{ background: "var(--navy)", opacity: ready ? 1 : 0.4, cursor: ready ? "pointer" : "not-allowed" }}
      >
        Importer et assembler →
      </button>

      <p className="text-center text-xs text-slate-400 mt-4">
        Polycam : Partager → Format → glTF · Qualité Medium/High &nbsp;·&nbsp; Scaniverse : Share → Export Model → GLB
      </p>
    </div>
  );
}
