/**
 * Structured data generation.
 *
 * Only emits a type when the page actually contains the content that type
 * describes, and only populates properties from resolved data. Each emitted
 * block is validated against its required properties before it is attached, and
 * an invalid block blocks publication via the quality gate.
 */
import type { RenderedBlock } from "@/engine/templates/renderer";

export interface SchemaBlock {
  type: string;
  jsonld: Record<string, unknown>;
  valid: boolean;
  issues: string[];
}

export interface SchemaInput {
  url: string;
  absoluteUrl: string;
  title: string;
  metaDescription: string;
  brandName: string;
  brandUrl: string;
  blocks: RenderedBlock[];
  faqs: { question: string; answer: string }[];
  breadcrumbs: { url: string; label: string }[];
  values: Record<string, any>;
  lastUpdated: string;
}

const REQUIRED: Record<string, string[]> = {
  WebPage: ["name", "url"],
  FAQPage: ["mainEntity"],
  BreadcrumbList: ["itemListElement"],
  Organization: ["name", "url"],
  Trip: ["name"],
};

function validate(type: string, jsonld: Record<string, unknown>): { valid: boolean; issues: string[] } {
  const required = REQUIRED[type] ?? [];
  const issues = required.filter((p) => {
    const v = jsonld[p];
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === "";
  });
  return { valid: issues.length === 0, issues: issues.map((p) => `missing required property "${p}"`) };
}

function block(type: string, jsonld: Record<string, unknown>): SchemaBlock {
  const { valid, issues } = validate(type, jsonld);
  return { type, jsonld, valid, issues };
}

export function generateSchemas(input: SchemaInput): SchemaBlock[] {
  const out: SchemaBlock[] = [];

  // WebPage - always applicable.
  out.push(
    block("WebPage", {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: input.title,
      description: input.metaDescription,
      url: input.absoluteUrl,
      dateModified: input.lastUpdated,
      inLanguage: "en",
      publisher: { "@type": "Organization", name: input.brandName, url: input.brandUrl },
    }),
  );

  // BreadcrumbList - only with a real trail.
  if (input.breadcrumbs.length > 1) {
    out.push(
      block("BreadcrumbList", {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: input.breadcrumbs.map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: c.label,
          item: c.url.startsWith("http") ? c.url : `${input.brandUrl.replace(/\/$/, "")}${c.url}`,
        })),
      }),
    );
  }

  // FAQPage - only when a visible FAQ block rendered.
  const faqRendered = input.blocks.some((b) => b.componentKey === "faq" && b.rendered);
  if (faqRendered && input.faqs.length) {
    out.push(
      block("FAQPage", {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: input.faqs.map((f) => ({
          "@type": "Question",
          name: f.question,
          acceptedAnswer: { "@type": "Answer", text: f.answer },
        })),
      }),
    );
  }

  // Trip - only when both endpoints resolved. Deliberately conservative: no
  // offers/price properties unless a live pricing source supplied them.
  const originCity = input.values?.origin?.city;
  const destCity = input.values?.destination?.city;
  if (originCity && destCity) {
    const trip: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "Trip",
      name: `${originCity} to ${destCity} flight`,
      description: input.metaDescription,
      itinerary: [
        {
          "@type": "Place",
          name: input.values?.origin?.airportName ?? originCity,
          address: { "@type": "PostalAddress", addressLocality: originCity, addressCountry: input.values?.origin?.countryCode },
        },
        {
          "@type": "Place",
          name: input.values?.destination?.airportName ?? destCity,
          address: { "@type": "PostalAddress", addressLocality: destCity, addressCountry: input.values?.destination?.countryCode },
        },
      ],
      provider: { "@type": "Organization", name: input.brandName, url: input.brandUrl },
    };
    out.push(block("Trip", trip));
  }

  return out;
}

/** Site-level Organization + WebSite graph, emitted once. */
export function generateSiteSchema(brandName: string, brandUrl: string, searchPath = "/search?from={from}&to={to}"): SchemaBlock[] {
  return [
    block("Organization", {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: brandName,
      url: brandUrl,
    }),
    block("WebSite", {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: brandName,
      url: brandUrl,
      potentialAction: {
        "@type": "SearchAction",
        target: `${brandUrl.replace(/\/$/, "")}${searchPath}`,
        "query-input": "required name=from",
      },
    }),
  ];
}
