"use client";

import { useRef } from "react";
import { generateDXF, type FacadeData } from "@/lib/blueprint";

interface Props {
  svgContent: string;
  data: FacadeData;
  realWidthM?: number;
}

export default function FacadeViewer({ svgContent, data, realWidthM }: Props) {
  const svgRef = useRef<HTMLDivElement>(null);

  function downloadSVG() {
    const blob = new Blob([svgContent], { type: "image/svg+xml" });
    dl(blob, "facade.svg");
  }

  function downloadDXF() {
    const dxf = generateDXF(data, realWidthM);
    const blob = new Blob([dxf], { type: "application/dxf" });
    dl(blob, "facade.dxf");
  }

  async function downloadPNG() {
    const div = svgRef.current;
    if (!div) return;
    const svgEl = div.querySelector("svg");
    if (!svgEl) return;

    const { width, height } = svgEl.getBoundingClientRect();
    const scale = 3; // 3× pour qualité impression
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d")!;

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => b && dl(b, "facade.png"), "image/png");
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgContent);
  }

  function dl(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-white shrink-0">
        <div className="flex-1">
          <span className="text-sm font-medium text-slate-700">{data.facade.style}</span>
          <span className="ml-2 text-xs text-slate-400">
            {data.facade.floors} niveaux · {data.elements.length} éléments
            {realWidthM && ` · ${realWidthM} m`}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            onClick={downloadSVG}
            className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            ↓ SVG
          </button>
          <button
            onClick={downloadPNG}
            className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            ↓ PNG
          </button>
          <button
            onClick={downloadDXF}
            className="px-3 py-1.5 rounded-lg text-white text-xs font-medium transition-colors"
            style={{ background: "var(--navy)" }}
          >
            ↓ DXF
          </button>
        </div>
      </div>

      {/* Blueprint */}
      <div
        ref={svgRef}
        className="flex-1 overflow-auto"
        style={{ background: "#0a1628" }}
        dangerouslySetInnerHTML={{ __html: svgContent }}
      />

      {/* Légende des éléments détectés */}
      <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-2 overflow-x-auto">
        <div className="flex gap-4 text-xs text-slate-500 min-w-max">
          {data.elements.slice(0, 12).map((el, i) => (
            <span key={i} className="whitespace-nowrap">
              <span className="font-medium">{el.label}</span>
            </span>
          ))}
          {data.elements.length > 12 && (
            <span className="text-slate-400">+{data.elements.length - 12} autres</span>
          )}
        </div>
      </div>
    </div>
  );
}
