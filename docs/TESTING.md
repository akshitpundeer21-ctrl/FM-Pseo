# Testing

```bash
npm test                                  # all 93 tests
npx vitest run tests/unit.test.ts          # pure logic (50)
npx vitest run tests/integration.test.ts   # database + control plane + tools (28)
npx vitest run tests/e2e-workflow.test.ts  # full pipeline (15)
npx vitest                                 # watch mode
```

## How the test database works

`tests/global-setup.ts` deletes `prisma/test.db`, applies the schema with `prisma db push`, and runs the
real seed script. `tests/setup.ts` then points each worker at that file and forces `LOG_SILENT`,
`DEMO_MODE=true` and a separate publish directory (`published-test/`).

Tests therefore run against the real schema and the real seed. The development database is never touched.

## What each suite covers

### Unit — `tests/unit.test.ts`

The rules that decide whether a page gets built and published:

- **Opportunity scoring** — approves a well-supported candidate; rejects one whose data does not resolve
  *however strong the demand*; rejects a near-duplicate; sends mid-strength candidates to review
- **URL patterns** — expansion, slugification, and refusing to build with a missing variable
- **Expressions** — truthiness, comparisons, boolean logic, unresolved paths as false, and that
  `process.exit(1)` and constructor-chain escapes do nothing
- **Intent + clustering** — deterministic classification, entity-first grouping, cannibalisation on
  singular/plural variants
- **Composition** — measured mix, hybrid-block splitting, policy breach detection
- **Brand compliance** — banned phrases, unsupportable superlatives, price-shaped values
- **Crypto** — encrypt/decrypt round trip, tamper detection, hints that are not the secret, password
  verification
- **RBAC** — publishing stays away from editors and viewers
- **Linking** — links pages sharing an endpoint, skips unrelated and unpublished pages, finds orphans
- **Answer-engine extraction** — mentions with position and context, citations, owned-domain detection
  with a port
- **Claim extraction** — quantitative claims mapped to predicates, time-sensitive classification, not
  mistaking `850 km/h` for a distance
- **Objective interpretation** — classification, entity parsing, and reporting what it could not resolve
- **Structured data** — FAQPage only with a rendered FAQ block, required-property validation
- **Quality gate** — passes a complete page; rejects unsupported claims, time-sensitive claims without a
  live source, near-duplicates, missing required blocks, invalid schema and duplicate titles

### Integration — `tests/integration.test.ts`

Real database, real Control Plane, real tools:

- Seed creates the full catalog and **no fabricated results**
- Login, session resolution, wrong-password rejection, weak-password rejection
- **An agent cannot use a tool it was not granted** — asserted at the policy layer *and* at the execution
  layer
- **Only `publishing` holds the `publish` capability** — asserted across the whole agent table
- Approval policy per mode; low-confidence escalation
- Budget ledger and rate limiting
- Credential encryption, server-side resolution, and that the dashboard view never contains the value
- Dynamic Data Engine provenance, and its refusal to serve live offers from a mock source
- Tool input validation, invocation recording, mock fallback flagging
- `travel.offers` failing loudly rather than fabricating
- Task lifecycle transitions
- Agent execution recording a full `AgentRun`; schema rejection; failure recording

### End-to-end — `tests/e2e-workflow.test.ts`

The whole pipeline, exactly as the spec describes it:

1. Orchestrator interprets the objective, resolves DEL→YYZ, plans, and **delegates nothing to itself**
2. The workflow runs research → opportunity → strategy → generation → verification → optimization →
   linking → quality, and **stops at the approval gate**
3. **Publishing is refused while the approval is pending**
4. After approval the workflow resumes and writes a **real HTML file** containing the real content,
   canonical and JSON-LD
5. Structured data is valid and matches the page
6. Composition is recorded and within policy
7. Every fact is attributed
8. **The price block is omitted and no currency figure appears anywhere in the copy**
9. Publishing is audited
10. Rollback unpublishes when there is no earlier version, and audits it
11. Generation from a REJECTED opportunity is refused
12. AI visibility records mentions and citations with platform/model/timestamp
13. Search performance reports honestly when a page has no history, and only produces a simulated series
    when explicitly asked

## Terminal walkthrough

`npm run e2e` runs the same pipeline against the development database with readable output: the plan, the
step-by-step progress, the approval pause, the resume, and a summary of every agent run with latency,
confidence and cost.

## Adding tests

Unit tests import from `@/…` and need no database. Anything touching Prisma belongs in the integration or
e2e suite; the shared database means those run in a single fork (`poolOptions.forks.singleFork`), so
ordering within a file is significant — clean up what you create.
