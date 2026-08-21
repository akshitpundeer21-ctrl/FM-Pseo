/**
 * Workflow engine.
 *
 * Executes a workflow definition step by step, creating a Task and a
 * WorkflowStepRun for each stage so the whole run is observable. It is
 * resumable: when a step needs human approval the run parks in
 * WAITING_APPROVAL with its context persisted, and `resumeWorkflow` picks up
 * exactly where it stopped once the approval is granted.
 */
import { prisma } from "@/core/db/client";
import { readJson, writeJson } from "@/core/db/json";
import { scopedLogger } from "@/core/logging/logger";
import { describeError } from "@/core/errors";
import { ControlPlane } from "@/control-plane/control-plane";
import { audit } from "@/control-plane/audit";
import { createAgent } from "@/agents/registry";
import { createTask, updateTaskStatus } from "@/engine/tasks/task-service";
import { workflowByKey, type WorkflowContext, type WorkflowDefinition, type WorkflowStepDefinition } from "@/engine/workflow/definitions";

const log = scopedLogger("workflow");

export interface StartWorkflowParams {
  workflowKey: string;
  projectId: string;
  goalId?: string;
  websiteId?: string;
  objective: string;
  entities?: WorkflowContext["entities"];
  pageFamilyKey?: string;
  actorId?: string;
}

export interface WorkflowRunResult {
  workflowRunId: string;
  status: string;
  completedSteps: string[];
  waitingOn: { stepKey: string; approvalId: string | null } | null;
  failedStep: string | null;
  error: string | null;
  context: WorkflowContext;
}

export async function startWorkflow(params: StartWorkflowParams): Promise<WorkflowRunResult> {
  const definition = workflowByKey(params.workflowKey);
  if (!definition) throw new Error(`Unknown workflow "${params.workflowKey}"`);

  const project = await prisma.project.findUnique({ where: { id: params.projectId } });
  if (!project) throw new Error(`Project ${params.projectId} not found`);

  const workflowRow = await prisma.workflow.upsert({
    where: { key: definition.key },
    update: { name: definition.name, description: definition.description, stepsJson: stepsMeta(definition) },
    create: {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      version: definition.version,
      stepsJson: stepsMeta(definition),
    },
  });

  const context: WorkflowContext = {
    projectId: params.projectId,
    organizationId: project.organizationId,
    goalId: params.goalId,
    websiteId: params.websiteId,
    objective: params.objective,
    entities: params.entities ?? {},
    pageFamilyKey: params.pageFamilyKey ?? "route",
    outputs: {},
  };

  const run = await prisma.workflowRun.create({
    data: {
      workflowId: workflowRow.id,
      projectId: params.projectId,
      goalId: params.goalId,
      status: "RUNNING",
      inputJson: writeJson({ objective: params.objective, entities: context.entities, pageFamilyKey: context.pageFamilyKey }),
      contextJson: writeJson(context),
      startedAt: new Date(),
    },
  });

  await audit({
    organizationId: project.organizationId,
    projectId: params.projectId,
    actorType: "USER",
    actorId: params.actorId,
    action: "workflow.started",
    entityType: "WORKFLOW_RUN",
    entityId: run.id,
    meta: { workflow: definition.key, objective: params.objective },
  });

  return executeFrom(run.id, definition, context, 0, params.actorId);
}

