/**
 * Content Strategy Agent.
 *
 * Ensures the page family and its template exist, sets the composition policy
 * (the configurable template/dynamic/generated mix), and produces the per-page
 * content plan: which blocks, which questions to answer, which keywords the page
 * owns. Runs before a single word is generated.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readJson, writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { ROUTE_TEMPLATE_BLOCKS, componentByKey } from "@/engine/templates/component-library";
import type { CompositionPolicy } from "@/engine/templates/renderer";

const InputSchema = z.object({
  pageFamilyKey: z.string(),
  opportunityId: z.string().optional(),
  templateKey: z.string().optional(),
  /** Operator override of the family's composition policy. */
  policy: z
    .object({
      minUniqueShare: z.number().min(0).max(1).optional(),
      maxTemplateShare: z.number().min(0).max(1).optional(),
      maxAiShare: z.number().min(0).max(1).optional(),
      minDistinctDataPoints: z.number().int().min(0).optional(),
    })
    .optional(),
});

const OutputSchema = z.object({
  pageFamilyId: z.string(),
  templateId: z.string(),
  templateKey: z.string(),
  blockCount: z.number(),
  requiredBlockCount: z.number(),
  policy: z.object({
    minUniqueShare: z.number().optional(),
    maxTemplateShare: z.number().optional(),
    maxAiShare: z.number().optional(),
    minDistinctDataPoints: z.number().optional(),
  }),
  plan: z.object({
    targetUrl: z.string().nullable(),
    primaryKeyword: z.string().nullable(),
    supportingKeywords: z.array(z.string()),
    questions: z.array(z.string()),
    sections: z.array(z.object({ componentKey: z.string(), source: z.string(), required: z.boolean() })),
  }),
});

export type ContentStrategyInput = z.infer<typeof InputSchema>;
export type ContentStrategyOutput = z.infer<typeof OutputSchema>;

/**
 * Default composition policy for a route family.
 *
 * These numbers are a starting point, stored per family and editable in the
 * dashboard. They are NOT a universal "70/30 rule" - the policy exists so each
 * family can be tuned, and the renderer measures the actual mix against it.
 */
export const DEFAULT_ROUTE_POLICY: CompositionPolicy = {
  minUniqueShare: 0.45,
  maxTemplateShare: 0.55,
  maxAiShare: 0.6,
  minDistinctDataPoints: 8,
};

export class ContentStrategyAgent extends BaseAgent<ContentStrategyInput, ContentStrategyOutput> {
  readonly key = "content_strategy";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;

  readonly validationRules: ValidationRule<ContentStrategyOutput>[] = [
    { name: "has_blocks", check: (o) => o.blockCount > 0, message: "Template has no blocks" },
    { name: "has_required_blocks", check: (o) => o.requiredBlockCount > 0, message: "Template has no required blocks" },
    {
      name: "policy_set",
      check: (o) => o.policy.minUniqueShare !== undefined || o.policy.maxTemplateShare !== undefined,
      message: "No composition policy was set for the family",
    },
  ];

