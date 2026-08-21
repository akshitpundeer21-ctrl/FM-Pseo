/**
 * SEO / AEO / GEO / CFA Optimization Agent.
 *
 * Takes a verified draft and produces the parts that determine how it is found,
 * answered from, and cited:
 *   SEO - title, meta description, heading hierarchy check, keyword placement
 *   AEO - standalone answer block + question-form FAQ set
 *   GEO - entity disambiguation, evidence completeness, coverage gaps
 *   CFA - fact summary + explicit entity relationships
 *   plus validated JSON-LD.
 *
 * It makes no claims about controlling rankings or citations; it optimises for
 * clarity, extractability and attribution, and the AI Visibility module
 * measures whether that moved anything.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readJson, writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { generateSchemas } from "@/engine/schema/generator";
import { clampToSentence, wordCount } from "@/core/utils/text";
import { buildTitle } from "@/engine/content/composer";
import { env } from "@/core/config/env";
import type { RenderedBlock } from "@/engine/templates/renderer";

const InputSchema = z.object({
  pageVersionId: z.string(),
  primaryKeyword: z.string().optional(),
});

const OutputSchema = z.object({
  pageVersionId: z.string(),
  title: z.string(),
  metaDescription: z.string(),
  seo: z.object({
    titleLength: z.number(),
    metaLength: z.number(),
    keywordInTitle: z.boolean(),
    h1Count: z.number(),
    headingIssues: z.array(z.string()),
  }),
  aeo: z.object({
    answerPresent: z.boolean(),
    answerWords: z.number(),
    faqCount: z.number(),
    questionHeadings: z.boolean(),
  }),
  geo: z.object({
    entities: z.array(z.object({ name: z.string(), type: z.string(), identifier: z.string().nullable(), disambiguated: z.boolean() })),
    evidenceRows: z.number(),
    coverageGaps: z.array(z.string()),
  }),
  cfa: z.object({ summaryRows: z.number(), relationships: z.array(z.string()) }),
  schemas: z.array(z.object({ type: z.string(), valid: z.boolean(), issues: z.array(z.string()) })),
});

export type SeoOptimizationInput = z.infer<typeof InputSchema>;
export type SeoOptimizationOutput = z.infer<typeof OutputSchema>;

export class SeoOptimizationAgent extends BaseAgent<SeoOptimizationInput, SeoOptimizationOutput> {
  readonly key = "seo_optimization";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;

  readonly validationRules: ValidationRule<SeoOptimizationOutput>[] = [
    { name: "title_present", check: (o) => o.title.trim().length > 10, message: "Title is missing or too short" },
    { name: "title_length", check: (o) => o.seo.titleLength <= 70, message: "Title exceeds the hard length ceiling" },
    { name: "meta_present", check: (o) => o.metaDescription.trim().length > 40, message: "Meta description is missing or too short" },
    {
      name: "schema_valid",
      check: (o) => o.schemas.length > 0 && o.schemas.every((s) => s.valid),
      message: "No valid structured data was produced",
    },
  ];

  protected async perform(input: SeoOptimizationInput, ctx: AgentRunContext): Promise<AgentOutcome<SeoOptimizationOutput>> {
    if (!ctx.brand) throw new Error("Brand profile is required for optimization");

    const version = await prisma.pageVersion.findUnique({
      where: { id: input.pageVersionId },
      include: { page: true },
    });
    if (!version) throw new Error(`Page version ${input.pageVersionId} not found`);

    const vars = readJson<{ origin: string; destination: string; originCity: string; destinationCity: string }>(
      version.page.variablesJson,
      { origin: "", destination: "", originCity: "", destinationCity: "" },
    );
    const blocks = readJson<RenderedBlock[]>(version.blocksJson, []);
    const aeoStored = readJson<{ faqs: { question: string; answer: string }[] }>(version.aeoJson, { faqs: [] });
    const geoStored = readJson<{
      evidence: { claim: string; source: string; retrievedAt: string; isMock: boolean }[];
      breadcrumbs: { url: string; label: string }[];
    }>(version.geoJson, { evidence: [], breadcrumbs: [] });

    // --- primary keyword ---------------------------------------------------
    const primaryKeyword =
      input.primaryKeyword ??
      (
        await prisma.keyword.findFirst({
          where: { projectId: ctx.projectId, origin: vars.origin, destination: vars.destination },
          orderBy: { volume: "desc" },
        })
      )?.keyword ??
      `${vars.originCity} to ${vars.destinationCity} flights`;

    // --- SEO: title + meta -------------------------------------------------
    const titleMax = ctx.brand.seoRules?.titleMaxChars ?? 60;
    const metaMax = ctx.brand.seoRules?.metaMaxChars ?? 158;

    const title = buildTitle(vars, ctx.brand);

    let metaDescription = version.metaDescription;
    if (!metaDescription || metaDescription.length < 60 || metaDescription.length > metaMax) {
      const generated = await ctx.generate({
        task: "meta_description",
        prompt: `Write a meta description under ${metaMax} characters for the ${vars.originCity} to ${vars.destinationCity} route page. Mention the route and what the page helps with. No price claims, no superlatives.`,
        variables: { origin: { city: vars.originCity }, destination: { city: vars.destinationCity } },
        maxTokens: 120,
        complexity: 0.2,
      });
      metaDescription = clampToSentence(generated.text.trim() || metaDescription, metaMax);
    }

    // --- SEO: heading hierarchy -------------------------------------------
    const headingIssues: string[] = [];
    const h1s = [...version.html.matchAll(/<h1[^>]*>/gi)].length;
    if (h1s === 0) headingIssues.push("No H1 on the page");
    if (h1s > 1) headingIssues.push(`${h1s} H1 elements - there must be exactly one`);

    const headingLevels = [...version.html.matchAll(/<h([2-6])[^>]*>/gi)].map((m) => Number(m[1]));
    for (let i = 1; i < headingLevels.length; i++) {
      if (headingLevels[i] - headingLevels[i - 1] > 1) {
        headingIssues.push(`Heading level jumps from H${headingLevels[i - 1]} to H${headingLevels[i]}`);
        break;
      }
    }

    // --- AEO ---------------------------------------------------------------
    const answerBlock = blocks.find((b) => b.componentKey === "answer_block" && b.rendered);
    const answerText = answerBlock
      ? (await prisma.contentItem.findFirst({ where: { pageVersionId: version.id, componentKey: "answer_block" } }))?.text ?? ""
      : "";
    const answerWords = wordCount(answerText);
    const questionHeadings = aeoStored.faqs.every((f) => /\?$/.test(f.question.trim()));

    // --- GEO: entity disambiguation ---------------------------------------
    const values = await entityValues(version.id, vars);
    const entities = [
      {
        name: values.originAirport ?? vars.originCity,
        type: "Airport",
        identifier: vars.origin || null,
        disambiguated: Boolean(values.originAirport && vars.origin && version.html.includes(vars.origin)),
      },
      {
        name: values.destinationAirport ?? vars.destinationCity,
        type: "Airport",
        identifier: vars.destination || null,
        disambiguated: Boolean(values.destinationAirport && vars.destination && version.html.includes(vars.destination)),
      },
      { name: vars.originCity, type: "City", identifier: null, disambiguated: version.html.includes(vars.originCity) },
      { name: vars.destinationCity, type: "City", identifier: null, disambiguated: version.html.includes(vars.destinationCity) },
      ...values.airlines.map((a) => ({ name: a.name, type: "Airline", identifier: a.iata ?? null, disambiguated: version.html.includes(a.name) })),
    ];

    const coverageGaps: string[] = [];
    if (!answerBlock) coverageGaps.push("No extractable direct answer at the top of the page");
    if (aeoStored.faqs.length < 3) coverageGaps.push(`Only ${aeoStored.faqs.length} questions answered; answer engines prefer broader coverage`);
    if (!geoStored.evidence.length) coverageGaps.push("No visible source/evidence block - claims are unattributed to a reader");
    if (!values.airlines.length) coverageGaps.push("No carrier information resolved for this route");

    // --- CFA ---------------------------------------------------------------
    const summaryBlock = blocks.find((b) => b.componentKey === "route_summary" && b.rendered);
    const relationships = [
      `${vars.originCity} --origin-of--> ${vars.originCity}-${vars.destinationCity} route`,
      `${vars.destinationCity} --destination-of--> ${vars.originCity}-${vars.destinationCity} route`,
      ...values.airlines.slice(0, 4).map((a) => `${a.name} --operates--> ${vars.origin}-${vars.destination}`),
    ];

    // --- Structured data ---------------------------------------------------
    const appUrl = env().APP_URL;
    const schemas = generateSchemas({
      url: version.page.url,
      absoluteUrl: `${appUrl}/site${version.page.url}`,
      title,
      metaDescription,
      brandName: ctx.brand.brandName,
      brandUrl: appUrl,
      blocks,
      faqs: aeoStored.faqs,
      breadcrumbs: geoStored.breadcrumbs,
      values: {
        origin: { city: vars.originCity, airportName: values.originAirport, countryCode: values.originCountryCode },
        destination: { city: vars.destinationCity, airportName: values.destinationAirport, countryCode: values.destinationCountryCode },
      },
      lastUpdated: new Date().toISOString(),
    });

    // Persist schemas against the page (replacing the previous set).
    await prisma.schemaMarkup.deleteMany({ where: { pageId: version.pageId } });
    for (const s of schemas) {
      await prisma.schemaMarkup.create({
        data: {
          pageId: version.pageId,
          type: s.type,
          jsonld: JSON.stringify(s.jsonld),
          validationStatus: s.valid ? "VALID" : "INVALID",
          issuesJson: writeJson(s.issues),
        },
      });
    }

    const seo = {
      titleLength: title.length,
      metaLength: metaDescription.length,
      keywordInTitle: title.toLowerCase().includes(vars.destinationCity.toLowerCase()),
      h1Count: h1s,
      headingIssues,
    };
    const aeo = { answerPresent: Boolean(answerBlock), answerWords, faqCount: aeoStored.faqs.length, questionHeadings };
    const geo = { entities, evidenceRows: geoStored.evidence.length, coverageGaps };
    const cfa = { summaryRows: summaryBlock ? 1 : 0, relationships };

    await prisma.pageVersion.update({
      where: { id: version.id },
      data: {
        title,
        metaDescription,
        seoJson: writeJson({ ...readJson<Record<string, unknown>>(version.seoJson, {}), ...seo, primaryKeyword }),
        aeoJson: writeJson({ ...aeoStored, ...aeo }),
        geoJson: writeJson({ ...geoStored, ...geo }),
        schemaJson: writeJson(schemas.map((s) => s.jsonld)),
      },
    });
    await prisma.page.update({ where: { id: version.pageId }, data: { title, metaDescription } });

    const confidence = Math.min(
      0.92,
      0.5 +
        (schemas.every((s) => s.valid) ? 0.15 : 0) +
        (aeo.answerPresent ? 0.12 : 0) +
        (aeo.faqCount >= 3 ? 0.08 : 0) +
        (headingIssues.length === 0 ? 0.07 : 0),
    );

    return {
      output: { pageVersionId: version.id, title, metaDescription, seo, aeo, geo, cfa, schemas: schemas.map((s) => ({ type: s.type, valid: s.valid, issues: s.issues })) },
      confidence,
      summary: `Optimized "${title}" — ${schemas.length} schema block(s), ${aeo.faqCount} FAQs, answer block ${aeo.answerPresent ? `${answerWords} words` : "MISSING"}, ${coverageGaps.length} coverage gap(s).`,
      nextAction: coverageGaps.length ? "Address coverage gaps before the quality gate" : "Propose internal links and run quality control",
    };
  }
}

/** Pull entity values out of the persisted facts for this page's route. */
async function entityValues(pageVersionId: string, vars: { origin: string; destination: string }) {
  const version = await prisma.pageVersion.findUnique({ where: { id: pageVersionId }, select: { pageId: true, page: { select: { projectId: true } } } });
  const facts = version
    ? await prisma.fact.findMany({
        where: { projectId: version.page.projectId, subject: `route:${vars.origin}-${vars.destination}` },
        orderBy: { retrievedAt: "desc" },
      })
    : [];

  const get = (predicate: string) => facts.find((f) => f.predicate === predicate)?.value;

  const airlinesRaw = get("route.airlines");
  let airlines: { name: string; iata?: string }[] = [];
  if (airlinesRaw) {
    try {
      const parsed = JSON.parse(airlinesRaw);
      if (Array.isArray(parsed)) airlines = parsed.map((a: any) => ({ name: a.name ?? String(a), iata: a.iata }));
    } catch {
      airlines = airlinesRaw.split(",").map((n) => ({ name: n.trim() })).filter((a) => a.name);
    }
  }

  return {
    originAirport: get("origin.airportName"),
    destinationAirport: get("destination.airportName"),
    originCountryCode: get("origin.countryCode"),
    destinationCountryCode: get("destination.countryCode"),
    airlines,
  };
}
