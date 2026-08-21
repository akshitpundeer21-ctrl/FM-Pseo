/**
 * Keyword clustering + cannibalisation detection.
 *
 * Clusters are formed around the (entity, page-type) pair first and refined by
 * token similarity, because for a travel site the entity is the real organising
 * principle - "DEL->YYZ" is one page whether the query says flights, airfare or
 * how long the flight is.
 *
 * Cannibalisation is reported when two clusters would produce pages targeting
 * overlapping primary queries.
 */
import { tokenSimilarity, uniqueBy } from "@/core/utils/text";
import type { SearchIntent } from "@/core/types/enums";

export interface ClusterableKeyword {
  keyword: string;
  intent: SearchIntent;
  entityType: string | null;
  origin: string | null;
  destination: string | null;
  airport?: string | null;
  airline?: string | null;
  pageType: string | null;
  volume: number;
  difficulty: number;
  businessValue: number;
}

export interface KeywordCluster {
  name: string;
  primaryKeyword: string;
  intent: SearchIntent;
  pageType: string | null;
  entityKey: string;
  totalVolume: number;
  avgDifficulty: number;
  opportunityScore: number;
  keywords: ClusterableKeyword[];
  questionKeywords: string[];
}

/** The entity a keyword belongs to; keywords with the same key share a page. */
export function entityKeyFor(k: ClusterableKeyword): string {
  if (k.origin && k.destination) return `ROUTE:${k.origin}-${k.destination}`;
  if (k.airline) return `AIRLINE:${k.airline}`;
  if (k.airport) return `AIRPORT:${k.airport}`;
  if (k.destination) return `DESTINATION:${k.destination}`;
  return `TOPIC:${k.keyword.split(/\s+/).slice(0, 2).join("-").toLowerCase()}`;
}

/**
 * Page-type families that should never share a page even for the same entity
 * (e.g. an airline page and its baggage-policy page).
 */
function pageTypeGroup(pageType: string | null): string {
  if (!pageType) return "GENERIC";
  if (pageType.startsWith("AIRLINE_")) return pageType;
  if (pageType.startsWith("AIRPORT_")) return pageType;
  return pageType;
}

export function clusterKeywords(keywords: ClusterableKeyword[], similarityFloor = 0.18): KeywordCluster[] {
  const buckets = new Map<string, ClusterableKeyword[]>();

  for (const k of keywords) {
    const key = `${entityKeyFor(k)}|${pageTypeGroup(k.pageType)}`;
    const list = buckets.get(key) ?? [];
    list.push(k);
    buckets.set(key, list);
  }

  const clusters: KeywordCluster[] = [];

  for (const [key, members] of buckets) {
    const [entityKey, pageType] = key.split("|");
    // Refine: drop members that are semantically unrelated to the bucket head.
    const sorted = [...members].sort((a, b) => b.volume - a.volume);
    const head = sorted[0];
    const kept = sorted.filter((m) => m === head || tokenSimilarity(head.keyword, m.keyword) >= similarityFloor || sharesEntity(head, m));

    const totalVolume = kept.reduce((s, k) => s + k.volume, 0);
    const avgDifficulty = kept.length ? kept.reduce((s, k) => s + k.difficulty, 0) / kept.length : 0;
    const intent = dominantIntent(kept);
    const businessValue = totalVolume
      ? kept.reduce((s, k) => s + k.businessValue * k.volume, 0) / totalVolume
      : 0;

    // Cluster-level opportunity: demand x value, discounted by difficulty.
    const demand = Math.min(1, Math.log10(Math.max(totalVolume, 1)) / 4.3);
    const opportunityScore = Math.round(demand * 55 + (businessValue / 100) * 30 + (1 - avgDifficulty / 100) * 15);

    clusters.push({
      name: clusterName(head, entityKey),
      primaryKeyword: head.keyword,
      intent,
      pageType: pageType === "GENERIC" ? null : pageType,
      entityKey,
      totalVolume,
      avgDifficulty: Math.round(avgDifficulty * 10) / 10,
      opportunityScore,
      keywords: uniqueBy(kept, (k) => k.keyword.toLowerCase()),
      questionKeywords: kept.filter((k) => k.intent === "QUESTION").map((k) => k.keyword),
    });
  }

  return clusters.sort((a, b) => b.opportunityScore - a.opportunityScore);
}

