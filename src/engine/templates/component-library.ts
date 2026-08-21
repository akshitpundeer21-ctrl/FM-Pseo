/**
 * Reusable component library.
 *
 * Each component is independently configurable and declares:
 *   - requiredBindings: data paths without which it must not render
 *   - optionalBindings: paths that enrich it when present
 *   - aiSlots: named generation tasks the composer fills
 *   - contentSource: how its output is accounted for in the composition ratio
 *
 * A component is a pure function of (props, resolved data, generated slots) ->
 * HTML + plain text. It never fetches anything itself, which is what keeps
 * presentation separate from the Dynamic Data Engine.
 *
 * Updating a component's version propagates to pages generated afterwards when
 * the template has `propagateUpdates` enabled.
 */
import { escapeHtml } from "@/core/utils/text";
import { lookup } from "@/engine/data/types";
import type { ContentSource } from "@/core/types/enums";

export interface AiSlot {
  name: string;
  /** Task key passed to the LLM router (and to the deterministic mock writer). */
  task: string;
  instruction: string;
  maxTokens?: number;
  complexity?: number;
  /** Slot is skipped rather than blocking when its data is absent. */
  optional?: boolean;
}

export interface RenderInput {
  props: Record<string, unknown>;
  values: Record<string, unknown>;
  /** Filled AI slots, keyed by slot name. */
  slots: Record<string, string>;
  /** Page-level context (url, brand name, related pages...). */
  page: {
    url: string;
    brandName: string;
    relatedRoutes?: { url: string; label: string; note?: string }[];
    relatedAirports?: { url: string; label: string }[];
    relatedDestinations?: { url: string; label: string }[];
    breadcrumbs?: { url: string; label: string }[];
    faqs?: { question: string; answer: string }[];
    evidence?: { claim: string; source: string; retrievedAt: string; isMock: boolean }[];
    lastUpdated?: string;
  };
}

export interface RenderOutput {
  html: string;
  text: string;
  /** Data paths actually used, for provenance + composition accounting. */
  usedPaths: string[];
  /** Set when the component decided not to render. */
  skippedReason?: string;
}

export interface ComponentDefinition {
  key: string;
  name: string;
  category: string;
  description: string;
  version: number;
  contentSource: ContentSource;
  requiredBindings: string[];
  optionalBindings: string[];
  aiSlots: AiSlot[];
  defaults: Record<string, unknown>;
  /** Extra validation beyond required bindings. */
  validate?: (input: RenderInput) => string[];
  render: (input: RenderInput) => RenderOutput;
}

// --- helpers ---------------------------------------------------------------

const S = (v: unknown, fallback = ""): string => (v === undefined || v === null ? fallback : String(v));
const N = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function humanDuration(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function section(id: string, heading: string | null, body: string): string {
  return `      <section id="${id}">\n${heading ? `        <h2>${escapeHtml(heading)}</h2>\n` : ""}${body}\n      </section>`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `        <p>${escapeHtml(p.trim())}</p>`)
    .join("\n");
}

function bullets(items: string[]): string {
  return `        <ul>\n${items.map((i) => `          <li>${escapeHtml(i)}</li>`).join("\n")}\n        </ul>`;
}

