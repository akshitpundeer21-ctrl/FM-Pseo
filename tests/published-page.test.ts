/**
 * Published-page tests.
 *
 * These cover the two things that make a published page trustworthy rather than
 * merely pretty:
 *
 *   1. Blocks that depend on a provider we do not have render NOTHING and say
 *      why. A fare panel, a price chart or a destination guide must never be
 *      filled in from imagination.
 *   2. Every link on the page resolves where the site is actually served, and
 *      the structured data agrees with the visible links.
 */
import { describe, expect, it } from "vitest";
import { componentByKey, ROUTE_TEMPLATE_BLOCKS, type RenderInput } from "@/engine/templates/component-library";
import { applyBasePath, rebaseJsonLd } from "@/modules/publishing/page-theme";
import { renderDocument } from "@/modules/publishing/adapters";
import { buildTitle } from "@/engine/content/composer";
import { DEFAULT_BRAND, type BrandKnowledge } from "@/modules/brand/brand";

const brand: BrandKnowledge = { ...DEFAULT_BRAND, brandName: "FaresMatch", version: 1 };

const routeValues = {
  route: {
    origin: "DEL",
    destination: "YYZ",
    distanceKm: 11640,
    typicalDurationMinutes: 922,
    typicalStops: 0,
    nonstopAvailable: true,
    airlines: [
      { iata: "AC", name: "Air Canada" },
      { iata: "AI", name: "Air India" },
    ],
  },
  origin: { city: "Delhi", iata: "DEL", airportName: "Indira Gandhi International Airport", terminals: 3 },
  destination: { city: "Toronto", iata: "YYZ", airportName: "Toronto Pearson International Airport", terminals: 2 },
};

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    props: {},
    values: routeValues,
    slots: {},
    page: { url: "/flights/del/yyz", brandName: "FaresMatch" },
    ...overrides,
  };
}

function render(key: string, overrides: Partial<RenderInput> = {}) {
  const component = componentByKey(key);
  if (!component) throw new Error(`component ${key} missing`);
  const base = input(overrides);
  return component.render({ ...base, props: { ...component.defaults, ...base.props } });
}

describe("blocks that need a provider we do not have", () => {
  it("omits the fare panel entirely when no pricing source is connected", () => {
    const out = render("fare_hero");
    expect(out.html).toBe("");
    expect(out.skippedReason).toMatch(/pricing source/i);
  });

  it("renders the fare panel only from a resolved price", () => {
    const out = render("fare_hero", {
      values: {
        ...routeValues,
        offers: { cheapestPrice: 812.4, currency: "USD", count: 26, sourceName: "Amadeus", retrievedAt: "2026-08-21T09:00:00Z" },
      },
    });
    expect(out.html).toContain("$812.40");
    expect(out.html).toContain("via Amadeus");
    expect(out.skippedReason).toBeUndefined();
  });

  it("omits the price chart without a swept series, and needs at least two real points", () => {
    expect(render("price_by_week").html).toBe("");
    expect(render("price_by_week", { values: { ...routeValues, offers: { weeklySeries: [{ label: "Wk 1", price: 800 }] } } }).html).toBe(
      "",
    );

    const out = render("price_by_week", {
      values: {
        ...routeValues,
        offers: {
          currency: "USD",
          weeklySeries: [
            { label: "Wk 1", price: 800 },
            { label: "Wk 2", price: 910 },
            { label: "Wk 3", price: 745 },
          ],
        },
      },
    });
    expect(out.html).toContain("<svg");
    expect(out.html).toContain("Wk 3");
  });

  it("omits destination highlights when no attractions source is connected", () => {
    const out = render("things_to_do");
    expect(out.html).toBe("");
    expect(out.skippedReason).toMatch(/attractions/i);
  });

  it("falls back to a branded band rather than inventing a photograph", () => {
    const withoutPhoto = render("hero_photo");
    expect(withoutPhoto.html).toContain("hero-band");
    expect(withoutPhoto.html).not.toContain("<img");

    const withPhoto = render("hero_photo", {
      values: { ...routeValues, destination: { ...routeValues.destination, imageUrl: "https://cdn.example/yyz.jpg", imageCredit: "Photographer" } },
    });
    expect(withPhoto.html).toContain("https://cdn.example/yyz.jpg");
    expect(withPhoto.html).toContain("Photographer");
  });

  it("does not link the search dock or the CTA to a search that does not exist", () => {
    const dock = render("search_box");
    expect(dock.html).toContain("search-dock");
    expect(dock.html).not.toContain("<form");
    expect(dock.html).not.toContain("<button");

    const cta = render("cta");
    expect(cta.html).toBe("");
    expect(cta.skippedReason).toMatch(/search destination/i);
  });

  it("uses the configured search destination when there is one", () => {
    const page = { url: "/flights/del/yyz", brandName: "FaresMatch", searchUrl: "https://faresmatch.example/search" };
    const dock = render("search_box", { page });
    expect(dock.html).toContain('action="https://faresmatch.example/search"');
    expect(dock.html).toContain("<button");

    const cta = render("cta", { page });
    expect(cta.html).toContain("https://faresmatch.example/search?from=DEL&amp;to=YYZ");
  });
});

