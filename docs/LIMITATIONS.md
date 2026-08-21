# What is implemented, what is mocked, what is deferred

An honest inventory. If something is not in the "implemented" list, assume it is not built.

---

## Implemented and working

### Foundation
- Next.js 15 App Router application, TypeScript strict, production build verified
- Prisma schema with 45 models and a real migration; SQLite locally, Postgres-ready
- Authentication (scrypt + HMAC session cookies), RBAC with 4 roles and 17 permissions, tenant isolation
- Typed error hierarchy; structured logging to stdout and to the database
- Control Plane: agent identity, capabilities, tool allowlists, monthly token/cost budgets, sliding-window
  rate limits, approval policy, append-only audit log
- Tool Registry with a fixed permission → validation → credential → execution → record sequence
- Integration catalog with AES-256-GCM credential storage and env fallback
- LLM provider abstraction (Anthropic, OpenAI, deterministic mock) with a tier/complexity router
- Task system with the full 10-state lifecycle
- Resumable workflow engine that parks at approval gates and continues from where it stopped

### SEO intelligence
- Real fetch-based crawler with robots.txt handling, concurrency control and HTML/JSON-LD parsing
- Keyword discovery (DataForSEO client + synthetic corpus), rule-based intent classification
- Entity-first clustering with stemmed cannibalisation detection
- 12-factor opportunity scoring with hard rejection rules and recorded reasons

### Content engine
- Brand/content knowledge layer, enforced by a deterministic compliance check
- Full skill management: immutable versions, DRAFT/TESTING/READY/ACTIVE/ARCHIVED lifecycle, activation
  preflight (validation + automated tests), rollback, per-agent assignment with version pinning, a
  no-side-effects sandbox, a playground with version comparison, and skill-scoped tool narrowing
- 17-component reusable library with required/optional data bindings and named generation slots
- Template system with per-block conditions, overrides and content-source classification
- Safe expression evaluator (purpose-built parser, never `eval`)
- Dynamic Data Engine with provenance on every value and a hard rule against mock sources for
  time-sensitive namespaces
- Page composer producing FAQs, evidence block, breadcrumbs, title and meta
- Composition measurement against a configurable per-family policy
- Claim extraction and fact verification with four verdict types
- 11-check quality gate with weighted scoring and PASS/REVIEW/REJECT

### Publishing and technical SEO
- Three publishing adapters (local_static, webhook, WordPress) with honest fallback recording
- Full lifecycle: draft → validated → approved → published → unpublish → rollback
- Entity-graph internal linking with relevance scoring and orphan detection
- JSON-LD generation with required-property validation (WebPage, BreadcrumbList, FAQPage, Trip,
  Organization, WebSite)
- Sitemap and robots.txt generated from actual published state
- Technical SEO audit with severity-classified findings

### Search and AI visibility
- Search performance adapter (Google Search Console client + labelled synthetic series)
- Recommendation generation from performance movement
- AI visibility prompt library, multi-platform probing, deterministic mention/citation extraction
- Mention rate, citation rate, query coverage, citation share, competitor share, composite score
- Competitor tracking joined to visibility measurement
- Flight search experience linked to landing pages, recording demand

### Interface
- 23 dashboard sections, all rendering live data
- 125 passing tests (unit, integration, end-to-end, skill management)

---

## Mocked — labelled everywhere it appears

| Capability | Mock behaviour | Real when you connect |
| --- | --- | --- |
| LLM generation | Deterministic composer writing only from resolved data | Anthropic / OpenAI |
| Keyword metrics | 488-row synthetic corpus from route demand indices | DataForSEO |
| Search performance | Series derived from publish date + cluster volume | Google Search Console |
| Analytics sessions | Same synthetic series | GA4 |
| AI visibility | Deterministic mock assistant | Anthropic / OpenAI / Perplexity |
| Route/airport/airline reference data | Bundled approximate dataset | Amadeus / Duffel |

Every mock result carries `isMock` through the database and renders a `MOCK` badge in the UI. Mock and
real data are never blended into a single headline metric.

---

## Deliberately not mocked

**Live flight prices, schedules and seat availability.** There is no mock adapter. Without a credentialed
provider the price block is omitted, the page says nothing about fares, and the search panel says so
plainly. Faking inventory would be the single most damaging thing this system could do.

