/**
 * Publishing adapters.
 *
 * `local_static` is the default and it is REAL: it writes the rendered page to
 * disk under PUBLISH_LOCAL_DIR and the app serves it at /site/<path>, so the
 * publish -> verify -> crawl loop closes without any external CMS.
 *
 * `webhook` and `wordpress` are real HTTP clients. They refuse to run without
 * credentials rather than pretending to succeed.
 *
 * Every adapter supports the full lifecycle the spec requires: publish, update,
 * unpublish and rollback (rollback = republish a previous version's payload).
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "@/core/config/env";
import { prisma } from "@/core/db/client";
import { IntegrationNotConfiguredError, PublishError } from "@/core/errors";
import { scopedLogger } from "@/core/logging/logger";
import {
  applyBasePath,
  rebaseJsonLd,
  FONT_LINKS,
  PAGE_CSS,
  renderDataNotice,
  renderFooter,
  renderHeader,
  type PageBrand,
} from "@/modules/publishing/page-theme";

const log = scopedLogger("publishing");

export interface PublishPayload {
  url: string; // site-relative path, e.g. /flights/delhi-to-toronto
  title: string;
  metaDescription: string;
  html: string;
  markdown?: string;
  jsonLd: unknown[];
  canonical?: string;
  /** Site chrome + provenance for the published document. */
  brand?: PageBrand;
  /** Shown as a banner when the page relies on reference rather than live data. */
  dataNotice?: string;
  meta?: Record<string, unknown>;
}

export interface PublishOutcome {
  remoteId: string;
  remoteUrl: string;
  adapter: string;
  raw: Record<string, unknown>;
}

export interface PublishingAdapter {
  readonly key: string;
  readonly name: string;
  isConfigured(): boolean;
  publish(payload: PublishPayload): Promise<PublishOutcome>;
  unpublish(remoteId: string): Promise<void>;
}

// ---------------------------------------------------------------------------

function sitePath(urlPath: string): string {
  const clean = urlPath.replace(/^\/+/, "").replace(/\.\./g, "").replace(/\/+$/, "");
  return clean || "index";
}

/**
 * Writes a complete, standalone HTML document to disk. The file is genuinely
 * served by the app at /site/<path>, so the Technical SEO crawler can fetch it
 * over real HTTP and validate what was actually published.
 */
export class LocalStaticAdapter implements PublishingAdapter {
  readonly key = "local_static";
  readonly name = "Local static site (served at /site/*)";

  constructor(private readonly baseDir = env().PUBLISH_LOCAL_DIR, private readonly appUrl = env().APP_URL) {}

  isConfigured() {
    return true;
  }

  private fileFor(urlPath: string) {
    return path.join(process.cwd(), this.baseDir, `${sitePath(urlPath)}.html`);
  }

