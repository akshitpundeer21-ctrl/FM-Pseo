# Architecture

## The core idea

This is not a collection of AI agents that each call a model. It is an operating system: a Control Plane
governs identity, permissions, budgets and approvals; a Tool Registry mediates every external call; a
Master Orchestrator turns objectives into delegated work; and every stage leaves an auditable trail.

```
                                USER
                                  │
                          WEB DASHBOARD (Next.js)
                                  │
                        MASTER ORCHESTRATOR
                                  │
      ┌───────────────────────────┼───────────────────────────┐
      │                           │                           │
 DIRECTOR/SPECIALIST AGENTS  GUARDIAN AGENTS            WORKFLOW ENGINE
      │                           │                           │
      └───────────┬───────────────┴───────────────┬───────────┘
                  │                               │
            CONTROL PLANE  ◄──────────────────────┘
       (identity, capabilities, tool allowlist,
        budgets, rate limits, approvals, audit)
                  │
            TOOL REGISTRY
                  │
   ┌──────────┬───┴────┬───────────┬────────────┐
   │          │        │           │            │
 LLM       KEYWORD   TRAVEL     CRAWLER       CMS
 ROUTER     DATA      DATA                  ADAPTERS
   │          │        │           │            │
   └──────────┴────────┴───────────┴────────────┘
                  │
            VALIDATION  (fact verification → quality gate)
                  │
             APPROVAL  (human, per project policy)
                  │
             EXECUTION  (publish → sitemap)
                  │
            MONITORING  (crawl → search performance → AI visibility)
                  │
             FEEDBACK  (recommendations)
                  │
        back to the MASTER ORCHESTRATOR
```

## Layers

### 1. Core (`src/core`)

Config (Zod-validated env), the Prisma singleton, the typed error hierarchy, structured logging, security
primitives (AES-256-GCM, scrypt, HMAC sessions), RBAC and shared utilities. Nothing above this layer
reads `process.env` directly or throws an untyped error.

### 2. Control Plane (`src/control-plane`)

The chokepoint between "an agent wants to act" and "it happens".

- **Identity** — loads the agent row, its capability set and its tool allowlist.
- **Capabilities** — `publish`, `write_content`, `call_llm`, `crawl_web`, … Checked per action.
- **Tool allowlist** — an agent may only use tools listed on its own record.
- **Budget** — a monthly token/USD ledger per organization, checked before any billable call.
- **Rate limiting** — a sliding window per key, for API routes and outbound calls.
- **Approval policy** — `MANUAL` / `SEMI_AUTOMATIC` / `AUTOMATIC`, plus a per-project allowlist that only
  applies in `AUTOMATIC` mode. Publishing is never allowlisted by default.
- **Audit** — an append-only record of every state change and every allow/deny decision.

### 3. Agents (`src/agents`)

`BaseAgent` gives every agent, identically: typed input/output validation, skill + brand injection,
mediated tool access, timeout, retries, confidence scoring, self-validation rules, cost accounting and an
`AgentRun` row that makes the run observable in the dashboard. Subclasses implement `perform()` only.

Agents are registered in two places: `AGENT_DEFINITIONS` (identity + permissions, seeded to the database)
and the factory in `registry.ts` (key → implementation). Adding an agent is two entries and one file.

### 4. Skills (`src/skills`) and Brand knowledge (`src/modules/brand`)

Skills are versioned and immutable. The runtime resolves `agent → assignment → active (or pinned) version`
and records the version id on the run, so a historical execution always reports the exact instructions that
produced it. See [SKILL-MANAGEMENT.md](SKILL-MANAGEMENT.md).

Skills say **how** to do the work — methodology, hard rules, output contract. Brand knowledge says **what
the output must be like** — voice, audience, banned terms, SEO/AEO/GEO rules, quality standards. Both live
in the database and are composed into the system prompt at run time, so editing either changes future
output without touching code.

Brand rules are also *enforced*: `checkBrandCompliance` runs after generation and its findings feed the
quality gate.

### 5. Tools (`src/tools`)

A tool declares its required capability, its integration, whether a mock fallback is permitted, whether it
is billable, and Zod schemas for input and output. `executeTool` runs a fixed sequence:

```
allowlist → capability → budget → input validation → credential resolution
  → timed execution with retries → output validation → ToolInvocation record
```

Credentials are resolved server-side and handed to the tool implementation only. They never reach the
agent, a prompt or a log.

### 6. LLM abstraction (`src/llm`)

Providers implement one interface. The router picks by explicit preference, then task complexity, then
availability, and degrades to the deterministic mock composer when nothing is configured (and
`DEMO_MODE=true`). Model tiers (`fast` / `balanced` / `deep`) map to concrete model ids per provider.

The mock provider is not an imitation of a model — it is a deterministic composer that assembles copy from
the structured variables the caller already resolved. It cannot invent a price because it is never given
one.

