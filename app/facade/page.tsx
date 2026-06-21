"use client";

import { useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateBlueprintSVG, type FacadeData } from "@/lib/blueprint";

const FacadeViewer = dynamic(() => import("@/components/FacadeViewer"), { ssr: false });

export default function FacadePage() {
  const { loading: authLoading } = useRequireAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [measureNote, setMeasureNote] = useState("");
  const [realWidth, setRealWidth] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ data: FacadeData; svg: string; model: string } | null>(null);

  const loadImage = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Fichier non supporté — images uniquement (JPG, PNG, WebP)");
      return;
    }
    setImageFile(file);
    setResult(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) loadImage(f);
  }, [loadImage]);

  async function analyze() {
    if (!imageFile || !imagePreview) return;
    setAnalyzing(true);
    setError(null);

    try {
      // Encoder en base64 (sans le préfixe data:...)
      const base64 = imagePreview.split(",")[1];
      const mimeType = imageFile.type || "image/jpeg";

      const note = [
        measureNote.trim(),
        realWidth ? `Largeur totale de la façade : ${realWidth} m` : "",
      ].filter(Boolean).join(". ");

      const res = await fetch("/api/facade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType, measureNote: note || undefined }),
      });

      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error ?? "Erreur API");

      const data: FacadeData = json.data;
      const widthM = realWidth ? parseFloat(realWidth) : undefined;
      const svg = generateBlueprintSVG(data, widthM);
      setResult({ data, svg, model: json.model });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  if (authLoading) return (
    <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">Chargement…</div>
  );

  return (
    <div className="flex h-[calc(100vh-64px)]">

      {/* Panneau gauche — saisie */}
      <div className="w-80 shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-y-auto">
        <div className="p-5 border-b border-slate-100">
          <h1 className="text-lg font-bold" style={{ color: "var(--navy)" }}>
            Analyse de façade
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Photo → Blueprint (SVG · PNG · DXF)
          </p>
        </div>

        <div className="p-4 flex flex-col gap-4 flex-1">

          {/* Zone drop photo */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-2">
              Photo de la façade
            </label>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              className="cursor-pointer rounded-xl border-2 border-dashed transition-colors overflow-hidden"
              style={{
                borderColor: dragging ? "var(--orange)" : imagePreview ? "var(--navy)" : "#cbd5e1",
                minHeight: 140,
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) loadImage(f); }}
              />
              {imagePreview ? (
                <img
                  src={imagePreview}
                  alt="Aperçu"
                  className="w-full object-cover"
                  style={{ maxHeight: 200 }}
                />
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-slate-400">
                  <span className="text-3xl mb-2 opacity-30">🏢</span>
                  <span className="text-sm">Déposez une photo</span>
                  <span className="text-xs mt-1">ou cliquez pour parcourir</span>
                </div>
              )}
            </div>
          </div>

          {/* Mesures optionnelles */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">
              Largeur façade (m) — optionnel
            </label>
            <input
              type="number"
              step="0.1"
              min="1"
              value={realWidth}
              onChange={(e) => setRealWidth(e.target.value)}
              placeholder="Ex : 12.5"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
            />
            <p className="text-xs text-slate-400 mt-1">Calibre le DXF et la barre d'échelle</p>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">
              Note de mesure — optionnel
            </label>
            <textarea
              value={measureNote}
              onChange={(e) => setMeasureNote(e.target.value)}
              placeholder="Ex : porte d'entrée = 0.90 m · hauteur R+1 = 3.20 m"
              rows={3}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none"
            />
            <p className="text-xs text-slate-400 mt-1">Transmis à Gemini pour affiner les proportions</p>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
              {error}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-100">
          <button
            onClick={analyze}
            disabled={!imageFile || analyzing}
            className="w-full py-2.5 rounded-xl text-white text-sm font-semibold transition-opacity"
            style={{
              background: "var(--orange)",
              opacity: !imageFile || analyzing ? 0.4 : 1,
            }}
          >
            {analyzing ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block" />
                Analyse Gemini…
              </span>
            ) : (
              "Analyser la façade →"
            )}
          </button>
          {result && (
            <p className="text-center text-xs text-slate-400 mt-2">
              via {result.model}
            </p>
          )}
        </div>
      </div>

      {/* Zone droite — blueprint */}
      <div className="flex-1 min-w-0">
        {result ? (
          <FacadeViewer
            svgContent={result.svg}
            data={result.data}
            realWidthM={realWidth ? parseFloat(realWidth) : undefined}
          />
        ) : (
          <div
            className="flex-1 h-full flex flex-col items-center justify-center text-slate-400"
            style={{ background: "#0a1628" }}
          >
            <div className="text-6xl mb-4 opacity-10">📐</div>
            <p className="text-slate-500 font-medium">Blueprint apparaîtra ici</p>
            <p className="text-slate-600 text-sm mt-1">
              Chargez une photo de façade et lancez l'analyse
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
