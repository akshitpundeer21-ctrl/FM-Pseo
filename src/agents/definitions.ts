/**
 * Agent catalog.
 *
 * Declarative identity + permissions for every agent. This is what the seed
 * writes into the Agent table and what the Control Plane enforces at runtime.
 *
 * Note the deliberate separation: `content_generation` can write content and
 * call an LLM but has NO publish capability; only `publishing` holds it. Even if
 * another agent knew the tool key, the Control Plane would refuse the call.
 */
import type { Capability, ModelTier } from "@/core/types/enums";
import { TOOL_KEYS } from "@/tools/definitions";

export interface AgentDefinition {
  key: string;
  name: string;
  description: string;
  role: string;
  kind: "ORCHESTRATOR" | "SPECIALIST" | "GUARDIAN";
  allowedTools: string[];
  capabilities: Capability[];
  confidenceThreshold: number;
  maxRetries: number;
  timeoutMs: number;
  modelTier: ModelTier;
  /** Human-readable contract, surfaced in the Agents dashboard. */
  inputContract: Record<string, string>;
  outputContract: Record<string, string>;
  validationRules: string[];
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    key: "master_orchestrator",
    name: "Master Orchestrator",
    description:
      "Interprets a business objective, decides which stages and agents are required, creates structured tasks, delegates, and decides where human approval is needed.",
    role: "Central coordinator. Plans and delegates; never performs specialist work itself.",
    kind: "ORCHESTRATOR",
    allowedTools: [TOOL_KEYS.llmGenerate, TOOL_KEYS.travelReference],
    capabilities: ["read_project", "request_approval", "call_llm", "spend_budget", "write_recommendations"],
    confidenceThreshold: 0.6,
    maxRetries: 1,
    timeoutMs: 120_000,
    modelTier: "balanced",
    inputContract: { objective: "string", context: "string?", constraints: "object?" },
    outputContract: { plan: "PlanStep[]", entities: "object", workflowKey: "string", nextAction: "string" },
    validationRules: [
      "Plan must contain at least one step",
      "Every step must name a registered agent",
      "Publishing steps must carry an approval requirement unless explicitly allowlisted",
    ],
  },
  {
    key: "keyword_research",
    name: "Keyword Research Agent",
    description:
      "Discovers and qualifies keywords for the target entities: long-tail, question, route, airport, airline and destination queries, with intent and opportunity scoring.",
    role: "Turns entities and objectives into a scored, clustered keyword set.",
    kind: "SPECIALIST",
    allowedTools: [TOOL_KEYS.keywordDiscover, TOOL_KEYS.competitors, TOOL_KEYS.travelReference],
    capabilities: ["read_project", "write_keywords", "call_external_api", "spend_budget", "call_llm"],
    confidenceThreshold: 0.65,
    maxRetries: 2,
    timeoutMs: 120_000,
    modelTier: "fast",
    inputContract: { origin: "IATA?", destination: "IATA?", seeds: "string[]?", limit: "number?" },
    outputContract: {
      keywordCount: "number",
      clusters: "ClusterSummary[]",
      cannibalisation: "Finding[]",
      isMock: "boolean",
    },
    validationRules: ["At least one keyword discovered", "Every keyword carries an intent label"],
  },
  {
    key: "programmatic_opportunity",
    name: "Programmatic Opportunity Agent",
    description:
      "Scores candidate programmatic pages on demand, intent, data availability, uniqueness, competition and duplication risk, and decides BUILD / REVIEW / REJECT.",
    role: "The gate that prevents mass generation of pages that should not exist.",
    kind: "GUARDIAN",
    allowedTools: [TOOL_KEYS.travelReference, TOOL_KEYS.dataResolve, TOOL_KEYS.keywordDiscover],
    capabilities: ["read_project", "write_opportunities", "call_external_api", "spend_budget"],
    confidenceThreshold: 0.7,
    maxRetries: 1,
    timeoutMs: 180_000,
    modelTier: "fast",
    inputContract: { pageFamilyKey: "string", clusterIds: "string[]?", maxCandidates: "number?" },
    outputContract: { evaluated: "number", build: "number", review: "number", reject: "number", opportunities: "Opportunity[]" },
    validationRules: [
      "Every candidate has a decision and at least one reason",
      "No candidate with data availability below 40% is marked BUILD",
    ],
  },
  {
    key: "content_strategy",
    name: "Content Strategy Agent",
    description:
      "Creates the page family, selects/creates the template, sets the composition policy and produces the per-page content plan.",
    role: "Decides the shape of the page before a single word is generated.",
    kind: "SPECIALIST",
    allowedTools: [TOOL_KEYS.travelReference, TOOL_KEYS.dataResolve],
    capabilities: ["read_project", "write_page_family", "write_template", "write_content"],
    confidenceThreshold: 0.65,
    maxRetries: 1,
    timeoutMs: 120_000,
    modelTier: "balanced",
    inputContract: { pageFamilyKey: "string", opportunityId: "string" },
    outputContract: { pageFamilyId: "string", templateId: "string", plan: "ContentPlan" },
    validationRules: ["Template has at least one required block", "Composition policy is set"],
  },
  {
    key: "content_generation",
    name: "Content Generation Agent",
    description:
      "Resolves dynamic data, fills the template's AI slots and assembles the page version. Cannot publish.",
    role: "Produces the draft page from template + data + generated prose.",
    kind: "SPECIALIST",
    allowedTools: [TOOL_KEYS.dataResolve, TOOL_KEYS.travelOffers, TOOL_KEYS.llmGenerate, TOOL_KEYS.factsLookup],
    capabilities: ["read_project", "write_content", "call_llm", "call_external_api", "spend_budget"],
    confidenceThreshold: 0.65,
    maxRetries: 2,
    timeoutMs: 240_000,
    modelTier: "balanced",
    inputContract: { opportunityId: "string", templateId: "string" },
    outputContract: { pageId: "string", pageVersionId: "string", wordCount: "number", composition: "CompositionReport" },
    validationRules: [
      "All required template blocks rendered",
      "No price-shaped string appears unless a live pricing source supplied it",
    ],
  },
  {
    key: "fact_verification",
    name: "Fact Verification Agent",
    description:
      "Extracts checkable claims from a draft and matches each to an attributed source. Blocks publication of unsupported or stale time-sensitive claims.",
    role: "Guards factual integrity.",
    kind: "GUARDIAN",
    allowedTools: [TOOL_KEYS.factsLookup, TOOL_KEYS.fetchUrl, TOOL_KEYS.dataResolve],
    capabilities: ["read_project", "write_facts", "crawl_web"],
    confidenceThreshold: 0.75,
    maxRetries: 1,
    timeoutMs: 120_000,
    modelTier: "fast",
    inputContract: { pageVersionId: "string" },
    outputContract: { verdicts: "ClaimVerdict[]", gate: "PASS|FAIL", blocking: "string[]" },
    validationRules: ["Every extracted claim receives a verdict"],
  },
  {
    key: "seo_optimization",
    name: "SEO / AEO / GEO Optimization Agent",
    description:
      "Produces the title, meta description, answer block, FAQ set, entity clarity pass and structured data for a page version.",
    role: "Optimises a draft for search, answer engines and generative engines.",
    kind: "SPECIALIST",
    allowedTools: [TOOL_KEYS.llmGenerate],
    capabilities: ["read_project", "write_content", "write_schema", "call_llm", "spend_budget"],
    confidenceThreshold: 0.65,
    maxRetries: 1,
    timeoutMs: 180_000,
    modelTier: "balanced",
    inputContract: { pageVersionId: "string", clusterId: "string?" },
    outputContract: { title: "string", metaDescription: "string", faqs: "FAQ[]", schemas: "SchemaBlock[]", geo: "object" },
    validationRules: ["Title within configured length", "At least one valid schema block"],
  },
  {
    key: "technical_seo",
    name: "Technical SEO Agent",
    description:
      "Crawls the site and validates status codes, canonicals, indexability, titles, headings, structured data, orphan pages and broken links.",
    role: "Verifies what was actually published is technically sound.",
    kind: "SPECIALIST",
    allowedTools: [TOOL_KEYS.crawl, TOOL_KEYS.fetchUrl],
    capabilities: ["read_project", "crawl_web", "write_recommendations"],
    confidenceThreshold: 0.6,
    maxRetries: 1,
    timeoutMs: 300_000,
    modelTier: "fast",
    inputContract: { websiteId: "string", maxPages: "number?" },
    outputContract: { crawled: "number", issues: "Issue[]", errors: "number", warnings: "number" },
    validationRules: ["Crawl attempted at least one URL"],
  },
  {
    key: "internal_linking",
    name: "Internal Linking Agent",
    description:
      "Proposes internal links from the entity graph, scores relevance and detects orphan pages.",
    role: "Builds the semantic link graph.",
    kind: "SPECIALIST",
    allowedTools: [],
    capabilities: ["read_project", "write_links"],
    confidenceThreshold: 0.6,
    maxRetries: 1,
    timeoutMs: 90_000,
    modelTier: "fast",
    inputContract: { pageId: "string?", projectWide: "boolean?" },
    outputContract: { proposed: "number", orphans: "string[]" },
    validationRules: ["No link targets an unpublished page"],
  },
  {
    key: "publishing",
    name: "Publishing Agent",
    description:
      "The only agent permitted to publish. Verifies approval, publishes through the configured adapter, records the result and supports rollback.",
    role: "Executes approved publishing actions.",
    kind: "SPECIALIST",
    allowedTools: [TOOL_KEYS.publish, TOOL_KEYS.unpublish],
    capabilities: ["read_project", "publish", "unpublish", "request_approval"],
    confidenceThreshold: 0.8,
    maxRetries: 1,
    timeoutMs: 120_000,
    modelTier: "fast",
    inputContract: { pageVersionId: "string", adapter: "string?" },
    outputContract: { published: "boolean", remoteUrl: "string", adapterUsed: "string" },
    validationRules: ["An APPROVED approval record exists for the page version", "Quality gate decision is PASS"],
  },
  {
    key: "search_performance",
    name: "Search Performance Agent",
    description:
      "Pulls clicks/impressions/CTR/position for published pages and target queries and turns movement into recommendations.",
    role: "Closes the feedback loop from search data back to the orchestrator.",
    kind: "SPECIALIST",
    allowedTools: [TOOL_KEYS.searchPerformance],
    capabilities: ["read_project", "read_analytics", "write_recommendations"],
    confidenceThreshold: 0.6,
    maxRetries: 1,
    timeoutMs: 120_000,
    modelTier: "fast",
    inputContract: { days: "number?", dimension: "query|page" },
    outputContract: { rows: "number", clicks: "number", impressions: "number", recommendations: "Recommendation[]" },
    validationRules: ["Data source is recorded on every snapshot"],
  },
  {
    key: "ai_visibility",
    name: "AI Visibility Agent",
    description:
      "Runs the prompt library against answer engines, extracts brand/competitor mentions and citations, and computes mention rate, citation rate, coverage and share of voice.",
    role: "Measures presence in generated answers - mentions and citations, never rankings.",
    kind: "SPECIALIST",
    allowedTools: [TOOL_KEYS.aiVisibilityProbe, TOOL_KEYS.competitors],
    capabilities: ["read_project", "call_llm", "spend_budget", "write_recommendations"],
    confidenceThreshold: 0.6,
    maxRetries: 1,
    timeoutMs: 300_000,
    modelTier: "balanced",
    inputContract: { platforms: "string[]", promptIds: "string[]?", limit: "number?" },
    outputContract: { runs: "number", metrics: "VisibilityMetrics", isMock: "boolean" },
    validationRules: ["Every run records platform, model and timestamp"],
  },
  {
    key: "quality_control",
    name: "Quality Control Agent",
    description:
      "Runs the full programmatic page quality gate and decides PASS / REVIEW / REJECT, raising an approval request when a human must decide.",
    role: "Final gate before anything reaches the publishing queue.",
    kind: "GUARDIAN",
    allowedTools: [TOOL_KEYS.factsLookup],
    capabilities: ["read_project", "request_approval", "write_recommendations"],
    confidenceThreshold: 0.75,
    maxRetries: 1,
    timeoutMs: 120_000,
    modelTier: "fast",
    inputContract: { pageVersionId: "string" },
    outputContract: { decision: "PASS|REVIEW|REJECT", score: "number", gates: "GateResult[]" },
    validationRules: ["Every gate produces a result", "A REJECT decision lists at least one blocking reason"],
  },
];

export function agentDefinition(key: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((a) => a.key === key);
}
