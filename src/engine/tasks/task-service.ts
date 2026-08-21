/**
 * Task system.
 *
 * Every meaningful action becomes a Task row before it runs, so the dashboard
 * can show what the system intends to do, what it is doing, and what it did -
 * including work that is waiting on a human.
 */
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { scopedLogger } from "@/core/logging/logger";
import { TERMINAL_TASK_STATUSES, type TaskStatus, type ValidationStatus } from "@/core/types/enums";

const log = scopedLogger("tasks");

export interface CreateTaskParams {
  projectId: string;
  title: string;
  goal: string;
  agentKey?: string;
  goalId?: string;
  parentTaskId?: string;
  workflowRunId?: string;
  input?: unknown;
  priority?: number;
  requiresApproval?: boolean;
  dependencies?: string[];
}

export async function createTask(params: CreateTaskParams) {
  const agent = params.agentKey ? await prisma.agent.findUnique({ where: { key: params.agentKey } }) : null;

  const task = await prisma.task.create({
    data: {
      projectId: params.projectId,
      goalId: params.goalId,
      parentTaskId: params.parentTaskId,
      workflowRunId: params.workflowRunId,
      agentId: agent?.id,
      title: params.title,
      goal: params.goal,
      status: "PENDING",
      priority: params.priority ?? 50,
      inputJson: writeJson(params.input ?? {}),
      dependenciesJson: writeJson(params.dependencies ?? []),
      requiresApproval: params.requiresApproval ?? false,
    },
  });

  log.info("task created", { projectId: params.projectId, taskId: task.id, title: params.title, agent: params.agentKey });
  return task;
}

export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra: { output?: unknown; error?: string; confidence?: number; validationStatus?: ValidationStatus } = {},
) {
  const now = new Date();
  const data: Record<string, unknown> = { status };

  if (status === "RUNNING") data.startedAt = now;
  if (TERMINAL_TASK_STATUSES.includes(status)) data.completedAt = now;
  if (extra.output !== undefined) data.outputJson = writeJson(extra.output);
  if (extra.error !== undefined) data.error = extra.error.slice(0, 2000);
  if (extra.confidence !== undefined) data.confidence = extra.confidence;
  if (extra.validationStatus !== undefined) data.validationStatus = extra.validationStatus;
  if (status === "RUNNING") data.attempts = { increment: 1 };

  return prisma.task.update({ where: { id: taskId }, data });
}

export async function taskTree(projectId: string, limit = 100) {
  return prisma.task.findMany({
    where: { projectId },
    include: { agent: { select: { key: true, name: true } }, runs: { select: { id: true, status: true, latencyMs: true, costUsd: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function pendingApprovalTasks(projectId: string) {
  return prisma.task.findMany({
    where: { projectId, status: { in: ["WAITING", "REVIEW"] } },
    include: { agent: { select: { key: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function taskCounts(projectId: string) {
  const rows = await prisma.task.groupBy({ by: ["status"], where: { projectId }, _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}
