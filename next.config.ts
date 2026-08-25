import type { NextConfig } from "next";

import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root: a lockfile in the user home dir would otherwise be
  // inferred as the root and break file tracing.
  outputFileTracingRoot: path.resolve(process.cwd()),
  // `next build` and `next dev` share .next by default, so a verification build
  // run while the dev server is up overwrites the dev chunks. The dev server
  // keeps serving manifests that point at files the build has replaced, every
  // <script> 404s, and the dev overlay reports the resulting load Event as
  // "[object Event]". `npm run build:check` sets NEXT_DIST_DIR to keep the two
  // apart. Unset, this is exactly the default.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  // Server-only packages that must not be bundled for the browser.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Keep server actions modest; the OS uses route handlers for orchestration.
    serverActions: { bodySizeLimit: "4mb" },
  },
  outputFileTracingIncludes: {
    "/api/**": ["./data/mock/**"],
    "/site/**": ["./data/mock/**"],
  },
};

export default nextConfig;
