/**
 * Master Orchestrator.
 *
 * Given "Create an SEO growth strategy around Delhi to Toronto flights" it
 * decides: which entities are in play, which workflow applies, which stages are
 * actually required, which agents own them, what data is needed, and where a
 * human has to approve. It then emits a plan of structured tasks.
 *
 * It deliberately does NOT do specialist work. Entity parsing and workflow
 * selection are deterministic (auditable, and they work with no LLM); the LLM is
 * used only to narrate the plan when a provider is configured.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { loadAirports } from "@/engine/data/adapters/static-dataset";
import { MASTER_WORKFLOW, MONITORING_WORKFLOW, RESEARCH_ONLY_WORKFLOW, type WorkflowDefinition } from "@/engine/workflow/definitions";
import { agentDefinition } from "@/agents/definitions";
import { riskFor } from "@/control-plane/control-plane";

const InputSchema = z.object({
  objective: z.string().min(5),
  context: z.string().optional(),
  /** Operator can pin entities instead of relying on parsing. */
  entities: z
    .object({ origin: z.string().optional(), destination: z.string().optional() })
    .optional(),
  pageFamilyKey: z.string().optional(),
  workflowKey: z.string().optional(),
});

const PlanStepSchema = z.object({
  step: z.string(),
  name: z.string(),
  agentKey: z.string(),
  agentName: z.string(),
  rationale: z.string(),
  dependsOn: z.array(z.string()),
  requiresApproval: z.boolean(),
  risk: z.string(),
  optional: z.boolean(),
});

const OutputSchema = z.object({
  goalId: z.string(),
  workflowKey: z.string(),
  workflowName: z.string(),
  objectiveType: z.string(),
  entities: z.object({
    origin: z.string().nullable(),
    destination: z.string().nullable(),
    originCity: z.string().nullable(),
    destinationCity: z.string().nullable(),
    unresolved: z.array(z.string()),
  }),
  plan: z.array(PlanStepSchema),
  requiredData: z.array(z.string()),
  approvalMode: z.string(),
  approvalGates: z.array(z.string()),
  narrative: z.string(),
});

export type OrchestratorInput = z.infer<typeof InputSchema>;
export type OrchestratorOutput = z.infer<typeof OutputSchema>;

export class MasterOrchestratorAgent extends BaseAgent<OrchestratorInput, OrchestratorOutput> {
  readonly key = "master_orchestrator";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;

  readonly validationRules: ValidationRule<OrchestratorOutput>[] = [
    { name: "plan_not_empty", check: (o) => o.plan.length > 0, message: "The plan contains no steps" },
    {
      name: "steps_name_real_agents",
      check: (o) => o.plan.every((s) => Boolean(agentDefinition(s.agentKey))),
      message: "A plan step names an agent that is not in the catalog",
    },
    {
      name: "publishing_is_gated",
      check: (o) => o.plan.every((s) => s.agentKey !== "publishing" || s.requiresApproval || o.approvalMode === "AUTOMATIC"),
      message: "A publishing step was planned without an approval gate",
    },
  ];

  protected roleDescription(): string {
    return (
      "You are the Master Orchestrator of an AI Search Growth Operating System for travel websites. " +
      "You interpret business objectives, decide which stages and specialist agents are required, and where a human must approve. " +
      "You never perform specialist work yourself."
    );
  }

