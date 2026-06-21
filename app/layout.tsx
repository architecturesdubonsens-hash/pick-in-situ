import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { HeaderNav } from "@/components/HeaderNav";

export const metadata: Metadata = {
  title: "Pick In Situ — Relevé LiDAR",
  description: "Application de relevé terrain LiDAR pour architectes",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="h-full">
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <header style={{ background: "var(--navy)" }} className="px-6 py-4 flex items-center gap-4">
            <a href="/" className="text-white font-bold text-lg tracking-wide hover:opacity-80 transition-opacity">
              Pick In Situ
            </a>
            <span style={{ color: "var(--orange)" }} className="text-sm font-medium">
              Relevé LiDAR · BC-Archi
            </span>
            <div className="ml-auto">
              <HeaderNav />
            </div>
          </header>
          <main className="flex-1">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