---

## Deferred — scoped but not built

### Page families beyond routes
`airport`, `airline` and `destination` families exist as rows with URL patterns and thresholds, but only
`route` has a template. The `airline` family additionally needs a carrier-policy data source before it
could produce anything publishable, since baggage and fare rules are exactly the time-sensitive claims the
fact gate blocks.

### Background job queue
Workflows run inline in the request. A long run holds the connection for 30–60 seconds. Production needs a
queue (BullMQ/Redis or a hosted equivalent) with the workflow engine as the worker. The engine is already
resumable, which is the hard part.

### Scheduled monitoring
Search performance and AI visibility are run on demand. Recurring collection needs the same queue plus a
scheduler.

### Multi-project switching
The schema is multi-project and multi-tenant; the console resolves the first project in the organization.
A project switcher is UI work, not architecture work.

### Google service-account JWT flow
GSC/GA4 support the OAuth refresh-token flow. The service-account path is recognised but the JWT signing
step is not implemented — the provider raises a configuration error rather than pretending.

### Skill test cases in the UI
`SkillTestCase` rows can be created through the API (`saveAs` on a test call) and are run automatically at
activation, but the dashboard has no dedicated editor for managing them yet.

### Skill diffing
Versions are compared by running both in the playground. There is no textual side-by-side diff of two
versions’ configuration.

### Component update propagation
`Template.propagateUpdates` is stored and surfaced, and component versions are recorded per block, but a
"regenerate all pages whose component version is stale" job is not built.

### Streaming progress
Workflow runs return their result at the end. The UI polls via refresh rather than streaming step-by-step
progress.

### A/B testing, personalisation, autonomous optimisation
Named in the specification as future modules. Extension points exist; no implementation.

### Revenue / Customer / Supply / Operations / Risk Intelligence, Traveler Graph, Executive Brain
Future modules. Not started, by design.

---

## Known limitations

**Runs from before skill versioning report no version.** Those runs recorded only skill keys, so the
agent page shows "(version not recorded)" rather than inferring one. The migration did create a v1 from
whatever each skill held at the time, but attributing it to an older run would be a guess presented as a
record. Runs since the upgrade carry the exact version id.

**SQLite concurrency.** Fine for local development and the test suite; it serialises writes. Move to
Postgres for anything concurrent (see `docs/DEPLOYMENT.md`).

**Crawling requires the app to be running.** The Technical SEO Agent fetches real URLs. If the dev server
is not up, a crawl of `/site/*` correctly records a fetch failure rather than inventing a result.

**Regex HTML parsing.** The crawler uses regex rather than a DOM parser. Sufficient for head/link/heading
signals; it would need a real parser for anything requiring accurate DOM semantics.

**Mock keyword volumes are synthetic.** They are plausible enough to exercise scoring and clustering. They
are not measurements and must never be reported as such.

**Route durations are estimated, not scheduled.** Computed as
`(distance × 1.08) / 850 km/h + 35 min` for non-stop, plus a connection allowance for one-stop. The
formula is recorded on the datum and shown in each page's evidence block.

**Answer-engine measurement is sampling, not truth.** Answer engines are non-deterministic. A single run
is an anecdote; the value is in running the prompt library repeatedly over time. Nothing here claims
causality between a content change and a citation.

**Estimated LLM cost.** Cost is computed from a static price table, not from vendor billing. Treat it as
an estimate.

**First run needs a growth goal.** The dashboard is intentionally empty after seeding because no results
are fabricated. Submit a goal to populate it.

**Internal links need inventory.** The first page published has nothing to link to, so it will show a
link-count warning until sibling pages exist. This is correct behaviour, not a bug.

**Single-node rate limiting.** The limiter is in-process. Multi-instance deployments need a shared store.

---

## Things this system will not do

- Publish a page whose required data did not resolve
- State a price, schedule, baggage allowance or policy without a live source
- Present mock data as measured data
- Generate the full cartesian product of entity combinations
- Let a content agent publish
- Publish without an approval in MANUAL or SEMI-AUTOMATIC mode
- Claim that answer engines rank pages the way a search engine does
- Promise rankings or AI citations
