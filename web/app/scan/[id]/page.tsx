"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";

// Chargement client-only (Three.js ne tourne pas en SSR)
const Viewer3D = dynamic(() => import("@/components/Viewer3D"), { ssr: false });

// Données mock — seront remplacées par Supabase
const MOCK_DATA: Record<string, {
  nom: string; adresse: string; surface: number; pieces: number; hauteur: number; date: string;
}> = {
  "demo-appartement": { nom: "Appartement Rue de la Paix", adresse: "Paris 75002", surface: 78, pieces: 4, hauteur: 2.7, date: "2026-06-20" },
  "demo-bureau": { nom: "Bureaux Toulouse Centre", adresse: "Toulouse 31000", surface: 120, pieces: 6, hauteur: 2.8, date: "2026-06-18" },
  "demo-entrepot": { nom: "Entrepôt Montbartier", adresse: "Montbartier 82700", surface: 2400, pieces: 3, hauteur: 9.5, date: "2026-06-15" },
};

export default function ScanPage({ params }: { params: { id: string } }) {
  const [view, setView] = useState<"3d" | "plan">("3d");
  const data = MOCK_DATA[params.id] ?? MOCK_DATA["demo-appartement"];

  return (
    <div className="h-[calc(100vh-56px)] flex flex-col">
      {/* Barre de navigation */}
      <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-slate-400 hover:text-slate-600 text-sm">← Chantiers</Link>
          <span className="text-slate-300">/</span>
          <span className="font-medium text-slate-800 text-sm">{data.nom}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Toggle 3D / Plan */}
          <div className="flex rounded-lg border border-slate-200 overflow-hidden">
            <button
              onClick={() => setView("3d")}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                view === "3d" ? "text-white" : "text-slate-500 hover:bg-slate-50"
              }`}
              style={view === "3d" ? { background: "var(--navy)" } : {}}
            >
              3D
            </button>
            <button
              onClick={() => setView("plan")}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                view === "plan" ? "text-white" : "text-slate-500 hover:bg-slate-50"
              }`}
              style={view === "plan" ? { background: "var(--navy)" } : {}}
            >
              Plan
            </button>
          </div>
          {/* Exports */}
          <button className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600">
            ↓ DXF
          </button>
          <button className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600">
            ↓ PDF
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded-lg text-white"
            style={{ background: "var(--orange)" }}
          >
            ↓ glTF
          </button>
        </div>
      </div>

      {/* Contenu principal */}
      <div className="flex flex-1 overflow-hidden">
        {/* Viewer */}
        <div className="flex-1 relative">
          {view === "3d" ? (
            <Viewer3D />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-slate-100">
              <div className="text-center text-slate-400">
                <svg className="w-16 h-16 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
                <p className="text-sm">Plan 2D généré depuis roomplan.json</p>
                <p className="text-xs text-slate-300 mt-1">Importez un scan depuis l&apos;app iOS</p>
              </div>
            </div>
          )}
        </div>

        {/* Panneau latéral */}
        <aside className="w-72 bg-white border-l border-slate-200 flex flex-col overflow-y-auto">
          {/* Infos scan */}
          <div className="p-4 border-b border-slate-100">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Données du scan</h2>
            <dl className="grid grid-cols-2 gap-3">
              {[
                { label: "Surface", value: `${data.surface} m²` },
                { label: "Pièces", value: `${data.pieces}` },
                { label: "Hauteur", value: `${data.hauteur} m` },
                { label: "Date", value: data.date },
              ].map(({ label, value }) => (
                <div key={label}>
                  <dt className="text-xs text-slate-400">{label}</dt>
                  <dd className="font-semibold text-slate-800 text-sm">{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Éléments détectés */}
          <div className="p-4 border-b border-slate-100">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Éléments détectés</h2>
            {[
              { icon: "◼", label: "Murs", count: 12, color: "#1e3a5f" },
              { icon: "▬", label: "Portes", count: 4, color: "#F97316" },
              { icon: "▭", label: "Fenêtres", count: 6, color: "#3b82f6" },
              { icon: "▪", label: "Mobilier", count: 8, color: "#94a3b8" },
            ].map(({ icon, label, count, color }) => (
              <div key={label} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-2">
                  <span style={{ color }} className="text-sm">{icon}</span>
                  <span className="text-sm text-slate-600">{label}</span>
                </div>
                <span className="text-sm font-medium text-slate-800">{count}</span>
              </div>
            ))}
          </div>

          {/* Actions export */}
          <div className="p-4">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Exporter</h2>
            <div className="grid gap-2">
              <button className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm text-slate-700 flex items-center gap-2">
                <span>📐</span> DXF pour ArchiCAD
              </button>
              <button className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm text-slate-700 flex items-center gap-2">
                <span>📄</span> Plan PDF coté
              </button>
              <button className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm text-slate-700 flex items-center gap-2">
                <span>🧊</span> Modèle glTF / OBJ
              </button>
              <button className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm text-slate-700 flex items-center gap-2">
                <span>🏗️</span> IFC (BIM)
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
