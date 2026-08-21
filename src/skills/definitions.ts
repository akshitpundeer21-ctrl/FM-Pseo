import type { SkillExample, SkillIoField, SkillModelGuidance } from "@/skills/types";

/**
 * Skill Library.
 *
 * A skill is a reusable, versioned instruction set describing HOW to perform a
 * class of work. Skills are data, not code: they are seeded into the Skill table
 * and attached to agents through AgentSkill, so an operator can edit a
 * methodology without touching agent logic, and one skill can serve many agents.
 *
 * Skills answer "how". Brand knowledge (src/modules/brand) answers "what the
 * output should be like". Agents compose both at prompt-build time.
 */

export interface SkillDefinition {
  key: string;
  name: string;
  category: string;
  description: string;
  /** Injected verbatim into the agent's system prompt. */
  instructions: string;
  /** Ordered procedure the agent should follow. */
  methodology: string[];
  /** Hard rules. Violating one should fail validation, not just look bad. */
  constraints: string[];
  /** Shape the skill expects the agent to produce. */
  outputContract: Record<string, string>;
  /** Declared inputs. Seeded into v1's input schema. */
  inputs?: SkillIoField[];
  /** Tools this skill requests. Always intersected with the agent allowlist. */
  allowedTools?: string[];
  /** Extra rule categories surfaced separately in the UI. */
  qualityCriteria?: string[];
  safetyRules?: string[];
  businessRules?: string[];
  examples?: SkillExample[];
  modelGuidance?: SkillModelGuidance;
}

