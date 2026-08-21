/**
 * Technical tools: crawling, single-URL fetch, LLM generation.
 */
import { z } from "zod";
import { registerTool } from "@/tools/registry";
import { FetchCrawler } from "@/modules/crawler/crawler";
import { createRouter } from "@/llm/router";
import { ModelTierSchema } from "@/core/types/enums";

const CrawledPageSchema = z.object({
  url: z.string(),
  httpStatus: z.number(),
  contentType: z.string().nullable(),
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  h1: z.string().nullable(),
  headings: z.array(z.object({ level: z.number(), text: z.string() })),
  canonical: z.string().nullable(),
  robots: z.string().nullable(),
  indexable: z.boolean(),
  wordCount: z.number(),
  internalLinks: z.array(z.string()),
  outboundLinks: z.array(z.string()),
  schemaTypes: z.array(z.string()),
  jsonLd: z.array(z.unknown()),
  responseMs: z.number(),
  error: z.string().optional(),
});

export const crawlTool = registerTool({
  key: "web.crawl",
  name: "Crawl website",
  description: "Fetches and parses pages from a site (respects robots.txt) for technical SEO analysis.",
  category: "technical",
  requiredCapability: "crawl_web",
  integrationProvider: "internal_crawler",
  allowMockFallback: true,
  timeoutMs: 180_000,
  inputSchema: z.object({
    startUrls: z.array(z.string().url()).min(1),
    maxPages: z.number().int().min(1).max(500).optional(),
    sameOriginOnly: z.boolean().optional(),
  }),
  outputSchema: z.object({ pages: z.array(CrawledPageSchema), crawled: z.number() }),
  async execute(input, ctx) {
    const crawler = new FetchCrawler();
    const pages = await crawler.crawl(input.startUrls, {
      maxPages: input.maxPages,
      sameOriginOnly: input.sameOriginOnly ?? true,
    });
    ctx.logger.info("crawl complete", { pages: pages.length });
    return { pages, crawled: pages.length };
  },
});

export const fetchUrlTool = registerTool({
  key: "web.fetch",
  name: "Fetch a single URL",
  description: "Fetches one URL and returns parsed SEO signals. Used for verification evidence and spot checks.",
  category: "technical",
  requiredCapability: "crawl_web",
  integrationProvider: "internal_crawler",
  allowMockFallback: true,
  retries: 1,
  inputSchema: z.object({ url: z.string().url() }),
  outputSchema: CrawledPageSchema,
  async execute(input) {
    return new FetchCrawler().fetchOne(input.url);
  },
});

export const llmGenerateTool = registerTool({
  key: "llm.generate",
  name: "LLM generation",
  description:
    "Generates text through the model router. Falls back to the deterministic mock composer when no provider is configured.",
  category: "content",
  requiredCapability: "call_llm",
  allowMockFallback: true,
  costly: true,
  retries: 1,
  inputSchema: z.object({
    task: z.string(),
    system: z.string().optional(),
    prompt: z.string(),
    variables: z.record(z.string(), z.unknown()).optional(),
    tier: ModelTierSchema.optional(),
    maxTokens: z.number().int().min(64).max(8000).optional(),
    temperature: z.number().min(0).max(1).optional(),
    complexity: z.number().min(0).max(1).optional(),
  }),
  outputSchema: z.object({
    text: z.string(),
    provider: z.string(),
    model: z.string(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    costUsd: z.number(),
    isMock: z.boolean(),
    routingReason: z.string(),
  }),
  async execute(input, ctx) {
    const router = createRouter({ organizationId: ctx.organizationId, projectId: ctx.projectId });
    const res = await router.complete({
      task: input.task,
      tier: input.tier,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      complexity: input.complexity,
      variables: input.variables,
      messages: [
        ...(input.system ? [{ role: "system" as const, content: input.system }] : []),
        { role: "user" as const, content: input.prompt },
      ],
    });

    if (res.isMock) ctx.markMock();
    await ctx.charge(res.costUsd, { tokensIn: res.tokensIn, tokensOut: res.tokensOut, category: "llm" });

    return {
      text: res.text,
      provider: res.provider,
      model: res.model,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      costUsd: res.costUsd,
      isMock: res.isMock,
      routingReason: res.routing.reason,
    };
  },
});
