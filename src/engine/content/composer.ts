/**
 * Page composer.
 *
 * Turns (opportunity variables + template + resolved data + brand) into a fully
 * rendered page version. It is the concrete implementation of the
 *
 *   TEMPLATE + COMPONENTS + DYNAMIC DATA + PAGE-SPECIFIC DATA + GENERATED PROSE
 *
 * architecture: the structure is reusable, the substance is per-page, and the
 * mix is measured rather than assumed.
 *
 * The composer never invents anything. Generated prose is produced from the
 * resolved data context only, and any block whose data did not resolve is
 * skipped with a recorded reason.
 */
import { clampToSentence, titleCase, truncate } from "@/core/utils/text";
import type { BrandKnowledge } from "@/modules/brand/brand";
import type { DataContext, DataPoint } from "@/engine/data/types";
import { renderTemplate, type CompositionPolicy, type RenderResult, type TemplateBlockSpec } from "@/engine/templates/renderer";
import type { RenderInput } from "@/engine/templates/component-library";

export interface ComposeVariables {
  origin: string;
  destination: string;
  originCity: string;
  destinationCity: string;
}

export interface ComposeDeps {
  /** Generates one AI slot. Returns null when generation is unavailable. */
  generate: (params: {
    task: string;
    prompt: string;
    variables: Record<string, unknown>;
    maxTokens?: number;
    complexity?: number;
  }) => Promise<string | null>;
}

export interface ComposeParams {
  url: string;
  variables: ComposeVariables;
  blocks: TemplateBlockSpec[];
  data: DataContext;
  brand: BrandKnowledge;
  policy?: CompositionPolicy;
  relatedRoutes?: { url: string; label: string; note?: string }[];
  relatedAirports?: { url: string; label: string }[];
  relatedDestinations?: { url: string; label: string }[];
  /** Question keywords this page should answer (AEO targets). */
  questions: string[];
  deps: ComposeDeps;
}

export interface ComposedPage {
  title: string;
  metaDescription: string;
  render: RenderResult;
  faqs: { question: string; answer: string }[];
  evidence: { claim: string; source: string; retrievedAt: string; isMock: boolean }[];
  breadcrumbs: { url: string; label: string }[];
  usedMock: boolean;
}

/** Human-readable labels for the evidence block. */
const CLAIM_LABELS: Record<string, string> = {
  "route.distanceKm": "Route distance",
  "route.typicalDurationMinutes": "Typical total travel time",
  "route.typicalStops": "Typical number of stops",
  "route.airlines": "Carriers on this route",
  "route.nonstopAvailable": "Non-stop availability",
  "origin.airportName": "Departure airport",
  "destination.airportName": "Arrival airport",
  "origin.terminals": "Departure airport terminals",
  "destination.terminals": "Arrival airport terminals",
  "offers.cheapestPrice": "Lowest live fare found",
};

