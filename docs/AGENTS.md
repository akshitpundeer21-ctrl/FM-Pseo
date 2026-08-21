# Agents

Thirteen agents. Each has an identity row in the database, a capability set, a tool allowlist, typed
input/output schemas, validation rules applied to its own output, a confidence threshold, a retry policy
and a timeout. The Control Plane enforces all of it at run time.

The dashboard renders this same information live at `/agents`.

---

## Master Orchestrator — `master_orchestrator`

**Kind** ORCHESTRATOR · **Tier** balanced · **Confidence floor** 0.6

Interprets a business objective, resolves the entities in it, selects a workflow, prunes stages that
cannot run, decides where human approval is required, and emits a delegated plan of structured tasks.

- **Tools** `llm.generate`, `travel.reference`
- **Capabilities** `read_project`, `request_approval`, `call_llm`, `spend_budget`, `write_recommendations`
- **Skills** Orchestration Planning, Programmatic SEO
- **Validation** plan is non-empty · every step names a registered agent · publishing steps carry an
  approval gate

Entity parsing and workflow selection are deterministic, so planning works with no LLM configured. The
model is used only to narrate the plan for the operator.

**It never performs specialist work.** The e2e test asserts that no plan step is assigned to the
orchestrator itself.

---

## Keyword Research Agent — `keyword_research`

**Kind** SPECIALIST · **Tier** fast · **Confidence floor** 0.65

Discovers, classifies, scores and clusters keywords for the target entities, and reports cannibalisation.

- **Tools** `keyword.discover`, `research.competitors`, `travel.reference`
- **Capabilities** `read_project`, `write_keywords`, `call_external_api`, `spend_budget`, `call_llm`
- **Skills** SEO Keyword Research, Search Intent Classification, Competitor Research
- **Output** keyword count, clusters (with intent, page type, volume, difficulty, opportunity score),
  cannibalisation findings, provider and mock flag

Intent classification is a deterministic rule set rather than a model call: intent drives page-type
routing, and a stable auditable rule beats a probabilistic one. Re-running replaces the clustering and
re-points existing keyword rows, so the agent is idempotent.

---

## Programmatic Opportunity Agent — `programmatic_opportunity`

**Kind** GUARDIAN · **Tier** fast · **Confidence floor** 0.7

Scores every candidate page before it exists and records BUILD / REVIEW / REJECT with reasons.

- **Tools** `travel.reference`, `data.resolve`, `keyword.discover`
- **Capabilities** `read_project`, `write_opportunities`, `call_external_api`, `spend_budget`
- **Validation** every candidate has a decision and at least one reason · nothing is marked BUILD below
  40% data availability

This is the agent that stops the system becoming a page mill.

---

## Content Strategy Agent — `content_strategy`

**Kind** SPECIALIST · **Tier** balanced · **Confidence floor** 0.65

Ensures the page family and template exist, sets the composition policy, and produces the content plan:
target URL, primary keyword, supporting keywords and the questions the page must answer.

- **Tools** `travel.reference`, `data.resolve`
- **Capabilities** `read_project`, `write_page_family`, `write_template`, `write_content`
- **Validation** template has blocks · template has at least one required block · a composition policy is
  set

On first use for a family it builds the template from the component library, carrying each component's
own content-source classification onto the block.

---

## Content Generation Agent — `content_generation`

**Kind** SPECIALIST · **Tier** balanced · **Confidence floor** 0.65

Resolves the data contract, attempts live offers, computes related links, generates only the prose the
template asks for, assembles the page and persists a new version with per-block provenance.

- **Tools** `data.resolve`, `travel.offers`, `llm.generate`, `facts.lookup`
- **Capabilities** `read_project`, `write_content`, `call_llm`, `call_external_api`, `spend_budget`
- **Validation** all required blocks rendered · page has real content · no price-shaped value without a
  live source

**It cannot publish.** It does not hold the `publish` capability and `cms.publish` is not on its
allowlist; the integration test asserts the tool layer refuses the call.

---

## Fact Verification Agent — `fact_verification`

**Kind** GUARDIAN · **Tier** fast · **Confidence floor** 0.75

Extracts checkable claims from the draft and matches each to an attributed source.

- **Tools** `facts.lookup`, `web.fetch`, `data.resolve`
- **Capabilities** `read_project`, `write_facts`, `crawl_web`
- **Verdicts** `VERIFIED` · `UNSUPPORTED` · `REQUIRES_LIVE_SOURCE` · `STALE`

Extraction is regex-driven and scoped to the blocks that make claims about the page's own entity —
comparison tables and the evidence block describe other things and are excluded, which is what stops false
positives on sibling-route figures.

Time-sensitive claims (prices, schedules, baggage, fees) require a live, non-mock source. Anything else is
blocking, and the quality gate turns that into a `REJECT`.

---

## SEO / AEO / GEO Optimization Agent — `seo_optimization`

**Kind** SPECIALIST · **Tier** balanced · **Confidence floor** 0.65

