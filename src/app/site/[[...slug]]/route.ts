/**
 * Serves published pages. Checks the database first (Page.publishedHtml),
 * then falls back to the local filesystem for backward compatibility in
 * local development.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { env } from "@/core/config/env";
import { prisma } from "@/core/db/client";

export const dynamic = "force-dynamic";

function safeJoin(base: string, segments: string[]): string | null {
  const target = path.resolve(base, ...segments);
  const root = path.resolve(base);
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;

  if (!slug || slug.length === 0) return index();

  const url = `/${slug.join("/")}`;

  // 1. Try database (works on Vercel and local dev with PostgreSQL)
  try {
    const page = await prisma.page.findFirst({
      where: { url, status: "PUBLISHED", publishedHtml: { not: null } },
      select: { publishedHtml: true },
    });
    if (page?.publishedHtml) {
      return new NextResponse(page.publishedHtml, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      });
    }
  } catch {
    // DB unavailable or column missing — fall through to filesystem
  }

  // 2. Fall back to filesystem (local dev with local_static adapter)
  const baseDir = path.join(process.cwd(), env().PUBLISH_LOCAL_DIR);
  const file = safeJoin(baseDir, [`${slug.join("/")}.html`]);
  if (!file) return new NextResponse("Not found", { status: 404 });

  try {
    const html = await fs.readFile(file, "utf8");
    return new NextResponse(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return new NextResponse(
      `<!doctype html><html><head><title>404 — not published</title><meta name="robots" content="noindex"></head><body style="font:15px system-ui;max-width:640px;margin:60px auto;padding:0 20px">
        <h1>404 — this page has not been published</h1>
        <p>No page exists at <code>/${slug.join("/")}</code>.</p>
        <p><a href="/site">See what is published</a> · <a href="/content">Open the console</a></p>
      </body></html>`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}

async function index() {
  const pages = await prisma.page.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    select: { url: true, title: true, publishedAt: true, qualityScore: true },
  });

  const baseDir = path.join(process.cwd(), env().PUBLISH_LOCAL_DIR);
  let onDisk: string[] = [];
  try {
    onDisk = await walk(baseDir, baseDir);
  } catch {
    onDisk = [];
  }

  const rows = pages
    .map(
      (p) =>
        `<li><a href="/site${p.url}">${escapeHtml(p.title)}</a> <span class="m">${p.url} · quality ${p.qualityScore.toFixed(0)}/100 · published ${p.publishedAt?.toISOString().slice(0, 10) ?? "—"}</span></li>`,
    )
    .join("\n");

  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>FaresMatch — published pages</title>
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:0 auto;padding:48px 24px;color:#16181d}
     h1{font-size:24px;margin:0 0 6px}.sub{color:#6a7080;margin:0 0 28px}
     ul{list-style:none;padding:0}li{padding:12px 0;border-bottom:1px solid #e4e7ec}
     a{color:#1f5eff;text-decoration:none;font-weight:600}.m{display:block;color:#6a7080;font-size:12.5px;font-weight:400}
     .empty{color:#6a7080}</style></head>
     <body><h1>Published pages</h1>
     <p class="sub">${onDisk.length} file${onDisk.length === 1 ? "" : "s"} on disk · ${pages.length} in database.</p>
     ${rows ? `<ul>${rows}</ul>` : '<p class="empty">Nothing published yet. Run a goal through the console and approve the publish step.</p>'}
     </body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function walk(dir: string, root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full, root)));
      else if (entry.name.endsWith(".html")) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  } catch {
    // Directory doesn't exist (normal on Vercel)
  }
  return out;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
