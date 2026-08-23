/**
 * Seed enrichment for the built-in skill library.
 *
 * The 15 skills in definitions.ts describe *how* the work is done. This file
 * adds the machine-readable parts the management system needs: the inputs a
 * skill expects, the tools it requests, and the extra rule categories the UI
 * surfaces separately.
 *
 * Kept separate from definitions.ts so the instruction text stays readable and
 * so adding schema detail to a skill never risks disturbing its prose.
 */
import type { SkillDefinition } from "@/skills/definitions";
import type { SkillIoField } from "@/skills/types";

type SkillExtras = Pick<
  SkillDefinition,
  "inputs" | "allowedTools" | "qualityCriteria" | "safetyRules" | "businessRules" | "examples" | "modelGuidance"
>;

const str = (name: string, description: string, required = true, validation?: string): SkillIoField => ({
  name,
  type: "string",
  required,
  description,
  ...(validation ? { validation } : {}),
});
const num = (name: string, description: string, required = false): SkillIoField => ({
  name,
  type: "number",
  required,
  description,
});
const arr = (name: string, description: string, required = false): SkillIoField => ({
  name,
  type: "array",
  required,
  description,
});
const obj = (name: string, description: string, required = false): SkillIoField => ({
  name,
  type: "object",
  required,
  description,
});

