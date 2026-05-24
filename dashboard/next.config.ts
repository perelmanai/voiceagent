import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the workspace root to this project. Without this, Turbopack infers the
    // root from the nearest lockfile and a stray ~/package-lock.json makes it pick
    // the home directory — so it watches the entire home tree, which degrades and
    // eventually wedges `next dev` (ingest starts returning 500, phone lines never
    // reach the browser, and every page load feels stuck).
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
