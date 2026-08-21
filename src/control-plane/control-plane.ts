/**
 * Agent Control Plane.
 *
 * The single chokepoint between "an agent wants to do something" and "it
 * happens". It owns:
 *   - agent identity + capability checks
 *   - tool permission checks (an agent may only use tools on its allowlist)
 *   - budget enforcement before spend
 *   - approval policy (MANUAL / SEMI_AUTOMATIC / AUTOMATIC)
 *   - escalation when confidence is below threshold
 *   - audit logging of every decision
 *
 * Nothing in the agent layer talks to a tool or a publisher without passing
 * through here first.
 */
import { prisma } from "@/core/db/client";
import { readStringArray, writeJson } from "@/core/db/json";
import { scopedLogger } from "@/core/logging/logger";
import { ApprovalRequiredError, ForbiddenError, NotFoundError, ToolNotPermittedError } from "@/core/errors";
import { ApprovalModeSchema, type ApprovalMode, type Capability, type RiskLevel } from "@/core/types/enums";
import { assertBudgetAvailable, recordUsage } from "@/control-plane/budget";
import { audit } from "@/control-plane/audit";

const log = scopedLogger("control-plane");

export interface AgentIdentity {
  id: string;
  key: string;
  name: string;
  kind: string;
  allowedTools: string[];
  capabilities: Capability[];
  confidenceThreshold: number;
  maxRetries: number;
  timeoutMs: number;
  modelTier: string;
  isEnabled: boolean;
}

export interface ExecutionContext {
  organizationId: string;
  projectId: string;
  /** Human on whose behalf the run happens (for audit + approvals). */
  actorId?: string;
  approvalMode: ApprovalMode;
  confidenceThreshold: number;
  /** Actions the project explicitly allows to run unattended in AUTOMATIC mode. */
  autoApprovedActions: string[];
}

/** Risk classification per action type. Publishing is never LOW. */
const ACTION_RISK: Record<string, RiskLevel> = {
  keyword_research: "LOW",
  opportunity_scoring: "LOW",
  page_family_create: "MEDIUM",
  template_configure: "MEDIUM",
  content_generate: "MEDIUM",
  fact_verify: "LOW",
  optimize: "LOW",
  internal_link: "LOW",
  schema_generate: "LOW",
  quality_control: "LOW",
  publish: "HIGH",
  unpublish: "HIGH",
  rollback: "HIGH",
  crawl: "LOW",
  ai_visibility_run: "LOW",
};

export function riskFor(action: string): RiskLevel {
  return ACTION_RISK[action] ?? "MEDIUM";
}

export class ControlPlane {
  constructor(private readonly ctx: ExecutionContext) {}

  get context(): ExecutionContext {
    return this.ctx;
  }

  static async forProject(projectId: string, actorId?: string): Promise<ControlPlane> {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundError("Project", projectId);
    const settings = JSON.parse(project.settingsJson || "{}") as { autoApprovedActions?: string[] };
    return new ControlPlane({
      organizationId: project.organizationId,
      projectId: project.id,
      actorId,
      approvalMode: ApprovalModeSchema.catch("SEMI_AUTOMATIC").parse(project.approvalMode),
      confidenceThreshold: project.confidenceThreshold,
      autoApprovedActions: settings.autoApprovedActions ?? [],
    });
  }

  // --- identity -----------------------------------------------------------

  async identify(agentKey: string): Promise<AgentIdentity> {
    const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
    if (!agent) throw new NotFoundError("Agent", agentKey);
    if (!agent.isEnabled) throw new ForbiddenError(`Agent "${agentKey}" is disabled`);

    return {
      id: agent.id,
      key: agent.key,
      name: agent.name,
      kind: agent.kind,
      allowedTools: readStringArray(agent.allowedToolsJson),
      capabilities: readStringArray(agent.permissionsJson) as Capability[],
      confidenceThreshold: agent.confidenceThreshold,
      maxRetries: agent.maxRetries,
      timeoutMs: agent.timeoutMs,
      modelTier: agent.modelTier,
      isEnabled: agent.isEnabled,
    };
  }

  // --- permissions --------------------------------------------------------

  assertCapability(agent: AgentIdentity, capability: Capability) {
    if (!agent.capabilities.includes(capability)) {
      log.warn("capability denied", { agent: agent.key, capability, projectId: this.ctx.projectId });
      throw new ForbiddenError(`Agent "${agent.key}" lacks capability "${capability}"`, {
        agentKey: agent.key,
        capability,
        granted: agent.capabilities,
      });
    }
  }

  assertToolAllowed(agent: AgentIdentity, toolKey: string) {
    // "*" is never granted by seed data; it exists so an operator can debug.
    if (agent.allowedTools.includes("*")) return;
    if (!agent.allowedTools.includes(toolKey)) {
      log.warn("tool denied", { agent: agent.key, tool: toolKey, projectId: this.ctx.projectId });
      throw new ToolNotPermittedError(agent.key, toolKey);
    }
  }