- **SEO** title, meta description, heading hierarchy, keyword placement
- **AEO** standalone answer block within the configured word band, question-form FAQ set
- **GEO** entity disambiguation, evidence completeness, coverage gaps
- **CFA** fact summary table and explicit entity relationships
- plus validated JSON-LD, persisted per page

- **Tools** `llm.generate`
- **Capabilities** `read_project`, `write_content`, `write_schema`, `call_llm`, `spend_budget`
- **Validation** title present and within the ceiling · meta present · at least one valid schema block

It makes no claim about controlling rankings or citations. It optimises for clarity, extractability and
attribution; the AI Visibility module measures whether that moved anything.

---

## Technical SEO Agent — `technical_seo`

**Kind** SPECIALIST · **Tier** fast · **Confidence floor** 0.6

Crawls the published site over real HTTP and validates status codes, canonicals, robots directives,
titles, meta descriptions, heading hierarchy, structured data validity, thin content, duplicate titles,
orphan pages and broken links.

- **Tools** `web.crawl`, `web.fetch`
- **Capabilities** `read_project`, `crawl_web`, `write_recommendations`
- **Validation** at least one URL was attempted

Severity is honest: a missing meta description is a warning, a `noindex` on a page you just published is
an error.

---

## Internal Linking Agent — `internal_linking`

**Kind** SPECIALIST · **Tier** fast · **Confidence floor** 0.6

Builds the entity graph, proposes links above the configured relevance floor, and reports orphans.

- **Tools** none — it works from the database
- **Capabilities** `read_project`, `write_links`
- **Validation** no proposed link has an invalid target

Relevance comes from shared entities (route, airport, city, country, airline), page-type
complementarity and a weak title-similarity signal. Links to unpublished pages are never proposed.

---

## Publishing Agent — `publishing`

**Kind** SPECIALIST · **Tier** fast · **Confidence floor** 0.8

The **only** agent that can publish.

- **Tools** `cms.publish`, `cms.unpublish`
- **Capabilities** `read_project`, `publish`, `unpublish`, `request_approval`
- **Validation** publishing completed · a destination URL was returned

Before acting it re-checks, from the database rather than the caller's word: the quality gate decision is
`PASS`, and an `APPROVED` approval exists (unless the project explicitly allowlisted unattended publishing
in `AUTOMATIC` mode). It records which adapter actually ran, including a fallback, so nothing is ever
reported as having reached a CMS that it did not.

Rollback and unpublish live alongside it as a service so the dashboard can trigger them with an audit
trail.

---

## Search Performance Agent — `search_performance`

**Kind** SPECIALIST · **Tier** fast · **Confidence floor** 0.6

Pulls query- and page-level performance for published inventory, persists snapshots, and turns movement
into recommendations (striking-distance queries, weak snippets).

- **Tools** `analytics.search_performance`
- **Capabilities** `read_project`, `read_analytics`, `write_recommendations`
- **Validation** the data source is recorded on every snapshot

With Search Console connected this is measured data. Without it, the series is synthetic, every row is
flagged `isMock`, and a page published today correctly has no history at all. A `simulateHistoryDays`
input exists purely so the dashboard can be inspected in a demo; it is explicitly labelled.

---

## AI Visibility Agent — `ai_visibility`

**Kind** SPECIALIST · **Tier** balanced · **Confidence floor** 0.6

Runs the prompt library against the configured answer engines and records the full response, brand and
competitor mentions, and cited URLs.

- **Tools** `ai_visibility.probe`, `research.competitors`
- **Capabilities** `read_project`, `call_llm`, `spend_budget`, `write_recommendations`
- **Metrics** mention rate, citation rate, query coverage, citation share, competitor mention share,
  composite visibility score
- **Validation** every run records platform, model and timestamp · every rate is within 0..1

Prompts where the brand never appears are written back as content-gap recommendations. The module never
describes a mention as a ranking position.

---

## Quality Control Agent — `quality_control`

**Kind** GUARDIAN · **Tier** fast · **Confidence floor** 0.75

Runs the full quality gate, persists every check, sets the page and version status, and routes to
approval, review or rejection.

- **Tools** `facts.lookup`
- **Capabilities** `read_project`, `request_approval`, `write_recommendations`
- **Validation** every gate produces a result · a `REJECT` names at least one blocking reason

A `REJECT` also writes a recommendation describing what to fix.

---

## Capability matrix

| Agent | publish | write_content | call_llm | crawl_web | spend_budget |
| --- | :-: | :-: | :-: | :-: | :-: |
| master_orchestrator | | | ● | | ● |
| keyword_research | | | ● | | ● |
| programmatic_opportunity | | | | | ● |
| content_strategy | | ● | | | |
| content_generation | | ● | ● | | ● |
| fact_verification | | | | ● | |
| seo_optimization | | ● | ● | | ● |
| technical_seo | | | | ● | |
| internal_linking | | | | | |
| **publishing** | **●** | | | | |
| search_performance | | | | | |
| ai_visibility | | | ● | | ● |
| quality_control | | | | | |
