/**
 * Tool Registry + mediated executor.
 *
 * This is the only place a tool is ever invoked. The sequence is fixed:
 *   allowlist check -> capability check -> budget check -> input validation ->
 *   credential resolution -> timed execution with retries -> output validation
 *   -> ToolInvocation record.
 *
 * A failure at any stage is recorded and surfaced; nothing fails silently.
 */
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { env } from "@/core/config/env";
import { scopedLogger } from "@/core/logging/logger";
import { AppError, NotFoundError, ToolError, ValidationError, describeError, toAppError } from "@/core/errors";
import type { AgentIdentity, ControlPlane } from "@/control-plane/control-plane";
import { resolveCredentials } from "@/integrations/service";
import type { ToolContext, ToolDefinition, ToolResult } from "@/tools/types";

const registry = new Map<string, ToolDefinition>();
const log = scopedLogger("tools");

export function registerTool<I, O>(tool: ToolDefinition<I, O>) {
  if (registry.has(tool.key)) throw new Error(`Duplicate tool key: ${tool.key}`);
  registry.set(tool.key, tool as ToolDefinition);
  return tool;
}

export function getTool(key: string): ToolDefinition {
  const tool = registry.get(key);
  if (!tool) throw new NotFoundError("Tool", key);
  return tool;
}

export function listTools(): ToolDefinition[] {
  return [...registry.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function describeTools() {
  return listTools().map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    category: t.category,
    requiredCapability: t.requiredCapability,
    integrationProvider: t.integrationProvider ?? null,
    allowMockFallback: t.allowMockFallback,
    costly: Boolean(t.costly),
  }));
}

