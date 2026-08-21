/**
 * Content Generation Agent.
 *
 * Resolves the page's dynamic data, generates only the prose the template asks
 * for, assembles the page and persists it as a new PageVersion with per-block
 * provenance. It holds `write_content` but NOT `publish` - a draft is the most
 * it can produce.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readJson, writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { composePage, toBlockSpecs } from "@/engine/content/composer";
import { DEFAULT_ROUTE_POLICY } from "@/agents/content-strategy.agent";
import { proposeLinks, routeEntities, type LinkablePage } from "@/engine/linking/linker";
import { loadRoutes } from "@/engine/data/adapters/static-dataset";
import type { DataContext } from "@/engine/data/types";
import type { CompositionPolicy } from "@/engine/templates/renderer";

const InputSchema = z.object({
  opportunityId: z.string(),
  templateId: z.string(),
  questions: z.array(z.string()).optional(),
  /** Force a new version even when content is unchanged. */
  forceNewVersion: z.boolean().optional(),
});

const OutputSchema = z.object({
  pageId: z.string(),
  pageVersionId: z.string(),
  version: z.number(),
  url: z.string(),
  title: z.string(),
  metaDescription: z.string(),
  wordCount: z.number(),
  renderedBlocks: z.number(),
  skippedBlocks: z.array(z.object({ blockKey: z.string(), reason: z.string() })),
  missingRequiredBlocks: z.array(z.string()),
  distinctDataPoints: z.number(),
  composition: z.object({
    templateShare: z.number(),
    dynamicShare: z.number(),
    aiShare: z.number(),
    withinPolicy: z.boolean(),
    policyNotes: z.array(z.string()),
  }),
  faqCount: z.number(),
  usedMockData: z.boolean(),
  liveOffersAvailable: z.boolean(),
});

export type ContentGenerationInput = z.infer<typeof InputSchema>;
export type ContentGenerationOutput = z.infer<typeof OutputSchema>;

export class ContentGenerationAgent extends BaseAgent<ContentGenerationInput, ContentGenerationOutput> {
  readonly key = "content_generation";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;

  readonly validationRules: ValidationRule<ContentGenerationOutput>[] = [
    {
      name: "required_blocks_rendered",
      check: (o) => o.missingRequiredBlocks.length === 0,
      message: "One or more required template blocks did not render",
    },
    { name: "has_content", check: (o) => o.wordCount > 120, message: "Rendered page has almost no content" },
    {
      name: "no_unsourced_prices",
      check: (o) => o.liveOffersAvailable || !/[$€£₹]\s?\d/.test(o.title + o.metaDescription),
      message: "A price-shaped value appeared without a live pricing source",
    },
  ];

