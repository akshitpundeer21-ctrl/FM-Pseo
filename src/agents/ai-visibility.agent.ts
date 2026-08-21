/**
 * AI Visibility Agent.
 *
 * Runs the project's prompt library against the configured answer-engine
 * platforms and records, per run: the full response, brand/competitor mentions,
 * cited URLs, and which of those URLs we own.
 *
 * Metrics are deliberately mention/citation-shaped, never ranking-shaped:
 *   mentionRate, citationRate, queryCoverage, citationShare,
 *   competitorMentionShare, and a composite visibilityScore.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { env } from "@/core/config/env";

const InputSchema = z.object({
  platforms: z.array(z.enum(["anthropic", "openai", "perplexity", "mock"])).optional(),
  promptIds: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(60).optional(),
});

const OutputSchema = z.object({
  runs: z.number(),
  platforms: z.array(z.string()),
  isMock: z.boolean(),
  metrics: z.object({
    mentionRate: z.number(),
    citationRate: z.number(),
    queryCoverage: z.number(),
    citationShare: z.number(),
    competitorMentionShare: z.number(),
    visibilityScore: z.number(),
  }),
  competitorBreakdown: z.array(z.object({ name: z.string(), mentions: z.number(), citations: z.number(), mentionShare: z.number() })),
  uncoveredPrompts: z.array(z.string()),
});

export type AiVisibilityInput = z.infer<typeof InputSchema>;
export type AiVisibilityOutput = z.infer<typeof OutputSchema>;

export class AiVisibilityAgent extends BaseAgent<AiVisibilityInput, AiVisibilityOutput> {
  readonly key = "ai_visibility";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;

  readonly validationRules: ValidationRule<AiVisibilityOutput>[] = [
    { name: "ran_something", check: (o) => o.runs > 0, message: "No prompts were run" },
    {
      name: "rates_in_range",
      check: (o) =>
        [o.metrics.mentionRate, o.metrics.citationRate, o.metrics.queryCoverage, o.metrics.citationShare].every(
          (v) => v >= 0 && v <= 1,
        ),
      message: "A visibility rate fell outside 0..1",
    },
  ];

  protected async perform(input: AiVisibilityInput, ctx: AgentRunContext): Promise<AgentOutcome<AiVisibilityOutput>> {
    const brandName = ctx.brand?.brandName ?? "the brand";
    const website = await prisma.website.findFirst({ where: { projectId: ctx.projectId } });
    const brandDomain = website?.domain ?? "example.com";

    const competitorRows = await prisma.competitor.findMany({ where: { projectId: ctx.projectId } });
    const competitors = competitorRows.map((c) => ({ name: c.name, domain: c.domain }));

    const prompts = await prisma.aIPrompt.findMany({
      where: {
        projectId: ctx.projectId,
        isActive: true,
        ...(input.promptIds?.length ? { id: { in: input.promptIds } } : {}),
      },
      take: input.limit ?? 12,
    });
    if (!prompts.length) throw new Error("The prompt library is empty. Seed prompts before running AI visibility.");

    const platforms = input.platforms?.length
      ? input.platforms
      : (env().AI_VISIBILITY_PLATFORMS.split(",").map((p) => p.trim()).filter(Boolean) as ("anthropic" | "openai" | "perplexity" | "mock")[]);

    const usedPlatforms = new Set<string>();
    let runs = 0;
    let brandMentions = 0;
    let brandCitations = 0;
    let promptsWithBrand = 0;
    let totalCitations = 0;
    let ownedCitations = 0;
    let allMentions = 0;
    let sawMock = false;

    const competitorTally = new Map<string, { mentions: number; citations: number }>();
    const uncoveredPrompts: string[] = [];

    for (const prompt of prompts) {
      let mentionedInAnyPlatform = false;

      for (const platform of platforms) {
        try {
          const result = await ctx.tool<{
            platform: string;
            model: string;
            text: string;
            isMock: boolean;
            tokensIn: number;
            tokensOut: number;
            costUsd: number;
            latencyMs: number;
            mentions: { entityName: string; entityType: string; context: string; position: number; sentiment: string }[];
            citations: { url: string; domain: string; isOwned: boolean; position: number }[];
          }>("ai_visibility.probe", {
            platform,
            prompt: prompt.prompt,
            brandName,
            brandDomain,
            competitors,
          });

          usedPlatforms.add(result.platform);
          if (result.isMock) sawMock = true;
          runs++;

          const brandMention = result.mentions.find((m) => m.entityType === "BRAND");
          const brandCitation = result.citations.find((c) => c.isOwned);
          if (brandMention) {
            brandMentions++;
            mentionedInAnyPlatform = true;
          }
          if (brandCitation) brandCitations++;

          allMentions += result.mentions.length;
          totalCitations += result.citations.length;
          ownedCitations += result.citations.filter((c) => c.isOwned).length;

          for (const m of result.mentions.filter((x) => x.entityType === "COMPETITOR")) {
            const t = competitorTally.get(m.entityName) ?? { mentions: 0, citations: 0 };
            t.mentions++;
            competitorTally.set(m.entityName, t);
          }
          for (const c of result.citations.filter((x) => !x.isOwned)) {
            const match = competitors.find((comp) => c.domain.includes(comp.domain.replace(/^www\./, "")));
            if (match) {
              const t = competitorTally.get(match.name) ?? { mentions: 0, citations: 0 };
              t.citations++;
              competitorTally.set(match.name, t);
            }
          }

          const aiRun = await prisma.aIRun.create({
            data: {
              promptId: prompt.id,
              platform: result.platform,
              model: result.model,
              responseText: result.text.slice(0, 12000),
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              costUsd: result.costUsd,
              latencyMs: result.latencyMs,
              brandMentioned: Boolean(brandMention),
              domainMentioned: result.text.includes(brandDomain),
              brandCited: Boolean(brandCitation),
              isMock: result.isMock,
            },
          });

          for (const m of result.mentions) {
            await prisma.aIMention.create({
              data: {
                aiRunId: aiRun.id,
                entityName: m.entityName,
                entityType: m.entityType,
                context: m.context.slice(0, 500),
                position: m.position,
                sentiment: m.sentiment,
              },
            });
          }
          for (const c of result.citations) {
            await prisma.aICitation.create({
              data: { aiRunId: aiRun.id, url: c.url.slice(0, 500), domain: c.domain, isOwned: c.isOwned, position: c.position },
            });
          }
        } catch (e) {
          ctx.logger.error("ai visibility probe failed", { platform, prompt: prompt.prompt.slice(0, 80), error: (e as Error).message });
          await prisma.aIRun.create({
            data: {
              promptId: prompt.id,
              platform,
              model: "unknown",
              error: (e as Error).message.slice(0, 500),
              isMock: false,
            },
          });
        }
      }

      if (mentionedInAnyPlatform) promptsWithBrand++;
      else uncoveredPrompts.push(prompt.prompt);
    }

    // --- metrics -------------------------------------------------------------
    const mentionRate = runs ? brandMentions / runs : 0;
    const citationRate = runs ? brandCitations / runs : 0;
    const queryCoverage = prompts.length ? promptsWithBrand / prompts.length : 0;
    const citationShare = totalCitations ? ownedCitations / totalCitations : 0;
    const competitorMentions = [...competitorTally.values()].reduce((s, t) => s + t.mentions, 0);
    const competitorMentionShare = allMentions ? competitorMentions / allMentions : 0;

    // Composite. Weighted toward citation, which is the harder signal to earn.
    const visibilityScore = Number(
      ((mentionRate * 0.3 + citationRate * 0.35 + queryCoverage * 0.2 + citationShare * 0.15) * 100).toFixed(1),
    );

    const competitorBreakdown = [...competitorTally.entries()]
      .map(([name, t]) => ({
        name,
        mentions: t.mentions,
        citations: t.citations,
        mentionShare: allMentions ? Number((t.mentions / allMentions).toFixed(3)) : 0,
      }))
      .sort((a, b) => b.mentions - a.mentions);

    // Uncovered prompts are content opportunities, not failures.
    if (uncoveredPrompts.length) {
      await prisma.recommendation.create({
        data: {
          projectId: ctx.projectId,
          type: "AI_VISIBILITY",
          title: `${uncoveredPrompts.length} answer-engine prompt(s) never mention ${brandName}`,
          detail: `These prompts produced answers with no brand mention:\n${uncoveredPrompts.slice(0, 8).map((p) => `- ${p}`).join("\n")}\n\nEach one is a content gap: build or deepen the page that would be the obvious source for that answer, with a direct answer block and a visible evidence block.`,
          priority: 72,
          impact: "MEDIUM",
          effort: "MEDIUM",
          evidenceJson: writeJson({ runs, mentionRate, citationRate, isMock: sawMock }),
          sourceAgent: this.key,
        },
      });
    }

    return {
      output: {
        runs,
        platforms: [...usedPlatforms],
        isMock: sawMock,
        metrics: {
          mentionRate: Number(mentionRate.toFixed(3)),
          citationRate: Number(citationRate.toFixed(3)),
          queryCoverage: Number(queryCoverage.toFixed(3)),
          citationShare: Number(citationShare.toFixed(3)),
          competitorMentionShare: Number(competitorMentionShare.toFixed(3)),
          visibilityScore,
        },
        competitorBreakdown,
        uncoveredPrompts: uncoveredPrompts.slice(0, 20),
      },
      confidence: sawMock ? 0.55 : 0.85,
      summary: `${runs} probe(s) across ${[...usedPlatforms].join(", ")}${sawMock ? " (MOCK)" : ""}: mention rate ${(mentionRate * 100).toFixed(0)}%, citation rate ${(citationRate * 100).toFixed(0)}%, coverage ${(queryCoverage * 100).toFixed(0)}%, visibility score ${visibilityScore}.`,
      nextAction: uncoveredPrompts.length
        ? `Build content for the ${uncoveredPrompts.length} uncovered prompt(s)`
        : "Continue sampling the prompt library on a schedule",
    };
  }
}