### 7. Engine (`src/engine`)

| Module | Responsibility |
| --- | --- |
| `data/` | Dynamic Data Engine + source adapters. Every value carries provenance. Time-sensitive namespaces may only be served by credentialed adapters. |
| `templates/` | Component library, safe expression evaluator, renderer, composition accounting |
| `content/` | Page composer: FAQ generation, evidence block, breadcrumbs, title/meta |
| `pseo/` | Opportunity scoring and URL pattern expansion |
| `quality/` | The 11-gate quality report |
| `linking/` | Entity-graph link proposal and orphan detection |
| `schema/` | JSON-LD generation with required-property validation |
| `tasks/` | Task lifecycle |
| `workflow/` | Workflow definitions and the resumable engine |

### 8. Modules (`src/modules`)

Vendor-facing implementations kept behind interfaces: brand knowledge, keyword providers, analytics
providers, the crawler, publishing adapters and answer-engine probing.

### 9. App (`src/app`)

Next.js App Router. Server components query Prisma directly for read paths; mutations go through route
handlers under `/api`. `/site/[[...slug]]` serves what the publishing adapter wrote, which is what makes
the publish → crawl loop real in local development.

## The template + dynamic data architecture

```
PAGE TEMPLATE          ordered component blocks, per-block conditions and overrides
  +
REUSABLE COMPONENTS    independently versioned; each declares required/optional data bindings
  +                    and named AI generation slots
DYNAMIC DATA           resolved per page, every value carrying source/timestamp/confidence
  +
PAGE-SPECIFIC DATA     origin, destination, carriers, distance, duration…
  +
GENERATED PROSE        written only from the resolved data context
  =
FINAL PAGE
```

Three things make this more than string templating:

1. **A component with unresolved required bindings does not render.** The reason is recorded on the page
   version. If the block was required, the page cannot pass the quality gate.
2. **Composition is measured, not assumed.** The renderer sums the characters produced by each source
   class and compares the result against the page family's configured policy. There is no hard-coded
   70/30 anywhere — `minUniqueShare`, `maxTemplateShare`, `maxAiShare` and `minDistinctDataPoints` are
   per-family settings.
3. **Conditions are evaluated by a tiny purpose-built parser**, never `eval`. Template conditions are
   operator-editable data, so they must not be able to execute code. Unknown paths evaluate to false.

## The opportunity gate

Twelve sub-scores (demand, intent match, business value, data availability, uniqueness, utility,
competition, traffic potential, conversion potential, quality ceiling, indexation risk, duplication risk)
are weighted into a total, then risks are *subtracted* so a risky page cannot be rescued by strong demand.

Hard rejections happen before the score matters: under 40% data availability, over 70% duplication, or a
total below the viability floor. Approval to build requires clearing the family threshold, 60% data
availability and under 45% duplication risk. Everything else goes to a human, with reasons.

## The quality gate

Eleven checks, weighted: required blocks, data availability, composition policy, differentiation against
siblings, content depth, brand compliance, fact support, AEO answer block, internal links, structured data
and metadata. Any `ERROR`-severity failure produces `REJECT` regardless of score. `PASS` needs the
weighted score to clear the family threshold; anything between is `REVIEW`, which cannot auto-publish in
any approval mode.

## Data model

45 tables covering identity and tenancy, projects and websites, brand knowledge, agents and skills, tasks
and workflows, agent runs and tool invocations, keywords and clusters, opportunities, page families,
templates, components, pages and versions, content items, quality checks, facts and verifications, crawl
results, internal links, schema markup, publish records, approvals, audit logs, integrations and encrypted
credentials, competitors, analytics snapshots, AI prompts/runs/mentions/citations, recommendations, usage
records and flight searches.

The schema avoids provider-specific features (enums, native JSON, arrays) so the same file migrates to
PostgreSQL by changing `provider` and `DATABASE_URL`. Structured values live in `*Json` string columns,
always read through the helpers in `src/core/db/json.ts` so a corrupt row degrades instead of crashing a
page.

## Extension points

- **New agent** — add to `AGENT_DEFINITIONS`, implement `BaseAgent`, register in the factory.
- **New tool** — `registerTool()` with schemas and a required capability.
- **New integration** — add to `INTEGRATION_CATALOG`; the Integrations UI renders from it.
- **New component** — add to `COMPONENT_LIBRARY`; the seed inserts it and templates can use it.
- **New page family** — a row plus a data contract; the Content Strategy Agent builds the template.
- **New data source** — implement `DataSourceAdapter` and register it in the engine.
- **New LLM provider** — implement `LlmProvider`; the router picks it up.
- **New workflow** — a definition object of steps; the engine executes and resumes it.
- **New publishing target** — implement `PublishingAdapter`.

Future modules named in the specification (Revenue Intelligence, Traveler Graph, Executive Brain and the
rest) attach at these points. None of them require changes to the core.
