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
import { IntegrationNotConfiguredError, PublishError } from "@/core/errors";
import { scopedLogger } from "@/core/logging/logger";

const log = scopedLogger("publishing");

export interface PublishPayload {
  url: string; // site-relative path, e.g. /flights/delhi-to-toronto
  title: string;
  metaDescription: string;
  html: string;
  markdown?: string;
  jsonLd: unknown[];
  canonical?: string;
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
    const doc = renderDocument(payload, canonical);
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

export function renderDocument(payload: PublishPayload, canonical: string): string {
  const ld = payload.jsonLd
    .map((obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`)
    .join("\n    ");

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
    ${ld}
    <style>
      :root { color-scheme: light dark; }
      body { font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #fbfbfd; color: #16181d; }
      main { max-width: 820px; margin: 0 auto; padding: 40px 24px 80px; }
      h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 8px; }
      h2 { font-size: 1.35rem; margin: 40px 0 12px; }
      h3 { font-size: 1.05rem; margin: 24px 0 8px; }
      section { margin: 0 0 28px; }
      table { border-collapse: collapse; width: 100%; margin: 12px 0; }
      th, td { border: 1px solid #e2e4ea; padding: 8px 10px; text-align: left; font-size: 0.95rem; }
      th { background: #f2f4f8; }
      .fm-faq dt { font-weight: 600; margin-top: 14px; }
      .fm-faq dd { margin: 4px 0 0; }
      .fm-meta { color: #6a7080; font-size: .85rem; }
      .fm-sources { border-top: 1px solid #e2e4ea; margin-top: 40px; padding-top: 16px; font-size: .85rem; color: #6a7080; }
      .fm-cta { display: inline-block; margin-top: 8px; padding: 10px 18px; background: #1f5eff; color: #fff; border-radius: 8px; text-decoration: none; }
      ul { padding-left: 20px; }
      @media (prefers-color-scheme: dark) {
        body { background: #0f1115; color: #e6e8ee; }
        th, td { border-color: #262a33; } th { background: #171a21; }
        .fm-sources, .fm-meta { color: #97a0b5; }
      }
    </style>
  </head>
  <body>
    <main>
${payload.html}
    </main>
  </body>
</html>
`;
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
