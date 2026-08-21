/**
 * Publishing + analytics + AI-visibility tools.
 *
 * `cms.publish` requires the `publish` capability, which only the Publishing
 * Agent holds. Content agents cannot reach it even if they know the tool key.
 */
import { z } from "zod";
import { registerTool } from "@/tools/registry";
import { selectAdapter } from "@/modules/publishing/adapters";
import {
  GoogleSearchConsoleProvider,
  MockSearchPerformanceProvider,
  type SearchPerformanceProvider,
} from "@/modules/analytics/providers";
import { probe, extractMentions, extractCitations, domainOf, isOwnedUrl } from "@/modules/ai-visibility/platforms";
import { resolveCredentials } from "@/integrations/service";

export const publishTool = registerTool({
  key: "cms.publish",
  name: "Publish page",
  description:
    "Publishes a rendered page through the configured adapter. Records which adapter actually ran, including any fallback.",
  category: "publishing",
  requiredCapability: "publish",
  integrationProvider: "webhook_cms",
  allowMockFallback: true,
  timeoutMs: 60_000,
  inputSchema: z.object({
    adapter: z.enum(["local_static", "webhook", "wordpress"]).optional(),
    payload: z.object({
      url: z.string(),
      title: z.string(),
      metaDescription: z.string(),
      html: z.string(),
      markdown: z.string().optional(),
      jsonLd: z.array(z.unknown()),
      canonical: z.string().optional(),
    }),
  }),
  outputSchema: z.object({
    remoteId: z.string(),
    remoteUrl: z.string(),
    adapterUsed: z.string(),
    requestedAdapter: z.string(),
    fellBack: z.boolean(),
    reason: z.string(),
  }),
  async execute(input, ctx) {
    const wp = await resolveCredentials(ctx.organizationId, "wordpress", ctx.projectId).catch(() => null);
    const hook = await resolveCredentials(ctx.organizationId, "webhook_cms", ctx.projectId).catch(() => null);

    const selection = selectAdapter(input.adapter ?? "local_static", {
      webhookUrl: hook?.settings.url,
      webhookSecret: hook?.values.secret,
      wpBaseUrl: wp?.settings.baseUrl,
      wpUser: wp?.values.username,
      wpPassword: wp?.values.applicationPassword,
    });

    if (selection.fellBack) {
      ctx.logger.warn("publishing adapter fell back", { requested: input.adapter ?? "local_static", reason: selection.reason });
    }

    const outcome = await selection.adapter.publish({
      ...input.payload,
      jsonLd: input.payload.jsonLd as unknown[],
    });

    return {
      remoteId: outcome.remoteId,
      remoteUrl: outcome.remoteUrl,
      adapterUsed: selection.adapter.key,
      requestedAdapter: selection.requested,
      fellBack: selection.fellBack,
      reason: selection.reason,
    };
  },
});

export const unpublishTool = registerTool({
  key: "cms.unpublish",
  name: "Unpublish page",
  description: "Removes a published page from the target. Used by rollback and unpublish flows.",
  category: "publishing",
  requiredCapability: "unpublish",
  allowMockFallback: true,
  inputSchema: z.object({ adapter: z.enum(["local_static", "webhook", "wordpress"]), remoteId: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), adapterUsed: z.string() }),
  async execute(input, ctx) {
    const selection = selectAdapter(input.adapter);
    await selection.adapter.unpublish(input.remoteId);
    ctx.logger.warn("page unpublished", { remoteId: input.remoteId, adapter: selection.adapter.key });
    return { ok: true, adapterUsed: selection.adapter.key };
  },
});

