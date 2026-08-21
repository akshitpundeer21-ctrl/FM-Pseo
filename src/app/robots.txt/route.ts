import { NextResponse } from "next/server";
import { env } from "@/core/config/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const base = env().APP_URL.replace(/\/$/, "");
  // The console itself must never be indexed; only the published site may be.
  const body = `User-agent: *
Allow: /site/
Disallow: /api/
Disallow: /dashboard
Disallow: /login

Sitemap: ${base}/sitemap.xml
`;
  return new NextResponse(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
