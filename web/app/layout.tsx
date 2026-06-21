import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pick In Situ — Relevé LiDAR",
  description: "Application de relevé terrain LiDAR pour architectes",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="h-full">
      <body className="min-h-full flex flex-col">
        <header style={{ background: "var(--navy)" }} className="px-6 py-4 flex items-center gap-4">
          <span className="text-white font-bold text-lg tracking-wide">Pick In Situ</span>
          <span style={{ color: "var(--orange)" }} className="text-sm font-medium">
            Relevé LiDAR · BC-Archi
          </span>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
