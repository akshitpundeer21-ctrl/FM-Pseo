/**
 * Technical SEO Agent.
 *
 * Crawls what was actually published (over real HTTP) and validates the
 * technical surface: status codes, canonicals, robots directives, titles, meta
 * descriptions, heading hierarchy, structured data validity, internal links,
 * orphans and broken links. Findings are persisted as CrawlResults and, for the
 * important ones, as Recommendations.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";

const InputSchema = z.object({
  websiteId: z.string(),
  maxPages: z.number().int().min(1).max(500).optional(),
  extraUrls: z.array(z.string()).optional(),
});

const IssueSchema = z.object({
  url: z.string(),
  check: z.string(),
  severity: z.enum(["ERROR", "WARNING", "INFO"]),
  message: z.string(),
});

const OutputSchema = z.object({
  crawlRunId: z.string(),
  crawled: z.number(),
  errors: z.number(),
  warnings: z.number(),
  orphans: z.array(z.string()),
  brokenLinks: z.array(z.object({ from: z.string(), to: z.string(), status: z.number() })),
  issues: z.array(IssueSchema),
});

export type TechnicalSeoInput = z.infer<typeof InputSchema>;
export type TechnicalSeoOutput = z.infer<typeof OutputSchema>;

interface CrawledPage {
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

export class TechnicalSeoAgent extends BaseAgent<TechnicalSeoInput, TechnicalSeoOutput> {
  readonly key = "technical_seo";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;
  protected readonly needsBrand = false;

  readonly validationRules: ValidationRule<TechnicalSeoOutput>[] = [
    { name: "crawl_attempted", check: (o) => o.crawled > 0, message: "No URLs were crawled" },
  ];

  protected async perform(input: TechnicalSeoInput, ctx: AgentRunContext): Promise<AgentOutcome<TechnicalSeoOutput>> {
    const website = await prisma.website.findUnique({ where: { id: input.websiteId } });
    if (!website) throw new Error(`Website ${input.websiteId} not found`);

    const publishedPages = await prisma.page.findMany({
      where: { projectId: ctx.projectId, status: "PUBLISHED" },
      select: { id: true, url: true, title: true },
    });

    const base = website.baseUrl.replace(/\/$/, "");
    const startUrls = [
      ...publishedPages.map((p) => `${base}${p.url}`),
      ...(input.extraUrls ?? []),
    ];
    if (!startUrls.length) startUrls.push(base || "http://localhost:3000/site");

    const crawlRun = await prisma.crawlRun.create({
      data: { websiteId: website.id, status: "RUNNING", adapter: "internal_fetch" },
    });

    try {
      const result = await ctx.tool<{ pages: CrawledPage[]; crawled: number }>("web.crawl", {
        startUrls,
        maxPages: input.maxPages ?? 100,
        sameOriginOnly: true,
      });

      const issues: z.infer<typeof IssueSchema>[] = [];
      const titles = new Map<string, string[]>();

      for (const page of result.pages) {
        const pageIssues: z.infer<typeof IssueSchema>[] = [];
        const add = (check: string, severity: "ERROR" | "WARNING" | "INFO", message: string) =>
          pageIssues.push({ url: page.url, check, severity, message });

        if (page.error || page.httpStatus === 0) {
          add("fetch", "ERROR", `Could not fetch the page: ${page.error ?? "no response"}`);
        } else if (page.httpStatus >= 500) {
          add("http_status", "ERROR", `Server error ${page.httpStatus}`);
        } else if (page.httpStatus >= 400) {
          add("http_status", "ERROR", `Client error ${page.httpStatus}`);
        } else if (page.httpStatus >= 300) {
          add("http_status", "WARNING", `Redirect status ${page.httpStatus}`);
        }

        if (page.httpStatus === 200) {
          if (!page.title) add("title", "ERROR", "Missing <title>");
          else if (page.title.length > 65) add("title", "WARNING", `Title is ${page.title.length} characters`);

          if (!page.metaDescription) add("meta_description", "WARNING", "Missing meta description");
          else if (page.metaDescription.length > 165) add("meta_description", "WARNING", `Meta description is ${page.metaDescription.length} characters`);

          const h1Count = page.headings.filter((h) => h.level === 1).length;
          if (h1Count === 0) add("h1", "ERROR", "No H1 element");
          if (h1Count > 1) add("h1", "WARNING", `${h1Count} H1 elements`);

          if (!page.canonical) add("canonical", "WARNING", "No canonical link");
          else if (!page.canonical.includes(new URL(page.url).pathname)) {
            add("canonical", "WARNING", `Canonical points elsewhere: ${page.canonical}`);
          }

          if (!page.indexable) add("indexability", "ERROR", `Page is noindex (robots: ${page.robots})`);

          if (!page.schemaTypes.length) add("structured_data", "WARNING", "No structured data found");
          if (page.schemaTypes.includes("INVALID_JSON_LD")) add("structured_data", "ERROR", "A JSON-LD block failed to parse");

          if (page.wordCount < 300) add("thin_content", "WARNING", `Only ~${page.wordCount} words on the page`);
          if (page.internalLinks.length === 0) add("internal_links", "WARNING", "Page has no internal links");
          if (page.responseMs > 2000) add("performance", "WARNING", `Response took ${page.responseMs}ms`);

          if (page.title) {
            const list = titles.get(page.title) ?? [];
            list.push(page.url);
            titles.set(page.title, list);
          }
        }

        issues.push(...pageIssues);

        await prisma.crawlResult.create({
          data: {
            websiteId: website.id,
            crawlRunId: crawlRun.id,
            url: page.url,
            httpStatus: page.httpStatus,
            contentType: page.contentType,
            title: page.title,
            metaDescription: page.metaDescription,
            h1: page.h1,
            canonical: page.canonical,
            robots: page.robots,
            indexable: page.indexable,
            wordCount: page.wordCount,
            internalLinkCount: page.internalLinks.length,
            outboundLinkCount: page.outboundLinks.length,
            schemaTypesJson: writeJson(page.schemaTypes),
            issuesJson: writeJson(pageIssues),
            responseMs: page.responseMs,
          },
        });
      }

      // Duplicate titles across the crawled set.
      for (const [title, urls] of titles) {
        if (urls.length > 1) {
          issues.push({
            url: urls[0],
            check: "duplicate_title",
            severity: "ERROR",
            message: `Title "${title}" is shared by ${urls.length} pages: ${urls.slice(0, 4).join(", ")}`,
          });
        }
      }

      // Orphans: published pages nothing links to.
      const linkedPaths = new Set<string>();
      for (const page of result.pages) {
        for (const link of page.internalLinks) {
          try {
            linkedPaths.add(new URL(link).pathname);
          } catch {
            /* ignore malformed */
          }
        }
      }
      const orphans = publishedPages
        .filter((p) => {
          const sitePath = `/site${p.url}`;
          return !linkedPaths.has(sitePath) && !linkedPaths.has(p.url);
        })
        .map((p) => p.url);

      for (const orphan of orphans) {
        issues.push({ url: orphan, check: "orphan_page", severity: "WARNING", message: "Published page has no inbound internal link" });
      }

      // Broken internal links.
      const statusByUrl = new Map(result.pages.map((p) => [p.url, p.httpStatus]));
      const brokenLinks: { from: string; to: string; status: number }[] = [];
      for (const page of result.pages) {
        for (const link of page.internalLinks) {
          const status = statusByUrl.get(link);
          if (status !== undefined && (status === 0 || status >= 400)) {
            brokenLinks.push({ from: page.url, to: link, status });
          }
        }
      }
      for (const b of brokenLinks.slice(0, 50)) {
        issues.push({ url: b.from, check: "broken_link", severity: "ERROR", message: `Links to ${b.to} which returns ${b.status}` });
      }

      const errors = issues.filter((i) => i.severity === "ERROR").length;
      const warnings = issues.filter((i) => i.severity === "WARNING").length;

      await prisma.crawlRun.update({
        where: { id: crawlRun.id },
        data: { status: "COMPLETED", pagesCrawled: result.crawled, issuesFound: issues.length, completedAt: new Date() },
      });
      await prisma.website.update({ where: { id: website.id }, data: { lastCrawledAt: new Date() } });

      // Only the material findings become recommendations.
      if (errors > 0) {
        await prisma.recommendation.create({
          data: {
            projectId: ctx.projectId,
            type: "TECHNICAL_SEO",
            title: `${errors} technical SEO error(s) found on ${website.domain}`,
            detail: issues
              .filter((i) => i.severity === "ERROR")
              .slice(0, 10)
              .map((i) => `${i.url} — ${i.check}: ${i.message}`)
              .join("\n"),
            priority: 85,
            impact: "HIGH",
            effort: "LOW",
            evidenceJson: writeJson({ crawlRunId: crawlRun.id, errors, warnings }),
            sourceAgent: this.key,
          },
        });
      }

      return {
        output: { crawlRunId: crawlRun.id, crawled: result.crawled, errors, warnings, orphans, brokenLinks, issues: issues.slice(0, 300) },
        confidence: result.crawled > 0 ? 0.9 : 0.3,
        summary: `Crawled ${result.crawled} URL(s): ${errors} error(s), ${warnings} warning(s), ${orphans.length} orphan(s), ${brokenLinks.length} broken link(s).`,
        nextAction: errors ? "Fix the technical errors before the next publish cycle" : "Technical surface is clean",
      };
    } catch (e) {
      await prisma.crawlRun.update({
        where: { id: crawlRun.id },
        data: { status: "FAILED", error: (e as Error).message, completedAt: new Date() },
      });
      throw e;
    }
  }
}