export const SKILLS: SkillDefinition[] = [
  {
    key: "seo_keyword_research",
    name: "SEO Keyword Research",
    category: "RESEARCH",
    description: "Discover, qualify and prioritise keywords for a travel site, including long-tail and question queries.",
    instructions: [
      "Work from entities (routes, airports, airlines, destinations) rather than from adjectives.",
      "For every seed, expand into the four demand shapes: core commercial, long-tail modifier, question form, and code/abbreviation form.",
      "Qualify each candidate on demand, business proximity and how well a single page could satisfy it.",
      "Never treat raw volume as priority. A 300/mo transactional route query usually outranks a 10,000/mo generic informational one for an OTA.",
      "Flag any keyword that a page in the existing inventory already targets - that is a cannibalisation risk, not an opportunity.",
    ].join(" "),
    methodology: [
      "Resolve the entities named in the objective (IATA codes, city names, carrier names).",
      "Build seed terms from entity templates plus explicit question variants.",
      "Retrieve metrics from the keyword provider; record whether the data is live or synthetic.",
      "Classify search intent for each row.",
      "Score opportunity = f(demand, business value, difficulty, intent fit).",
      "Group into clusters where one page can satisfy the whole group.",
      "Detect cannibalisation against existing pages and clusters.",
      "Recommend an action per keyword: TARGET_NEW, TARGET_EXISTING, SUPPORT, or IGNORE.",
    ],
    constraints: [
      "Do not invent search volumes. If the provider is synthetic, label every row as MOCK.",
      "Do not recommend a page for a keyword whose intent cannot be satisfied by the data available.",
      "Do not create more than one target page per cluster.",
    ],
    outputContract: {
      keywords: "Array of {keyword,intent,entityType,origin,destination,pageType,volume,difficulty,opportunityScore,recommendedAction}",
      clusters: "Array of {name,primaryKeyword,intent,pageType,totalVolume,opportunityScore,keywords[]}",
      cannibalisation: "Array of {keyword,conflictsWith,severity}",
    },
  },
  {
    key: "search_intent_classification",
    name: "Search Intent Classification",
    category: "RESEARCH",
    description: "Assign a defensible intent label and map it to the page type that can satisfy it.",
    instructions: [
      "Classify into INFORMATIONAL, NAVIGATIONAL, COMMERCIAL, TRANSACTIONAL or QUESTION.",
      "Intent is about what the searcher wants to DO next, not the grammar of the query.",
      "Map intent to page type: TRANSACTIONAL/COMMERCIAL route queries -> ROUTE page; QUESTION -> an answer block on the relevant entity page, not usually a new page; NAVIGATIONAL brand/carrier queries -> AIRLINE page.",
      "When a query mixes intents, choose the one that determines the page format, and note the secondary intent so the content plan can cover it in a section.",
    ].join(" "),
    methodology: [
      "Detect entity type and modifiers.",
      "Apply the deterministic rule set first; escalate ambiguous cases only.",
      "Map to page type and record the reason.",
      "Note secondary intent for section planning.",
    ],
    constraints: [
      "Never create a standalone page for a QUESTION query that an existing entity page can answer in a section.",
      "Record the classification reason so it is auditable.",
    ],
    outputContract: { intent: "SearchIntent", pageType: "PageType", reason: "string", secondaryIntent: "SearchIntent|null" },
  },
  {
    key: "programmatic_seo",
    name: "Programmatic SEO",
    category: "STRATEGY",
    description: "Design page families and decide which programmatic combinations deserve to exist at all.",
    instructions: [
      "A page family is a URL pattern plus a template plus a data contract. Define all three before generating anything.",
      "Existence of a combination is NOT a reason to create a page. Demand, data availability and unique utility are.",
      "Every generated page must be able to answer something a template alone cannot: real route data, real entity attributes, genuinely route-specific guidance.",
      "Prefer fewer, substantially better pages. Thin programmatic inventory is a liability that suppresses the whole family.",
      "Plan the internal link graph as part of the family design, not afterwards.",
    ].join(" "),
    methodology: [
      "Define the URL pattern and its variables.",
      "Define the data contract: which bindings must resolve for a page to be publishable.",
      "Set the composition policy: how much of the page is template, dynamic data, and generated prose.",
      "Score every candidate combination through the opportunity model.",
      "Set the minimum score for automatic build; everything below goes to review or is rejected.",
      "Define sibling/parent links so no page is orphaned.",
    ],
    constraints: [
      "Never mass-generate the full cartesian product of entities.",
      "A page whose required data bindings do not resolve must not be generated.",
      "Do not hard-code a fixed template/unique ratio; it is configured per family.",
    ],
    outputContract: {
      pageFamily: "{key,name,urlPattern,entityTypes,composition,qualityThresholds,minOpportunityScore}",
      opportunities: "Array of scored candidates with a BUILD|REVIEW|REJECT decision and reasons",
    },
  },
  {
    key: "travel_content_writing",
    name: "Travel Content Writing",
    category: "CONTENT",
    description: "Write useful, specific travel copy that respects what is actually known.",
    instructions: [
      "Lead with what the traveller needs to decide: how long, how many stops, who flies it, what changes the price.",
      "Be concrete. 'Long-haul' is weak; 'about 15h nonstop' is useful - but only write the number if it came from resolved data.",
      "Write for a traveller who is comparing options, not for a search engine.",
      "Never state a price, schedule, baggage allowance, fee or policy that did not arrive as a verified data point. Omit the sentence instead.",
      "Prefer short paragraphs, scannable structure and plain language at the configured reading level.",
    ].join(" "),
    methodology: [
      "Read the resolved data context and the brand profile first.",
      "Draft only the sections whose data bindings resolved.",
      "Weave entity specifics (cities, airports, carriers) into every section that has them.",
      "Close each section with something actionable.",
      "Re-read against the brand's avoid-words and avoid-claims lists.",
    ],
    constraints: [
      "No fabricated numbers, prices, durations, policies or dates.",
      "No superlatives that cannot be substantiated ('cheapest', 'guaranteed', 'always').",
      "No filler that restates the heading.",
      "Respect the configured reading level and banned terminology.",
    ],
    outputContract: { sections: "Array of {blockKey,text,factsUsed[]}", confidence: "0..1" },
  },
  {
    key: "fact_verification",
    name: "Fact Verification",
    category: "QUALITY",
    description: "Establish whether each claim on a page is supported, and block publication when it is not.",
    instructions: [
      "Every checkable claim needs a source, a retrieval timestamp and a confidence.",
      "Treat prices, schedules, baggage allowances, fees, visa rules and carrier policies as time-sensitive: they require a live, credentialed source, and a stale or synthetic source is not acceptable.",
      "Structural facts (distance, airport identity, country) may rest on reference data, but must still carry provenance.",
      "An unsupported claim is not a small problem. Remove the claim or block the page.",
    ].join(" "),
    methodology: [
      "Extract checkable claims from the draft.",
      "Match each claim to a resolved data point or stored fact.",
      "Mark claims with no matching source as UNSUPPORTED.",
      "Mark time-sensitive claims backed only by mock/static data as REQUIRES_LIVE_SOURCE.",
      "Emit a verdict per claim plus an overall gate result.",
    ],
    constraints: [
      "Never mark a claim VERIFIED on the strength of model fluency.",
      "Never allow a time-sensitive claim to publish from a mock source.",
      "Record evidence for every verdict.",
    ],
    outputContract: {
      claims: "Array of {claim,status,source,confidence,evidence}",
      gate: "PASS|FAIL",
      blockingClaims: "Array of strings",
    },
  },
  {
    key: "aeo_optimization",
    name: "Answer Engine Optimization (AEO)",
    category: "OPTIMIZATION",
    description: "Make the page's answers directly extractable by answer engines and featured results.",
    instructions: [
      "Every question the page targets should have a self-contained answer of roughly 40-60 words placed immediately under its heading.",
      "The answer must make sense with zero surrounding context - assume it will be lifted out.",
      "Use the question phrasing people actually type as the heading.",
      "Structure beats prose: definition lists, short tables and clean FAQ blocks are easier to extract.",
      "Do not bury the answer under a preamble.",
    ].join(" "),
    methodology: [
      "Collect the QUESTION-intent keywords mapped to this page.",
      "Give each a heading in natural question form.",
      "Write a direct answer block first, then optional supporting detail.",
      "Emit FAQPage structured data for the Q&A set.",
      "Verify each answer is standalone and within the length band.",
    ],
    constraints: [
      "Answers must not hedge to the point of saying nothing.",
      "Answers must not contain unverified specifics.",
      "One answer per question; no duplicated answers across questions.",
    ],
    outputContract: { answers: "Array of {question,answer,wordCount,standalone:boolean}", faqSchema: "JSON-LD FAQPage" },
  },
  {
    key: "geo_optimization",
    name: "Generative Engine Optimization (GEO)",
    category: "OPTIMIZATION",
    description: "Improve the odds of being used and cited by generative answer engines - without claiming to control them.",
    instructions: [
      "Generative engines synthesise from sources they can parse, trust and attribute. Optimise for clarity, entity precision and citability.",
      "Name entities explicitly and consistently: full airport name plus IATA code, full carrier name, city plus country.",
      "State the source and recency of factual claims on the page itself - a visible evidence block is both good UX and a citability signal.",
      "Cover the topic completely enough that an engine does not need a second source for the basics.",
      "Never claim that any technique guarantees a citation. Measure mention and citation rates instead.",
    ].join(" "),
    methodology: [
      "Build the entity list for the page and ensure each appears in a disambiguated form at least once.",
      "Attach a source/evidence block listing each factual claim's origin and retrieval date.",
      "Ensure the page answers the adjacent questions an engine would otherwise leave.",
      "Emit precise structured data with entity identifiers.",
      "Register the page's target prompts in the AI visibility prompt library so the effect is measured.",
    ],
    constraints: [
      "Do not describe answer-engine behaviour as ranking.",
      "Do not promise citations or AI placement.",
      "Do not pad the page to look comprehensive; completeness is about covered questions, not word count.",
    ],
    outputContract: {
      entities: "Array of {name,type,identifier,disambiguated:boolean}",
      evidenceBlock: "Array of {claim,source,retrievedAt}",
      coverageGaps: "Array of strings",
    },
  },
  {
    key: "cfa_structuring",
    name: "Clear Factual Answering (CFA)",
    category: "OPTIMIZATION",
    description: "Express the page's facts in extractable, relationship-aware structures.",
    instructions: [
      "Give each factual cluster a stable structure: key-value summaries, comparison tables, and explicit entity relationships.",
      "Say what relates to what: this route connects these two airports, is operated by these carriers, and belongs to this destination.",
      "Attribute every fact inline or in the evidence block.",
      "Prefer one canonical statement of a fact per page; repetition creates contradiction risk.",
    ].join(" "),
    methodology: [
      "Build a fact summary table for the page's core entity.",
      "Express relationships explicitly in both prose and structured data.",
      "Attach attribution to each fact.",
      "Check for internal contradictions across sections.",
    ],
    constraints: ["No fact appears twice with different values.", "Every fact in the summary table has a source."],
    outputContract: { summaryTable: "Array of {label,value,source}", relationships: "Array of {from,relation,to}" },
  },
  {
    key: "technical_seo",
    name: "Technical SEO",
    category: "TECHNICAL",
    description: "Validate that a page is crawlable, indexable and technically coherent.",
    instructions: [
      "Check status, canonical, robots directives, title and meta length, heading hierarchy, and structured data validity.",
      "A page with a self-referencing canonical, a unique title, one H1 and valid JSON-LD is the baseline, not the goal.",
      "Orphan pages are a real defect: every published page needs at least one internal link pointing at it.",
      "Report severity honestly. A missing meta description is a warning; a noindex directive on a page you just published is an error.",
    ].join(" "),
    methodology: [
      "Crawl the target URLs.",
      "Run each check and classify severity as ERROR, WARNING or INFO.",
      "Detect orphans by diffing the link graph against the published set.",
      "Verify sitemap membership.",
      "Produce a prioritised fix list.",
    ],
    constraints: [
      "Do not report a check as passed if the page could not be fetched.",
      "Do not silently ignore non-200 responses.",
    ],
    outputContract: { issues: "Array of {url,check,severity,message}", passed: "number", failed: "number" },
  },
  {
    key: "schema_markup",
    name: "Structured Data",
    category: "TECHNICAL",
    description: "Emit accurate, minimal JSON-LD that matches what is actually on the page.",
    instructions: [
      "Only emit a type whose required properties are backed by real page content.",
      "FAQPage only when visible Q&A exists. BreadcrumbList to reflect the real hierarchy. Organization/WebSite at site level.",
      "Never mark up content the user cannot see.",
      "Keep the graph small and correct rather than large and speculative.",
    ].join(" "),
    methodology: [
      "Determine eligible types from the rendered blocks.",
      "Populate required properties from resolved data only.",
      "Validate required-property presence before emitting.",
      "Attach the JSON-LD to the page version and record validation status.",
    ],
    constraints: [
      "No markup for absent content.",
      "No invented identifiers or ratings.",
      "Invalid JSON-LD blocks publication.",
    ],
    outputContract: { schemas: "Array of {type,jsonld,valid:boolean,issues[]}" },
  },
  {
    key: "internal_linking",
    name: "Internal Linking",
    category: "TECHNICAL",
    description: "Connect pages by real semantic relationships, not by link quota.",
    instructions: [
      "Link because the target genuinely helps the reader at that point, not to hit a number.",
      "Use the entity graph: a route page relates to its origin airport, destination airport, destination city, operating carriers, and sibling routes from the same origin.",
      "Anchor text should describe the destination page, and vary naturally across pages.",
      "Every published page must have at least one inbound internal link from a relevant page.",
    ].join(" "),
    methodology: [
      "Build the entity graph for the page.",
      "Find candidate targets that share entities and are published.",
      "Score relevance from shared entities, intent proximity and hierarchy distance.",
      "Propose links above the relevance floor, capped per section.",
      "Check the inbound-link count of every published page and fix orphans.",
    ],
    constraints: [
      "No link farms or repeated identical anchors across a family.",
      "No links to unpublished or rejected pages.",
      "Relevance floor is configured, not guessed.",
    ],
    outputContract: { links: "Array of {fromUrl,targetUrl,anchorText,relevance,reason}", orphans: "Array of strings" },
  },
  {
    key: "competitor_research",
    name: "Competitor Research",
    category: "RESEARCH",
    description: "Understand what the competitive set covers and where the gaps are.",
    instructions: [
      "Compare on coverage and depth, not on vanity metrics.",
      "Identify the entity/question space competitors cover that we do not, and vice versa.",
      "Note structural patterns worth matching (answer placement, data tables, evidence blocks) and patterns worth avoiding (thin doorway pages).",
      "Never assert a competitor's internal methodology as fact; describe only what is observable.",
    ].join(" "),
    methodology: [
      "Define the competitive set.",
      "Map their coverage of the target entity space.",
      "Diff against our published inventory.",
      "Rank gaps by demand and feasibility.",
    ],
    constraints: [
      "Do not claim knowledge of a competitor's internal formula or strategy.",
      "Cite the observation source for each claim.",
    ],
    outputContract: { gaps: "Array of {entity,queryShape,demand,feasibility}", observations: "Array of strings" },
  },
  {
    key: "ai_visibility",
    name: "AI Visibility Measurement",
    category: "MEASUREMENT",
    description: "Measure brand presence in generated answers honestly.",
    instructions: [
      "Answer engines do not rank pages the way a search engine does. Measure mention rate, citation rate, query coverage and share of voice against competitors.",
      "Sample repeatedly: a single run is an anecdote, a prompt library run over time is a measurement.",
      "Record the platform, model, timestamp and full response for every run so results are auditable.",
      "Report competitor mention/citation share alongside our own; absolute numbers without share are misleading.",
      "Never describe a mention as a ranking position.",
    ].join(" "),
    methodology: [
      "Maintain a prompt library covering route, destination, policy, booking and brand queries.",
      "Run the library across the configured platforms on a schedule.",
      "Extract mentions and citations deterministically.",
      "Compute mention rate, citation rate, coverage and share.",
      "Feed uncovered prompts back as content opportunities.",
    ],
    constraints: [
      "Only use permitted APIs or approved access methods.",
      "Label synthetic runs as MOCK and never blend them with real ones in a headline metric.",
      "Do not claim causality between a content change and a citation without a controlled comparison.",
    ],
    outputContract: {
      metrics: "{mentionRate,citationRate,queryCoverage,citationShare,competitorMentionShare,visibilityScore}",
      runs: "Array of {prompt,platform,brandMentioned,brandCited,competitorsMentioned[]}",
    },
  },
  {
    key: "content_quality_control",
    name: "Content Quality Control",
    category: "QUALITY",
    description: "Decide whether a page is genuinely good enough to publish.",
    instructions: [
      "Judge utility first: would a traveller comparing options be better off with this page than without it?",
      "Check differentiation against sibling pages in the same family - if swapping two city names produces the other page, it is too thin.",
      "Check completeness against the questions the page claims to answer.",
      "Check that every required data binding resolved and every claim is supported.",
      "A failing page goes to review or rejection. It does not get published with a warning.",
    ].join(" "),
    methodology: [
      "Run each gate and score it.",
      "Compute the differentiation ratio against sibling pages.",
      "Aggregate to a weighted quality score.",
      "Compare against the family's thresholds.",
      "Emit PASS, REVIEW or REJECT with the reasons that drove it.",
    ],
    constraints: [
      "Never pass a page with an unresolved required binding.",
      "Never pass a page with an unsupported time-sensitive claim.",
      "Never pass a page below the family's differentiation floor.",
    ],
    outputContract: { gates: "Array of {gate,passed,score,message}", score: "0..100", decision: "PASS|REVIEW|REJECT" },
  },
  {
    key: "orchestration_planning",
    name: "Orchestration Planning",
    category: "STRATEGY",
    description: "Turn a business objective into a delegated, verifiable plan.",
    instructions: [
      "Read the objective for the entities, the outcome and the constraints it implies.",
      "Decide which stages are actually required - do not run the full workflow when the objective only needs part of it.",
      "Delegate each stage to the agent whose role owns it. Never perform specialist work directly.",
      "Decide where human approval is required based on the project's approval mode and the risk of each stage.",
      "Sequence stages so that each has the inputs it needs, and state the dependency explicitly.",
    ].join(" "),
    methodology: [
      "Parse entities and the objective type from the goal text.",
      "Select the workflow definition and prune stages that do not apply.",
      "Create a structured task per stage with inputs, dependencies and approval requirements.",
      "Delegate, monitor, and react to failures by escalating rather than silently skipping.",
      "Summarise the outcome and the recommended next action.",
    ],
    constraints: [
      "The orchestrator never publishes, writes content or calls a specialist tool itself.",
      "Every delegated task records its agent, inputs and approval requirement.",
      "A failed required stage stops the workflow; it is not skipped.",
    ],
    outputContract: {
      plan: "Array of {step,agentKey,inputs,dependsOn,requiresApproval,rationale}",
      entities: "Parsed entity map",
      nextAction: "string",
    },
  },
];

export function skillByKey(key: string): SkillDefinition | undefined {
  return SKILLS.find((s) => s.key === key);
}

/** Skills granted to each agent at seed time. */
export const AGENT_SKILL_MAP: Record<string, string[]> = {
  master_orchestrator: ["orchestration_planning", "programmatic_seo"],
  keyword_research: ["seo_keyword_research", "search_intent_classification", "competitor_research"],
  programmatic_opportunity: ["programmatic_seo", "search_intent_classification", "seo_keyword_research"],
  content_strategy: ["programmatic_seo", "travel_content_writing", "search_intent_classification"],
  content_generation: ["travel_content_writing", "aeo_optimization", "cfa_structuring"],
  fact_verification: ["fact_verification"],
  seo_optimization: ["aeo_optimization", "geo_optimization", "cfa_structuring", "schema_markup"],
  technical_seo: ["technical_seo", "schema_markup"],
  internal_linking: ["internal_linking"],
  publishing: ["technical_seo"],
  search_performance: ["seo_keyword_research"],
  ai_visibility: ["ai_visibility", "geo_optimization", "competitor_research"],
  quality_control: ["content_quality_control", "fact_verification", "technical_seo"],
};
