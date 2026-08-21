/**
 * Internal link proposal engine.
 *
 * Links are proposed from the ENTITY GRAPH, not from a link quota. A route page
 * relates to its origin airport, its destination airport and city, its
 * operating carriers, and sibling routes that share an endpoint. Relevance is
 * scored from shared entities, hierarchy distance and intent proximity, and
 * anything below the configured floor is not proposed at all.
 */
import { tokenSimilarity } from "@/core/utils/text";

export interface LinkablePage {
  id: string;
  url: string;
  title: string;
  pageType: string;
  status: string;
  /** Entities this page is about: e.g. ["AIRPORT:DEL","CITY:Delhi","AIRLINE:AC"] */
  entities: string[];
}

export interface LinkProposal {
  fromPageId: string;
  toPageId: string | null;
  targetUrl: string;
  anchorText: string;
  relevance: number;
  reason: string;
}

export interface LinkingOptions {
  relevanceFloor?: number;
  maxLinks?: number;
  minLinks?: number;
}

/** Weight of each shared-entity kind. Endpoint identity matters most. */
const ENTITY_WEIGHT: Record<string, number> = {
  ROUTE: 0.5,
  AIRPORT: 0.35,
  CITY: 0.3,
  AIRLINE: 0.2,
  COUNTRY: 0.1,
};

function entityKind(entity: string): string {
  return entity.split(":")[0] ?? "";
}

export function scoreRelevance(a: LinkablePage, b: LinkablePage): { score: number; shared: string[] } {
  const setB = new Set(b.entities);
  const shared = a.entities.filter((e) => setB.has(e));

  let score = 0;
  for (const e of shared) score += ENTITY_WEIGHT[entityKind(e)] ?? 0.1;

  // Different page types on a shared entity are complementary, not competing.
  if (a.pageType !== b.pageType && shared.length) score += 0.12;

  // Title similarity is a weak secondary signal - never the primary one.
  score += tokenSimilarity(a.title, b.title) * 0.15;

  return { score: Math.min(1, score), shared };
}

export function proposeLinks(
  page: LinkablePage,
  candidates: LinkablePage[],
  opts: LinkingOptions = {},
): { proposals: LinkProposal[]; considered: number } {
  const floor = opts.relevanceFloor ?? 0.35;
  const maxLinks = opts.maxLinks ?? 12;

  const scored = candidates
    .filter((c) => c.id !== page.id)
    // Never link to something that is not live.
    .filter((c) => c.status === "PUBLISHED" || c.status === "APPROVED")
    .map((c) => {
      const { score, shared } = scoreRelevance(page, c);
      return { candidate: c, score, shared };
    })
    .filter((s) => s.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxLinks);

  const proposals = scored.map(({ candidate, score, shared }) => ({
    fromPageId: page.id,
    toPageId: candidate.id,
    targetUrl: candidate.url,
    anchorText: anchorFor(candidate),
    relevance: Number(score.toFixed(3)),
    reason: shared.length
      ? `Shares ${shared.length} entit${shared.length === 1 ? "y" : "ies"} (${shared.slice(0, 3).join(", ")})`
      : "Topically adjacent page",
  }));

  return { proposals, considered: candidates.length };
}

/** Anchor text that describes the destination, varied by page type. */
function anchorFor(page: LinkablePage): string {
  const title = page.title.replace(/\s*[|-].*$/, "").trim();
  switch (page.pageType) {
    case "ROUTE":
      return title;
    case "AIRPORT":
      return `${title} guide`;
    case "AIRLINE":
      return title;
    case "DESTINATION":
      return `flights to ${title.replace(/^flights to /i, "")}`;
    default:
      return title;
  }
}

/** Pages with no inbound internal link. Orphans are a real defect. */
export function findOrphans(pages: LinkablePage[], links: { toPageId: string | null }[]): LinkablePage[] {
  const linked = new Set(links.map((l) => l.toPageId).filter(Boolean) as string[]);
  return pages.filter((p) => p.status === "PUBLISHED" && !linked.has(p.id));
}

/** Entity tags for a route page, used by the graph. */
export function routeEntities(params: {
  origin: string;
  destination: string;
  originCity?: string;
  destinationCity?: string;
  originCountry?: string;
  destinationCountry?: string;
  airlines?: string[];
}): string[] {
  const out = [
    `ROUTE:${params.origin}-${params.destination}`,
    `AIRPORT:${params.origin}`,
    `AIRPORT:${params.destination}`,
  ];
  if (params.originCity) out.push(`CITY:${params.originCity}`);
  if (params.destinationCity) out.push(`CITY:${params.destinationCity}`);
  if (params.originCountry) out.push(`COUNTRY:${params.originCountry}`);
  if (params.destinationCountry) out.push(`COUNTRY:${params.destinationCountry}`);
  for (const a of params.airlines ?? []) out.push(`AIRLINE:${a}`);
  return out;
}
