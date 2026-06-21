"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { supabase, type Chantier, type Scan } from "@/lib/supabase";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import type { ScanLayer } from "@/components/ViewerMulti";

// Chargement dynamique (Three.js = client only)
const ViewerMulti   = dynamic(() => import("@/components/ViewerMulti"),   { ssr: false });
const PlanExtractor = dynamic(() => import("@/components/PlanExtractor"), { ssr: false });

type Tab = "3d" | "plans";

export default function ChantierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { loading: authLoading } = useRequireAuth();
  const [chantier, setChantier] = useState<Chantier | null>(null);
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("3d");

  useEffect(() => {
    if (authLoading) return;
    async function load() {
      const [{ data: c, error: ce }, { data: s, error: se }] = await Promise.all([
        supabase.from("chantiers").select("*").eq("id", id).single(),
        supabase.from("scans").select("*").eq("chantier_id", id).order("captured_at", { ascending: true }),
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
  if (error) return <div className="p-8 text-red-600">Erreur : {error}</div>;
  if (!chantier) return <div className="p-8 text-slate-500">Chantier introuvable.</div>;

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

      {/* ── Barre chantier + tabs ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-2 border-b border-slate-200 bg-white shrink-0">
        <Link href="/" className="text-slate-400 hover:text-slate-600 text-sm shrink-0">← Chantiers</Link>
        <span className="text-slate-300">·</span>
        <div className="min-w-0">
          <span className="font-semibold text-slate-800 truncate">{chantier.nom}</span>
          {chantier.adresse && (
            <span className="ml-2 text-slate-400 text-sm hidden sm:inline">{chantier.adresse}</span>
          )}
        </div>

        {/* Tabs */}
        {layers.length > 0 && (
          <div className="flex rounded-lg border border-slate-200 overflow-hidden ml-4">
            {([["3d", "🧊 Vue 3D"], ["plans", "📐 Plans & Façades"]] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className="px-3 py-1.5 text-xs font-medium transition-colors"
                style={tab === key
                  ? { background: "var(--navy)", color: "white" }
                  : { color: "#64748b" }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          <span className="text-slate-400 text-xs shrink-0">
            {scans.length} scan{scans.length !== 1 ? "s" : ""}
            {readyScans.length < scans.length && ` · ${scans.length - readyScans.length} en cours`}
          </span>
          <Link
            href="/upload"
            className="px-3 py-1.5 rounded-lg text-white text-xs font-medium shrink-0"
            style={{ background: "var(--orange)" }}
          >
            + Pièce
          </Link>
        </div>
      </div>

      {/* ── Corps ─────────────────────────────────────────────────────────── */}
      {layers.length === 0 ? (
        <div className="flex-1 flex items-center justify-center flex-col gap-3 text-slate-400">
          <div className="text-5xl opacity-20">🧊</div>
          <p className="font-medium">Aucun scan prêt</p>
          <p className="text-sm">
            {scans.length > 0 ? "Les scans sont encore en traitement." : "Ajoutez votre premier scan glTF."}
          </p>
          <Link href="/upload" className="mt-2 px-4 py-2 rounded-lg text-white text-sm" style={{ background: "var(--navy)" }}>
            Importer un scan
          </Link>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          {tab === "3d"    && <ViewerMulti   chantierNom={chantier.nom} scans={layers} />}
          {tab === "plans" && <PlanExtractor chantierNom={chantier.nom} scans={layers} />}
        </div>
      )}

      {/* ── Scans en traitement ───────────────────────────────────────────── */}
      {scans.some((s) => !s.mesh_path) && (
        <div className="shrink-0 border-t border-slate-100 bg-white px-5 py-2 flex gap-3 overflow-x-auto">
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