export async function composePage(params: ComposeParams): Promise<ComposedPage> {
  const { variables: v, data, brand } = params;

  // --- 1. FAQ answers (AEO) ------------------------------------------------
  // Deduplicate case-insensitively: the same question can arrive both as a
  // discovered keyword and as a default, and a duplicated Q&A pair would end up
  // in the FAQPage schema.
  const seenQuestions = new Set<string>();
  const uniqueQuestions = params.questions.filter((q) => {
    const key = q.trim().toLowerCase().replace(/\?+$/, "");
    if (!key || seenQuestions.has(key)) return false;
    seenQuestions.add(key);
    return true;
  });

  const faqs: { question: string; answer: string }[] = [];
  for (const question of uniqueQuestions.slice(0, 6)) {
    const answer = await params.deps.generate({
      task: "faq_answer",
      prompt: `Answer this question for the ${v.originCity} to ${v.destinationCity} route in ${brand.aeoRules?.answerWordsMin ?? 35}-${brand.aeoRules?.answerWordsMax ?? 70} words. The answer must stand alone with no surrounding context. Use only the supplied data. Question: "${question}"`,
      variables: { ...data.values, question },
      maxTokens: 220,
      complexity: 0.35,
    });
    if (answer?.trim()) faqs.push({ question: normaliseQuestion(question), answer: answer.trim() });
  }

  // --- 2. Evidence block (GEO) --------------------------------------------
  const evidence = buildEvidence(data.points);

  // --- 3. Breadcrumbs ------------------------------------------------------
  const breadcrumbs = [
    { url: "/", label: "Home" },
    { url: "/flights", label: "Flights" },
    { url: `/flights/${v.origin.toLowerCase()}`, label: `From ${v.originCity}` },
    { url: params.url, label: `${v.originCity} to ${v.destinationCity}` },
  ];

  // --- 4. Render -----------------------------------------------------------
  const page: RenderInput["page"] = {
    url: params.url,
    brandName: brand.brandName,
    relatedRoutes: params.relatedRoutes,
    relatedAirports: params.relatedAirports,
    relatedDestinations: params.relatedDestinations,
    breadcrumbs,
    faqs,
    evidence,
    lastUpdated: new Date().toISOString(),
  };

  const render = await renderTemplate({
    blocks: params.blocks,
    values: data.values,
    page,
    policy: params.policy,
    generateSlot: async ({ task, instruction, maxTokens, complexity, values }) => {
      const text = await params.deps.generate({
        task,
        prompt: `${instruction}\n\nRoute: ${v.originCity} (${v.origin}) to ${v.destinationCity} (${v.destination}).`,
        variables: values,
        maxTokens,
        complexity,
      });
      return text;
    },
  });

  // --- 5. Provisional title + meta (the optimisation agent refines these) ---
  const title = buildTitle(v, brand);
  const metaDescription =
    (await params.deps.generate({
      task: "meta_description",
      prompt: `Write a meta description under ${brand.seoRules?.metaMaxChars ?? 158} characters for this route page. No price claims.`,
      variables: data.values,
      maxTokens: 120,
      complexity: 0.2,
    })) ?? "";

  return {
    title,
    metaDescription: clampToSentence(metaDescription.trim() || fallbackMeta(v), brand.seoRules?.metaMaxChars ?? 158),
    render,
    faqs,
    evidence,
    breadcrumbs,
    usedMock: data.containsMock,
  };
}

function buildTitle(v: ComposeVariables, brand: BrandKnowledge): string {
  const max = brand.seoRules?.titleMaxChars ?? 60;
  const base = `${titleCase(v.originCity)} to ${titleCase(v.destinationCity)} Flights`;
  const withBrand = `${base} | ${brand.brandName}`;
  return withBrand.length <= max ? withBrand : truncate(base, max);
}

function fallbackMeta(v: ComposeVariables): string {
  return `Compare ${v.originCity} to ${v.destinationCity} flights: airlines, typical routings, airport details and booking tips. Search live fares for your dates.`;
}

function normaliseQuestion(q: string): string {
  const trimmed = q.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[?]$/.test(capitalised) ? capitalised : `${capitalised}?`;
}

/**
 * One evidence row per attributed scalar the page relies on. Time-sensitive
 * values are labelled so a reader can see what is live and what is reference
 * data - this is both a GEO citability signal and basic honesty.
 */
export function buildEvidence(points: DataPoint[]): { claim: string; source: string; retrievedAt: string; isMock: boolean }[] {
  const rows: { claim: string; source: string; retrievedAt: string; isMock: boolean }[] = [];
  const seen = new Set<string>();

  for (const p of points) {
    const label = CLAIM_LABELS[p.path];
    if (!label || seen.has(label)) continue;
    if (p.value === null || p.value === undefined) continue;
    seen.add(label);
    rows.push({
      claim: p.method ? `${label} (${p.method})` : label,
      source: p.sourceName,
      retrievedAt: p.retrievedAt,
      isMock: p.isMock,
    });
  }
  return rows;
}

/** Template block specs from persisted TemplateBlock rows. */
export function toBlockSpecs(
  rows: { id: string; sequence: number; isRequired: boolean; condition: string | null; configJson: string; contentSource: string; component: { key: string } }[],
): TemplateBlockSpec[] {
  return rows.map((r) => ({
    blockKey: `${r.component.key}#${r.sequence}`,
    componentKey: r.component.key,
    sequence: r.sequence,
    isRequired: r.isRequired,
    condition: r.condition,
    config: safeParse(r.configJson),
    contentSource: r.contentSource as TemplateBlockSpec["contentSource"],
  }));
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