function table(rows: { label: string; value: string; note?: string }[]): string {
  const body = rows
    .map(
      (r) =>
        `            <tr><th scope="row">${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}${
          r.note ? ` <span class="fm-meta">${escapeHtml(r.note)}</span>` : ""
        }</td></tr>`,
    )
    .join("\n");
  return `        <table>\n          <tbody>\n${body}\n          </tbody>\n        </table>`;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// --- components ------------------------------------------------------------

const hero: ComponentDefinition = {
  key: "hero",
  name: "Hero",
  category: "LAYOUT",
  description: "Page H1, one-line positioning and the primary CTA.",
  version: 1,
  contentSource: "HYBRID",
  requiredBindings: ["origin.city", "destination.city"],
  optionalBindings: ["route.typicalDurationMinutes", "route.nonstopAvailable"],
  aiSlots: [],
  defaults: { ctaLabel: "Search live fares", ctaHref: "/search" },
  render({ values, props, page }) {
    const o = S(lookup(values, "origin.city"));
    const d = S(lookup(values, "destination.city"));
    const dur = humanDuration(N(lookup(values, "route.typicalDurationMinutes")));
    const nonstop = lookup(values, "route.nonstopAvailable") === true;

    const subtitleParts = [
      nonstop ? "Non-stop options available" : "Usually flown with one stop",
      dur ? `around ${dur} total travel time` : null,
    ].filter(Boolean);

    const html = `      <header class="fm-hero">
        <h1>${escapeHtml(`${o} to ${d} flights`)}</h1>
        <p class="fm-lede">${escapeHtml(subtitleParts.join(" · "))}</p>
        <a class="fm-cta" href="${escapeHtml(S(props.ctaHref, "/search"))}?from=${escapeHtml(S(lookup(values, "route.origin")))}&to=${escapeHtml(S(lookup(values, "route.destination")))}">${escapeHtml(S(props.ctaLabel, "Search live fares"))}</a>
      </header>`;

    return {
      html,
      text: `${o} to ${d} flights. ${subtitleParts.join(", ")}.`,
      usedPaths: ["origin.city", "destination.city", "route.typicalDurationMinutes", "route.nonstopAvailable"],
    };
  },
};

const searchBox: ComponentDefinition = {
  key: "search_box",
  name: "Flight search box",
  category: "INTERACTIVE",
  description: "Pre-filled flight search form linking the SEO page to the search experience.",
  version: 1,
  contentSource: "TEMPLATE",
  requiredBindings: ["route.origin", "route.destination"],
  optionalBindings: [],
  aiSlots: [],
  defaults: { cabins: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS"] },
  render({ values, props }) {
    const o = S(lookup(values, "route.origin"));
    const d = S(lookup(values, "route.destination"));
    const cabins = (props.cabins as string[]) ?? ["ECONOMY"];
    const html = `      <section id="search" class="fm-search">
        <form method="get" action="/search">
          <input type="hidden" name="from" value="${escapeHtml(o)}" />
          <input type="hidden" name="to" value="${escapeHtml(d)}" />
          <fieldset>
            <legend>Search ${escapeHtml(o)} → ${escapeHtml(d)}</legend>
            <label>Departure <input type="date" name="depart" /></label>
            <label>Return <input type="date" name="return" /></label>
            <label>Passengers <input type="number" name="passengers" min="1" max="9" value="1" /></label>
            <label>Cabin
              <select name="cabin">${cabins.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c.replace(/_/g, " ").toLowerCase())}</option>`).join("")}</select>
            </label>
            <button type="submit">Search flights</button>
          </fieldset>
        </form>
      </section>`;
    return { html, text: `Flight search: ${o} to ${d}.`, usedPaths: ["route.origin", "route.destination"] };
  },
};

const routeSummary: ComponentDefinition = {
  key: "route_summary",
  name: "Route summary table",
  category: "DATA",
  description: "Key route facts as an extractable table (CFA-friendly), with sources.",
  version: 1,
  contentSource: "DYNAMIC",
  requiredBindings: ["origin.airportName", "destination.airportName"],
  optionalBindings: ["route.distanceKm", "route.typicalDurationMinutes", "route.typicalStops", "route.airlines"],
  aiSlots: [],
  defaults: { heading: "Route at a glance" },
  render({ values, props }) {
    const rows: { label: string; value: string; note?: string }[] = [];
    const used: string[] = [];

    const oName = S(lookup(values, "origin.airportName"));
    const oIata = S(lookup(values, "origin.iata"));
    const dName = S(lookup(values, "destination.airportName"));
    const dIata = S(lookup(values, "destination.iata"));

    if (oName) {
      rows.push({ label: "Departs from", value: oIata ? `${oName} (${oIata})` : oName });
      used.push("origin.airportName", "origin.iata");
    }
    if (dName) {
      rows.push({ label: "Arrives at", value: dIata ? `${dName} (${dIata})` : dName });
      used.push("destination.airportName", "destination.iata");
    }

    const dist = N(lookup(values, "route.distanceKm"));
    if (dist) {
      rows.push({ label: "Distance", value: `${dist.toLocaleString("en-US")} km`, note: "great-circle" });
      used.push("route.distanceKm");
    }

    const dur = humanDuration(N(lookup(values, "route.typicalDurationMinutes")));
    if (dur) {
      rows.push({ label: "Typical total travel time", value: dur, note: "estimated, not a schedule" });
      used.push("route.typicalDurationMinutes");
    }

    const stops = N(lookup(values, "route.typicalStops"));
    if (stops !== null) {
      rows.push({ label: "Typical stops", value: stops === 0 ? "Non-stop available" : `${stops} stop${stops === 1 ? "" : "s"}` });
      used.push("route.typicalStops");
    }

    const airlines = lookup(values, "route.airlines");
    if (Array.isArray(airlines) && airlines.length) {
      rows.push({ label: "Carriers seen on this route", value: airlines.map((a: any) => a.name ?? a).join(", ") });
      used.push("route.airlines");
    }

    if (!rows.length) return { html: "", text: "", usedPaths: [], skippedReason: "No route data resolved" };

    return {
      html: section("route-summary", S(props.heading, "Route at a glance"), table(rows)),
      text: rows.map((r) => `${r.label}: ${r.value}`).join(". "),
      usedPaths: used,
    };
  },
};

const routeOverview: ComponentDefinition = {
  key: "route_overview",
  name: "Route overview",
  category: "CONTENT",
  description: "Generated prose that explains the route using only resolved data.",
  version: 1,
  contentSource: "AI",
  requiredBindings: ["origin.city", "destination.city"],
  optionalBindings: ["route.typicalDurationMinutes", "route.airlines", "route.distanceKm"],
  aiSlots: [
    {
      name: "overview",
      task: "route_overview",
      instruction:
        "Write 4-6 sentences introducing this route for someone comparing options. Use only the facts in the data context. Do not state prices, schedules or policies.",
      maxTokens: 420,
      complexity: 0.5,
    },
  ],
  defaults: { heading: "About this route" },
  render({ slots, props, values }) {
    const text = slots.overview?.trim();
    if (!text) return { html: "", text: "", usedPaths: [], skippedReason: "Overview slot was not generated" };
    return {
      html: section("overview", S(props.heading, "About this route"), paragraphs(text)),
      text,
      usedPaths: ["origin.city", "destination.city", "route.typicalDurationMinutes", "route.airlines"],
    };
  },
};

const answerBlock: ComponentDefinition = {
  key: "answer_block",
  name: "Direct answer block",
  category: "AEO",
  description: "A standalone 35-70 word answer placed high on the page for answer engines.",
  version: 1,
  contentSource: "AI",
  requiredBindings: ["origin.city", "destination.city"],
  optionalBindings: ["route.typicalDurationMinutes", "route.typicalStops", "route.airlines"],
  aiSlots: [
    {
      name: "answer",
      task: "answer_block",
      instruction:
        "Write one self-contained answer of 35-70 words that would still make sense if lifted out of the page entirely. Facts only, no hedging, no price claims.",
      maxTokens: 200,
      complexity: 0.4,
    },
  ],
  defaults: {},
  render({ slots }) {
    const text = slots.answer?.trim();
    if (!text) return { html: "", text: "", usedPaths: [], skippedReason: "Answer slot was not generated" };
    return {
      html: `      <section id="answer" class="fm-answer">\n        <p><strong>${escapeHtml(text)}</strong></p>\n      </section>`,
      text,
      usedPaths: ["route.typicalDurationMinutes", "route.typicalStops", "route.airlines"],
    };
  },
};

const flightOptions: ComponentDefinition = {
  key: "flight_options",
  name: "Flight options",
  category: "DATA",
  description: "Live priced offers. Renders only when a credentialed live pricing source returned data.",
  version: 1,
  contentSource: "DYNAMIC",
  requiredBindings: ["offers.items"],
  optionalBindings: ["offers.cheapestPrice", "offers.cheapestCarrier"],
  aiSlots: [],
  defaults: { heading: "Current flight options", limit: 5 },
  render({ values, props }) {
    const items = lookup(values, "offers.items");
    if (!Array.isArray(items) || !items.length) {
      return {
        html: "",
        text: "",
        usedPaths: [],
        skippedReason: "No live pricing source is connected, so no prices are shown. Connect Amadeus or Duffel to enable this block.",
      };
    }
    const limit = N(props.limit) ?? 5;
    const rows = items.slice(0, limit).map((o: any) => ({
      label: `${o.carrier ?? "Carrier"} · ${o.stops === 0 ? "non-stop" : `${o.stops} stop${o.stops === 1 ? "" : "s"}`}`,
      value: `${o.priceTotal} ${o.currency ?? ""}`.trim(),
      note: o.duration ?? undefined,
    }));
    return {
      html: section("flight-options", S(props.heading, "Current flight options"), table(rows)),
      text: rows.map((r) => `${r.label}: ${r.value}`).join(". "),
      usedPaths: ["offers.items"],
    };
  },
};

const airlineCards: ComponentDefinition = {
  key: "airline_cards",
  name: "Airlines on this route",
  category: "DATA",
  description: "One card per carrier with alliance and hub, plus generated context.",
  version: 1,
  contentSource: "HYBRID",
  requiredBindings: ["route.airlines"],
  optionalBindings: [],
  aiSlots: [
    {
      name: "context",
      task: "airline_context",
      instruction: "Two sentences on what differs between carriers on this route. No policy or baggage specifics.",
      maxTokens: 200,
      complexity: 0.35,
      optional: true,
    },
  ],
  defaults: { heading: "Airlines flying this route" },
  render({ values, slots, props }) {
    const airlines = lookup(values, "route.airlines");
    if (!Array.isArray(airlines) || !airlines.length) {
      return { html: "", text: "", usedPaths: [], skippedReason: "No carrier data resolved" };
    }
    const cards = airlines
      .map((a: any) => {
        const bits = [a.alliance && a.alliance !== "None" ? a.alliance : null].filter(Boolean);
        return `          <li><strong>${escapeHtml(a.name ?? String(a))}</strong>${
          a.iata ? ` <span class="fm-meta">(${escapeHtml(a.iata)})</span>` : ""
        }${bits.length ? ` — ${escapeHtml(bits.join(", "))}` : ""}</li>`;
      })
      .join("\n");

    const context = slots.context?.trim();
    const body = `        <ul>\n${cards}\n        </ul>${context ? `\n${paragraphs(context)}` : ""}`;
    return {
      html: section("airlines", S(props.heading, "Airlines flying this route"), body),
      text: `${airlines.map((a: any) => a.name ?? a).join(", ")}. ${context ?? ""}`.trim(),
      usedPaths: ["route.airlines"],
    };
  },
};

const airportCards: ComponentDefinition = {
  key: "airport_cards",
  name: "Airport information",
  category: "DATA",
  description: "Origin and destination airport details with generated practical context.",
  version: 1,
  contentSource: "HYBRID",
  requiredBindings: ["origin.airportName", "destination.airportName"],
  optionalBindings: ["origin.terminals", "destination.terminals", "origin.timezone", "destination.timezone"],
  aiSlots: [
    {
      name: "originContext",
      task: "airport_context",
      instruction: "Two practical sentences about departing from this airport.",
      maxTokens: 180,
      complexity: 0.3,
      optional: true,
    },
    {
      name: "destinationContext",
      task: "airport_context",
      instruction: "Two practical sentences about arriving at this airport.",
      maxTokens: 180,
      complexity: 0.3,
      optional: true,
    },
  ],
  defaults: { heading: "Airport information" },
  render({ values, slots, props }) {
    const blocks: string[] = [];
    const used: string[] = [];

    for (const [prefix, slotKey, label] of [
      ["origin", "originContext", "Departure airport"],
      ["destination", "destinationContext", "Arrival airport"],
    ] as const) {
      const name = S(lookup(values, `${prefix}.airportName`));
      if (!name) continue;
      const iata = S(lookup(values, `${prefix}.iata`));
      const city = S(lookup(values, `${prefix}.city`));
      const terminals = N(lookup(values, `${prefix}.terminals`));
      const tz = S(lookup(values, `${prefix}.timezone`));
      used.push(`${prefix}.airportName`, `${prefix}.iata`, `${prefix}.city`);

      const facts = [
        city ? `Serves ${city}` : null,
        terminals ? `${terminals} passenger terminal${terminals === 1 ? "" : "s"}` : null,
        tz ? `Timezone ${tz}` : null,
      ].filter(Boolean) as string[];

      const ctx = slots[slotKey]?.trim();
      blocks.push(
        `        <h3>${escapeHtml(label)}: ${escapeHtml(iata ? `${name} (${iata})` : name)}</h3>\n${bullets(facts)}${
          ctx ? `\n${paragraphs(ctx)}` : ""
        }`,
      );
    }

    if (!blocks.length) return { html: "", text: "", usedPaths: [], skippedReason: "No airport data resolved" };
    return {
      html: section("airports", S(props.heading, "Airport information"), blocks.join("\n")),
      text: stripTags(blocks.join(" ")),
      usedPaths: used,
    };
  },
};

const travelTips: ComponentDefinition = {
  key: "travel_tips",
  name: "Travel tips",
  category: "CONTENT",
  description: "Route-specific practical advice, generated from resolved route characteristics.",
  version: 1,
  contentSource: "AI",
  requiredBindings: ["origin.city", "destination.city"],
  optionalBindings: ["route.typicalStops"],
  aiSlots: [
    {
      name: "tips",
      task: "route_travel_tips",
      instruction: "Three to four practical tips specific to this route. No prices, no policies, no visa rules.",
      maxTokens: 380,
      complexity: 0.45,
    },
  ],
  defaults: { heading: "Before you book" },
  render({ slots, props }) {
    const text = slots.tips?.trim();
    if (!text) return { html: "", text: "", usedPaths: [], skippedReason: "Tips slot was not generated" };
    return { html: section("tips", S(props.heading, "Before you book"), paragraphs(text)), text, usedPaths: ["route.typicalStops"] };
  },
};

const faq: ComponentDefinition = {
  key: "faq",
  name: "FAQ",
  category: "AEO",
  description: "Question-form headings with standalone answers; emits FAQPage schema.",
  version: 1,
  contentSource: "AI",
  requiredBindings: [],
  optionalBindings: [],
  aiSlots: [],
  defaults: { heading: "Frequently asked questions" },
  render({ page, props }) {
    const faqs = page.faqs ?? [];
    if (!faqs.length) return { html: "", text: "", usedPaths: [], skippedReason: "No FAQ entries were produced" };
    const body = `        <dl class="fm-faq">\n${faqs
      .map((f) => `          <dt>${escapeHtml(f.question)}</dt>\n          <dd>${escapeHtml(f.answer)}</dd>`)
      .join("\n")}\n        </dl>`;
    return {
      html: section("faq", S(props.heading, "Frequently asked questions"), body),
      text: faqs.map((f) => `${f.question} ${f.answer}`).join(" "),
      usedPaths: [],
    };
  },
};

const comparisonTable: ComponentDefinition = {
  key: "comparison_table",
  name: "Comparison table",
  category: "DATA",
  description: "Compares this route against sibling routes from the same origin.",
  version: 1,
  contentSource: "DYNAMIC",
  requiredBindings: [],
  optionalBindings: [],
  aiSlots: [],
  defaults: { heading: "How this route compares" },
  render({ page, props }) {
    const related = page.relatedRoutes ?? [];
    if (related.length < 2) return { html: "", text: "", usedPaths: [], skippedReason: "Not enough sibling routes to compare" };
    const rows = related.slice(0, 6).map((r) => ({ label: r.label, value: r.note ?? "" }));
    return {
      html: section("comparison", S(props.heading, "How this route compares"), table(rows)),
      text: rows.map((r) => `${r.label} ${r.value}`).join(". "),
      usedPaths: [],
    };
  },
};

const relatedRoutes: ComponentDefinition = {
  key: "related_routes",
  name: "Related routes",
  category: "LINKING",
  description: "Semantically related route pages, supplied by the Internal Linking Agent.",
  version: 1,
  contentSource: "TEMPLATE",
  requiredBindings: [],
  optionalBindings: [],
  aiSlots: [],
  defaults: { heading: "Related routes" },
  render({ page, props }) {
    const items = page.relatedRoutes ?? [];
    if (!items.length) return { html: "", text: "", usedPaths: [], skippedReason: "No related routes proposed" };
    const body = `        <ul>\n${items
      .map((r) => `          <li><a href="${escapeHtml(r.url)}">${escapeHtml(r.label)}</a></li>`)
      .join("\n")}\n        </ul>`;
    return { html: section("related-routes", S(props.heading, "Related routes"), body), text: items.map((i) => i.label).join(", "), usedPaths: [] };
  },
};

const relatedDestinations: ComponentDefinition = {
  key: "related_destinations",
  name: "Related destinations",
  category: "LINKING",
  description: "Destination and airport pages related to this page's entities.",
  version: 1,
  contentSource: "TEMPLATE",
  requiredBindings: [],
  optionalBindings: [],
  aiSlots: [],
  defaults: { heading: "Explore related pages" },
  render({ page, props }) {
    const items = [...(page.relatedAirports ?? []), ...(page.relatedDestinations ?? [])];
    if (!items.length) return { html: "", text: "", usedPaths: [], skippedReason: "No related destination pages proposed" };
    const body = `        <ul>\n${items
      .map((r) => `          <li><a href="${escapeHtml(r.url)}">${escapeHtml(r.label)}</a></li>`)
      .join("\n")}\n        </ul>`;
    return { html: section("related-destinations", S(props.heading, "Explore related pages"), body), text: items.map((i) => i.label).join(", "), usedPaths: [] };
  },
};

const breadcrumb: ComponentDefinition = {
  key: "breadcrumb",
  name: "Breadcrumb",
  category: "LAYOUT",
  description: "Hierarchy trail; also emitted as BreadcrumbList structured data.",
  version: 1,
  contentSource: "TEMPLATE",
  requiredBindings: [],
  optionalBindings: [],
  aiSlots: [],
  defaults: {},
  render({ page }) {
    const crumbs = page.breadcrumbs ?? [];
    if (!crumbs.length) return { html: "", text: "", usedPaths: [], skippedReason: "No breadcrumb trail supplied" };
    const items = crumbs
      .map((c, i) =>
        i === crumbs.length - 1
          ? `<span aria-current="page">${escapeHtml(c.label)}</span>`
          : `<a href="${escapeHtml(c.url)}">${escapeHtml(c.label)}</a>`,
      )
      .join(" › ");
    return { html: `      <nav class="fm-breadcrumb" aria-label="Breadcrumb">${items}</nav>`, text: crumbs.map((c) => c.label).join(" > "), usedPaths: [] };
  },
};

const cta: ComponentDefinition = {
  key: "cta",
  name: "Call to action",
  category: "CONVERSION",
  description: "Closing CTA in the brand's configured style.",
  version: 1,
  contentSource: "TEMPLATE",
  requiredBindings: ["origin.city", "destination.city"],
  optionalBindings: [],
  aiSlots: [],
  defaults: { label: "Compare live fares", href: "/search" },
  render({ values, props }) {
    const o = S(lookup(values, "origin.city"));
    const d = S(lookup(values, "destination.city"));
    const text = `Ready to compare ${o} to ${d} options? Live availability changes daily — check the dates you actually want.`;
    const html = section(
      "cta",
      null,
      `        <p>${escapeHtml(text)}</p>\n        <a class="fm-cta" href="${escapeHtml(S(props.href, "/search"))}?from=${escapeHtml(S(lookup(values, "route.origin")))}&to=${escapeHtml(S(lookup(values, "route.destination")))}">${escapeHtml(S(props.label, "Compare live fares"))}</a>`,
    );
    return { html, text, usedPaths: ["origin.city", "destination.city"] };
  },
};

const sourceEvidence: ComponentDefinition = {
  key: "source_evidence",
  name: "Source & evidence block",
  category: "GEO",
  description: "Visible provenance for every factual claim: source, retrieval date and whether it is reference data.",
  version: 1,
  contentSource: "DYNAMIC",
  requiredBindings: [],
  optionalBindings: [],
  aiSlots: [],
  defaults: { heading: "Where this information comes from" },
  render({ page, props }) {
    const evidence = page.evidence ?? [];
    if (!evidence.length) return { html: "", text: "", usedPaths: [], skippedReason: "No evidence entries supplied" };
    const rows = evidence
      .map(
        (e) =>
          `          <li>${escapeHtml(e.claim)} — <em>${escapeHtml(e.source)}</em>, retrieved ${escapeHtml(
            e.retrievedAt.slice(0, 10),
          )}${e.isMock ? ' <span class="fm-meta">(reference dataset, not live)</span>' : ""}</li>`,
      )
      .join("\n");
    return {
      html: `      <section id="sources" class="fm-sources">\n        <h2>${escapeHtml(S(props.heading, "Where this information comes from"))}</h2>\n        <ul>\n${rows}\n        </ul>${
        page.lastUpdated ? `\n        <p class="fm-meta">Last updated ${escapeHtml(page.lastUpdated.slice(0, 10))}.</p>` : ""
      }\n      </section>`,
      text: evidence.map((e) => `${e.claim} (${e.source})`).join("; "),
      usedPaths: [],
    };
  },
};

const authorTrust: ComponentDefinition = {
  key: "author_trust",
  name: "Author / trust block",
  category: "GEO",
  description: "States who produced the page and how it is maintained.",
  version: 1,
  contentSource: "TEMPLATE",
  requiredBindings: [],
  optionalBindings: [],
  aiSlots: [],
  defaults: {},
  render({ page }) {
    const text = `Compiled and maintained by the ${page.brandName} route research team. Route facts are drawn from the sources listed above and reviewed before publication; anything time-sensitive is verified against a live source or omitted.`;
    return {
      html: `      <section id="about-this-page" class="fm-meta">\n        <p>${escapeHtml(text)}</p>\n      </section>`,
      text,
      usedPaths: [],
    };
  },
};

export const COMPONENT_LIBRARY: ComponentDefinition[] = [
  breadcrumb,
  hero,
  searchBox,
  answerBlock,
  routeSummary,
  routeOverview,
  flightOptions,
  airlineCards,
  airportCards,
  travelTips,
  faq,
  comparisonTable,
  relatedRoutes,
  relatedDestinations,
  sourceEvidence,
  authorTrust,
  cta,
];

export function componentByKey(key: string): ComponentDefinition | undefined {
  return COMPONENT_LIBRARY.find((c) => c.key === key);
}

/** Ordered block list for the canonical route page family. */
export const ROUTE_TEMPLATE_BLOCKS: {
  componentKey: string;
  isRequired: boolean;
  condition?: string;
  config?: Record<string, unknown>;
}[] = [
  { componentKey: "breadcrumb", isRequired: false },
  { componentKey: "hero", isRequired: true },
  { componentKey: "answer_block", isRequired: true },
  { componentKey: "search_box", isRequired: false },
  { componentKey: "route_summary", isRequired: true },
  { componentKey: "route_overview", isRequired: true },
  { componentKey: "flight_options", isRequired: false, condition: "offers.items" },
  { componentKey: "airline_cards", isRequired: false, condition: "route.airlines" },
  { componentKey: "airport_cards", isRequired: false },
  { componentKey: "travel_tips", isRequired: false },
  { componentKey: "faq", isRequired: true },
  { componentKey: "comparison_table", isRequired: false },
  { componentKey: "related_routes", isRequired: false },
  { componentKey: "related_destinations", isRequired: false },
  { componentKey: "source_evidence", isRequired: true },
  { componentKey: "author_trust", isRequired: false },
  { componentKey: "cta", isRequired: false },
];