async function withTimeout<T>(p: Promise<T>, ms: number, toolKey: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError(toolKey, `timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ExecuteOptions {
  controlPlane: ControlPlane;
  agent: AgentIdentity;
  agentRunId?: string;
  taskId?: string;
  /**
   * Optional narrowing from the resolved skills (agent allowlist ∩ skill
   * requests). This can only RESTRICT: the control-plane check against the
   * agent's own allowlist runs first and independently, so a skill can never
   * grant access to a tool the agent does not hold.
   */
  skillScopedTools?: string[];
}

/**
 * Execute a tool on behalf of an agent. Throws AppError on failure so the
 * caller (BaseAgent) can decide between retry, escalate and fail.
 */
export async function executeTool<I = any, O = any>(
  toolKey: string,
  input: I,
  opts: ExecuteOptions,
): Promise<ToolResult<O>> {
  const tool = getTool(toolKey);
  const { controlPlane, agent } = opts;
  const ctxInfo = controlPlane.context;
  const started = Date.now();

  let isMock = false;
  let costUsd = 0;

  const toolLogger = log.child(tool.key, { projectId: ctxInfo.projectId, agentRunId: opts.agentRunId });

  const record = async (status: string, error: string | null, responseSummary: string, integrationId: string | null) => {
    await prisma.toolInvocation
      .create({
        data: {
          agentRunId: opts.agentRunId,
          toolKey: tool.key,
          integrationId,
          status,
          requestJson: writeJson(safeInput(input)),
          responseSummary: responseSummary.slice(0, 1000),
          latencyMs: Date.now() - started,
          costUsd,
          isMock,
          error,
        },
      })
      .catch((e) => toolLogger.error("failed to record tool invocation", { error: (e as Error).message }));
  };

  try {
    // 1-2. Permission gates. The agent allowlist is authoritative; the skill
    // scope is a second, narrower gate applied on top of it.
    controlPlane.assertToolAllowed(agent, tool.key);
    controlPlane.assertCapability(agent, tool.requiredCapability);

    if (opts.skillScopedTools && !opts.skillScopedTools.includes(tool.key)) {
      toolLogger.warn("tool outside the resolved skill scope", {
        agent: agent.key,
        tool: tool.key,
        effective: opts.skillScopedTools,
      });
      throw new AppError(
        "TOOL_NOT_PERMITTED",
        `Tool "${tool.key}" is outside the tool scope resolved from this agent's skills. Effective scope: ${opts.skillScopedTools.join(", ") || "(none)"}.`,
        { status: 403, details: { agentKey: agent.key, toolKey: tool.key, effectiveTools: opts.skillScopedTools } },
      );
    }

    // 3. Budget gate for anything that can spend vendor money.
    if (tool.costly) await controlPlane.assertCanSpend(agent, tool.key);

    // 4. Input validation.
    const parsedInput = tool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ValidationError(`Invalid input for tool "${tool.key}"`, parsedInput.error.flatten());
    }

    // 5. Credentials (server-side only).
    let credentials = null as Awaited<ReturnType<typeof resolveCredentials>> | null;
    if (tool.integrationProvider) {
      credentials = await resolveCredentials(ctxInfo.organizationId, tool.integrationProvider, ctxInfo.projectId);
      if (!credentials.configured && !tool.allowMockFallback) {
        throw new AppError(
          "INTEGRATION_NOT_CONFIGURED",
          `Tool "${tool.key}" requires the "${tool.integrationProvider}" integration. Missing: ${credentials.missing.join(", ")}.`,
          { details: { provider: tool.integrationProvider, missing: credentials.missing } },
        );
      }
      if (!credentials.configured && !env().DEMO_MODE) {
        throw new AppError(
          "INTEGRATION_NOT_CONFIGURED",
          `Tool "${tool.key}" has no credentials and DEMO_MODE is off, so no mock fallback is permitted.`,
          { details: { provider: tool.integrationProvider, missing: credentials.missing } },
        );
      }
    }

    const toolCtx: ToolContext = {
      organizationId: ctxInfo.organizationId,
      projectId: ctxInfo.projectId,
      agentKey: agent.key,
      agentRunId: opts.agentRunId,
      taskId: opts.taskId,
      controlPlane,
      logger: toolLogger,
      credentials,
      markMock: () => {
        isMock = true;
      },
      charge: async (usd, meta) => {
        costUsd += usd;
        await controlPlane.chargeUsage({
          tokensIn: meta?.tokensIn ?? 0,
          tokensOut: meta?.tokensOut ?? 0,
          costUsd: usd,
          category: meta?.category ?? "tool",
        });
      },
    };

    // 6. Execute with timeout + retries.
    const maxAttempts = (tool.retries ?? 1) + 1;
    const timeoutMs = tool.timeoutMs ?? env().AGENT_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const raw = await withTimeout(tool.execute(parsedInput.data, toolCtx), timeoutMs, tool.key);
        const parsedOutput = tool.outputSchema.safeParse(raw);
        if (!parsedOutput.success) {
          throw new ToolError(tool.key, "returned an output that failed its own schema", parsedOutput.error.flatten());
        }
        await record("SUCCESS", null, summarise(parsedOutput.data), credentials?.integrationId ?? null);
        toolLogger.debug("tool succeeded", { attempt, isMock, latencyMs: Date.now() - started });
        return { ok: true, output: parsedOutput.data as O, toolKey: tool.key, latencyMs: Date.now() - started, isMock, costUsd };
      } catch (e) {
        lastError = e;
        const appErr = toAppError(e);
        const willRetry = attempt < maxAttempts && appErr.retryable;
        toolLogger.warn(`tool attempt ${attempt}/${maxAttempts} failed`, {
          error: appErr.message,
          code: appErr.code,
          willRetry,
        });
        if (!willRetry) break;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    throw lastError;
  } catch (e) {
    const message = describeError(e);
    await record("FAILED", message, "", null);
    toolLogger.error("tool failed", { error: message });
    throw toAppError(e);
  }
}

/** Strip anything credential-shaped before an input is persisted. */
function safeInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const clone: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of Object.keys(clone)) {
    if (/key|secret|password|token|credential/i.test(key)) clone[key] = "[redacted]";
  }
  return clone;
}

function summarise(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output.slice(0, 500);
  if (Array.isArray(output)) return `array(${output.length})`;
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    const parts = Object.entries(o)
      .slice(0, 8)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : typeof v === "object" ? "{…}" : String(v).slice(0, 60)}`);
    return parts.join(", ");
  }
  return String(output);
}

/** Test helper - clears the registry between suites. */
export function __resetToolRegistry() {
  registry.clear();
}
