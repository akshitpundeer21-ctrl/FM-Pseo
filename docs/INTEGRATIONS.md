# Integrations

Every external service, the exact credentials it needs, where to put them, and precisely what the system
does without it.

Credentials can be supplied two ways:

1. **Dashboard** → `/integrations`. Encrypted with AES-256-GCM and stored in the database. Preferred.
2. **Environment** → `.env`. Used as a fallback when no encrypted credential exists.

Either way the value is resolved server-side inside the tool execution path only. It is never returned to
the browser, never placed in a prompt, and never written to a log.

---

## Credentials required — summary

| Provider | Credentials | Env fallback | Without it |
| --- | --- | --- | --- |
| Anthropic | `apiKey` | `ANTHROPIC_API_KEY` | Deterministic mock composer, output labelled MOCK |
| OpenAI | `apiKey` | `OPENAI_API_KEY` | Same as above |
| DataForSEO | `login`, `password` | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Synthetic keyword corpus, labelled MOCK |
| Google Search Console | OAuth `clientId` + `clientSecret` + `refreshToken` (or service-account JSON) · setting `siteUrl` | `GOOGLE_OAUTH_*`, `GSC_SITE_URL` | Synthetic performance series, labelled MOCK |
| Google Analytics 4 | `serviceAccountJson` · setting `propertyId` | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GA4_PROPERTY_ID` | Sessions/conversions come from the mock series |
| Amadeus | `clientId`, `clientSecret` | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET` | **No live prices at all.** The price block is omitted |
| Duffel | `apiKey` | `DUFFEL_API_KEY` | Same as Amadeus |
| WordPress | `username`, `applicationPassword` · setting `baseUrl` | `WORDPRESS_*` | Publishing falls back to `local_static` and says so |
| Generic CMS webhook | `secret` (optional) · setting `url` | `PUBLISH_WEBHOOK_URL`, `PUBLISH_WEBHOOK_SECRET` | Same fallback |
| Perplexity | `apiKey` | `PERPLEXITY_API_KEY` | AI visibility runs against the mock assistant |
| Built-in crawler | none | — | Always available |

---

## Language models

**What it powers** — prose in AI slots, FAQ answers, meta descriptions, plan narration, and (optionally)
answer-engine probing.

**Without a key** the router selects `MockLlmProvider`. This is *not* a model imitation: it is a
deterministic composer that assembles copy from the structured variables the caller already resolved. It
cannot invent a price because it is never handed one, and it writes a sentence only when the datum for it
exists. Everything it produces is flagged `isMock` and the UI badges it.

**Model tiers** are configurable:

```
LLM_MODEL_FAST=claude-haiku-4-5-20251001
LLM_MODEL_BALANCED=claude-sonnet-5
LLM_MODEL_DEEP=claude-opus-5
```

The router chooses a tier from the agent's configured tier and the task's complexity, then maps it to the
concrete model for whichever provider is configured. If a configured provider errors mid-run and
`DEMO_MODE=true`, it degrades to the mock composer and logs the degradation rather than dropping the
workflow.

---

## Keyword data — DataForSEO

**What it powers** — volume, difficulty and CPC in the Keyword Research Agent.

**Without it** the `MockKeywordProvider` serves `data/mock/keywords.json`: 488 rows generated
deterministically from route demand indices and query-template shares. These are **synthetic values that
exist so scoring and clustering can be exercised**, not measurements. Every row carries `isMock: true`,
the Keywords page shows a banner, and each row is badged.

Regenerate the corpus with `npx tsx scripts/build-keywords-dataset.ts`.

---

## Google Search Console

**What it powers** — clicks, impressions, CTR and position per query or page; the feedback loop that turns
movement into recommendations.

**Setup** — create OAuth credentials, obtain a refresh token for an account with access to the property,
then set `clientId`, `clientSecret`, `refreshToken` and the `siteUrl` setting. The service-account path is
recognised but the JWT signing step is deliberately not implemented; the provider raises
`IntegrationNotConfiguredError` rather than pretending.

