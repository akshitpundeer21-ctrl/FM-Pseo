import type { NextConfig } from "next";

import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root: a lockfile in the user home dir would otherwise be
  // inferred as the root and break file tracing.
  outputFileTracingRoot: path.resolve(process.cwd()),
  reactStrictMode: true,
  // Server-only packages that must not be bundled for the browser.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Keep server actions modest; the OS uses route handlers for orchestration.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
