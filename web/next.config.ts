import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Three.js — désactiver la minification qui peut casser les addons WASM
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
    };
    return config;
  },
};

export default nextConfig;
