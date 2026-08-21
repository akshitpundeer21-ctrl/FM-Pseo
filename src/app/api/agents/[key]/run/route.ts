/**
 * POST /api/agents/:key/run
 *
 * Run one agent directly with an explicit input. Used by the dashboard's
 * per-agent "Run" actions (crawl now, refresh search performance, run the AI
 * visibility library, re-link a page…). The Control Plane still applies every
 * permission, budget and approval rule.
 */
import { z } from "zod";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { ControlPlane } from "@/control-plane/control-plane";
import { createAgent, implementedAgentKeys } from "@/agents/registry";
import { NotFoundError } from "@/core/errors";
import { createTask, updateTaskStatus } from "@/engine/tasks/task-service";
import { agentDefinition } from "@/agents/definitions";

const Body = z.object({ input: z.record(z.string(), z.unknown()).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const auth = await guard("task:run", 40);
    const { key } = await params;
    if (!implementedAgentKeys().includes(key)) throw new NotFoundError("Agent", key);

    const body = await parseBody(req, Body);
    const project = await activeProject(auth);
    const definition = agentDefinition(key);

    const task = await createTask({
      projectId: project.id,
      title: `Manual run: ${definition?.name ?? key}`,
      goal: `Operator-initiated run of the ${definition?.name ?? key}`,
      agentKey: key,
      input: body.input ?? {},
    });

    const controlPlane = await ControlPlane.forProject(project.id, auth.userId);
    const agent = createAgent(key, controlPlane);

    await updateTaskStatus(task.id, "RUNNING");
    const result = await agent.run(body.input ?? {}, { taskId: task.id });

    await updateTaskStatus(task.id, result.ok ? (result.escalated ? "REVIEW" : "COMPLETED") : "FAILED", {
      output: result.output,
      error: result.error,
      confidence: result.confidence,
      validationStatus: result.ok ? "PASSED" : "FAILED",
    });

    return ok({
      ok: result.ok,
      agentRunId: result.agentRunId,
      taskId: task.id,
      summary: result.summary,
      nextAction: result.nextAction,
      confidence: result.confidence,
      escalated: result.escalated,
      isMock: result.isMock,
      toolsUsed: result.toolsUsed,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      error: result.error,
      output: result.output,
    });
  } catch (e) {
    return fail(e);
  }
}
