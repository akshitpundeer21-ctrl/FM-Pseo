/**
 * Research tools: keyword discovery and competitor lookup.
 */
import { z } from "zod";
import { registerTool } from "@/tools/registry";
import { DataForSeoProvider, MockKeywordProvider, type KeywordProvider } from "@/modules/keywords/providers";
import { loadCompetitors } from "@/engine/data/adapters/static-dataset";
import { SearchIntentSchema } from "@/core/types/enums";

const KeywordRowSchema = z.object({
  keyword: z.string(),
  intent: SearchIntentSchema,
  entityType: z.string().nullable(),
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  airport: z.string().nullable().optional(),
  airline: z.string().nullable().optional(),
  pageType: z.string().nullable(),
  volume: z.number(),
  difficulty: z.number(),
  cpc: z.number(),
  businessValue: z.number(),
  source: z.string(),
  isMock: z.boolean(),
});

export const keywordDiscoverTool = registerTool({
  key: "keyword.discover",
  name: "Keyword discovery",
  description:
    "Returns keyword candidates with volume, difficulty, CPC and intent. Uses DataForSEO when credentials exist, otherwise the labelled synthetic corpus.",
  category: "research",
  requiredCapability: "call_external_api",
  integrationProvider: "dataforseo",
  allowMockFallback: true,
  costly: true,
  retries: 1,
  inputSchema: z.object({
    seeds: z.array(z.string()).min(1),
    origin: z.string().optional(),
    destination: z.string().optional(),
    entityTypes: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    minVolume: z.number().int().min(0).optional(),
  }),
  outputSchema: z.object({
    provider: z.string(),
    isMock: z.boolean(),
    rows: z.array(KeywordRowSchema),
    note: z.string(),
  }),
  async execute(input, ctx) {
    const creds = ctx.credentials;
    let provider: KeywordProvider = new MockKeywordProvider();
    let note = "Synthetic corpus (MOCK). Volumes are illustrative, not measured.";

    if (creds?.configured) {
      const real = new DataForSeoProvider(creds.values.login, creds.values.password);
      if (real.isConfigured()) {
        provider = real;
        note = "Live DataForSEO search-volume data.";
      }
    }
    if (provider.isMock) ctx.markMock();

    const rows = await provider.discover(input);
    ctx.logger.info("keyword discovery complete", { provider: provider.key, rows: rows.length, isMock: provider.isMock });

    // Real providers bill per request; record a nominal cost for the ledger.
    if (!provider.isMock) await ctx.charge(0.01, { category: "keyword_data" });

    return { provider: provider.key, isMock: provider.isMock, rows, note };
  },
});

export const competitorLookupTool = registerTool({
  key: "research.competitors",
  name: "Competitor lookup",
  description: "Returns the seed competitive set for travel search. Replaceable with a live SERP provider later.",
  category: "research",
  requiredCapability: "read_project",
  allowMockFallback: true,
  inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
  outputSchema: z.object({
    isMock: z.boolean(),
    competitors: z.array(z.object({ name: z.string(), domain: z.string(), type: z.string(), isPrimary: z.boolean() })),
  }),
  async execute(input, ctx) {
    ctx.markMock();
    return { isMock: true, competitors: loadCompetitors().slice(0, input.limit ?? 20) };
  },
});
