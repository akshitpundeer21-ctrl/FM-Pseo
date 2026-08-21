/**
 * Sitemap for the locally published site. Generated from the PUBLISHED pages in
 * the database, so it can never list something that was not actually published.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/core/db/client";
import { env } from "@/core/config/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const base = env().APP_URL.replace(/\/$/, "");
  const pages = await prisma.page.findMany({
    where: { status: "PUBLISHED" },
    select: { url: true, publishedAt: true, updatedAt: true },
    orderBy: { publishedAt: "desc" },
  });

  const urls = pages
    .map(
      (p) => `  <url>
    <loc>${base}/site${p.url}</loc>
    <lastmod>${(p.publishedAt ?? p.updatedAt).toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
  </url>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new NextResponse(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" } });
}