  protected async perform(input: ContentStrategyInput, ctx: AgentRunContext): Promise<AgentOutcome<ContentStrategyOutput>> {
    // --- 1. Page family ----------------------------------------------------
    const family = await prisma.pageFamily.findFirst({ where: { projectId: ctx.projectId, key: input.pageFamilyKey } });
    if (!family) throw new Error(`Page family "${input.pageFamilyKey}" does not exist. Create it before planning content.`);

    const existingComposition = readJson<Record<string, unknown>>(family.compositionJson, {});
    const policy: CompositionPolicy = {
      ...DEFAULT_ROUTE_POLICY,
      ...(existingComposition.policy as CompositionPolicy | undefined),
      ...(input.policy ?? {}),
    };

    await prisma.pageFamily.update({
      where: { id: family.id },
      data: { compositionJson: writeJson({ ...existingComposition, policy }) },
    });

    // --- 2. Template -------------------------------------------------------
    const templateKey = input.templateKey ?? `${family.key}_v1`;
    let template = await prisma.template.findFirst({
      where: { projectId: ctx.projectId, key: templateKey },
      include: { blocks: { include: { component: true }, orderBy: { sequence: "asc" } } },
    });

    if (!template) {
      ctx.logger.info("creating template", { templateKey, family: family.key });
      const created = await prisma.template.create({
        data: {
          projectId: ctx.projectId,
          pageFamilyId: family.id,
          key: templateKey,
          name: `${family.name} template`,
          description: `Reusable block structure for ${family.name}. Structure is shared; substance is resolved per page.`,
          seoConfigJson: writeJson({
            titlePattern: "{originCity} to {destinationCity} Flights | {brand}",
            metaPattern: "Compare {originCity} to {destinationCity} flights: airlines, routings, airports and tips.",
          }),
        },
      });

      let sequence = 0;
      for (const spec of ROUTE_TEMPLATE_BLOCKS) {
        const component = await prisma.componentDef.findUnique({ where: { key: spec.componentKey } });
        if (!component) {
          ctx.logger.warn("component missing from library table - skipping block", { componentKey: spec.componentKey });
          continue;
        }
        const def = componentByKey(spec.componentKey);
        await prisma.templateBlock.create({
          data: {
            templateId: created.id,
            componentId: component.id,
            sequence: sequence++,
            isRequired: spec.isRequired,
            condition: spec.condition ?? null,
            configJson: writeJson(spec.config ?? {}),
            contentSource: def?.contentSource ?? "HYBRID",
          },
        });
      }

      template = await prisma.template.findUnique({
        where: { id: created.id },
        include: { blocks: { include: { component: true }, orderBy: { sequence: "asc" } } },
      });
    }

    if (!template) throw new Error("Template creation failed");

    // --- 3. Content plan ---------------------------------------------------
    let primaryKeyword: string | null = null;
    let supportingKeywords: string[] = [];
    let questions: string[] = [];
    let targetUrl: string | null = null;

    if (input.opportunityId) {
      const opportunity = await prisma.opportunity.findUnique({ where: { id: input.opportunityId } });
      if (opportunity) {
        targetUrl = opportunity.candidateUrl;
        primaryKeyword = opportunity.primaryKeyword;
        const vars = readJson<{ origin?: string; destination?: string }>(opportunity.variablesJson, {});
        const keywords = await prisma.keyword.findMany({
          where: { projectId: ctx.projectId, origin: vars.origin, destination: vars.destination },
          orderBy: { volume: "desc" },
        });
        primaryKeyword = primaryKeyword ?? keywords[0]?.keyword ?? null;
        supportingKeywords = keywords
          .filter((k) => k.keyword !== primaryKeyword && k.intent !== "QUESTION")
          .slice(0, 10)
          .map((k) => k.keyword);
        questions = keywords.filter((k) => k.intent === "QUESTION").slice(0, 6).map((k) => k.keyword);

        // A route page must answer the core questions even if the provider did
        // not surface them as keywords.
        if (questions.length < 3 && vars.origin && vars.destination) {
          const { originCity, destinationCity } = readJson<{ originCity?: string; destinationCity?: string }>(
            opportunity.variablesJson,
            {},
          );
          if (originCity && destinationCity) {
            for (const q of [
              `how long is the flight from ${originCity} to ${destinationCity}`,
              `which airlines fly from ${originCity} to ${destinationCity}`,
              `are there direct flights from ${originCity} to ${destinationCity}`,
            ]) {
              if (!questions.some((existing) => existing.trim().toLowerCase() === q.trim().toLowerCase())) {
                questions.push(q);
              }
            }
          }
        }
      }
    }

    const sections = template.blocks.map((b) => ({
      componentKey: b.component.key,
      source: b.contentSource,
      required: b.isRequired,
    }));

    return {
      output: {
        pageFamilyId: family.id,
        templateId: template.id,
        templateKey: template.key,
        blockCount: template.blocks.length,
        requiredBlockCount: template.blocks.filter((b) => b.isRequired).length,
        policy,
        plan: { targetUrl, primaryKeyword, supportingKeywords, questions, sections },
      },
      confidence: template.blocks.length >= 8 ? 0.85 : 0.6,
      summary: `Family "${family.key}" ready with template "${template.key}" (${template.blocks.length} blocks, ${template.blocks.filter((b) => b.isRequired).length} required). ${questions.length} questions planned.`,
      nextAction: "Generate the page from the template and resolved data",
    };
  }
}
