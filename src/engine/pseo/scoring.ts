/**
 * Programmatic opportunity scoring.
 *
 * The gate that stops this system from becoming a page mill. A combination
 * existing is never a reason to build a page - it has to earn its place on
 * demand, data availability, differentiation and utility, and the reasons are
 * recorded so a human can audit the decision.
 *
 * Every sub-score is 0..100 and independently inspectable in the dashboard.
 */
import { clamp, tokenSimilarity } from "@/core/utils/text";
import type { OpportunityDecision, SearchIntent } from "@/core/types/enums";

export interface ScoringInput {
  /** Keywords mapped to this candidate page. */
  keywords: { keyword: string; volume: number; difficulty: number; intent: SearchIntent; businessValue: number }[];
  /** Fraction (0..1) of the page family's REQUIRED data bindings that resolved. */
  dataAvailability: number;
  /** Number of distinct, page-specific data points available (drives uniqueness). */
  distinctDataPoints: number;
  /** Titles/URLs of already-existing pages, for duplication risk. */
  existingPageTitles: string[];
  /** Candidate title, used for the duplication comparison. */
  candidateTitle: string;
  /** Question-intent keywords the page could answer (drives utility). */
  questionCount: number;
  /** Family policy. */
  minScoreToBuild: number;
}

export interface ScoringResult {
  searchDemand: number;
  intentMatch: number;
  businessValue: number;
  dataAvailability: number;
  uniqueness: number;
  userUtility: number;
  competition: number;
  trafficPotential: number;
  conversionPotential: number;
  contentQualityCeiling: number;
  indexationRisk: number;
  duplicationRisk: number;
  totalScore: number;
  decision: OpportunityDecision;
  reasons: string[];
}

/** Business proximity of each intent for an online travel agency. */
const INTENT_VALUE: Record<SearchIntent, number> = {
  TRANSACTIONAL: 100,
  COMMERCIAL: 82,
  QUESTION: 48,
  INFORMATIONAL: 40,
  NAVIGATIONAL: 30,
};

/** Expected CTR by achievable position - used for traffic potential only. */
function expectedCtr(difficulty: number): number {
  // Harder keyword -> realistically lower achieved position -> lower CTR.
  const assumedPosition = 2 + (difficulty / 100) * 12;
  return Math.max(0.005, 0.31 * Math.exp(-0.28 * (assumedPosition - 1)));
}

const WEIGHTS = {
  searchDemand: 0.16,
  intentMatch: 0.14,
  businessValue: 0.12,
  dataAvailability: 0.16,
  uniqueness: 0.12,
  userUtility: 0.1,
  competition: 0.06,
  trafficPotential: 0.08,
  conversionPotential: 0.06,
} as const;

