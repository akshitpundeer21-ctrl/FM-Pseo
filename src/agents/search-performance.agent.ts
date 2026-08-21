/**
 * Search Performance Agent.
 *
 * Pulls query- and page-level performance for the project's published pages and
 * target queries, persists snapshots, and converts movement into concrete
 * recommendations that feed back to the orchestrator.
 *
 * With Google Search Console connected this is measured data. Without it, the
 * series is synthetic and every row is flagged isMock - the dashboard labels it
 * and headline metrics never blend the two.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";

const InputSchema = z.object({
  days: z.number().int().min(1).max(180).optional(),
  dimension: z.enum(["query", "page"]).optional(),
  /**
   * Demo only. A page published today genuinely has no search history, so the
   * synthetic provider returns nothing - which is correct but leaves the
   * dashboard empty. Setting this backdates the page's "live since" date so a
   * SIMULATED series can be inspected. It has no effect when a real Search
   * Console integration is connected, and every row stays flagged isMock.
   */
  simulateHistoryDays: z.number().int().min(0).max(180).optional(),
});

const OutputSchema = z.object({
  provider: z.string(),
  isMock: z.boolean(),
  rows: z.number(),
  clicks: z.number(),
  impressions: z.number(),
  avgPosition: z.number(),
  avgCtr: z.number(),
  topMovers: z.array(z.object({ value: z.string(), clicks: z.number(), impressions: z.number(), position: z.number() })),
  recommendations: z.array(z.object({ title: z.string(), detail: z.string(), priority: z.number() })),
});

export type SearchPerformanceInput = z.infer<typeof InputSchema>;
export type SearchPerformanceOutput = z.infer<typeof OutputSchema>;

export class SearchPerformanceAgent extends BaseAgent<SearchPerformanceInput, SearchPerformanceOutput> {
  readonly key = "search_performance";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;
  protected readonly needsBrand = false;

  readonly validationRules: ValidationRule<SearchPerformanceOutput>[] = [
    { name: "provider_recorded", check: (o) => o.provider.length > 0, message: "No data source was recorded" },
  ];

  protected async perform(input: SearchPerformanceInput, ctx: AgentRunContext): Promise<AgentOutcome<SearchPerformanceOutput>> {
    const days = input.days ?? 28;
    const dimension = input.dimension ?? "query";
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);

    // Seeds define the universe for the synthetic provider and are ignored by
    // the real one (GSC returns whatever the property actually has).
    const seeds: { value: string; weight: number; since?: string }[] = [];

    if (dimension === "query") {
      const keywords = await prisma.keyword.findMany({
        where: { projectId: ctx.projectId, recommendedAction: { in: ["TARGET_NEW", "TARGET_EXISTING", "SUPPORT"] } },
        orderBy: { volume: "desc" },
        take: 40,
      });
      const publishedAtByPair = new Map<string, string>();
      for (const p of await prisma.page.findMany({
        where: { projectId: ctx.projectId, status: "PUBLISHED" },
        select: { variablesJson: true, publishedAt: true },
      })) {
        try {
          const v = JSON.parse(p.variablesJson) as { origin?: string; destination?: string };
          if (v.origin && v.destination && p.publishedAt) publishedAtByPair.set(`${v.origin}-${v.destination}`, p.publishedAt.toISOString());
        } catch {
          /* ignore */
        }
      }
      for (const k of keywords) {
        const since = k.origin && k.destination ? publishedAtByPair.get(`${k.origin}-${k.destination}`) : undefined;
        // A keyword with no published page has no impressions to attribute.
        if (!since) continue;
        seeds.push({ value: k.keyword, weight: Math.max(5, Math.round(k.volume * 0.35)), since });
      }
    } else {
      const pages = await prisma.page.findMany({
        where: { projectId: ctx.projectId, status: "PUBLISHED" },
        select: { url: true, publishedAt: true, cluster: { select: { totalVolume: true } } },
      });
      for (const p of pages) {
        seeds.push({
          value: p.url,
          weight: Math.max(20, Math.round((p.cluster?.totalVolume ?? 800) * 0.4)),
          since: p.publishedAt?.toISOString(),
        });
      }
    }

    // Demo backdating: shift each seed's "live since" into the past so the
    // synthetic series has something to show. Rows remain flagged isMock.
    if (input.simulateHistoryDays) {
      const backdated = new Date(end.getTime() - input.simulateHistoryDays * 86_400_000).toISOString();
      for (const s of seeds) s.since = backdated;
      ctx.logger.warn("simulating search history for demo purposes", {
        days: input.simulateHistoryDays,
        seeds: seeds.length,
      });
    }

