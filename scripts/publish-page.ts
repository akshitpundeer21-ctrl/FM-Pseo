/**
 * Generates and publishes a single route page using the real rendering pipeline.
 *
 * Usage: npx tsx scripts/publish-page.ts BOM LHR
 *
 * This resolves data through the adapters directly, generates prose through
 * the deterministic mock writers, and writes via renderDocument — the same
 * path the Publishing Agent takes.
 */
import { ROUTE_TEMPLATE_BLOCKS } from "@/engine/templates/component-library";
import { composePage } from "@/engine/content/composer";
import { renderDocument } from "@/modules/publishing/adapters";
import { loadRoutes, StaticDatasetAdapter } from "@/engine/data/adapters/static-dataset";
import { TravelDbAdapter } from "@/engine/data/adapters/travel-db";
import { materialise, type DataPoint } from "@/engine/data/types";
import { MockLlmProvider } from "@/llm/providers/mock";
import { DEFAULT_BRAND } from "@/modules/brand/brand";
import { BundledReferenceProvider } from "@/modules/travel/providers/bundled";
import { ingestFromProvider } from "@/modules/travel/ingest";
import { env } from "@/core/config/env";
import { prisma } from "@/core/db/client";
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const [origin, destination] = process.argv.slice(2).map((s) => s.toUpperCase());
  if (!origin || !destination) {
    console.error("Usage: npx tsx scripts/publish-page.ts <ORIGIN_IATA> <DEST_IATA>");
    process.exit(1);
  }

  // Ensure travel data (including any new routes) is in the database
  await ingestFromProvider(new BundledReferenceProvider());

  const routes = loadRoutes();
  const route = routes.find((r: any) => r.origin === origin && r.destination === destination);
  if (!route) {
    console.error(`No route found for ${origin} → ${destination} in data/mock/routes.json`);
    process.exit(1);
  }

  const url = `/flights/${origin.toLowerCase()}/${destination.toLowerCase()}`;
  const variables = {
    origin,
    destination,
    originCity: route.originCity,
    destinationCity: route.destinationCity,
  };

  // Resolve data through adapters directly (TravelDb first, static fallback)
  const adapters = [new TravelDbAdapter(), new StaticDatasetAdapter()];
  const requests: { namespace: string; params: Record<string, string> }[] = [
    { namespace: "route", params: { origin, destination } },
    { namespace: "airport", params: { iata: origin, prefix: "origin" } },
    { namespace: "airport", params: { iata: destination, prefix: "destination" } },
  ];

  const points: DataPoint[] = [];
  for (const req of requests) {
    for (const adapter of adapters) {
      if (!adapter.supports(req.namespace)) continue;
      try {
        const resolved = await adapter.resolve(req.namespace, req.params);
        if (resolved.length) {
          points.push(...resolved);
          break;
        }
      } catch {}
    }
  }

  const values = materialise(points);

  // Find sibling routes from the same origin for the comparison block
  const siblings = routes
    .filter((r: any) => r.origin === origin && r.destination !== destination)
    .slice(0, 5)
    .map((r: any) => ({
      url: `/flights/${r.origin.toLowerCase()}/${r.destination.toLowerCase()}`,
      label: `${r.originCity} to ${r.destinationCity}`,
      note: `${r.distanceKm.toLocaleString("en-US")} km · ${r.nonstopAvailable ? "non-stop available" : `${r.typicalStops} stop${r.typicalStops === 1 ? "" : "s"}`}`,
    }));

  // Default questions for the route
  const questions = [
    `How long is the flight from ${route.originCity} to ${route.destinationCity}?`,
    `Which airlines fly from ${route.originCity} to ${route.destinationCity}?`,
    `Are there direct flights from ${route.originCity} to ${route.destinationCity}?`,
  ];

  // Compose the page using the template blocks
  const blocks = ROUTE_TEMPLATE_BLOCKS.map((b, i) => ({
    blockKey: `${b.componentKey}#${i}`,
    componentKey: b.componentKey,
    sequence: i,
    isRequired: b.isRequired,
    condition: b.condition ?? null,
    config: b.config ?? {},
    contentSource: undefined as any,
  }));

  const llm = new MockLlmProvider();

  const composed = await composePage({
    url,
    variables,
    blocks,
    data: { values, points, missing: [], containsMock: points.some((p) => p.isMock) },
    brand: { ...DEFAULT_BRAND, brandName: "FaresMatch", version: 1 },
    relatedRoutes: siblings,
    relatedAirports: [
      { url: `/airports/${origin.toLowerCase()}`, label: `${route.originCity} airport (${origin})` },
      { url: `/airports/${destination.toLowerCase()}`, label: `${route.destinationCity} airport (${destination})` },
    ],
    relatedDestinations: [
      { url: `/destinations/${destination.toLowerCase()}`, label: `${route.destinationCity} destination guide` },
    ],
    questions,
    deps: {
      generate: async (params) => {
        const resp = await llm.complete({
          task: params.task,
          messages: [{ role: "user", content: params.prompt }],
          variables: params.variables as Record<string, string>,
          maxTokens: params.maxTokens,
        });
        return resp.text;
      },
    },
  });

  // Build JSON-LD
  const appUrl = env().APP_URL;
  const canonical = `${appUrl}/site${url}`;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: composed.title,
      description: composed.metaDescription,
      url: canonical,
      dateModified: new Date().toISOString(),
      inLanguage: "en",
      publisher: { "@type": "Organization", name: "FaresMatch", url: `${appUrl}/` },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: composed.breadcrumbs.map((b, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: b.label,
        item: `${appUrl}${b.url}`,
      })),
    },
    ...(composed.faqs.length
      ? [
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: composed.faqs.map((f) => ({
              "@type": "Question",
              name: f.question,
              acceptedAnswer: { "@type": "Answer", text: f.answer },
            })),
          },
        ]
      : []),
    {
      "@context": "https://schema.org",
      "@type": "Trip",
      name: `${route.originCity} to ${route.destinationCity} flight`,
      description: composed.metaDescription,
      itinerary: [
        {
          "@type": "Place",
          name: String(values["origin.airportName"] ?? route.originCity),
          address: { "@type": "PostalAddress", addressLocality: route.originCity, addressCountry: route.originCountry },
        },
        {
          "@type": "Place",
          name: String(values["destination.airportName"] ?? route.destinationCity),
          address: { "@type": "PostalAddress", addressLocality: route.destinationCity, addressCountry: route.destinationCountry },
        },
      ],
      provider: { "@type": "Organization", name: "FaresMatch", url: `${appUrl}/` },
    },
  ];

  const dataNotice = composed.usedMock
    ? "Route facts on this page come from reference data, not a live provider feed. Fares and schedules are not shown because no live pricing source is connected."
    : undefined;

  // Render full document
  const doc = renderDocument(
    {
      url,
      title: composed.title,
      metaDescription: composed.metaDescription,
      html: composed.render.html,
      jsonLd,
      brand: { name: "FaresMatch", siteUrl: appUrl, basePath: "/site" },
      dataNotice,
    },
    canonical,
  );

  // Write to disk
  const outDir = path.join(process.cwd(), env().PUBLISH_LOCAL_DIR, "flights", origin.toLowerCase());
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${destination.toLowerCase()}.html`);
  await fs.writeFile(outFile, doc, "utf8");

  // Write JSON sidecar
  const sidecar = {
    url,
    title: composed.title,
    metaDescription: composed.metaDescription,
    canonical,
    publishedAt: new Date().toISOString(),
    evidence: composed.evidence,
    faqs: composed.faqs,
    composition: composed.render.composition,
    usedMock: composed.usedMock,
  };
  await fs.writeFile(outFile.replace(/\.html$/, ".json"), JSON.stringify(sidecar, null, 2), "utf8");

  // Publish to database so Vercel can serve the page
  try {
    const project = await prisma.project.findFirst();
    if (!project) throw new Error("No project in database — run seed first");

    const routeFamily = await prisma.pageFamily.findFirst({
      where: { projectId: project.id, key: "route" },
    });
    const template = await prisma.template.findFirst({
      where: { projectId: project.id, key: { startsWith: "route_v" } },
      orderBy: { version: "desc" },
    });

    const page = await prisma.page.upsert({
      where: {
        projectId_url: { projectId: project.id, url },
      },
      update: {
        title: composed.title,
        metaDescription: composed.metaDescription,
        status: "PUBLISHED",
        publishedHtml: doc,
        publishedAt: new Date(),
        qualityScore: 65,
        variablesJson: JSON.stringify(variables),
      },
      create: {
        projectId: project.id,
        pageFamilyId: routeFamily?.id ?? null,
        templateId: template?.id ?? null,
        url,
        title: composed.title,
        metaDescription: composed.metaDescription,
        status: "PUBLISHED",
        publishedHtml: doc,
        publishedAt: new Date(),
        qualityScore: 65,
        variablesJson: JSON.stringify(variables),
      },
    });

    console.log(`\n  Database: page stored (id: ${page.id})`);
    console.log(`  Vercel URL: ${appUrl}/site${url}`);
  } catch (dbErr) {
    console.error("\n  Database publish failed:", dbErr);
    console.log("  (Local file was still written successfully)");
  }

  console.log(`\nPublished: ${url}`);
  console.log(`  File: ${outFile}`);
  console.log(`  Title: ${composed.title}`);
  console.log(`  Blocks rendered: ${composed.render.blocks.filter((b) => b.rendered).length}/${composed.render.blocks.length}`);
  console.log(`  Composition: template ${(composed.render.composition.templateShare * 100).toFixed(0)}% / dynamic ${(composed.render.composition.dynamicShare * 100).toFixed(0)}% / AI ${(composed.render.composition.aiShare * 100).toFixed(0)}%`);
  console.log(`  Evidence rows: ${composed.evidence.length}`);
  console.log(`  FAQs: ${composed.faqs.length}`);
  console.log(`  Used mock data: ${composed.usedMock}`);
}

main().catch((e) => {
  console.error("Page generation failed:", e);
  process.exit(1);
});