describe("route template", () => {
  it("orders the reference layout and marks only self-sufficient blocks required", () => {
    const keys = ROUTE_TEMPLATE_BLOCKS.map((b) => b.componentKey);
    expect(keys.slice(0, 6)).toEqual(["breadcrumb", "search_box", "hero", "hero_photo", "fare_hero", "answer_block"]);
    expect(keys).toContain("price_by_week");
    expect(keys).toContain("things_to_do");

    // Nothing that depends on an unconnected provider may be required, or the
    // page would be unpublishable rather than simply shorter.
    for (const block of ROUTE_TEMPLATE_BLOCKS.filter((b) => b.isRequired)) {
      expect(block.condition).toBeUndefined();
      expect(["fare_hero", "price_by_week", "flight_options", "things_to_do"]).not.toContain(block.componentKey);
    }
  });

  it("every block in the template exists in the library", () => {
    for (const block of ROUTE_TEMPLATE_BLOCKS) expect(componentByKey(block.componentKey)).toBeTruthy();
  });
});

describe("link integrity", () => {
  it("rebases root-relative links onto the path the site is served from", () => {
    const html = `<a href="/flights/del/yvr">x</a><form action="/search"></form><a href="https://example.com/a">y</a><a href="#answer">z</a>`;
    const out = applyBasePath(html, "/site");
    expect(out).toContain('href="/site/flights/del/yvr"');
    expect(out).toContain('action="/site/search"');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('href="#answer"');
  });

  it("does not double-prefix and is a no-op without a base path", () => {
    expect(applyBasePath('<a href="/site/flights">x</a>', "/site")).toContain('href="/site/flights"');
    expect(applyBasePath('<a href="/flights">x</a>', undefined)).toContain('href="/flights"');
  });

  it("keeps structured data in agreement with the visible links", () => {
    const ld = rebaseJsonLd(
      [{ "@type": "BreadcrumbList", itemListElement: [{ item: "http://localhost:3000/flights" }, { item: "http://localhost:3000/site/x" }] }],
      "http://localhost:3000",
      "/site",
    );
    expect(JSON.stringify(ld)).toContain("http://localhost:3000/site/flights");
    expect(JSON.stringify(ld)).not.toContain("http://localhost:3000/site/site");
  });

  it("renders a complete document with the brand theme and no invented nav", () => {
    const doc = renderDocument(
      {
        url: "/flights/del/yyz",
        title: "Cheap Flights from Delhi to Toronto | FaresMatch",
        metaDescription: "Compare Delhi to Toronto flights.",
        html: `      <a href="/flights/del/yvr">Delhi to Vancouver</a>`,
        jsonLd: [{ "@type": "WebPage", url: "http://localhost:3000/flights/del/yyz" }],
        brand: { name: "FaresMatch", siteUrl: "http://localhost:3000", basePath: "/site" },
        dataNotice: "Route facts come from reference data.",
      },
      "http://localhost:3000/site/flights/del/yyz",
    );

    expect(doc).toContain("<title>Cheap Flights from Delhi to Toronto | FaresMatch</title>");
    expect(doc).toContain('class="data-note"');
    expect(doc).toContain('href="/site/flights/del/yvr"');
    expect(doc).toContain("http://localhost:3000/site/flights/del/yyz");
    expect(doc).not.toContain('<nav class="site-nav">');
  });
});

describe("title pattern", () => {
  it("prefers the reference pattern and degrades under the character cap", () => {
    expect(buildTitle({ originCity: "Delhi", destinationCity: "Toronto" }, brand)).toBe(
      "Cheap Flights from Delhi to Toronto | FaresMatch",
    );

    // A long city pair runs out of budget: the brand suffix goes before the route does.
    const long = buildTitle({ originCity: "Rio De Janeiro", destinationCity: "Kuala Lumpur" }, brand);
    expect(long).toContain("Rio De Janeiro");
    expect(long).toContain("Kuala Lumpur");
    expect(long.length).toBeLessThanOrEqual(brand.seoRules?.titleMaxChars ?? 60);
  });
});
