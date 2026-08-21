# Published pages

What the system actually puts on the web, and the rules that decide what appears on it.

The published page is a different artefact from the console. The console is an operator tool; the page is
the product. It carries the FaresMatch brand — Plus Jakarta Sans, the blue/green token palette, a 1000px
content column, card grids, chip rows and section rules — defined once in
[`src/modules/publishing/page-theme.ts`](../src/modules/publishing/page-theme.ts) and shared by every
component.

---

## Where the pieces live

| Concern | File |
| --- | --- |
| Visual system, site chrome, markup helpers | `src/modules/publishing/page-theme.ts` |
| Block markup and data rules | `src/engine/templates/component-library.ts` |
| Which blocks, in what order, and what is required | `ROUTE_TEMPLATE_BLOCKS` in the same file |
| Assembly + composition accounting | `src/engine/templates/renderer.ts` |
| Document shell, `<head>`, structured data, link rebasing | `src/modules/publishing/adapters.ts` |

Changing the look is a change to `page-theme.ts`. Changing what a page *says* is a change to a component
or to the data that feeds it. The two do not mix.

---

## Layout

`ROUTE_TEMPLATE_BLOCKS` is the canonical order:

```
breadcrumb → search dock → H1 + lede → hero image → lowest-fare panel → direct answer →
route at a glance → about this route → fare options → price by week → airlines →
airport guide → things to do → before you book → common questions → how this route compares →
related routes → explore related pages → sources → about this page → CTA
```

Only five blocks are **required**: `hero`, `answer_block`, `route_summary`, `route_overview`, `faq` and
`source_evidence`. Every other block renders when its data resolves and is skipped — with a recorded
reason — when it does not. A page with no fare provider is a shorter page, not a broken one and not a
fabricated one.

`ROUTE_TEMPLATE_VERSION` is part of the template key (`route_v2`). Bumping it builds a **new** template
rather than mutating the one existing pages were generated from.

---

## Blocks that need a provider

These are the reference layout's most eye-catching elements, and every one of them is gated:

| Block | Requires | Without it |
| --- | --- | --- |
| `fare_hero` | `offers.cheapestPrice` | Not rendered. The page states no fare at all. |
| `flight_options` | `offers.items` | Not rendered. |
| `price_by_week` | `offers.weeklySeries` (≥2 real points) | Not rendered. It is a chart of observed fares, never a forecast. |
| `things_to_do` | `destination.attractions` | Not rendered. Destinations are not described from memory. |
| `hero_photo` | `destination.imageUrl` | Falls back to a branded gradient band. No stock photo is invented or hot-linked. |
| `cta` / `search_box` | `SITE_SEARCH_URL` | The CTA is skipped and the dock renders as a static summary panel — no form, no button, no link to a page that does not exist. |

In the demo none of these providers is connected, so the published page carries **no currency figure
anywhere**. That is the system working, not a gap in it. Connect Amadeus or Duffel in **Integrations** and
the fare panel, the options grid and the price chart begin rendering on the next generation run.

Skipped blocks are not silent: each one records its reason on the `ContentItem` row, and the reason is
visible on the page-version detail screen.

---

## Link integrity

Components emit canonical site-relative URLs (`/flights/del/yvr`). The **adapter** knows where the site is
actually served and rebases them at publish time:

- `LocalStaticAdapter` serves under `/site`, so `applyBasePath` rewrites `href`/`action` attributes.
- `rebaseJsonLd` applies the identical rule to structured data, so the schema and the visible links can
  never disagree — a mismatch is a real SEO defect, not a cosmetic one.
- A CMS that serves at the root sets no base path and both functions are no-ops.

Both are covered by `tests/published-page.test.ts`.

### Site navigation

There is no default nav. The header renders the logo alone unless `SITE_NAV_JSON` supplies links:

```
SITE_NAV_JSON=[{"label":"Flights","href":"/flights"},{"label":"Hotels","href":"/hotels"}]
```

An earlier version shipped a hard-coded Flights/Hotels/Deals nav copied from the reference design. It
published three dead links on every page, which the Technical SEO Agent then correctly reported as 404
errors. Inventing nav is the same failure as inventing a fare.

---

## Provenance on the page itself

Two elements make the page auditable by a reader rather than only by an operator:

- **The data note.** When any block on the version rests on reference rather than live data, the
  Publishing Agent sets a banner saying so, above the header.
- **The sources block.** One row per attributed claim: the claim, the source name, the retrieval date, and
  a `reference data, not live` tag where it applies. It is generated from the same `DataPoint` provenance
  the fact-verification gate uses, so it cannot drift from what was actually checked.

---

## Titles

`buildTitle` in `src/engine/content/composer.ts` is the single rule, shared with the SEO Optimization
Agent so the composed title and the optimised title cannot diverge. It tries, in order:

```
Cheap Flights from {Origin} to {Destination} | {Brand}
Cheap Flights from {Origin} to {Destination}
{Origin} to {Destination} Flights | {Brand}
{Origin} to {Destination} Flights
```

and takes the first that fits the brand's `titleMaxChars`. The brand suffix is dropped before the route
is truncated.

---

## Known gaps

- **Hub pages do not exist yet.** Breadcrumbs and related-route chips point at `/flights`,
  `/flights/del`, `/airports/del`, `/destinations/yyz` and sibling routes. In a one-page demo those are
  404s, and the post-publish crawl reports them as errors. They are the Internal Linking Agent's plan for
  the site, not accidental links — build those pages and the errors clear. The crawl reporting them is
  the feedback loop doing its job.
- **No photography source is wired.** `hero_photo` and the image slot on `things_to_do` accept a URL and
  a credit line; nothing populates them yet.
- **The reference design's fare-history chart** is implemented (`lineChart`, dependency-free inline SVG)
  but has never rendered with real data, because no provider sweep exists to produce
  `offers.weeklySeries`.
