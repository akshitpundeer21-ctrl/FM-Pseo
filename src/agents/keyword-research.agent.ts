/**
 * Keyword Research Agent.
 *
 * Entities in -> scored, clustered, cannibalisation-checked keyword set out.
 * Structural work (scoring, clustering, intent) is deterministic; the LLM is
 * only consulted for a second opinion on ambiguous intent when a provider is
 * configured, so the agent produces identical, auditable output offline.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { loadAirports, loadRoutes } from "@/engine/data/adapters/static-dataset";
import { questionVariants, seedTermsFor, type KeywordRow } from "@/modules/keywords/providers";
import {
  clusterKeywords,
  detectCannibalisation,
  entityKeyFor,
  recommendAction,
  type ClusterableKeyword,
} from "@/modules/keywords/clustering";
import { SearchIntentSchema } from "@/core/types/enums";
import { clamp } from "@/core/utils/text";

const InputSchema = z.object({
  origin: z.string().optional(),
  destination: z.string().optional(),
  seeds: z.array(z.string()).optional(),
  entityTypes: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(400).optional(),
  includeSiblingRoutes: z.boolean().optional(),
});

const ClusterSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  primaryKeyword: z.string(),
  intent: SearchIntentSchema,
  pageType: z.string().nullable(),
  entityKey: z.string(),
  totalVolume: z.number(),
  avgDifficulty: z.number(),
  opportunityScore: z.number(),
  keywordCount: z.number(),
  questionCount: z.number(),
});

const OutputSchema = z.object({
  keywordCount: z.number(),
  clusterCount: z.number(),
  clusters: z.array(ClusterSummarySchema),
  topKeywords: z.array(
    z.object({ keyword: z.string(), volume: z.number(), intent: SearchIntentSchema, opportunityScore: z.number(), action: z.string() }),
  ),
  cannibalisation: z.array(
    z.object({ keyword: z.string(), clusterA: z.string(), clusterB: z.string(), similarity: z.number(), severity: z.string(), recommendation: z.string() }),
  ),
  provider: z.string(),
  isMock: z.boolean(),
});

export type KeywordResearchInput = z.infer<typeof InputSchema>;
export type KeywordResearchOutput = z.infer<typeof OutputSchema>;

export class KeywordResearchAgent extends BaseAgent<KeywordResearchInput, KeywordResearchOutput> {
  readonly key = "keyword_research";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;

  readonly validationRules: ValidationRule<KeywordResearchOutput>[] = [
    { name: "has_keywords", check: (o) => o.keywordCount > 0, message: "No keywords were discovered" },
    { name: "has_clusters", check: (o) => o.clusterCount > 0, message: "No clusters were formed" },
    {
      name: "cluster_integrity",
      check: (o) => o.clusters.every((c) => c.keywordCount > 0 && Boolean(c.primaryKeyword)),
      message: "A cluster has no keywords or no primary keyword",
    },
  ];

  protected async perform(input: KeywordResearchInput, ctx: AgentRunContext): Promise<AgentOutcome<KeywordResearchOutput>> {
    const airports = loadAirports();
    const resolveIata = (value?: string): string | undefined => {
      if (!value) return undefined;
      const v = value.trim();
      const byIata = airports.find((a) => a.iata.toLowerCase() === v.toLowerCase());
      if (byIata) return byIata.iata;
      const byCity = airports.find((a) => a.city.toLowerCase() === v.toLowerCase());
      return byCity?.iata;
    };

    const origin = resolveIata(input.origin);
    const destination = resolveIata(input.destination);
    const originCity = airports.find((a) => a.iata === origin)?.city ?? input.origin ?? "";
    const destinationCity = airports.find((a) => a.iata === destination)?.city ?? input.destination ?? "";

    // 1. Seeds: explicit + entity-derived + question variants.
    const seeds = new Set<string>(input.seeds ?? []);
    if (originCity && destinationCity) {
      for (const s of seedTermsFor(originCity, destinationCity)) seeds.add(s);
    }
    if (input.includeSiblingRoutes && origin) {
      for (const r of loadRoutes().filter((r) => r.origin === origin).slice(0, 8)) {
        seeds.add(`${r.originCity} to ${r.destinationCity} flights`);
      }
    }
    if (!seeds.size) seeds.add("flights");

    ctx.logger.info("keyword seeds prepared", { seeds: seeds.size, origin, destination });

    // 2. Discover.
    const discovery = await ctx.tool<{ provider: string; isMock: boolean; rows: KeywordRow[]; note: string }>("keyword.discover", {
      seeds: [...seeds],
      origin,
      destination,
      entityTypes: input.entityTypes,
      limit: input.limit ?? 120,
    });

    // 3. Enrich: business value + per-keyword opportunity score.
    const enriched: ClusterableKeyword[] = discovery.rows.map((row) => ({
      keyword: row.keyword,
      intent: row.intent,
      entityType: row.entityType,
      origin: row.origin,
      destination: row.destination,
      airport: row.airport ?? null,
      airline: row.airline ?? null,
      pageType: row.pageType,
      volume: row.volume,
      difficulty: row.difficulty,
      businessValue: row.businessValue || defaultBusinessValue(row.intent),
    }));

    // 4. Cluster + cannibalisation.
    const clusters = clusterKeywords(enriched);
    const cannibalisation = detectCannibalisation(clusters);

    // 5. Existing inventory, for TARGET_NEW vs TARGET_EXISTING.
    const existingPages = await prisma.page.findMany({ where: { projectId: ctx.projectId }, select: { url: true } });
    const existingUrls = new Set(existingPages.map((p) => p.url));

    // 6. Persist. Re-running research replaces the clustering (keywords keep
    //    their rows and are re-pointed) so the agent is idempotent.
    await prisma.keywordCluster.deleteMany({ where: { projectId: ctx.projectId } });

    const clusterIdByName = new Map<string, string>();
    for (const cluster of clusters) {
      const row = await prisma.keywordCluster.create({
        data: {
          projectId: ctx.projectId,
          name: cluster.name,
          primaryKeyword: cluster.primaryKeyword,
          intent: cluster.intent,
          pageType: cluster.pageType,
          totalVolume: cluster.totalVolume,
          avgDifficulty: cluster.avgDifficulty,
          opportunityScore: cluster.opportunityScore,
          cannibalizationNotes: cannibalisation
            .filter((c) => c.clusterA === cluster.name || c.clusterB === cluster.name)
            .map((c) => `${c.severity}: ${c.recommendation}`)
            .join(" | ") || null,
        },
      });
      clusterIdByName.set(cluster.name, row.id);
    }

    let persisted = 0;
    const topKeywords: KeywordResearchOutput["topKeywords"] = [];

    for (const cluster of clusters) {
      const clusterId = clusterIdByName.get(cluster.name)!;
      const candidateUrl = candidateUrlFor(cluster.entityKey);

      for (const k of cluster.keywords) {
        const opportunityScore = keywordOpportunity(k);
        const action = recommendAction(k, cluster, existingUrls, candidateUrl);

        await prisma.keyword.upsert({
          where: { projectId_keyword: { projectId: ctx.projectId, keyword: k.keyword } },
          update: {
            clusterId,
            intent: k.intent,
            entityType: k.entityType,
            origin: k.origin,
            destination: k.destination,
            pageType: k.pageType,
            volume: k.volume,
            difficulty: k.difficulty,
            businessValue: k.businessValue,
            opportunityScore,
            recommendedAction: action,
            source: discovery.provider,
            isMock: discovery.isMock,
          },
          create: {
            projectId: ctx.projectId,
            clusterId,
            keyword: k.keyword,
            intent: k.intent,
            entityType: k.entityType,
            origin: k.origin,
            destination: k.destination,
            pageType: k.pageType,
            volume: k.volume,
            difficulty: k.difficulty,
            cpc: 0,
            businessValue: k.businessValue,
            opportunityScore,
            recommendedAction: action,
            source: discovery.provider,
            isMock: discovery.isMock,
          },
        });
        persisted++;
        topKeywords.push({ keyword: k.keyword, volume: k.volume, intent: k.intent, opportunityScore, action });
      }
    }

    topKeywords.sort((a, b) => b.opportunityScore - a.opportunityScore);

    // 7. Register the question keywords as AEO targets for the strategy stage.
    if (originCity && destinationCity) {
      const missingQuestions = questionVariants(originCity, destinationCity).filter(
        (q) => !enriched.some((k) => k.keyword.toLowerCase() === q.toLowerCase()),
      );
      if (missingQuestions.length) {
        ctx.logger.info("question variants not present in provider data", { count: missingQuestions.length });
      }
    }

    const coverage = clamp(clusters.length / 3, 0, 1);
    const confidence = clamp((discovery.isMock ? 0.72 : 0.9) * (0.6 + coverage * 0.4), 0, 1);

    return {
      output: {
        keywordCount: persisted,
        clusterCount: clusters.length,
        clusters: clusters.map((c) => ({
          id: clusterIdByName.get(c.name)!,
          name: c.name,
          primaryKeyword: c.primaryKeyword,
          intent: c.intent,
          pageType: c.pageType,
          entityKey: c.entityKey,
          totalVolume: c.totalVolume,
          avgDifficulty: c.avgDifficulty,
          opportunityScore: c.opportunityScore,
          keywordCount: c.keywords.length,
          questionCount: c.questionKeywords.length,
        })),
        topKeywords: topKeywords.slice(0, 25),
        cannibalisation,
        provider: discovery.provider,
        isMock: discovery.isMock,
      },
      confidence,
      summary: `${persisted} keywords in ${clusters.length} clusters via ${discovery.provider}${discovery.isMock ? " (MOCK data)" : ""}. ${cannibalisation.length} cannibalisation finding(s).`,
      nextAction:
        clusters.length > 0
          ? "Score programmatic opportunities for the highest-value clusters"
          : "Broaden the seed set - no clusters formed",
    };
  }
}

function defaultBusinessValue(intent: string): number {
  switch (intent) {
    case "TRANSACTIONAL":
      return 95;
    case "COMMERCIAL":
      return 80;
    case "QUESTION":
      return 45;
    case "NAVIGATIONAL":
      return 30;
    default:
      return 40;
  }
}

function keywordOpportunity(k: ClusterableKeyword): number {
  const demand = clamp(Math.log10(Math.max(k.volume, 1)) / 4.3, 0, 1);
  const value = k.businessValue / 100;
  const ease = 1 - clamp(k.difficulty / 100, 0, 1);
  return Math.round((demand * 0.45 + value * 0.35 + ease * 0.2) * 1000) / 10;
}

function candidateUrlFor(entityKey: string): string {
  const [kind, value] = entityKey.split(":");
  if (kind === "ROUTE") {
    const [o, d] = value.split("-");
    return `/flights/${o.toLowerCase()}/${d.toLowerCase()}`;
  }
  if (kind === "AIRPORT") return `/airports/${value.toLowerCase()}`;
  if (kind === "AIRLINE") return `/airlines/${value.toLowerCase()}`;
  if (kind === "DESTINATION") return `/destinations/${value.toLowerCase()}`;
  return `/${value.toLowerCase()}`;
}

export { entityKeyFor };
