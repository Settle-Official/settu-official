import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A second local dev server (e.g. the bridge's testnet run) must not share
  // .next with the main one; NEXT_DIST_DIR gives it its own. Unset: .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