**Without it** `MockSearchPerformanceProvider` generates a deterministic series from each page's publish
date and its cluster volume, with a realistic ramp, weekly seasonality and a position→CTR curve. Every row
is `isMock`. A page published today genuinely has no history, which is why the dashboard offers an
explicitly-labelled "simulate history" action rather than quietly backdating.

---

## Travel data — Amadeus / Duffel

**What it powers** — live priced flight offers for the `flight_options` component and the flight search
panel.

**This is the one capability with no mock adapter, by design.** `travel.offers` sets
`allowMockFallback: false`. Without credentials:

- the tool fails loudly and the Content Generation Agent logs it,
- the `flight_options` block does not render and records why,
- the page says nothing about fares,
- the search panel states that no live provider is connected,
- and the Fact Verification Agent would block any price-shaped string that somehow appeared.

Route, airport and airline **reference** attributes (distance, typical duration, stops, carriers,
terminals) come from `data/mock/*.json` — approximate reference data, clearly labelled, with the
estimation method recorded on the datum itself and shown in the page's evidence block.

---

## Publishing

Three adapters, all real:

**`local_static`** (default) writes a complete HTML document — title, meta description, canonical, Open
Graph, JSON-LD, styles — to `PUBLISH_LOCAL_DIR`, plus a JSON sidecar for diffing and rollback. The app
serves it at `/site/*`, so the Technical SEO Agent can fetch the published page back over real HTTP. This
is what makes the publish → verify loop genuine with no CMS.

**`webhook`** POSTs the payload to your endpoint with an optional HMAC-SHA256 signature in
`x-faresmatch-signature`.

**`wordpress`** creates pages through the WP REST API using an application password.

If a requested adapter is not configured, publishing falls back to `local_static` **and records the
fallback** on the publish record. The Publishing page shows a banner listing every fallback that occurred.

---

## Answer engines — AI visibility

**Platforms** are chosen by `AI_VISIBILITY_PLATFORMS` (comma-separated: `anthropic,openai,perplexity,mock`).

- `anthropic` / `openai` — real completions through the router; requires that provider's key.
- `perplexity` — a real answer-engine call that also returns its own citation list.
- `mock` — the deterministic mock assistant, so the module is demonstrable offline.

Mention and citation extraction is deterministic string matching, not a model call, so measurement is
reproducible and auditable. Mock runs are flagged and never blended into a headline metric with real ones.

---

## Built-in crawler

No credentials. Real `fetch`, real parsing, `robots.txt` respected, configurable concurrency, page cap and
timeout:

```
CRAWLER_USER_AGENT=FaresMatchAIOS/0.1 (+https://faresmatch.local/bot)
CRAWLER_MAX_PAGES=200
CRAWLER_CONCURRENCY=4
CRAWLER_TIMEOUT_MS=15000
```

The `Crawler` interface exists so a hosted crawling service can replace it without touching the agent.

---

## DEMO_MODE

```
DEMO_MODE=true    # missing integration → labelled mock adapter (default)
DEMO_MODE=false   # missing integration → the tool fails loudly
```

`DEMO_MODE=false` is the right setting for production. It does not change what live pricing does — that
has no mock in either mode.

---

## Adding a provider

Add an entry to `INTEGRATION_CATALOG` in `src/integrations/catalog.ts`:

```ts
{
  provider: "my_provider",
  name: "My Provider",
  category: "KEYWORD_DATA",
  description: "What it does.",
  credentials: [{ key: "apiKey", label: "API key", envVar: "MY_PROVIDER_KEY" }],
  settings: [{ key: "accountId", label: "Account id" }],
  hasMock: true,
  degradesTo: "Exactly what happens without it.",
}
```

The Integrations dashboard renders from the catalog, so no UI change is needed. Then implement the
provider behind the relevant interface and select it in the tool when `ctx.credentials.configured` is
true.