export const SKILL_EXTRAS: Record<string, SkillExtras> = {
  seo_keyword_research: {
    allowedTools: ["keyword.discover", "research.competitors", "travel.reference"],
    inputs: [
      str("origin", "Origin as an IATA code or city name.", false, "3-letter IATA code, or a city in the reference dataset"),
      str("destination", "Destination as an IATA code or city name.", false, "3-letter IATA code, or a city name"),
      arr("seeds", "Explicit seed terms to expand from. Derived from the entities when omitted."),
      num("limit", "Maximum keyword rows to return."),
    ],
    qualityCriteria: [
      "Every returned keyword carries an intent label and a recommended action.",
      "Clusters map one target page to a coherent group of queries.",
      "Data provenance (live vs synthetic) is stated on every row.",
    ],
    safetyRules: ["Never present synthetic keyword volumes as measured search data."],
    businessRules: [
      "Transactional route queries outrank higher-volume generic informational queries for an OTA.",
      "A keyword an existing page already targets is a cannibalisation finding, not an opportunity.",
    ],
    examples: [
      {
        name: "Route research",
        input: { origin: "DEL", destination: "YYZ", limit: 120 },
        expectedOutput:
          "A keyword set led by 'Delhi to Toronto flights' (TRANSACTIONAL, TARGET_NEW), clustered under ROUTE:DEL-YYZ, with question variants marked SUPPORT and any near-duplicate cluster reported as cannibalisation.",
        notes: "Volumes come from the synthetic corpus unless DataForSEO is connected.",
      },
    ],
    modelGuidance: { tier: "fast", temperature: 0.2, notes: "Structural work is deterministic; the model is a second opinion only." },
  },

  search_intent_classification: {
    allowedTools: [],
    inputs: [
      str("keyword", "The query to classify."),
      str("context", "Optional surrounding context, e.g. the entity it belongs to.", false),
    ],
    qualityCriteria: ["The classification reason is recorded and auditable.", "A page type is always proposed alongside the intent."],
    businessRules: ["A QUESTION query that an existing entity page can answer becomes a section, not a new page."],
    examples: [
      {
        name: "Question form",
        input: { keyword: "how long is the flight from Delhi to Toronto" },
        expectedOutput: 'intent=QUESTION, pageType=ROUTE, reason="answerable as a section on the existing route page", secondaryIntent=INFORMATIONAL',
      },
    ],
    modelGuidance: { tier: "fast", temperature: 0 },
  },

  programmatic_seo: {
    allowedTools: ["travel.reference", "data.resolve"],
    inputs: [
      str("pageFamilyKey", "The page family being designed or evaluated."),
      num("maxCandidates", "Cap on candidates to evaluate in one pass."),
      arr("candidates", "Explicit entity combinations to evaluate."),
    ],
    qualityCriteria: [
      "Every candidate decision carries at least one human-readable reason.",
      "The data contract is defined before any page is generated.",
    ],
    safetyRules: ["Never mass-generate the cartesian product of entities."],
    businessRules: ["A candidate below the family's data-availability floor is rejected regardless of demand."],
    modelGuidance: { tier: "fast" },
  },

  travel_content_writing: {
    allowedTools: ["llm.generate", "data.resolve"],
    inputs: [
      obj("dataContext", "Resolved data points with provenance. The only source of factual claims.", true),
      str("section", "Which section to write.", true),
      str("origin", "Origin city, for route content.", false),
      str("destination", "Destination city, for route content.", false),
    ],
    qualityCriteria: [
      "Every factual sentence traces to a resolved data point.",
      "Paragraphs stay within the brand's sentence limit.",
      "Each section closes with something actionable.",
    ],
    safetyRules: [
      "Never state a price, schedule, baggage allowance, fee or policy that did not arrive as a verified data point.",
      "Omit the sentence rather than hedging around missing data.",
    ],
    businessRules: ["Write for a traveller comparing options, not for a search engine."],
    examples: [
      {
        name: "Route overview with partial data",
        input: { section: "route_overview", dataContext: { route: { typicalDurationMinutes: 922, typicalStops: 0 } } },
        expectedOutput:
          "Prose that states the ~15h 22m non-stop duration, names the carriers present in the data, and says nothing at all about fares because no pricing data was supplied.",
      },
    ],
    modelGuidance: { tier: "balanced", temperature: 0.5, maxTokens: 500 },
  },

  fact_verification: {
    allowedTools: ["facts.lookup", "web.fetch", "data.resolve"],
    inputs: [
      str("subject", "Fact-store subject to verify against, e.g. route:DEL-YYZ."),
      str("draftText", "The draft whose claims should be extracted and checked."),
      arr("claims", "Pre-extracted claims, when the caller has already parsed them.", false),
    ],
    qualityCriteria: ["Every extracted claim receives a verdict.", "Each verdict cites the source it was checked against."],
    safetyRules: [
      "A time-sensitive claim backed only by reference or synthetic data must be marked REQUIRES_LIVE_SOURCE.",
      "Never mark a claim VERIFIED on the strength of model fluency.",
    ],
    businessRules: ["Prices, schedules, baggage rules, fees and visa rules are always time-sensitive."],
    modelGuidance: { tier: "fast", temperature: 0 },
  },

  aeo_optimization: {
    allowedTools: ["llm.generate"],
    inputs: [
      arr("questions", "Question-intent queries the page must answer.", true),
      obj("dataContext", "Resolved data the answers may draw on.", true),
    ],
    qualityCriteria: [
      "Each answer is self-contained and survives being lifted out of the page.",
      "Answers sit within the configured word band.",
      "Headings use the question phrasing people actually type.",
    ],
    safetyRules: ["An answer must not contain unverified specifics."],
    modelGuidance: { tier: "balanced", temperature: 0.35, maxTokens: 220 },
  },

  geo_optimization: {
    allowedTools: ["llm.generate"],
    inputs: [
      arr("entities", "Entities the page is about, for disambiguation.", true),
      arr("claims", "Factual claims that need visible attribution.", false),
    ],
    qualityCriteria: [
      "Every entity appears once in disambiguated form (full name plus identifier).",
      "Each factual claim has a visible source and retrieval date.",
    ],
    safetyRules: [
      "Never describe answer-engine behaviour as ranking.",
      "Never promise a citation or AI placement.",
    ],
    modelGuidance: { tier: "balanced", temperature: 0.3 },
  },

  cfa_structuring: {
    allowedTools: [],
    inputs: [arr("facts", "Attributed facts to structure.", true)],
    qualityCriteria: ["One canonical statement per fact.", "Entity relationships are stated explicitly, not implied."],
    safetyRules: ["No fact may appear twice with different values."],
    modelGuidance: { tier: "fast" },
  },

  technical_seo: {
    allowedTools: ["web.crawl", "web.fetch"],
    inputs: [
      arr("startUrls", "URLs to crawl.", true),
      num("maxPages", "Page cap for this crawl."),
    ],
    qualityCriteria: ["Every finding carries a severity.", "Orphans are detected against the published set, not guessed."],
    safetyRules: [
      "Never report a check as passed if the page could not be fetched.",
      "Respect robots.txt on every request.",
    ],
    modelGuidance: { tier: "fast" },
  },

  schema_markup: {
    allowedTools: [],
    inputs: [
      str("pageType", "The kind of page being marked up."),
      arr("blocks", "Rendered blocks, so only visible content is marked up.", true),
    ],
    qualityCriteria: ["Every emitted type has its required properties populated from real content."],
    safetyRules: ["Never mark up content the user cannot see.", "Never invent identifiers or ratings."],
    modelGuidance: { tier: "fast", temperature: 0 },
  },

  internal_linking: {
    allowedTools: [],
    inputs: [
      str("pageUrl", "The page to propose links from."),
      arr("candidates", "Candidate target pages with their entity tags.", false),
      num("relevanceFloor", "Minimum relevance for a proposal."),
    ],
    qualityCriteria: ["Every proposal names the entities it shares with the target."],
    safetyRules: ["Never propose a link to an unpublished or rejected page."],
    businessRules: ["Link because the target helps the reader, never to reach a link count."],
    modelGuidance: { tier: "fast" },
  },

  competitor_research: {
    allowedTools: ["research.competitors", "web.fetch"],
    inputs: [
      arr("competitors", "The competitive set to analyse.", true),
      str("entitySpace", "The entity space to compare coverage across.", false),
    ],
    qualityCriteria: ["Each observation cites what was actually observed."],
    safetyRules: ["Never assert a competitor's internal methodology, formula or strategy as fact."],
    modelGuidance: { tier: "balanced" },
  },

  ai_visibility: {
    allowedTools: ["ai_visibility.probe", "research.competitors"],
    inputs: [
      str("brandName", "Brand to look for in generated answers."),
      arr("prompts", "Prompt library to sample.", true),
      arr("platforms", "Answer engines to probe.", false),
    ],
    qualityCriteria: [
      "Every run records platform, model, timestamp and the full response.",
      "Competitor share is reported alongside brand metrics.",
    ],
    safetyRules: [
      "Never describe a mention as a ranking position.",
      "Never blend synthetic runs into a headline metric with real ones.",
      "Use only permitted APIs or approved access methods.",
    ],
    businessRules: ["A single run is an anecdote; only repeated sampling is a measurement."],
    modelGuidance: { tier: "balanced", temperature: 0.4 },
  },

  content_quality_control: {
    allowedTools: ["facts.lookup"],
    inputs: [
      str("pageText", "The page body to judge."),
      arr("siblingTexts", "Sibling pages in the same family, for differentiation.", false),
    ],
    qualityCriteria: ["Every gate produces a result.", "A rejection names at least one blocking reason."],
    safetyRules: [
      "Never pass a page with an unresolved required binding.",
      "Never pass a page with an unsupported time-sensitive claim.",
      "Never pass a page below the family's differentiation floor.",
    ],
    modelGuidance: { tier: "fast", temperature: 0 },
  },

  orchestration_planning: {
    // Includes the Sheets tools because effective tools are the INTERSECTION of
    // the agent allowlist and what its skills declare: omitting them here would
    // silently revoke the grant the agent was just given.
    allowedTools: ["llm.generate", "travel.reference", "google_sheets.read", "google_sheets.update"],
    inputs: [
      str("objective", "The business objective to interpret."),
      str("context", "Any extra operator context.", false),
    ],
    qualityCriteria: [
      "Every planned step names the agent that owns it and why it is needed.",
      "Approval requirements are stated per step.",
    ],
    safetyRules: [
      "The orchestrator never publishes, writes content or calls a specialist tool itself.",
      "A failed required stage stops the workflow; it is never silently skipped.",
    ],
    modelGuidance: { tier: "balanced", temperature: 0.3 },
  },
};

/**
 * Derive an output schema from the human-readable output contract, so seeded
 * skills have a machine-checkable shape without duplicating the description.
 */
export function deriveOutputs(outputContract: Record<string, string>): SkillIoField[] {
  return Object.entries(outputContract).map(([name, description]) => ({
    name,
    type: guessType(description),
    required: true,
    description,
  }));
}

function guessType(description: string): SkillIoField["type"] {
  const d = description.trim().toLowerCase();
  if (d.startsWith("array")) return "array";
  if (d.startsWith("{") || d.includes("object")) return "object";
  if (d.includes("boolean") || d.startsWith("pass|") || d.includes("|fail")) return "string";
  if (d.includes("number") || d.includes("0..1") || d.includes("0..100")) return "number";
  return "string";
}