  protected async perform(input: OrchestratorInput, ctx: AgentRunContext): Promise<AgentOutcome<OrchestratorOutput>> {
    // --- 1. Understand the objective ---------------------------------------
    const objectiveType = classifyObjective(input.objective);
    const parsed = parseEntities(input.objective);
    const origin = input.entities?.origin ?? parsed.origin;
    const destination = input.entities?.destination ?? parsed.destination;

    const airports = loadAirports();
    const cityFor = (iata: string | null) => (iata ? airports.find((a) => a.iata === iata)?.city ?? null : null);

    const unresolved: string[] = [];
    if (!origin) unresolved.push("origin");
    if (!destination && objectiveType !== "MONITORING") unresolved.push("destination");

    // --- 2. Choose the workflow --------------------------------------------
    const definition: WorkflowDefinition = input.workflowKey
      ? [MASTER_WORKFLOW, RESEARCH_ONLY_WORKFLOW, MONITORING_WORKFLOW].find((w) => w.key === input.workflowKey) ?? MASTER_WORKFLOW
      : objectiveType === "MONITORING"
        ? MONITORING_WORKFLOW
        : objectiveType === "RESEARCH"
          ? RESEARCH_ONLY_WORKFLOW
          : MASTER_WORKFLOW;

    // --- 3. Prune stages that cannot run -----------------------------------
    const website = await prisma.website.findFirst({ where: { projectId: ctx.projectId } });
    const hasWebsite = Boolean(website);

    const plan: OrchestratorOutput["plan"] = [];
    let previousKey: string | null = null;

    for (const step of definition.steps) {
      const def = agentDefinition(step.agentKey);
      if (!def) continue;

      // Stages needing a website are dropped, with the reason recorded.
      if (!hasWebsite && (step.key === "technical_audit" || step.key === "post_publish_audit")) {
        ctx.logger.info("pruning stage - no website connected", { step: step.key });
        continue;
      }

      const risk = riskFor(step.key === "publish" ? "publish" : step.key);
      const approvalDecision = ctx.controlPlane.decideApproval({ action: step.key === "publish" ? "publish" : step.key });

      plan.push({
        step: step.key,
        name: step.name,
        agentKey: step.agentKey,
        agentName: def.name,
        rationale: rationaleFor(step.key, step.description, objectiveType),
        dependsOn: previousKey ? [previousKey] : [],
        requiresApproval: Boolean(step.requiresApproval) || approvalDecision.requiresApproval,
        risk,
        optional: Boolean(step.optional),
      });
      previousKey = step.key;
    }

    // --- 4. Data the plan depends on ---------------------------------------
    const requiredData = [
      "route reference data (distance, typical duration, stops, carriers)",
      "airport reference data for both endpoints",
      "keyword volume, difficulty and intent",
      ...(definition.key === "master_seo_growth" ? ["live flight offers (optional - omitted entirely if no provider is connected)"] : []),
      ...(definition.steps.some((s) => s.key === "search_monitoring") ? ["search performance (Search Console or labelled synthetic series)"] : []),
      ...(definition.steps.some((s) => s.key === "ai_visibility") ? ["answer-engine responses for the prompt library"] : []),
    ];

    // --- 5. Persist the goal + plan ----------------------------------------
    const goal = await prisma.goal.create({
      data: {
        projectId: ctx.projectId,
        objective: input.objective,
        context: input.context,
        status: "PLANNED",
        createdBy: this.key,
        planJson: writeJson({
          workflowKey: definition.key,
          objectiveType,
          entities: { origin, destination },
          plan,
          requiredData,
        }),
      },
    });

    // --- 6. Narrate (LLM when configured; deterministic fallback otherwise) -
    const narrativeResult = await ctx.generate({
      task: "orchestrator_reasoning",
      prompt: `Summarise this plan in 3-5 sentences for a non-technical operator. Objective: "${input.objective}". Workflow: ${definition.name}. Steps: ${plan.map((p) => p.name).join(" -> ")}. Approval mode: ${ctx.controlPlane.context.approvalMode}.`,
      variables: { objective: input.objective, steps: plan.map((p) => ({ name: p.name })) },
      maxTokens: 320,
      complexity: 0.3,
    });

    const approvalGates = plan.filter((p) => p.requiresApproval).map((p) => p.name);
    const confidence = unresolved.length ? 0.55 : plan.length >= 5 ? 0.88 : 0.7;

    return {
      output: {
        goalId: goal.id,
        workflowKey: definition.key,
        workflowName: definition.name,
        objectiveType,
        entities: {
          origin,
          destination,
          originCity: cityFor(origin),
          destinationCity: cityFor(destination),
          unresolved,
        },
        plan,
        requiredData,
        approvalMode: ctx.controlPlane.context.approvalMode,
        approvalGates,
        narrative: narrativeResult.text.trim(),
      },
      confidence,
      summary: `Planned ${plan.length} stage(s) via "${definition.name}" for ${origin ?? "?"}→${destination ?? "?"}. ${approvalGates.length} approval gate(s).${unresolved.length ? ` Unresolved: ${unresolved.join(", ")}.` : ""}`,
      nextAction: unresolved.length
        ? `Specify the ${unresolved.join(" and ")} before running the workflow`
        : `Execute the "${definition.key}" workflow`,
    };
  }
}