function sharesEntity(a: ClusterableKeyword, b: ClusterableKeyword): boolean {
  return entityKeyFor(a) === entityKeyFor(b);
}

function dominantIntent(keywords: ClusterableKeyword[]): SearchIntent {
  const tally = new Map<SearchIntent, number>();
  for (const k of keywords) tally.set(k.intent, (tally.get(k.intent) ?? 0) + k.volume);
  let best: SearchIntent = "INFORMATIONAL";
  let bestVal = -1;
  for (const [intent, v] of tally) {
    if (v > bestVal) {
      best = intent;
      bestVal = v;
    }
  }
  return best;
}

function clusterName(head: ClusterableKeyword, entityKey: string): string {
  if (head.origin && head.destination) return `${head.origin} → ${head.destination}`;
  if (head.airline) return `${head.airline} carrier queries`;
  if (head.airport) return `${head.airport} airport queries`;
  return entityKey.replace(/^\w+:/, "").replace(/-/g, " ");
}

/**
 * Similarity used for cannibalisation only, with light stemming.
 *
 * "delhi to toronto flights" and "delhi to toronto flight" are the same target
 * in practice; plain token overlap scores them 0.5 and would miss what is the
 * single most common cannibalisation case.
 */
export function phraseSimilarity(a: string, b: string): number {
  const stem = (s: string) =>
    new Set(
      tokenizeStemmed(s).map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t)),
    );
  const setA = stem(a);
  const setB = stem(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function tokenizeStemmed(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !["the", "a", "an", "to", "from", "for", "of", "in", "on", "and", "or"].includes(t));
}

export interface CannibalisationFinding {
  keyword: string;
  clusterA: string;
  clusterB: string;
  similarity: number;
  severity: "HIGH" | "MEDIUM" | "LOW";
  recommendation: string;
}

/**
 * Two clusters cannibalise when their primary keywords are near-identical or a
 * keyword appears in both. Reported, never silently merged - merging clusters is
 * a strategy decision for the operator.
 */
export function detectCannibalisation(clusters: KeywordCluster[]): CannibalisationFinding[] {
  const findings: CannibalisationFinding[] = [];

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i];
      const b = clusters[j];
      const similarity = phraseSimilarity(a.primaryKeyword, b.primaryKeyword);

      const sharedKeywords = a.keywords
        .map((k) => k.keyword.toLowerCase())
        .filter((k) => b.keywords.some((x) => x.keyword.toLowerCase() === k));

      if (similarity < 0.55 && sharedKeywords.length === 0) continue;

      const severity = sharedKeywords.length > 2 || similarity > 0.8 ? "HIGH" : similarity > 0.65 ? "MEDIUM" : "LOW";
      findings.push({
        keyword: sharedKeywords[0] ?? a.primaryKeyword,
        clusterA: a.name,
        clusterB: b.name,
        similarity: Number(similarity.toFixed(2)),
        severity,
        recommendation:
          severity === "HIGH"
            ? `Merge "${b.name}" into "${a.name}" or differentiate their primary targets before building both.`
            : `Differentiate the primary keyword and heading structure of "${b.name}" from "${a.name}".`,
      });
    }
  }

  return findings.sort((a, b) => b.similarity - a.similarity).slice(0, 50);
}

/** Recommended action per keyword given its cluster and the existing inventory. */
export function recommendAction(
  keyword: ClusterableKeyword,
  cluster: KeywordCluster,
  existingUrls: Set<string>,
  candidateUrl: string,
): string {
  if (existingUrls.has(candidateUrl)) {
    return keyword.keyword === cluster.primaryKeyword ? "TARGET_EXISTING" : "SUPPORT";
  }
  if (keyword.keyword === cluster.primaryKeyword) return "TARGET_NEW";
  if (keyword.intent === "QUESTION") return "SUPPORT";
  if (keyword.volume < 30) return "IGNORE";
  return "SUPPORT";
}
