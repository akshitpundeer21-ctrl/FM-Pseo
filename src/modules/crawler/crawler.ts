/**
 * Crawler abstraction + built-in fetch crawler.
 *
 * Real HTTP, real parsing - this is not a stub. It powers the Technical SEO
 * Agent and can crawl the locally published site (served at /site/*) as well as
 * any external URL. The `Crawler` interface exists so a hosted crawling service
 * can be swapped in later without touching the agent.
 *
 * Parsing is regex-based on purpose: it keeps the dependency surface at zero and
 * is sufficient for the head/link/heading signals technical SEO needs.
 */
import { env } from "@/core/config/env";
import { scopedLogger } from "@/core/logging/logger";
import { stripHtml, wordCount } from "@/core/utils/text";

const log = scopedLogger("crawler");

export interface CrawledPage {
  url: string;
  httpStatus: number;
  contentType: string | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  headings: { level: number; text: string }[];
  canonical: string | null;
  robots: string | null;
  indexable: boolean;
  wordCount: number;
  internalLinks: string[];
  outboundLinks: string[];
  schemaTypes: string[];
  jsonLd: unknown[];
  responseMs: number;
  error?: string;
}

export interface CrawlOptions {
  maxPages?: number;
  concurrency?: number;
  timeoutMs?: number;
  sameOriginOnly?: boolean;
  respectRobots?: boolean;
}

export interface Crawler {
  readonly key: string;
  fetchOne(url: string, opts?: CrawlOptions): Promise<CrawledPage>;
  crawl(startUrls: string[], opts?: CrawlOptions): Promise<CrawledPage[]>;
}

// --- parsing helpers -------------------------------------------------------

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1].trim() : null;
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

export function parseHtml(url: string, html: string): Omit<CrawledPage, "httpStatus" | "contentType" | "responseMs" | "url"> {
  const head = html.slice(0, html.search(/<\/head>/i) + 7) || html.slice(0, 8000);

  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);

  let metaDescription: string | null = null;
  let robots: string | null = null;
  let canonical: string | null = null;

  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, "name") ?? attr(tag, "property") ?? "").toLowerCase();
    if (name === "description") metaDescription = attr(tag, "content");
    if (name === "robots") robots = attr(tag, "content");
  }
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    if ((attr(tag, "rel") ?? "").toLowerCase() === "canonical") canonical = attr(tag, "href");
  }

  const headings: { level: number; text: string }[] = [];
  for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    headings.push({ level: Number(m[1]), text: stripHtml(m[2]).slice(0, 200) });
  }

  const base = safeUrl(url);
  const internalLinks: string[] = [];
  const outboundLinks: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = m[1];
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
    const abs = resolveUrl(href, url);
    if (!abs) continue;
    const target = safeUrl(abs);
    if (base && target && target.origin === base.origin) internalLinks.push(abs);
    else outboundLinks.push(abs);
  }

  const jsonLd: unknown[] = [];
  const schemaTypes: string[] = [];
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      jsonLd.push(parsed);
      const collect = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(collect);
        if (typeof node === "object") {
          if (typeof node["@type"] === "string") schemaTypes.push(node["@type"]);
          if (Array.isArray(node["@graph"])) node["@graph"].forEach(collect);
        }
      };
      collect(parsed);
    } catch {
      // Malformed JSON-LD is itself a finding; the technical agent flags it.
      schemaTypes.push("INVALID_JSON_LD");
    }
  }

  const robotsLower = (robots ?? "").toLowerCase();
  const indexable = !robotsLower.includes("noindex");

  return {
    title,
    metaDescription,
    h1: headings.find((h) => h.level === 1)?.text ?? null,
    headings,
    canonical,
    robots,
    indexable,
    wordCount: wordCount(html),
    internalLinks: [...new Set(internalLinks)],
    outboundLinks: [...new Set(outboundLinks)],
    schemaTypes: [...new Set(schemaTypes)],
    jsonLd,
  };
}

function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// --- built-in crawler ------------------------------------------------------

export class FetchCrawler implements Crawler {
  readonly key = "internal_fetch";
  private robotsCache = new Map<string, string[]>();