export async function resumeWorkflow(workflowRunId: string, actorId?: string): Promise<WorkflowRunResult> {
  const run = await prisma.workflowRun.findUnique({ where: { id: workflowRunId }, include: { workflow: true, steps: true } });
  if (!run) throw new Error(`Workflow run ${workflowRunId} not found`);

  const definition = workflowByKey(run.workflow.key);
  if (!definition) throw new Error(`Unknown workflow "${run.workflow.key}"`);

  const context = readJson<WorkflowContext>(run.contextJson, {
    projectId: run.projectId,
    organizationId: "",
    objective: "",
    entities: {},
    pageFamilyKey: "route",
    outputs: {},
  });

  const completed = new Set(run.steps.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").map((s) => s.stepKey));
  const startIndex = definition.steps.findIndex((s) => !completed.has(s.key));
  if (startIndex === -1) {
    await prisma.workflowRun.update({ where: { id: run.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    return {
      workflowRunId: run.id,
      status: "COMPLETED",
      completedSteps: [...completed],
      waitingOn: null,
      failedStep: null,
      error: null,
      context,
    };
  }

  await prisma.workflowRun.update({ where: { id: run.id }, data: { status: "RUNNING" } });
  log.info("resuming workflow", { workflowRunId: run.id, fromStep: definition.steps[startIndex].key });
  return executeFrom(run.id, definition, context, startIndex, actorId);
}

async function executeFrom(
  workflowRunId: string,
  definition: WorkflowDefinition,
  context: WorkflowContext,
  startIndex: number,
  actorId?: string,
): Promise<WorkflowRunResult> {
  const controlPlane = await ControlPlane.forProject(context.projectId, actorId);
  const completedSteps: string[] = [];

  for (let i = startIndex; i < definition.steps.length; i++) {
    const step = definition.steps[i];
    const runLogger = log.child(step.key, { projectId: context.projectId, workflowRunId });

    // --- skip conditions ---------------------------------------------------
    if (step.shouldRun && !step.shouldRun(context)) {
      await recordStep(workflowRunId, step, i, "SKIPPED", null, "Step condition was not met");
      runLogger.info("step skipped by condition");
      completedSteps.push(step.key);
      continue;
    }

    // --- approval gate -----------------------------------------------------
    if (step.requiresApproval) {
      const decision = controlPlane.decideApproval({ action: approvalActionFor(step) });
      if (decision.requiresApproval) {
        const entityId = approvalEntityId(step, context) ?? workflowRunId;
        const approval = await prisma.approval.findFirst({
          where: { projectId: context.projectId, entityType: "PAGE_VERSION", entityId },
          orderBy: { createdAt: "desc" },
        });

        if (!approval || approval.status === "PENDING") {
          const approvalId =
            approval?.id ??
            (await controlPlane.requestApproval({
              entityType: "PAGE_VERSION",
              entityId,
              title: `${step.name} - ${context.outputs.content_generation?.url ?? context.objective}`,
              summary: decision.reason,
              risk: "HIGH",
              requestedBy: "workflow_engine",
              payload: { workflowRunId, stepKey: step.key },
            }));

          await recordStep(workflowRunId, step, i, "WAITING", null, `Awaiting approval ${approvalId}`);
          await prisma.workflowRun.update({
            where: { id: workflowRunId },
            data: { status: "WAITING_APPROVAL", currentStep: step.key, contextJson: writeJson(context) },
          });
          runLogger.warn("workflow paused for approval", { approvalId });

          return {
            workflowRunId,
            status: "WAITING_APPROVAL",
            completedSteps,
            waitingOn: { stepKey: step.key, approvalId },
            failedStep: null,
            error: null,
            context,
          };
        }

        if (approval.status === "REJECTED") {
          await recordStep(workflowRunId, step, i, "FAILED", null, "Approval was rejected by a human reviewer");
          await prisma.workflowRun.update({
            where: { id: workflowRunId },
            data: { status: "CANCELLED", currentStep: step.key, contextJson: writeJson(context), completedAt: new Date() },
          });
          runLogger.warn("workflow cancelled - approval rejected", { approvalId: approval.id });
          return {
            workflowRunId,
            status: "CANCELLED",
            completedSteps,
            waitingOn: null,
            failedStep: step.key,
            error: "Approval rejected",
            context,
          };
        }
      }
    }

    // --- execute -----------------------------------------------------------
    const input = step.buildInput(context);
    const task = await createTask({
      projectId: context.projectId,
      title: step.name,
      goal: step.description,
      agentKey: step.agentKey,
      goalId: context.goalId,
      workflowRunId,
      input,
      requiresApproval: Boolean(step.requiresApproval),
    });

    const stepRun = await recordStep(workflowRunId, step, i, "RUNNING", input, null);
    await updateTaskStatus(task.id, "RUNNING");
    await prisma.workflowRun.update({ where: { id: workflowRunId }, data: { currentStep: step.key } });

    const startedAt = Date.now();
    try {
      const agent = createAgent(step.agentKey, controlPlane);
      const result = await agent.run(input, { taskId: task.id });

      if (!result.ok) throw new Error(result.error ?? "agent failed");

      const halt = step.applyOutput?.(context, result.output) === false;

      await prisma.workflowStepRun.update({
        where: { id: stepRun.id },
        data: {
          status: "COMPLETED",
          outputJson: writeJson(result.output),
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      });
      await updateTaskStatus(task.id, result.escalated ? "REVIEW" : "COMPLETED", {
        output: result.output,
        confidence: result.confidence,
        validationStatus: "PASSED",
      });
      await prisma.workflowRun.update({ where: { id: workflowRunId }, data: { contextJson: writeJson(context) } });

      completedSteps.push(step.key);
      runLogger.info("step completed", { confidence: result.confidence, durationMs: Date.now() - startedAt });

      if (halt) {
        await prisma.workflowRun.update({
          where: { id: workflowRunId },
          data: {
            status: "COMPLETED",
            currentStep: step.key,
            outputJson: writeJson(context.outputs),
            contextJson: writeJson(context),
            completedAt: new Date(),
          },
        });
        runLogger.warn("workflow halted early by step decision", { step: step.key });
        return {
          workflowRunId,
          status: "COMPLETED",
          completedSteps,
          waitingOn: null,
          failedStep: null,
          error: null,
          context,
        };
      }
    } catch (e) {
      const message = describeError(e);
      await prisma.workflowStepRun.update({
        where: { id: stepRun.id },
        data: { status: "FAILED", error: message.slice(0, 2000), completedAt: new Date(), durationMs: Date.now() - startedAt },
      });
      await updateTaskStatus(task.id, "FAILED", { error: message, validationStatus: "FAILED" });
      runLogger.error("step failed", { error: message, optional: Boolean(step.optional) });

      if (step.optional) {
        completedSteps.push(step.key);
        continue;
      }

      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: {
          status: "FAILED",
          currentStep: step.key,
          error: message.slice(0, 2000),
          contextJson: writeJson(context),
          completedAt: new Date(),
        },
      });
      return {
        workflowRunId,
        status: "FAILED",
        completedSteps,
        waitingOn: null,
        failedStep: step.key,
        error: message,
        context,
      };
    }
  }

  await prisma.workflowRun.update({
    where: { id: workflowRunId },
    data: {
      status: "COMPLETED",
      outputJson: writeJson(context.outputs),
      contextJson: writeJson(context),
      completedAt: new Date(),
    },
  });
  log.info("workflow completed", { workflowRunId, steps: completedSteps.length });

  return { workflowRunId, status: "COMPLETED", completedSteps, waitingOn: null, failedStep: null, error: null, context };
}

async function recordStep(
  workflowRunId: string,
  step: WorkflowStepDefinition,
  sequence: number,
  status: string,
  input: unknown,
  error: string | null,
) {
  const existing = await prisma.workflowStepRun.findFirst({ where: { workflowRunId, stepKey: step.key } });
  if (existing) {
    return prisma.workflowStepRun.update({
      where: { id: existing.id },
      data: {
        status,
        error,
        ...(input !== null ? { inputJson: writeJson(input) } : {}),
        ...(status === "RUNNING" ? { startedAt: new Date() } : {}),
      },
    });
  }
  return prisma.workflowStepRun.create({
    data: {
      workflowRunId,
      stepKey: step.key,
      stepName: step.name,
      agentKey: step.agentKey,
      status,
      sequence,
      inputJson: writeJson(input ?? {}),
      requiresApproval: Boolean(step.requiresApproval),
      error,
      ...(status === "RUNNING" ? { startedAt: new Date() } : {}),
    },
  });
}

function approvalActionFor(step: WorkflowStepDefinition): string {
  if (step.key === "publish") return "publish";
  return step.key;
}

function approvalEntityId(step: WorkflowStepDefinition, ctx: WorkflowContext): string | null {
  if (step.key === "publish") return ctx.outputs.content_generation?.pageVersionId ?? null;
  return null;
}

function stepsMeta(definition: WorkflowDefinition): string {
  return writeJson(
    definition.steps.map((s, i) => ({
      key: s.key,
      name: s.name,
      description: s.description,
      agentKey: s.agentKey,
      sequence: i,
      requiresApproval: Boolean(s.requiresApproval),
      optional: Boolean(s.optional),
    })),
  );
}
