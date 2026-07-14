import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Racine explicite : évite l'inférence erronée du workspace (double lockfile
  // avec l'ancien prototype web/, chemin Drive avec espaces).
  turbopack: { root: __dirname },
};

export default nextConfig;
