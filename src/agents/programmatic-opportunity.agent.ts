/**
 * Programmatic Opportunity Agent.
 *
 * For each candidate combination in a page family it resolves the family's data
 * contract, measures how much actually resolved, scores the opportunity and
 * records a BUILD / REVIEW / REJECT decision with reasons.
 *
 * This is the agent that keeps the system from becoming a page mill: a
 * combination existing is never sufficient.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readJson, readStringArray, writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { buildUrl, patternVariables, scoreOpportunity } from "@/engine/pseo/scoring";
import { loadAirports, loadRoutes } from "@/engine/data/adapters/static-dataset";
import { OpportunityDecisionSchema, SearchIntentSchema } from "@/core/types/enums";
import { clamp } from "@/core/utils/text";
import type { DataContext } from "@/engine/data/types";

const InputSchema = z.object({
  pageFamilyKey: z.string(),
  /** Restrict to these clusters; otherwise the family's own candidate source is used. */
  clusterIds: z.array(z.string()).optional(),
  maxCandidates: z.number().int().min(1).max(200).optional(),
  /** Explicit route pairs to evaluate, e.g. [{origin:"DEL",destination:"YYZ"}] */
  candidates: z.array(z.object({ origin: z.string(), destination: z.string() })).optional(),
});

const OpportunitySchema = z.object({
  id: z.string(),
  type: z.string(),
  candidateUrl: z.string(),
  title: z.string(),
  primaryKeyword: z.string().nullable(),
  totalScore: z.number(),
  decision: OpportunityDecisionSchema,
  reasons: z.array(z.string()),
  dataAvailability: z.number(),
  duplicationRisk: z.number(),
});

const OutputSchema = z.object({
  pageFamilyId: z.string(),
  evaluated: z.number(),
  build: z.number(),
  review: z.number(),
  reject: z.number(),
  opportunities: z.array(OpportunitySchema),
});

export type OpportunityInput = z.infer<typeof InputSchema>;
export type OpportunityOutput = z.infer<typeof OutputSchema>;

export class ProgrammaticOpportunityAgent extends BaseAgent<OpportunityInput, OpportunityOutput> {
  readonly key = "programmatic_opportunity";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;
  protected readonly needsBrand = false;

  readonly validationRules: ValidationRule<OpportunityOutput>[] = [
    { name: "evaluated_something", check: (o) => o.evaluated > 0, message: "No candidates were evaluated" },
    {
      name: "every_decision_has_reasons",
      check: (o) => o.opportunities.every((x) => x.reasons.length > 0),
      message: "An opportunity was recorded without any reason",
    },
    {
      name: "no_build_without_data",
      check: (o) => o.opportunities.every((x) => x.decision !== "BUILD" || x.dataAvailability >= 40),
      message: "A candidate was marked BUILD despite insufficient resolved data",
    },
  ];