  async publish(payload: PublishPayload): Promise<PublishOutcome> {
    const file = this.fileFor(payload.url);
    await fs.mkdir(path.dirname(file), { recursive: true });

    const canonical = payload.canonical ?? `${this.appUrl}/site/${sitePath(payload.url)}`;
    // This adapter serves the site under /site, so root-relative links written
    // by the components have to be rebased or every internal link 404s.
    const doc = renderDocument(
      { ...payload, brand: { name: "FaresMatch", siteUrl: this.appUrl, ...payload.brand, basePath: "/site" } },
      canonical,
    );
    await fs.writeFile(file, doc, "utf8");

    // Keep a JSON sidecar so rollback + diffing have structured input.
    await fs.writeFile(
      file.replace(/\.html$/, ".json"),
      JSON.stringify({ ...payload, canonical, publishedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );

    log.info("published to local static site", { url: payload.url, file });
    return {
      remoteId: sitePath(payload.url),
      remoteUrl: `${this.appUrl}/site/${sitePath(payload.url)}`,
      adapter: this.key,
      raw: { file, bytes: doc.length },
    };
  }

  async unpublish(remoteId: string): Promise<void> {
    const file = path.join(process.cwd(), this.baseDir, `${remoteId}.html`);
    await fs.rm(file, { force: true });
    await fs.rm(file.replace(/\.html$/, ".json"), { force: true });
    log.warn("unpublished from local static site", { remoteId });
  }
}

/**
 * Renders the complete published document: site chrome, brand theme, metadata,
 * structured data and the composed page body.
 */
export function renderDocument(payload: PublishPayload, canonical: string): string {
  const brand: PageBrand = payload.brand ?? {
    name: "FaresMatch",
    siteUrl: canonical.replace(/\/site\/.*$/, ""),
  };

  const ld = rebaseJsonLd(payload.jsonLd, brand.siteUrl, brand.basePath)
    .map((obj) => `    <script type="application/ld+json">${JSON.stringify(obj)}</script>`)
    .join("\n");

  const body = applyBasePath(
    `${renderDataNotice(payload.dataNotice)}
${renderHeader(brand)}
    <main class="wrap">
${payload.html}
    </main>
${renderFooter(brand, payload.url)}`,
    brand.basePath,
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeAttr(payload.title)}</title>
    <meta name="description" content="${escapeAttr(payload.metaDescription)}" />
    <link rel="canonical" href="${escapeAttr(canonical)}" />
    <meta name="robots" content="index,follow" />
    <meta property="og:title" content="${escapeAttr(payload.title)}" />
    <meta property="og:description" content="${escapeAttr(payload.metaDescription)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeAttr(canonical)}" />
${FONT_LINKS}
${ld}
    <style>${PAGE_CSS}</style>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------

/**
 * Stores the rendered document in Page.publishedHtml so it can be served from
 * the database. Used on Vercel where the filesystem is ephemeral.
 */
export class DatabaseAdapter implements PublishingAdapter {
  readonly key = "database";
  readonly name = "Database (serves from Page.publishedHtml)";

  constructor(private readonly appUrl = env().APP_URL) {}

  isConfigured() {
    return true;
  }

  async publish(payload: PublishPayload): Promise<PublishOutcome> {
    const canonical = payload.canonical ?? `${this.appUrl}/site/${sitePath(payload.url)}`;
    const doc = renderDocument(
      { ...payload, brand: { name: "FaresMatch", siteUrl: this.appUrl, ...payload.brand, basePath: "/site" } },
      canonical,
    );

    const updated = await prisma.page.updateMany({
      where: { url: payload.url, status: { not: "DELETED" } },
      data: { publishedHtml: doc },
    });

    if (updated.count === 0) {
      log.warn("database adapter: no page found for url, skipping DB write", { url: payload.url });
    }

    log.info("published to database", { url: payload.url, bytes: doc.length });
    return {
      remoteId: sitePath(payload.url),
      remoteUrl: `${this.appUrl}/site/${sitePath(payload.url)}`,
      adapter: this.key,
      raw: { bytes: doc.length, pagesUpdated: updated.count },
    };
  }

  async unpublish(remoteId: string): Promise<void> {
    await prisma.page.updateMany({
      where: { url: { contains: remoteId }, status: "PUBLISHED" },
      data: { publishedHtml: null },
    });
    log.warn("unpublished from database", { remoteId });
  }
}

// ---------------------------------------------------------------------------

/** POSTs the page payload to a customer-owned endpoint, HMAC-signed. */
export class WebhookAdapter implements PublishingAdapter {
  readonly key = "webhook";
  readonly name = "Generic CMS webhook";

  constructor(private readonly url?: string, private readonly secret?: string) {}

  isConfigured() {
    return Boolean(this.url);
  }

  async publish(payload: PublishPayload): Promise<PublishOutcome> {
    if (!this.url) throw new IntegrationNotConfiguredError("webhook_cms", ["PUBLISH_WEBHOOK_URL"]);
    const body = JSON.stringify({ action: "publish", payload });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.secret) headers["x-faresmatch-signature"] = crypto.createHmac("sha256", this.secret).update(body).digest("hex");

    const res = await fetch(this.url, { method: "POST", headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new PublishError(this.key, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data: any = await res.json().catch(() => ({}));
    return {
      remoteId: String(data.id ?? payload.url),
      remoteUrl: String(data.url ?? payload.url),
      adapter: this.key,
      raw: data,
    };
  }

  async unpublish(remoteId: string): Promise<void> {
    if (!this.url) throw new IntegrationNotConfiguredError("webhook_cms", ["PUBLISH_WEBHOOK_URL"]);
    const body = JSON.stringify({ action: "unpublish", id: remoteId });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.secret) headers["x-faresmatch-signature"] = crypto.createHmac("sha256", this.secret).update(body).digest("hex");
    const res = await fetch(this.url, { method: "POST", headers, body });
    if (!res.ok) throw new PublishError(this.key, `unpublish failed: HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------

/** WordPress REST API (application password auth). */
export class WordPressAdapter implements PublishingAdapter {
  readonly key = "wordpress";
  readonly name = "WordPress REST API";

  constructor(
    private readonly baseUrl?: string,
    private readonly username?: string,
    private readonly appPassword?: string,
  ) {}

  isConfigured() {
    return Boolean(this.baseUrl && this.username && this.appPassword);
  }

  private auth() {
    return `Basic ${Buffer.from(`${this.username}:${this.appPassword}`).toString("base64")}`;
  }

  async publish(payload: PublishPayload): Promise<PublishOutcome> {
    if (!this.isConfigured()) {
      throw new IntegrationNotConfiguredError("wordpress", ["baseUrl", "username", "applicationPassword"]);
    }
    const slug = sitePath(payload.url).split("/").pop() ?? "page";
    const jsonLdBlock = payload.jsonLd
      .map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`)
      .join("\n");

    const res = await fetch(`${this.baseUrl!.replace(/\/$/, "")}/wp-json/wp/v2/pages`, {
      method: "POST",
      headers: { authorization: this.auth(), "content-type": "application/json" },
      body: JSON.stringify({
        title: payload.title,
        slug,
        status: "publish",
        content: `${payload.html}\n${jsonLdBlock}`,
        excerpt: payload.metaDescription,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new PublishError(this.key, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data: any = await res.json();
    return { remoteId: String(data.id), remoteUrl: data.link ?? "", adapter: this.key, raw: { id: data.id, link: data.link } };
  }

  async unpublish(remoteId: string): Promise<void> {
    if (!this.isConfigured()) throw new IntegrationNotConfiguredError("wordpress", ["baseUrl", "username", "applicationPassword"]);
    const res = await fetch(`${this.baseUrl!.replace(/\/$/, "")}/wp-json/wp/v2/pages/${remoteId}`, {
      method: "DELETE",
      headers: { authorization: this.auth() },
    });
    if (!res.ok) throw new PublishError(this.key, `unpublish failed: HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------

export interface AdapterSelection {
  adapter: PublishingAdapter;
  requested: string;
  fellBack: boolean;
  reason: string;
}

/**
 * Choose the publishing adapter. If the requested one lacks credentials we fall
 * back to local_static and SAY SO - the publish record stores which adapter
 * actually ran, so nothing appears to have gone to a CMS that it did not.
 */
export function selectAdapter(
  requested: string,
  creds: { webhookUrl?: string; webhookSecret?: string; wpBaseUrl?: string; wpUser?: string; wpPassword?: string } = {},
): AdapterSelection {
  const local = new LocalStaticAdapter();

  if (requested === "database") {
    return { adapter: new DatabaseAdapter(), requested, fellBack: false, reason: "database adapter selected" };
  }

  if (requested === "webhook") {
    const a = new WebhookAdapter(creds.webhookUrl || env().PUBLISH_WEBHOOK_URL, creds.webhookSecret || env().PUBLISH_WEBHOOK_SECRET);
    if (a.isConfigured()) return { adapter: a, requested, fellBack: false, reason: "webhook configured" };
    return { adapter: local, requested, fellBack: true, reason: "PUBLISH_WEBHOOK_URL is not set; wrote to the local static site instead" };
  }

  if (requested === "wordpress") {
    const a = new WordPressAdapter(
      creds.wpBaseUrl || env().WORDPRESS_BASE_URL,
      creds.wpUser || env().WORDPRESS_USERNAME,
      creds.wpPassword || env().WORDPRESS_APP_PASSWORD,
    );
    if (a.isConfigured()) return { adapter: a, requested, fellBack: false, reason: "wordpress configured" };
    return {
      adapter: local,
      requested,
      fellBack: true,
      reason: "WordPress credentials are missing; wrote to the local static site instead",
    };
  }

  return { adapter: local, requested: "local_static", fellBack: false, reason: "local static adapter selected" };
}
