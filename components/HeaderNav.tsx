"use client";

import { useAuth } from "@/components/AuthProvider";
import { useRouter } from "next/navigation";

export function HeaderNav() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();

  if (loading) return null;

  if (!user) {
    return (
      <a href="/login" className="text-sm text-white/70 hover:text-white transition-colors">
        Connexion
      </a>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <a
        href="/facade"
        className="text-xs px-3 py-1.5 rounded-lg border border-white/20 text-white/80 hover:bg-white/10 transition-colors"
      >
        📐 Façade
      </a>
      <span className="text-white/60 text-xs hidden sm:block">{user.email}</span>
      <button
        onClick={async () => { await signOut(); router.replace("/login"); }}
        className="text-xs px-3 py-1.5 rounded-lg border border-white/20 text-white/80 hover:bg-white/10 transition-colors"
      >
        Déconnexion
      </button>
    </div>
  );
}