  protected async perform(input: ContentGenerationInput, ctx: AgentRunContext): Promise<AgentOutcome<ContentGenerationOutput>> {
    if (!ctx.brand) throw new Error("Brand profile is required before content generation");

    const opportunity = await prisma.opportunity.findUnique({ where: { id: input.opportunityId } });
    if (!opportunity) throw new Error(`Opportunity ${input.opportunityId} not found`);
    if (opportunity.decision === "REJECT") {
      throw new Error(`Opportunity ${opportunity.candidateUrl} was REJECTED by the opportunity gate - refusing to generate it`);
    }

    const template = await prisma.template.findUnique({
      where: { id: input.templateId },
      include: { blocks: { include: { component: true }, orderBy: { sequence: "asc" } }, pageFamily: true },
    });
    if (!template) throw new Error(`Template ${input.templateId} not found`);

    const vars = readJson<{ origin: string; destination: string; originCity: string; destinationCity: string }>(
      opportunity.variablesJson,
      { origin: "", destination: "", originCity: "", destinationCity: "" },
    );

    // --- 1. Resolve dynamic data ------------------------------------------
    const subject = `route:${vars.origin}-${vars.destination}`;
    const data = (await ctx.tool<DataContext & { factIds: string[] }>("data.resolve", {
      requests: [
        { namespace: "route", params: { origin: vars.origin, destination: vars.destination } },
        { namespace: "airport", params: { iata: vars.origin, prefix: "origin" } },
        { namespace: "airport", params: { iata: vars.destination, prefix: "destination" } },
      ],
      persistAs: subject,
    })) as DataContext & { factIds: string[] };

    // --- 2. Live offers: attempted, never fabricated -----------------------
    let liveOffersAvailable = false;
    try {
      const offers = await ctx.tool<{ available: boolean; reason?: string; offers: unknown[]; points: any[] }>("travel.offers", {
        origin: vars.origin,
        destination: vars.destination,
        passengers: 1,
      });
      if (offers.available && offers.offers.length) {
        liveOffersAvailable = true;
        for (const p of offers.points) {
          data.points.push(p);
          assignPath(data.values, p.path, p.value);
        }
      } else {
        ctx.logger.info("live offers unavailable - price block will be omitted", { reason: offers.reason });
      }
    } catch (e) {
      // travel.offers has no mock fallback by design.
      ctx.logger.warn("live offers tool unavailable; continuing without price data", { error: (e as Error).message });
    }

    // --- 3. Related pages for the internal-link blocks ---------------------
    const published = await prisma.page.findMany({
      where: { projectId: ctx.projectId, status: { in: ["PUBLISHED", "APPROVED"] } },
      select: { id: true, url: true, title: true, status: true, pageFamilyId: true, variablesJson: true },
    });

    const airlines = (data.values as any)?.route?.airlines ?? [];
    const selfEntities = routeEntities({
      origin: vars.origin,
      destination: vars.destination,
      originCity: vars.originCity,
      destinationCity: vars.destinationCity,
      originCountry: (data.values as any)?.origin?.country,
      destinationCountry: (data.values as any)?.destination?.country,
      airlines: Array.isArray(airlines) ? airlines.map((a: any) => a.iata ?? a) : [],
    });

    const candidates: LinkablePage[] = published.map((p) => {
      const pv = readJson<{ origin?: string; destination?: string; originCity?: string; destinationCity?: string }>(p.variablesJson, {});
      return {
        id: p.id,
        url: p.url,
        title: p.title,
        pageType: "ROUTE",
        status: p.status,
        entities: pv.origin && pv.destination
          ? routeEntities({
              origin: pv.origin,
              destination: pv.destination,
              originCity: pv.originCity,
              destinationCity: pv.destinationCity,
            })
          : [],
      };
    });

    const self: LinkablePage = {
      id: "self",
      url: opportunity.candidateUrl,
      title: opportunity.title,
      pageType: "ROUTE",
      status: "APPROVED",
      entities: selfEntities,
    };

    const linkResult = proposeLinks(self, candidates, {
      relevanceFloor: ctx.brand.linkingRules?.relevanceFloor ?? 0.35,
      maxLinks: ctx.brand.linkingRules?.maxInternalLinks ?? 12,
    });

    // Sibling routes from the reference dataset give the comparison block
    // something to compare even before many pages are published.
    const siblingRoutes = loadRoutes()
      .filter((r) => r.origin === vars.origin && r.destination !== vars.destination)
      .slice(0, 5)
      .map((r) => ({
        url: `/flights/${r.origin.toLowerCase()}/${r.destination.toLowerCase()}`,
        label: `${r.originCity} to ${r.destinationCity}`,
        note: `${Math.round(r.distanceKm).toLocaleString("en-US")} km · ${r.typicalStops === 0 ? "non-stop available" : `${r.typicalStops} stop`}`,
      }));

    const relatedRoutes = [
      ...linkResult.proposals.map((p) => ({ url: p.targetUrl, label: p.anchorText })),
      ...siblingRoutes.filter((s) => !linkResult.proposals.some((p) => p.targetUrl === s.url)),
    ].slice(0, 8);

    // --- 4. Compose --------------------------------------------------------
    const policy: CompositionPolicy =
      readJson<{ policy?: CompositionPolicy }>(template.pageFamily?.compositionJson ?? "{}", {}).policy ?? DEFAULT_ROUTE_POLICY;

    const questions = input.questions?.length
      ? input.questions
      : (
          await prisma.keyword.findMany({
            where: { projectId: ctx.projectId, origin: vars.origin, destination: vars.destination, intent: "QUESTION" },
            orderBy: { volume: "desc" },
            take: 6,
          })
        ).map((k) => k.keyword);

    const composed = await composePage({
      url: opportunity.candidateUrl,
      variables: vars,
      blocks: toBlockSpecs(template.blocks),
      data,
      brand: ctx.brand,
      policy,
      relatedRoutes,
      relatedDestinations: [
        { url: `/destinations/${vars.destination.toLowerCase()}`, label: `${vars.destinationCity} destination guide` },
      ],
      relatedAirports: [
        { url: `/airports/${vars.origin.toLowerCase()}`, label: `${vars.originCity} airport (${vars.origin})` },
        { url: `/airports/${vars.destination.toLowerCase()}`, label: `${vars.destinationCity} airport (${vars.destination})` },
      ],
      questions,
      deps: {
        generate: async ({ task, prompt, variables, maxTokens, complexity }) => {
          const res = await ctx.generate({ task, prompt, variables, maxTokens, complexity });
          return res.text;
        },
      },
    });

    // --- 5. Persist page + version ----------------------------------------
    const page = await prisma.page.upsert({
      where: { projectId_url: { projectId: ctx.projectId, url: opportunity.candidateUrl } },
      update: {
        title: composed.title,
        metaDescription: composed.metaDescription,
        pageFamilyId: template.pageFamilyId,
        templateId: template.id,
        opportunityId: opportunity.id,
        variablesJson: writeJson(vars),
        status: "GENERATED",
      },
      create: {
        projectId: ctx.projectId,
        pageFamilyId: template.pageFamilyId,
        templateId: template.id,
        opportunityId: opportunity.id,
        url: opportunity.candidateUrl,
        title: composed.title,
        metaDescription: composed.metaDescription,
        variablesJson: writeJson(vars),
        status: "GENERATED",
      },
    });

    const nextVersion = page.currentVersion + 1;
    const rendered = composed.render;

    const version = await prisma.pageVersion.create({
      data: {
        pageId: page.id,
        version: nextVersion,
        status: "DRAFT",
        title: composed.title,
        metaDescription: composed.metaDescription,
        // Structure + provenance only; block text lives in ContentItem so it is
        // stored once and stays the canonical copy.
        blocksJson: writeJson(
          rendered.blocks.map((b) => ({
            blockKey: b.blockKey,
            componentKey: b.componentKey,
            componentVersion: b.componentVersion,
            sequence: b.sequence,
            source: b.source,
            rendered: b.rendered,
            isRequired: b.isRequired,
            skippedReason: b.skippedReason ?? null,
            usedPaths: b.usedPaths,
            aiChars: b.aiChars,
            wordCount: b.wordCount,
          })),
        ),
        html: rendered.html,
        markdown: rendered.text,
        seoJson: writeJson({ questions, relatedRoutes: relatedRoutes.length }),
        aeoJson: writeJson({ faqs: composed.faqs }),
        geoJson: writeJson({ evidence: composed.evidence, breadcrumbs: composed.breadcrumbs }),
        compositionJson: writeJson(rendered.composition),
        factsJson: writeJson(data.factIds ?? []),
        wordCount: rendered.wordCount,
        createdBy: this.key,
      },
    });

    for (const block of rendered.blocks) {
      await prisma.contentItem.create({
        data: {
          pageVersionId: version.id,
          blockKey: block.blockKey,
          componentKey: block.componentKey,
          sequence: block.sequence,
          source: block.source === "HYBRID" ? (block.aiChars > 0 ? "AI" : "DYNAMIC") : block.source,
          text: block.text.slice(0, 8000),
          dataJson: writeJson({ usedPaths: block.usedPaths, slots: Object.keys(block.slots), skipped: block.skippedReason ?? null }),
          confidence: block.rendered ? 0.85 : 0,
          isMock: data.containsMock,
        },
      });
    }

    await prisma.page.update({ where: { id: page.id }, data: { currentVersion: nextVersion } });

    const renderedCount = rendered.blocks.filter((b) => b.rendered).length;
    const confidence =
      rendered.missingRequiredBlocks.length > 0
        ? 0.35
        : Math.min(0.92, 0.55 + (rendered.distinctDataPoints.length / 16) * 0.3 + (rendered.composition.withinPolicy ? 0.1 : 0));

    return {
      output: {
        pageId: page.id,
        pageVersionId: version.id,
        version: nextVersion,
        url: page.url,
        title: composed.title,
        metaDescription: composed.metaDescription,
        wordCount: rendered.wordCount,
        renderedBlocks: renderedCount,
        skippedBlocks: rendered.blocks
          .filter((b) => !b.rendered)
          .map((b) => ({ blockKey: b.blockKey, reason: b.skippedReason ?? "unknown" })),
        missingRequiredBlocks: rendered.missingRequiredBlocks,
        distinctDataPoints: rendered.distinctDataPoints.length,
        composition: {
          templateShare: rendered.composition.templateShare,
          dynamicShare: rendered.composition.dynamicShare,
          aiShare: rendered.composition.aiShare,
          withinPolicy: rendered.composition.withinPolicy,
          policyNotes: rendered.composition.policyNotes,
        },
        faqCount: composed.faqs.length,
        usedMockData: composed.usedMock,
        liveOffersAvailable,
      },
      confidence,
      summary: `Generated v${nextVersion} of ${page.url}: ${rendered.wordCount} words, ${renderedCount}/${rendered.blocks.length} blocks, ${composed.faqs.length} FAQs, composition ${(rendered.composition.templateShare * 100).toFixed(0)}/${(rendered.composition.dynamicShare * 100).toFixed(0)}/${(rendered.composition.aiShare * 100).toFixed(0)} (template/dynamic/generated).`,
      nextAction: "Verify the facts on this draft",
    };
  }
}

function assignPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur: any = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
