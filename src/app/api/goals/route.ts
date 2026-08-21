/**
 * POST /api/goals
 *
 * The main entry point: give the Master Orchestrator an objective. It plans,
 * then (unless dryRun) the workflow engine executes the plan by delegating to
 * specialist agents, pausing at any approval gate.
 */
import { z } from "zod";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { ControlPlane } from "@/control-plane/control-plane";
import { createAgent } from "@/agents/registry";
import { startWorkflow } from "@/engine/workflow/engine";
import { prisma } from "@/core/db/client";

const Body = z.object({
  objective: z.string().min(5).max(500),
  context: z.string().max(2000).optional(),
  origin: z.string().max(60).optional(),
  destination: z.string().max(60).optional(),
  pageFamilyKey: z.string().max(60).optional(),
  workflowKey: z.string().max(60).optional(),
  /** Plan only - do not execute. */
  dryRun: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const auth = await guard("task:run", 20);
    const body = await parseBody(req, Body);
    const project = await activeProject(auth);

    const controlPlane = await ControlPlane.forProject(project.id, auth.userId);
    const orchestrator = createAgent("master_orchestrator", controlPlane);

    const planResult = await orchestrator.run({
      objective: body.objective,
      context: body.context,
      entities: body.origin || body.destination ? { origin: body.origin, destination: body.destination } : undefined,
      workflowKey: body.workflowKey,
    });

    if (!planResult.ok) {
      return ok(
        { ok: false, stage: "planning", error: planResult.error, agentRunId: planResult.agentRunId },
        200,
      );
    }

    const plan = planResult.output as any;

    if (body.dryRun) {
      return ok({ ok: true, dryRun: true, plan, agentRunId: planResult.agentRunId });
    }

    if (plan.entities.unresolved.length) {
      return ok({
        ok: false,
        stage: "planning",
        plan,
        error: `Could not resolve ${plan.entities.unresolved.join(" and ")} from the objective. Name the cities or IATA codes explicitly.`,
      });
    }

    const website = await prisma.website.findFirst({ where: { projectId: project.id } });

    const run = await startWorkflow({
      workflowKey: body.workflowKey ?? plan.workflowKey,
      projectId: project.id,
      goalId: plan.goalId,
      websiteId: website?.id,
      objective: body.objective,
      entities: {
        origin: plan.entities.origin,
        destination: plan.entities.destination,
        originCity: plan.entities.originCity,
        destinationCity: plan.entities.destinationCity,
      },
      pageFamilyKey: body.pageFamilyKey ?? "route",
      actorId: auth.userId,
    });

    await prisma.goal.update({
      where: { id: plan.goalId },
      data: { status: run.status === "COMPLETED" ? "COMPLETED" : run.status === "FAILED" ? "FAILED" : "RUNNING" },
    });

    return ok({
      ok: run.status !== "FAILED",
      plan,
      workflowRunId: run.workflowRunId,
      status: run.status,
      completedSteps: run.completedSteps,
      waitingOn: run.waitingOn,
      failedStep: run.failedStep,
      error: run.error,
      outputs: run.context.outputs,
    });
  } catch (e) {
    return fail(e);
  }
}
