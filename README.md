# FaresMatch AI OS

An AI-powered **Programmatic SEO, AEO, GEO & AI Visibility Operating System** for travel websites.

This is a working MVP, not a mockup. The Master Orchestrator takes a business objective, decides which
specialist agents are needed, delegates structured tasks to them, gates the result on data availability
and factual support, stops for human approval, publishes a real file, then crawls it back over HTTP and
measures what happened.

---

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

Generate the two required secrets and paste them into `.env`:

```bash
node -e "console.log('APP_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex')); console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

Create the database, generate the client and seed the configuration:

```bash
npm run setup
```

Start the app:

```bash
npm run dev
```

Then open **http://localhost:3000** and sign in:

| Field | Value |
| --- | --- |
| Email | `admin@faresmatch.local` |
| Password | `faresmatch-demo-2026` |

> Change this password before the app is reachable from anything but localhost.

### First run

The seed creates **configuration only** — agents, skills, components, page families, the brand profile,
the competitor set and the AI-visibility prompt library. It deliberately creates **no** keywords, pages or
metrics, so nothing you see in the dashboard is fabricated.

To make the system produce something, go to **Goals & workflows** and submit:

> Create an SEO growth strategy around Delhi to Toronto flights

The run takes about 30–60 seconds, stops at the publish approval gate, and waits for you. Approve it in
**Approvals** and the page is published to `http://localhost:3000/site/flights/del/yyz`.

You can also drive the whole thing from the terminal:

```bash
npm run e2e
```

---

## What it does

```
USER GOAL
   ↓
MASTER ORCHESTRATOR ── plans, decides which agents/stages are needed, where approval is required
   ↓
WEBSITE AUDIT → KEYWORD RESEARCH → SEARCH INTENT → OPPORTUNITY SCORING → PAGE FAMILY / TEMPLATE
   ↓
DYNAMIC DATA → CONTENT GENERATION → FACT VERIFICATION → SEO/AEO/GEO/CFA → INTERNAL LINKING → SCHEMA
   ↓
QUALITY GATE → HUMAN APPROVAL → PUBLISH → SITEMAP
   ↓
TECHNICAL AUDIT → SEARCH MONITORING → AI VISIBILITY → RECOMMENDATIONS
   ↓
back to the MASTER ORCHESTRATOR
```

Thirteen agents, each with an explicit identity, skill set, tool allowlist, capability set, typed
input/output schema, validation rules, confidence threshold, retry policy and full run logging. A Control
Plane sits between every agent and every tool and enforces permissions, budgets and approvals.

---

## The rules this system holds itself to

These are enforced in code and covered by tests, not just documented:

| Rule | Where it is enforced |
| --- | --- |
| A combination existing is never a reason to build a page | `src/engine/pseo/scoring.ts` — data availability under 40% is an outright REJECT |
| Prices, schedules, baggage rules and policies are never invented | `travel.offers` has `allowMockFallback: false`; the Fact Verification Agent marks any time-sensitive claim without a live source `REQUIRES_LIVE_SOURCE`, which blocks publication |
| A component whose required data did not resolve does not render | `src/engine/templates/renderer.ts` — and if it was a required block, the page cannot pass the quality gate |
| Thin or near-duplicate pages do not publish | `src/engine/quality/gate.ts` — differentiation floor, distinct-data-point floor, duplicate-title check |
| Content agents cannot publish | Only `publishing` holds the `publish` capability; the tool layer refuses the call |
| Nothing publishes without a human in MANUAL/SEMI-AUTOMATIC mode | `ControlPlane.decideApproval` + the workflow engine parks the run |
| Mock data is never presented as real | Every mock result carries `isMock`, and the UI renders a `MOCK` badge next to it |
| Credentials never reach the browser or a prompt | AES-256-GCM at rest; resolved only inside the tool execution call stack |
| No hard-coded 70/30 content ratio | Composition is a per-family **policy**, and the renderer measures the page's actual mix against it |
| Published pages never invent imagery, attractions or nav links | `src/engine/templates/component-library.ts` — `hero_photo`, `things_to_do` and the site nav render only from supplied data |
| Structured data always agrees with the links on the page | `rebaseJsonLd` and `applyBasePath` in `src/modules/publishing/page-theme.ts` run the same rule over both |

---

## What is real vs. what is mocked

Everything runs end-to-end with **zero API keys**. Where an external service is missing, a clearly
labelled mock adapter takes over — except where faking would be dishonest, in which case the feature is
simply omitted.

### Real, with no configuration