  async fetchOne(url: string, opts: CrawlOptions = {}): Promise<CrawledPage> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? env().CRAWLER_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { "user-agent": env().CRAWLER_USER_AGENT, accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: controller.signal,
      });
      const contentType = res.headers.get("content-type");
      const isHtml = (contentType ?? "").includes("html");
      const body = isHtml ? await res.text() : "";
      const parsed = isHtml
        ? parseHtml(url, body)
        : {
            title: null,
            metaDescription: null,
            h1: null,
            headings: [],
            canonical: null,
            robots: null,
            indexable: false,
            wordCount: 0,
            internalLinks: [],
            outboundLinks: [],
            schemaTypes: [],
            jsonLd: [],
          };

      return { url, httpStatus: res.status, contentType, responseMs: Date.now() - started, ...parsed };
    } catch (e) {
      const message = (e as Error).name === "AbortError" ? "request timed out" : (e as Error).message;
      log.warn("fetch failed", { url, error: message });
      return {
        url,
        httpStatus: 0,
        contentType: null,
        title: null,
        metaDescription: null,
        h1: null,
        headings: [],
        canonical: null,
        robots: null,
        indexable: false,
        wordCount: 0,
        internalLinks: [],
        outboundLinks: [],
        schemaTypes: [],
        jsonLd: [],
        responseMs: Date.now() - started,
        error: message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Returns disallowed path prefixes for our user-agent. */
  private async disallowedPaths(origin: string): Promise<string[]> {
    const cached = this.robotsCache.get(origin);
    if (cached) return cached;
    const rules: string[] = [];
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": env().CRAWLER_USER_AGENT } });
      if (res.ok) {
        const text = await res.text();
        let applies = false;
        for (const line of text.split(/\r?\n/)) {
          const [rawKey, ...rest] = line.split(":");
          const key = rawKey.trim().toLowerCase();
          const value = rest.join(":").trim();
          if (key === "user-agent") applies = value === "*" || env().CRAWLER_USER_AGENT.includes(value);
          else if (key === "disallow" && applies && value) rules.push(value);
        }
      }
    } catch {
      // No robots.txt is not an error - it means no restrictions.
    }
    this.robotsCache.set(origin, rules);
    return rules;
  }

  async crawl(startUrls: string[], opts: CrawlOptions = {}): Promise<CrawledPage[]> {
    const maxPages = opts.maxPages ?? env().CRAWLER_MAX_PAGES;
    const concurrency = Math.max(1, opts.concurrency ?? env().CRAWLER_CONCURRENCY);
    const sameOriginOnly = opts.sameOriginOnly ?? true;
    const respectRobots = opts.respectRobots ?? true;

    const origins = new Set(startUrls.map((u) => safeUrl(u)?.origin).filter(Boolean) as string[]);
    const disallow = new Map<string, string[]>();
    if (respectRobots) {
      for (const origin of origins) disallow.set(origin, await this.disallowedPaths(origin));
    }

    const queue = [...startUrls];
    const seen = new Set(startUrls);
    const results: CrawledPage[] = [];

    const blocked = (url: string) => {
      const u = safeUrl(url);
      if (!u) return true;
      const rules = disallow.get(u.origin) ?? [];
      return rules.some((r) => u.pathname.startsWith(r));
    };

    while (queue.length && results.length < maxPages) {
      const batch = queue.splice(0, concurrency).filter((u) => !respectRobots || !blocked(u));
      if (!batch.length) continue;

      const pages = await Promise.all(batch.map((u) => this.fetchOne(u, opts)));
      for (const page of pages) {
        results.push(page);
        for (const link of page.internalLinks) {
          if (results.length + queue.length >= maxPages) break;
          if (seen.has(link)) continue;
          const linkUrl = safeUrl(link);
          if (!linkUrl) continue;
          if (sameOriginOnly && !origins.has(linkUrl.origin)) continue;
          seen.add(link);
          queue.push(link);
        }
      }
    }

    log.info("crawl finished", { pages: results.length, startUrls: startUrls.length });
    return results;
  }
}