export const searchPerformanceTool = registerTool({
  key: "analytics.search_performance",
  name: "Search performance",
  description:
    "Clicks/impressions/CTR/position by query or page. Google Search Console when connected, otherwise a labelled synthetic series.",
  category: "analytics",
  requiredCapability: "read_analytics",
  integrationProvider: "google_search_console",
  allowMockFallback: true,
  timeoutMs: 60_000,
  inputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
    dimension: z.enum(["query", "page"]),
    seeds: z.array(z.object({ value: z.string(), weight: z.number(), since: z.string().optional() })).optional(),
    rowLimit: z.number().int().max(5000).optional(),
  }),
  outputSchema: z.object({
    provider: z.string(),
    isMock: z.boolean(),
    rows: z.array(
      z.object({
        date: z.string(),
        dimension: z.enum(["query", "page"]),
        dimensionValue: z.string(),
        clicks: z.number(),
        impressions: z.number(),
        ctr: z.number(),
        position: z.number(),
        isMock: z.boolean(),
        source: z.string(),
      }),
    ),
  }),
  async execute(input, ctx) {
    const creds = ctx.credentials;
    let provider: SearchPerformanceProvider = new MockSearchPerformanceProvider();

    if (creds?.configured) {
      const gsc = new GoogleSearchConsoleProvider(
        {
          clientId: creds.values.clientId,
          clientSecret: creds.values.clientSecret,
          refreshToken: creds.values.refreshToken,
          serviceAccountJson: creds.values.serviceAccountJson,
        },
        creds.settings.siteUrl,
      );
      if (gsc.isConfigured()) provider = gsc;
    }
    if (provider.isMock) ctx.markMock();

    const rows = await provider.fetchPerformance({
      startDate: input.startDate,
      endDate: input.endDate,
      dimension: input.dimension,
      seeds: input.seeds,
      rowLimit: input.rowLimit,
    });
    return { provider: provider.key, isMock: provider.isMock, rows };
  },
});

export const aiVisibilityProbeTool = registerTool({
  key: "ai_visibility.probe",
  name: "AI visibility probe",
  description:
    "Runs one prompt against an answer engine and extracts brand/competitor mentions and cited URLs. Measures mentions and citations - not rankings.",
  category: "visibility",
  requiredCapability: "call_llm",
  allowMockFallback: true,
  costly: true,
  timeoutMs: 90_000,
  inputSchema: z.object({
    platform: z.enum(["anthropic", "openai", "perplexity", "mock"]),
    prompt: z.string().min(3),
    brandName: z.string(),
    brandDomain: z.string(),
    competitors: z.array(z.object({ name: z.string(), domain: z.string() })),
  }),
  outputSchema: z.object({
    platform: z.string(),
    model: z.string(),
    text: z.string(),
    isMock: z.boolean(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    costUsd: z.number(),
    latencyMs: z.number(),
    mentions: z.array(
      z.object({
        entityName: z.string(),
        entityType: z.enum(["BRAND", "COMPETITOR", "DOMAIN", "OTHER"]),
        context: z.string(),
        position: z.number(),
        sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE"]),
      }),
    ),
    citations: z.array(z.object({ url: z.string(), domain: z.string(), isOwned: z.boolean(), position: z.number() })),
  }),
  async execute(input, ctx) {
    let credentials: Record<string, string> | undefined;
    if (input.platform === "perplexity") {
      const c = await resolveCredentials(ctx.organizationId, "perplexity", ctx.projectId);
      credentials = c.values;
    }

    const result = await probe(input.platform, input.prompt, {
      brandName: input.brandName,
      brandDomain: input.brandDomain,
      competitors: input.competitors,
      credentials,
    });

    if (result.isMock) ctx.markMock();
    if (result.costUsd) await ctx.charge(result.costUsd, { tokensIn: result.tokensIn, tokensOut: result.tokensOut, category: "ai_visibility" });

    const mentions = extractMentions(result.text, { name: input.brandName, domain: input.brandDomain }, input.competitors);
    const citations = (result.citations.length ? result.citations : extractCitations(result.text)).map((c) => ({
      url: c.url,
      domain: domainOf(c.url),
      isOwned: isOwnedUrl(c.url, input.brandDomain),
      position: c.position,
    }));

    return {
      platform: result.platform,
      model: result.model,
      text: result.text,
      isMock: result.isMock,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      mentions,
      citations,
    };
  },
});