- The database, migrations and the full data model
- Authentication, sessions, RBAC and tenant isolation
- The Control Plane: permissions, capabilities, budgets, rate limits, approvals, audit log
- The Tool Registry and every permission/validation check around it
- Opportunity scoring, clustering, intent classification, cannibalisation detection
- The template/component engine, condition evaluation and composition accounting
- Fact verification (claim extraction → source matching → verdicts)
- The quality gate and all 11 of its checks
- Internal link proposal and orphan detection
- Structured data generation and validation
- **Publishing** — writes a real, brand-themed HTML file, served at `/site/*`
- **Crawling** — real HTTP fetches with real parsing, respecting robots.txt
- Sitemap and robots.txt generation
- The whole dashboard

### Mocked until you connect a provider (labelled `MOCK` everywhere)

| Capability | Without credentials | Connect |
| --- | --- | --- |
| LLM generation | Deterministic composer that writes only from resolved data | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| Keyword metrics | Synthetic corpus in `data/mock/keywords.json` | DataForSEO |
| Search performance | Synthetic series derived from publish date + cluster volume | Google Search Console |
| AI visibility | Deterministic mock assistant | Anthropic / OpenAI / Perplexity |
| Route & airport reference data | Bundled static dataset (approximate) | Amadeus / Duffel |

### Not mocked at all — omitted instead

**Live flight prices, schedules and seat availability.** There is no mock adapter for them. Without a
credentialed provider the price block does not render, the page says nothing about fares, and the search
panel states plainly that there are no live results.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app on http://localhost:3000 |
| `npm run setup` | Generate the Prisma client, apply migrations, seed configuration |
| `npm run seed` | Re-seed configuration (idempotent) |
| `npm run build` | Production build into `.next` |
| `npm run build:check` | Verification build into `.next-build` — safe to run while `npm run dev` is up |
| `npm test` | Run all 139 tests |
| `npm run e2e` | Drive the full pipeline from the terminal |
| `npm run typecheck` | TypeScript, no emit |
| `npm start` | Serve the production build |
| `npm run db:studio` | Browse the database |
| `npx tsx scripts/reset-run-data.ts` | Clear everything the agents produced, keep configuration |
| `npx tsx scripts/build-routes-dataset.ts` | Regenerate the route reference dataset |
| `npx tsx scripts/build-keywords-dataset.ts` | Regenerate the synthetic keyword corpus |

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, layers, data model, request flow |
| [docs/AGENTS.md](docs/AGENTS.md) | Every agent: role, skills, tools, capabilities, contracts |
| [docs/SKILLS.md](docs/SKILLS.md) | The skill library and how skills compose with brand knowledge |
| [docs/SKILL-MANAGEMENT.md](docs/SKILL-MANAGEMENT.md) | Versioning, activation, rollback, assignment, the sandbox and skill permissions |
| [docs/PUBLISHED-PAGES.md](docs/PUBLISHED-PAGES.md) | What a published page looks like, which blocks need a provider, and link integrity |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Every integration, the exact credentials it needs, and what breaks without it |
| [docs/API.md](docs/API.md) | HTTP API reference |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy and how to run the suites |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Moving from SQLite/localhost to Postgres/cloud |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | What is deliberately deferred, and known limitations |

---

## Project layout

```
prisma/                  Schema + migrations (SQLite locally, Postgres-ready)
data/mock/               Bundled reference datasets (airports, airlines, routes, keywords, competitors)
scripts/                 seed, e2e, dataset builders, reset
src/
  core/                  config, db, errors, logging, security (crypto/auth/rbac), utils
  control-plane/         agent identity, permissions, budgets, approvals, audit
  agents/                13 agents + BaseAgent + catalog + factory
  skills/                Skill library + registry
  tools/                 Tool Registry + tool definitions
  integrations/          Integration catalog + encrypted credential service
  llm/                   Provider abstraction, router, anthropic/openai/mock providers
  engine/
    data/                Dynamic Data Engine + source adapters
    templates/           Component library, expression evaluator, renderer
    content/             Page composer
    pseo/                Opportunity scoring
    quality/             Quality gate
    linking/             Internal link engine
    schema/              JSON-LD generation
    tasks/               Task service
    workflow/            Workflow definitions + engine
  modules/               brand, keywords, analytics, crawler, publishing, ai-visibility
  app/                   Next.js App Router — console UI, API routes, /site, sitemap, robots
  ui/                    Shared UI primitives
tests/                   unit, integration and end-to-end suites
published/               Output of the local_static publishing adapter
```

---

## Security notes

- Passwords: scrypt with a per-user salt and timing-safe comparison.
- Sessions: opaque random tokens; only an HMAC of the token is stored.
- Credentials: AES-256-GCM, decrypted only inside the tool execution path, never returned to the browser.
- Every mutating endpoint checks authentication, RBAC permission and a per-user rate limit.
- Every state change is written to an append-only audit log with its actor.
- The console is `Disallow`ed in robots.txt; only `/site/*` is crawlable.

Before deploying anywhere public: change the demo password, set fresh `APP_ENCRYPTION_KEY` and
`SESSION_SECRET`, set `DEMO_MODE=false`, and move to Postgres. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