/** Objective classification. Deterministic keyword rules, auditable. */
export function classifyObjective(objective: string): "GROWTH" | "RESEARCH" | "MONITORING" | "CONTENT" {
  const o = objective.toLowerCase();
  if (/\b(monitor|track|report|performance|visibility|audit|check)\b/.test(o) && !/\b(create|build|generate|launch)\b/.test(o)) {
    return "MONITORING";
  }
  if (/\b(research|analyse|analyze|explore|investigate|find keywords|keyword research)\b/.test(o) && !/\b(publish|create page|build page)\b/.test(o)) {
    return "RESEARCH";
  }
  if (/\b(write|draft|content|article|copy)\b/.test(o) && !/\b(strategy|growth)\b/.test(o)) return "CONTENT";
  return "GROWTH";
}

/**
 * Entity extraction from a natural-language objective.
 * Matches IATA codes and airport city names from the reference dataset, in the
 * "X to Y" order that travel objectives are almost always phrased in.
 */
export function parseEntities(objective: string): { origin: string | null; destination: string | null } {
  const airports = loadAirports();
  const text = objective.toLowerCase();

  // 1. Explicit "A to B" phrasing with city names.
  const toMatch = text.match(/\b([a-z\s]{3,25}?)\s+to\s+([a-z\s]{3,25}?)\b(?:\s+(?:flights?|route|air))?/);
  if (toMatch) {
    const originCity = airports.find((a) => toMatch[1].trim().endsWith(a.city.toLowerCase()));
    const destCity = airports.find((a) => toMatch[2].trim().startsWith(a.city.toLowerCase()));
    if (originCity && destCity) return { origin: originCity.iata, destination: destCity.iata };
  }

  // 2. IATA codes, in order of appearance.
  const codes = [...objective.matchAll(/\b([A-Z]{3})\b/g)]
    .map((m) => m[1])
    .filter((c) => airports.some((a) => a.iata === c));
  if (codes.length >= 2) return { origin: codes[0], destination: codes[1] };

  // 3. City names anywhere, in order of appearance.
  const found: { iata: string; index: number }[] = [];
  for (const a of airports) {
    const idx = text.indexOf(a.city.toLowerCase());
    if (idx >= 0 && !found.some((f) => f.iata === a.iata)) found.push({ iata: a.iata, index: idx });
  }
  found.sort((x, y) => x.index - y.index);
  if (found.length >= 2) return { origin: found[0].iata, destination: found[1].iata };
  if (found.length === 1) return { origin: found[0].iata, destination: null };
  if (codes.length === 1) return { origin: codes[0], destination: null };

  return { origin: null, destination: null };
}

function rationaleFor(stepKey: string, description: string, objectiveType: string): string {
  const map: Record<string, string> = {
    technical_audit: "Establish the existing inventory so duplication and orphan detection have a baseline.",
    keyword_research: "The objective names entities but not demand; research is required before deciding what to build.",
    opportunity_scoring: "Candidate pages must pass the opportunity gate before any content is generated.",
    content_strategy: "The page family, template and composition policy must exist before generation.",
    content_generation: "Assemble the page from the template, resolved data and generated prose.",
    fact_verification: "Every claim needs an attributed source before the page can be considered publishable.",
    optimization: "Search, answer-engine and generative-engine optimisation are applied to the verified draft.",
    internal_linking: "The page must be connected to the entity graph so it is not an orphan.",
    quality_control: "Final gate: utility, differentiation, data completeness and factual support.",
    publish: "Publishing is a high-risk, outward-facing action and is gated by the project's approval mode.",
    post_publish_audit: "Verify over real HTTP that what was published is technically sound.",
    search_monitoring: "Feed measured search performance back into the strategy.",
    ai_visibility: "Measure mention and citation rates in answer engines and surface uncovered prompts as content gaps.",
  };
  return map[stepKey] ?? `${description} (objective type: ${objectiveType})`;
}