  async assertCanSpend(agent: AgentIdentity, what: string) {
    this.assertCapability(agent, "spend_budget");
    return assertBudgetAvailable(this.ctx.organizationId, `${agent.key}:${what}`);
  }

  async chargeUsage(params: { tokensIn: number; tokensOut: number; costUsd: number; category?: string }) {
    await recordUsage({
      organizationId: this.ctx.organizationId,
      projectId: this.ctx.projectId,
      category: params.category ?? "llm",
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      costUsd: params.costUsd,
    });
  }

  // --- approval policy ----------------------------------------------------

  /**
   * Decide whether an action may proceed unattended.
   * Defaults are deliberately conservative: publishing always needs a human
   * unless the project is in AUTOMATIC mode AND the action is explicitly
   * allowlisted.
   */
  decideApproval(params: { action: string; confidence?: number; risk?: RiskLevel }): {
    requiresApproval: boolean;
    reason: string;
    risk: RiskLevel;
  } {
    const risk = params.risk ?? riskFor(params.action);
    const mode = this.ctx.approvalMode;
    const confidence = params.confidence ?? 1;
    const lowConfidence = confidence < this.ctx.confidenceThreshold;

    if (mode === "MANUAL") {
      return { requiresApproval: true, reason: "Project approval mode is MANUAL - every action is reviewed", risk };
    }

    if (mode === "AUTOMATIC") {
      if (this.ctx.autoApprovedActions.includes(params.action)) {
        if (lowConfidence) {
          return {
            requiresApproval: true,
            reason: `Action is allowlisted but confidence ${confidence.toFixed(2)} is below threshold ${this.ctx.confidenceThreshold}`,
            risk,
          };
        }
        return { requiresApproval: false, reason: `Action "${params.action}" is explicitly allowlisted for autonomous execution`, risk };
      }
      return {
        requiresApproval: true,
        reason: `AUTOMATIC mode only runs allowlisted actions unattended; "${params.action}" is not allowlisted`,
        risk,
      };
    }

    // SEMI_AUTOMATIC
    if (risk === "HIGH") {
      return { requiresApproval: true, reason: `High-risk action "${params.action}" always requires approval`, risk };
    }
    if (lowConfidence) {
      return {
        requiresApproval: true,
        reason: `Confidence ${confidence.toFixed(2)} is below the project threshold ${this.ctx.confidenceThreshold}`,
        risk,
      };
    }
    return { requiresApproval: false, reason: `Low/medium-risk action with sufficient confidence`, risk };
  }

  /** Create (or reuse) a pending approval request and return its id. */
  async requestApproval(params: {
    entityType: string;
    entityId: string;
    title: string;
    summary?: string;
    risk?: RiskLevel;
    requestedBy: string;
    pageId?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const existing = await prisma.approval.findFirst({
      where: { projectId: this.ctx.projectId, entityType: params.entityType, entityId: params.entityId, status: "PENDING" },
    });
    if (existing) return existing.id;

    const approval = await prisma.approval.create({
      data: {
        projectId: this.ctx.projectId,
        entityType: params.entityType,
        entityId: params.entityId,
        pageId: params.pageId,
        taskId: params.taskId,
        title: params.title,
        summary: params.summary ?? "",
        riskLevel: params.risk ?? "MEDIUM",
        requestedBy: params.requestedBy,
        payloadJson: writeJson(params.payload ?? {}),
      },
    });

    await audit({
      organizationId: this.ctx.organizationId,
      projectId: this.ctx.projectId,
      actorType: "AGENT",
      actorId: params.requestedBy,
      action: "approval.requested",
      entityType: params.entityType,
      entityId: params.entityId,
      meta: { approvalId: approval.id, title: params.title },
    });

    log.info("approval requested", { projectId: this.ctx.projectId, approvalId: approval.id, title: params.title });
    return approval.id;
  }

  /** Throw unless the given entity has an APPROVED approval on record. */
  async assertApproved(entityType: string, entityId: string, action: string) {
    const approval = await prisma.approval.findFirst({
      where: { projectId: this.ctx.projectId, entityType, entityId },
      orderBy: { createdAt: "desc" },
    });
    if (!approval || approval.status !== "APPROVED") {
      throw new ApprovalRequiredError(action, approval?.id);
    }
    return approval;
  }

  async logDecision(params: {
    action: string;
    agentKey: string;
    allowed: boolean;
    reason: string;
    entityType?: string;
    entityId?: string;
  }) {
    await audit({
      organizationId: this.ctx.organizationId,
      projectId: this.ctx.projectId,
      actorType: "AGENT",
      actorId: params.agentKey,
      action: `control_plane.${params.allowed ? "allow" : "deny"}:${params.action}`,
      entityType: params.entityType,
      entityId: params.entityId,
      meta: { reason: params.reason },
    });
  }
}