export function scoreOpportunity(input: ScoringInput): ScoringResult {
  const reasons: string[] = [];
  const kws = input.keywords;
  const totalVolume = kws.reduce((s, k) => s + k.volume, 0);

  // --- demand: log-scaled so a 50k keyword doesn't drown a strong 800 one.
  const searchDemand = clamp(Math.log10(Math.max(totalVolume, 1)) / 4.3, 0, 1) * 100;

  // --- intent: volume-weighted business proximity of the mapped intents.
  const intentMatch = totalVolume
    ? kws.reduce((s, k) => s + INTENT_VALUE[k.intent] * k.volume, 0) / totalVolume
    : 0;

  // --- business value: volume-weighted, falls back to intent when absent.
  const businessValue = totalVolume
    ? kws.reduce((s, k) => s + (k.businessValue || INTENT_VALUE[k.intent]) * k.volume, 0) / totalVolume
    : 0;

  // --- data availability: the hard gate.
  const dataAvailability = clamp(input.dataAvailability, 0, 1) * 100;

  // --- uniqueness: how much genuinely page-specific data exists.
  const uniqueness = clamp(input.distinctDataPoints / 14, 0, 1) * 100;

  // --- utility: can we answer real questions, and is there enough substance?
  const userUtility = clamp(input.questionCount / 5, 0, 1) * 60 + clamp(input.distinctDataPoints / 12, 0, 1) * 40;

  // --- competition: inverted difficulty (easier = more attractive).
  const avgDifficulty = kws.length ? kws.reduce((s, k) => s + k.difficulty, 0) / kws.length : 50;
  const competition = clamp(1 - avgDifficulty / 100, 0, 1) * 100;

  // --- traffic potential: volume x realistically achievable CTR.
  const rawTraffic = kws.reduce((s, k) => s + k.volume * expectedCtr(k.difficulty), 0);
  const trafficPotential = clamp(Math.log10(Math.max(rawTraffic, 1)) / 3, 0, 1) * 100;

  // --- conversion potential: transactional share x business value.
  const transactionalShare = totalVolume
    ? kws.filter((k) => k.intent === "TRANSACTIONAL" || k.intent === "COMMERCIAL").reduce((s, k) => s + k.volume, 0) / totalVolume
    : 0;
  const conversionPotential = transactionalShare * businessValue;

  // --- content quality ceiling: how good can this page get, at best?
  const contentQualityCeiling = clamp((input.distinctDataPoints / 16) * 0.7 + (input.questionCount / 6) * 0.3, 0, 1) * 100;

  // --- duplication risk: closeness to an existing page's title.
  const maxSimilarity = input.existingPageTitles.length
    ? Math.max(...input.existingPageTitles.map((t) => tokenSimilarity(t, input.candidateTitle)))
    : 0;
  const duplicationRisk = clamp(maxSimilarity, 0, 1) * 100;

  // --- indexation risk: thin data + low demand + high duplication.
  const indexationRisk = clamp(
    (1 - clamp(input.dataAvailability, 0, 1)) * 0.45 +
      (1 - clamp(input.distinctDataPoints / 12, 0, 1)) * 0.3 +
      clamp(maxSimilarity, 0, 1) * 0.25,
    0,
    1,
  ) * 100;

  const weighted =
    searchDemand * WEIGHTS.searchDemand +
    intentMatch * WEIGHTS.intentMatch +
    businessValue * WEIGHTS.businessValue +
    dataAvailability * WEIGHTS.dataAvailability +
    uniqueness * WEIGHTS.uniqueness +
    userUtility * WEIGHTS.userUtility +
    competition * WEIGHTS.competition +
    trafficPotential * WEIGHTS.trafficPotential +
    conversionPotential * WEIGHTS.conversionPotential;

  // Risks are subtracted, not averaged in - a risky page should not be rescued
  // by a strong demand score.
  const penalty = indexationRisk * 0.18 + duplicationRisk * 0.12;
  const totalScore = Math.round(clamp((weighted - penalty) / 100, 0, 1) * 1000) / 10;

  // --- decision -----------------------------------------------------------
  let decision: OpportunityDecision;

  if (input.dataAvailability < 0.4) {
    decision = "REJECT";
    reasons.push(
      `Rejected: only ${Math.round(input.dataAvailability * 100)}% of required data bindings resolve. A page cannot be published on data we do not have.`,
    );
  } else if (duplicationRisk > 70) {
    decision = "REJECT";
    reasons.push(`Rejected: ${Math.round(duplicationRisk)}% title/topic overlap with an existing page - this would cannibalise it.`);
  } else if (totalScore < 35) {
    decision = "REJECT";
    reasons.push(`Rejected: total score ${totalScore} is below the viability floor of 35.`);
  } else if (totalScore >= input.minScoreToBuild && input.dataAvailability >= 0.6 && duplicationRisk <= 45) {
    decision = "BUILD";
    reasons.push(`Approved to build: score ${totalScore} clears the family threshold of ${input.minScoreToBuild}.`);
  } else {
    decision = "REVIEW";
    if (totalScore < input.minScoreToBuild) {
      reasons.push(`Below the family build threshold (${totalScore} < ${input.minScoreToBuild}) - sent for human review.`);
    }
    if (input.dataAvailability < 0.6) {
      reasons.push(`Data availability ${Math.round(input.dataAvailability * 100)}% is below the 60% auto-build bar.`);
    }
    if (duplicationRisk > 45) {
      reasons.push(`Duplication risk ${Math.round(duplicationRisk)}% needs a human to confirm differentiation.`);
    }
  }

  // Always record the drivers, whatever the decision.
  reasons.push(
    `Demand ${Math.round(searchDemand)} | intent ${Math.round(intentMatch)} | data ${Math.round(dataAvailability)} | uniqueness ${Math.round(uniqueness)} | utility ${Math.round(userUtility)} | competition ${Math.round(competition)}`,
  );
  if (indexationRisk > 45) reasons.push(`Elevated indexation risk (${Math.round(indexationRisk)}) - thin or highly similar content.`);
  if (totalVolume === 0) reasons.push("No mapped keyword volume - demand is unproven.");

  return {
    searchDemand: round1(searchDemand),
    intentMatch: round1(intentMatch),
    businessValue: round1(businessValue),
    dataAvailability: round1(dataAvailability),
    uniqueness: round1(uniqueness),
    userUtility: round1(userUtility),
    competition: round1(competition),
    trafficPotential: round1(trafficPotential),
    conversionPotential: round1(conversionPotential),
    contentQualityCeiling: round1(contentQualityCeiling),
    indexationRisk: round1(indexationRisk),
    duplicationRisk: round1(duplicationRisk),
    totalScore,
    decision,
    reasons,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Expand a URL pattern like /flights/{origin}/{destination}. */
export function buildUrl(pattern: string, vars: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`URL pattern "${pattern}" needs variable "${key}"`);
    return String(v)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  });
}

export function patternVariables(pattern: string): string[] {
  return [...pattern.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}
