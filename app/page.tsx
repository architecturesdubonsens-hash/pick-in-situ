"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, type Chantier, type Scan } from "@/lib/supabase";
import { useRequireAuth } from "@/hooks/useRequireAuth";

interface ChantierWithScans extends Chantier {
  scans: Pick<Scan, "id" | "status">[];
}

function statusBadge(scans: Pick<Scan, "status">[]) {
  if (scans.length === 0) return { label: "vide", cls: "bg-slate-100 text-slate-500" };
  const hasProcessing = scans.some((s) => s.status === "processing" || s.status === "capturing");
  if (hasProcessing) return { label: "en cours", cls: "bg-orange-100 text-orange-800" };
  return { label: "prêt", cls: "bg-green-100 text-green-800" };
}

export default function Dashboard() {
  const { loading: authLoading } = useRequireAuth();
  const [chantiers, setChantiers] = useState<ChantierWithScans[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    supabase
      .from("chantiers")
      .select("*, scans(id, status)")
      .order("created_at", { ascending: false })
      .then(({ data, error: e }) => {
        if (e) setError(e.message);
        else setChantiers((data as ChantierWithScans[]) ?? []);
        setDataLoading(false);
      });
  }, [authLoading]);

  if (authLoading || dataLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        Chargement…
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--navy)" }}>
            Mes chantiers
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {chantiers.length > 0
              ? `${chantiers.length} chantier${chantiers.length > 1 ? "s" : ""} · ${chantiers.reduce((n, c) => n + c.scans.length, 0)} scan${chantiers.reduce((n, c) => n + c.scans.length, 0) > 1 ? "s" : ""}`
              : "Aucun relevé pour l'instant"}
          </p>
        </div>
        <Link
          href="/upload"
          className="px-4 py-2 rounded-lg text-white text-sm font-medium"
          style={{ background: "var(--orange)" }}
        >
          + Importer un scan
        </Link>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          Erreur : {error}
        </div>
      )}

      {chantiers.length === 0 && !error ? (
        <div className="p-12 rounded-2xl border-2 border-dashed border-slate-200 text-center">
          <div className="text-4xl mb-3 opacity-20">🏗</div>
          <p className="text-slate-500 font-medium">Aucun chantier</p>
          <p className="text-slate-400 text-sm mt-1">
            Importez un premier scan glTF pour commencer
          </p>
          <Link
            href="/upload"
            className="inline-block mt-4 px-5 py-2 rounded-lg text-white text-sm font-medium"
            style={{ background: "var(--navy)" }}
          >
            Importer un scan
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {chantiers.map((c) => {
            const { label, cls } = statusBadge(c.scans);
            const lastScan = c.scans[0];
            return (
              <Link
                key={c.id}
                href={`/chantier/${c.id}`}
                className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex items-center justify-between hover:shadow-md transition-shadow"
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl shrink-0"
                    style={{ background: "var(--navy)" }}
                  >
                    {c.nom[0].toUpperCase()}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800">{c.nom}</p>
                    {c.adresse && <p className="text-slate-500 text-sm">{c.adresse}</p>}
                    <p className="text-slate-400 text-xs mt-1">
                      {c.scans.length} scan{c.scans.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${cls}`}>
                    {label}
                  </span>
                  <span className="text-slate-400 text-sm">
                    {new Date(c.created_at).toLocaleDateString("fr-FR")}
                  </span>
                  <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <div className="mt-6 p-4 rounded-lg border-2 border-dashed border-slate-200 text-center text-slate-400 text-sm">
        Scannez un espace avec votre iPhone LiDAR → les scans apparaîtront ici automatiquement
      </div>
    </div>
  );
}