    if (!seeds.length) {
      return {
        output: {
          provider: "none",
          isMock: true,
          rows: 0,
          clicks: 0,
          impressions: 0,
          avgPosition: 0,
          avgCtr: 0,
          topMovers: [],
          recommendations: [],
        },
        confidence: 0.5,
        summary: "No published pages yet, so there is nothing to attribute search performance to.",
        nextAction: "Publish at least one page before monitoring search performance",
      };
    }

    const result = await ctx.tool<{
      provider: string;
      isMock: boolean;
      rows: {
        date: string;
        dimension: "query" | "page";
        dimensionValue: string;
        clicks: number;
        impressions: number;
        ctr: number;
        position: number;
        isMock: boolean;
        source: string;
      }[];
    }>("analytics.search_performance", {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      dimension,
      seeds,
    });

    // Replace the window so re-running does not double-count.
    await prisma.analyticsSnapshot.deleteMany({
      where: { projectId: ctx.projectId, dimension, date: { gte: start, lte: end } },
    });

    for (const row of result.rows) {
      await prisma.analyticsSnapshot.create({
        data: {
          projectId: ctx.projectId,
          source: row.source,
          date: new Date(`${row.date}T00:00:00Z`),
          dimension: row.dimension,
          dimensionValue: row.dimensionValue,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          isMock: row.isMock,
        },
      });
    }

    // --- aggregate + recommend ---------------------------------------------
    const byValue = new Map<string, { clicks: number; impressions: number; positionSum: number; n: number }>();
    for (const r of result.rows) {
      const agg = byValue.get(r.dimensionValue) ?? { clicks: 0, impressions: 0, positionSum: 0, n: 0 };
      agg.clicks += r.clicks;
      agg.impressions += r.impressions;
      agg.positionSum += r.position;
      agg.n++;
      byValue.set(r.dimensionValue, agg);
    }

    const clicks = result.rows.reduce((s, r) => s + r.clicks, 0);
    const impressions = result.rows.reduce((s, r) => s + r.impressions, 0);
    const avgPosition = result.rows.length ? result.rows.reduce((s, r) => s + r.position, 0) / result.rows.length : 0;
    const avgCtr = impressions ? clicks / impressions : 0;

    const ranked = [...byValue.entries()]
      .map(([value, a]) => ({ value, clicks: a.clicks, impressions: a.impressions, position: a.n ? a.positionSum / a.n : 0 }))
      .sort((a, b) => b.impressions - a.impressions);

    const recommendations: SearchPerformanceOutput["recommendations"] = [];

    // Striking distance: real impressions, position 8-20, weak CTR.
    for (const r of ranked.slice(0, 30)) {
      const ctr = r.impressions ? r.clicks / r.impressions : 0;
      if (r.impressions >= 50 && r.position > 8 && r.position <= 20) {
        recommendations.push({
          title: `Strengthen coverage for "${r.value}"`,
          detail: `${r.impressions.toLocaleString()} impressions at average position ${r.position.toFixed(1)} with ${r.clicks} clicks. This is within striking distance - deepen the section that targets it and add an answer block.`,
          priority: 75,
        });
      } else if (r.impressions >= 200 && r.position <= 8 && ctr < 0.03) {
        recommendations.push({
          title: `Improve the snippet for "${r.value}"`,
          detail: `Ranking well (position ${r.position.toFixed(1)}) but CTR is ${(ctr * 100).toFixed(1)}%. Rewrite the title and meta description to match the query intent more directly.`,
          priority: 70,
        });
      }
    }

    for (const rec of recommendations.slice(0, 8)) {
      await prisma.recommendation.create({
        data: {
          projectId: ctx.projectId,
          type: "SEARCH_PERFORMANCE",
          title: rec.title,
          detail: rec.detail,
          priority: rec.priority,
          impact: "MEDIUM",
          effort: "LOW",
          evidenceJson: writeJson({ provider: result.provider, isMock: result.isMock, window: `${days}d` }),
          sourceAgent: this.key,
        },
      });
    }

    return {
      output: {
        provider: result.provider,
        isMock: result.isMock,
        rows: result.rows.length,
        clicks,
        impressions,
        avgPosition: Number(avgPosition.toFixed(2)),
        avgCtr: Number(avgCtr.toFixed(4)),
        topMovers: ranked.slice(0, 10),
        recommendations: recommendations.slice(0, 8),
      },
      confidence: result.isMock ? 0.6 : 0.9,
      summary: `${result.rows.length} rows over ${days}d via ${result.provider}${result.isMock ? " (MOCK series)" : ""}: ${clicks} clicks, ${impressions} impressions, avg position ${avgPosition.toFixed(1)}. ${recommendations.length} recommendation(s).`,
      nextAction: recommendations.length ? "Feed the recommendations back into the content plan" : "Continue monitoring",
    };
  }
}
