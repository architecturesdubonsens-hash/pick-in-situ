"use client";

import Link from "next/link";

const MOCK_CHANTIERS = [
  {
    id: "demo-appartement",
    nom: "Appartement Rue de la Paix",
    adresse: "12 rue de la Paix, Paris 75002",
    date: "2026-06-20",
    scans: 2,
    surface: 78,
    status: "terminé",
  },
  {
    id: "demo-bureau",
    nom: "Bureaux Toulouse Centre",
    adresse: "45 allée Jean Jaurès, Toulouse 31000",
    date: "2026-06-18",
    scans: 1,
    surface: 120,
    status: "en cours",
  },
  {
    id: "demo-entrepot",
    nom: "Entrepôt Montbartier",
    adresse: "ZA Les Portes du Tarn, Montbartier 82700",
    date: "2026-06-15",
    scans: 3,
    surface: 2400,
    status: "terminé",
  },
];

const STATUS_COLORS: Record<string, string> = {
  "terminé": "bg-green-100 text-green-800",
  "en cours": "bg-orange-100 text-orange-800",
};

export default function Dashboard() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--navy)" }}>
            Mes chantiers
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Relevés LiDAR — scans terrain iPhone
          </p>
        </div>
        <button
          className="px-4 py-2 rounded-lg text-white text-sm font-medium cursor-pointer"
          style={{ background: "var(--orange)" }}
        >
          + Nouveau chantier
        </button>
      </div>

      <div className="grid gap-4">
        {MOCK_CHANTIERS.map((c) => (
          <Link
            key={c.id}
            href={`/scan/${c.id}`}
            className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex items-center justify-between hover:shadow-md transition-shadow"
          >
            <div className="flex items-center gap-4">
              <div
                className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl shrink-0"
                style={{ background: "var(--navy)" }}
              >
                {c.nom[0]}
              </div>
              <div>
                <p className="font-semibold text-slate-800">{c.nom}</p>
                <p className="text-slate-500 text-sm">{c.adresse}</p>
                <p className="text-slate-400 text-xs mt-1">
                  {c.scans} scan{c.scans > 1 ? "s" : ""} · {c.surface} m²
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLORS[c.status] ?? ""}`}>
                {c.status}
              </span>
              <span className="text-slate-400 text-sm">{c.date}</span>
              <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-6 p-4 rounded-lg border-2 border-dashed border-slate-200 text-center text-slate-400 text-sm">
        Scannez un espace avec votre iPhone LiDAR → les scans apparaîtront ici automatiquement
      </div>
    </div>
  );
}