  protected async perform(input: OpportunityInput, ctx: AgentRunContext): Promise<AgentOutcome<OpportunityOutput>> {
    const family = await prisma.pageFamily.findFirst({
      where: { projectId: ctx.projectId, key: input.pageFamilyKey },
    });
    if (!family) throw new Error(`Page family "${input.pageFamilyKey}" does not exist in this project`);

    const requiredBindings = readStringArray(family.entityTypesJson).length
      ? readJson<{ requiredBindings?: string[] }>(family.compositionJson, {}).requiredBindings ?? DEFAULT_REQUIRED_BINDINGS
      : DEFAULT_REQUIRED_BINDINGS;

    const vars = patternVariables(family.urlPattern);
    const airports = loadAirports();
    const cityOf = (iata: string) => airports.find((a) => a.iata === iata)?.city ?? iata;

    // --- candidate set -----------------------------------------------------
    let candidates: { origin: string; destination: string }[] = input.candidates ?? [];

    if (!candidates.length) {
      const clusters = await prisma.keywordCluster.findMany({
        where: {
          projectId: ctx.projectId,
          ...(input.clusterIds?.length ? { id: { in: input.clusterIds } } : {}),
        },
        orderBy: { opportunityScore: "desc" },
        take: input.maxCandidates ?? 25,
      });

      const seen = new Set<string>();
      for (const c of clusters) {
        const kws = await prisma.keyword.findMany({ where: { clusterId: c.id }, take: 1, orderBy: { volume: "desc" } });
        const k = kws[0];
        if (!k?.origin || !k?.destination) continue;
        const key = `${k.origin}-${k.destination}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ origin: k.origin, destination: k.destination });
      }

      // Fall back to the reference route list when clusters carry no pair.
      if (!candidates.length) {
        candidates = loadRoutes()
          .slice(0, input.maxCandidates ?? 20)
          .map((r) => ({ origin: r.origin, destination: r.destination }));
      }
    }

    ctx.logger.info("evaluating programmatic candidates", { count: candidates.length, family: family.key });

    // --- existing inventory, for duplication risk --------------------------
    const existingPages = await prisma.page.findMany({
      where: { projectId: ctx.projectId },
      select: { url: true, title: true },
    });
    const existingTitles = existingPages.map((p) => p.title);

    const results: OpportunityOutput["opportunities"] = [];
    let build = 0;
    let review = 0;
    let reject = 0;

    for (const cand of candidates) {
      const originCity = cityOf(cand.origin);
      const destinationCity = cityOf(cand.destination);

      // 1. Resolve the family's data contract for this combination.
      const data = await ctx.tool<DataContext & { factIds: string[] }>("data.resolve", {
        requests: [
          { namespace: "route", params: { origin: cand.origin, destination: cand.destination } },
          { namespace: "airport", params: { iata: cand.origin, prefix: "origin" } },
          { namespace: "airport", params: { iata: cand.destination, prefix: "destination" } },
        ],
      });

      const resolvedRequired = requiredBindings.filter((path) => hasValue(data.values, path));
      const dataAvailability = requiredBindings.length ? resolvedRequired.length / requiredBindings.length : 0;
      const distinctDataPoints = data.points.filter((p) => p.value !== null && p.value !== undefined).length;

      // 2. Keywords mapped to this combination.
      const keywords = await prisma.keyword.findMany({
        where: { projectId: ctx.projectId, origin: cand.origin, destination: cand.destination },
      });

      const candidateUrl = buildUrl(
        family.urlPattern,
        buildVars(vars, { origin: cand.origin, destination: cand.destination, originCity, destinationCity }),
      );
      const title = `${originCity} to ${destinationCity} flights`;

      // 3. Score.
      const score = scoreOpportunity({
        keywords: keywords.map((k) => ({
          keyword: k.keyword,
          volume: k.volume,
          difficulty: k.difficulty,
          intent: SearchIntentSchema.catch("INFORMATIONAL").parse(k.intent),
          businessValue: k.businessValue,
        })),
        dataAvailability,
        distinctDataPoints,
        existingPageTitles: existingTitles,
        candidateTitle: title,
        questionCount: keywords.filter((k) => k.intent === "QUESTION").length,
        minScoreToBuild: family.minOpportunityScore,
      });

      // 4. Persist (idempotent per candidate URL).
      const row = await prisma.opportunity.upsert({
        where: { projectId_candidateUrl: { projectId: ctx.projectId, candidateUrl } },
        update: {
          pageFamilyId: family.id,
          title,
          primaryKeyword: keywords.sort((a, b) => b.volume - a.volume)[0]?.keyword ?? null,
          variablesJson: writeJson({ origin: cand.origin, destination: cand.destination, originCity, destinationCity }),
          ...scoreColumns(score),
          reasonsJson: writeJson(score.reasons),
          isMock: data.containsMock,
        },
        create: {
          projectId: ctx.projectId,
          pageFamilyId: family.id,
          type: "ROUTE",
          candidateUrl,
          title,
          primaryKeyword: keywords.sort((a, b) => b.volume - a.volume)[0]?.keyword ?? null,
          variablesJson: writeJson({ origin: cand.origin, destination: cand.destination, originCity, destinationCity }),
          ...scoreColumns(score),
          reasonsJson: writeJson(score.reasons),
          isMock: data.containsMock,
        },
      });

      if (score.decision === "BUILD") build++;
      else if (score.decision === "REVIEW") review++;
      else reject++;

      results.push({
        id: row.id,
        type: "ROUTE",
        candidateUrl,
        title,
        primaryKeyword: row.primaryKeyword,
        totalScore: score.totalScore,
        decision: score.decision,
        reasons: score.reasons,
        dataAvailability: score.dataAvailability,
        duplicationRisk: score.duplicationRisk,
      });
    }

    results.sort((a, b) => b.totalScore - a.totalScore);

    const confidence = clamp(0.6 + (build / Math.max(candidates.length, 1)) * 0.3, 0.4, 0.95);

    return {
      output: { pageFamilyId: family.id, evaluated: candidates.length, build, review, reject, opportunities: results },
      confidence,
      summary: `Evaluated ${candidates.length} candidates for "${family.key}": ${build} BUILD, ${review} REVIEW, ${reject} REJECT.`,
      nextAction: build
        ? "Create the content plan and generate the highest-scoring BUILD opportunity"
        : "No candidate cleared the build threshold - review the family's data contract or thresholds",
    };
  }
}

const DEFAULT_REQUIRED_BINDINGS = [
  "origin.city",
  "origin.airportName",
  "destination.city",
  "destination.airportName",
  "route.distanceKm",
  "route.typicalDurationMinutes",
  "route.typicalStops",
  "route.airlines",
];

function hasValue(values: Record<string, unknown>, path: string): boolean {
  const v = path.split(".").reduce<any>((acc, p) => (acc == null ? undefined : acc[p]), values);
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function buildVars(patternVars: string[], available: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of patternVars) {
    if (available[v] !== undefined) out[v] = available[v];
    else if (v === "slug") out[v] = `${available.originCity}-to-${available.destinationCity}`;
    else out[v] = available.origin ?? "";
  }
  return out;
}

function scoreColumns(s: ReturnType<typeof scoreOpportunity>) {
  return {
    searchDemand: s.searchDemand,
    intentMatch: s.intentMatch,
    businessValue: s.businessValue,
    dataAvailability: s.dataAvailability,
    uniqueness: s.uniqueness,
    userUtility: s.userUtility,
    competition: s.competition,
    trafficPotential: s.trafficPotential,
    conversionPotential: s.conversionPotential,
    contentQualityCeiling: s.contentQualityCeiling,
    indexationRisk: s.indexationRisk,
    duplicationRisk: s.duplicationRisk,
    totalScore: s.totalScore,
    decision: s.decision,
  };
}
