"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, type Chantier, type Scan } from "@/lib/supabase";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import ViewerMulti, { type ScanLayer } from "@/components/ViewerMulti";

export default function ChantierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { loading: authLoading } = useRequireAuth();
  const [chantier, setChantier] = useState<Chantier | null>(null);
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    async function load() {
      const [{ data: c, error: ce }, { data: s, error: se }] = await Promise.all([
        supabase.from("chantiers").select("*").eq("id", id).single(),
        supabase
          .from("scans")
          .select("*")
          .eq("chantier_id", id)
          .order("captured_at", { ascending: true }),
      ]);
      if (ce || se) { setError((ce ?? se)!.message); setLoading(false); return; }
      setChantier(c as Chantier);
      setScans((s as Scan[]) ?? []);
      setLoading(false);
    }
    load();
  }, [id, authLoading]);

  if (authLoading || loading) {
    return <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">Chargement…</div>;
  }
  if (error) {
    return <div className="p-8 text-red-600">Erreur : {error}</div>;
  }
  if (!chantier) {
    return <div className="p-8 text-slate-500">Chantier introuvable.</div>;
  }

  const readyScans = scans.filter((s) => s.mesh_path);
  const layers: ScanLayer[] = readyScans.map((s) => ({
    id: s.id,
    nom: s.nom,
    meshPath: s.mesh_path,
    offsetX: s.offset_x,
    offsetY: s.offset_y,
    angle: s.offset_angle,
  }));

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Barre chantier */}
      <div
        className="flex items-center gap-3 px-5 py-3 border-b border-slate-200 bg-white shrink-0"
      >
        <Link href="/" className="text-slate-400 hover:text-slate-600 text-sm">← Chantiers</Link>
        <span className="text-slate-300">·</span>
        <div>
          <span className="font-semibold text-slate-800">{chantier.nom}</span>
          {chantier.adresse && (
            <span className="ml-2 text-slate-400 text-sm">{chantier.adresse}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-slate-400 text-sm">
            {scans.length} scan{scans.length !== 1 ? "s" : ""}
            {readyScans.length < scans.length && ` · ${scans.length - readyScans.length} en traitement`}
          </span>
          <Link
            href="/upload"
            className="px-3 py-1.5 rounded-lg text-white text-xs font-medium"
            style={{ background: "var(--orange)" }}
          >
            + Ajouter une pièce
          </Link>
        </div>
      </div>

      {/* Corps */}
      {layers.length === 0 ? (
        <div className="flex-1 flex items-center justify-center flex-col gap-3 text-slate-400">
          <div className="text-5xl opacity-20">🧊</div>
          <p className="font-medium">Aucun scan prêt</p>
          <p className="text-sm">
            {scans.length > 0
              ? "Les scans sont encore en traitement."
              : "Ajoutez votre premier scan glTF."}
          </p>
          <Link
            href="/upload"
            className="mt-2 px-4 py-2 rounded-lg text-white text-sm"
            style={{ background: "var(--navy)" }}
          >
            Importer un scan
          </Link>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <ViewerMulti chantierNom={chantier.nom} scans={layers} />
        </div>
      )}

      {/* Liste des scans non-ready */}
      {scans.some((s) => !s.mesh_path) && (
        <div className="shrink-0 border-t border-slate-100 bg-white px-5 py-2 flex gap-2 overflow-x-auto">
          {scans.filter((s) => !s.mesh_path).map((s) => (
            <div key={s.id} className="flex items-center gap-1.5 text-xs text-slate-400 whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400 inline-block animate-pulse" />
              {s.nom} ({s.status})
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
