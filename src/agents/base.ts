/**
 * BaseAgent.
 *
 * Every agent gets, for free and identically:
 *   identity + capability resolution, typed input/output validation, skill and
 *   brand injection, mediated tool access, retries, timeout, confidence scoring,
 *   validation rules, structured logging, cost accounting and an AgentRun record
 *   that makes the whole thing observable in the dashboard.
 *
 * Subclasses implement `perform()` and nothing else about the plumbing.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { env } from "@/core/config/env";
import { scopedLogger, type Logger } from "@/core/logging/logger";
import { AgentError, AgentTimeoutError, describeError, toAppError } from "@/core/errors";
import type { AgentIdentity, ControlPlane } from "@/control-plane/control-plane";
import { executeTool } from "@/tools/registry";
import "@/tools/definitions";
import { renderSkills, skillsForAgent, type LoadedSkill } from "@/skills/registry";
import { loadBrand, renderBrand, type BrandKnowledge } from "@/modules/brand/brand";

export interface AgentRunContext {
  identity: AgentIdentity;
  controlPlane: ControlPlane;
  projectId: string;
  organizationId: string;
  agentRunId: string;
  taskId?: string;
  logger: Logger;
  skills: LoadedSkill[];
  brand: BrandKnowledge | null;
  /** Composed system prompt: role + skills + brand. */
  systemPrompt: string;
  /** Mediated tool call. Throws AppError on failure. */
  tool: <O = any>(toolKey: string, input: unknown) => Promise<O>;
  /** Convenience wrapper over the llm.generate tool. */
  generate: (params: {
    task: string;
    prompt: string;
    variables?: Record<string, unknown>;
    tier?: "fast" | "balanced" | "deep";
    maxTokens?: number;
    temperature?: number;
    complexity?: number;
  }) => Promise<{ text: string; isMock: boolean; model: string; provider: string }>;
}

export interface AgentOutcome<O> {
  output: O;
  /** 0..1 self-assessment. Below the agent's threshold triggers escalation. */
  confidence: number;
  summary: string;
  nextAction?: string;
}

export interface ValidationRule<O> {
  name: string;
  check: (output: O) => boolean;
  message: string;
  severity?: "ERROR" | "WARNING";
}

export interface RunOptions {
  taskId?: string;
  /** Skip the AgentRun record (used by dry-run planning). */
  ephemeral?: boolean;
}

export interface AgentRunResult<O> {
  ok: boolean;
  agentRunId: string;
  output?: O;
  confidence: number;
  summary: string;
  nextAction?: string;
  error?: string;
  escalated: boolean;
  toolsUsed: string[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  isMock: boolean;
  validation: { name: string; passed: boolean; message: string; severity: string }[];
}

export abstract class BaseAgent<I, O> {
  abstract readonly key: string;
  abstract readonly inputSchema: z.ZodType<I>;
  abstract readonly outputSchema: z.ZodType<O>;
  /** Rules applied to the agent's own output before it is accepted. */
  readonly validationRules: ValidationRule<O>[] = [];
  /** Set false for agents that do not need brand knowledge (e.g. crawling). */
  protected readonly needsBrand: boolean = true;

  constructor(protected readonly controlPlane: ControlPlane) {}

  protected abstract perform(input: I, ctx: AgentRunContext): Promise<AgentOutcome<O>>;

  /** Role line prepended to the system prompt. Overridable. */
  protected roleDescription(identity: AgentIdentity): string {
    return `You are the ${identity.name}. ${identity.kind === "ORCHESTRATOR" ? "You coordinate other agents and never do specialist work yourself." : "You perform one specialist job well and hand structured output back to the orchestrator."}`;
  }

  async run(input: I, opts: RunOptions = {}): Promise<AgentRunResult<O>> {
    const started = Date.now();
    const ctxInfo = this.controlPlane.context;
    const identity = await this.controlPlane.identify(this.key);

    const parsedInput = this.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new AgentError(this.key, "input failed schema validation", parsedInput.error.flatten());
    }

    const agentRun = await prisma.agentRun.create({
      data: {
        agentId: identity.id,
        projectId: ctxInfo.projectId,
        taskId: opts.taskId,
        status: "RUNNING",
        inputSummary: summarise(parsedInput.data),
        inputJson: writeJson(parsedInput.data),
      },
    });

    const logger = scopedLogger(`agent.${this.key}`, {
      projectId: ctxInfo.projectId,
      agentRunId: agentRun.id,
      taskId: opts.taskId,
    });

    const toolsUsed: string[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let sawMock = false;

    const skills = await skillsForAgent(this.key);
    const brand = this.needsBrand ? await loadBrand(ctxInfo.projectId).catch(() => null) : null;

    const systemPrompt = [
      this.roleDescription(identity),
      brand ? renderBrand(brand) : "",
      renderSkills(skills),
      "Follow the hard rules exactly. If required information is missing, say so and omit the claim rather than guessing.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const ctx: AgentRunContext = {
      identity,
      controlPlane: this.controlPlane,
      projectId: ctxInfo.projectId,
      organizationId: ctxInfo.organizationId,
      agentRunId: agentRun.id,
      taskId: opts.taskId,
      logger,
      skills,
      brand,
      systemPrompt,
      tool: async <T = any>(toolKey: string, toolInput: unknown): Promise<T> => {
        const res = await executeTool<unknown, T>(toolKey, toolInput, {
          controlPlane: this.controlPlane,
          agent: identity,
          agentRunId: agentRun.id,
          taskId: opts.taskId,
        });
        if (!toolsUsed.includes(toolKey)) toolsUsed.push(toolKey);
        costUsd += res.costUsd;
        if (res.isMock) sawMock = true;
        return res.output as T;
      },
      generate: async (params) => {
        const res = await ctx.tool<{
          text: string;
          isMock: boolean;
          model: string;
          provider: string;
          tokensIn: number;
          tokensOut: number;
        }>("llm.generate", {
          task: params.task,
          system: systemPrompt,
          prompt: params.prompt,
          variables: params.variables,
          tier: params.tier ?? (identity.modelTier as "fast" | "balanced" | "deep"),
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          complexity: params.complexity,
        });
        tokensIn += res.tokensIn;
        tokensOut += res.tokensOut;
        return { text: res.text, isMock: res.isMock, model: res.model, provider: res.provider };
      },
    };

    const timeoutMs = identity.timeoutMs || env().AGENT_TIMEOUT_MS;
    const maxAttempts = (identity.maxRetries ?? env().AGENT_MAX_RETRIES) + 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.info(`run started (attempt ${attempt}/${maxAttempts})`);
        const outcome = await withTimeout(this.perform(parsedInput.data, ctx), timeoutMs, this.key);

        const parsedOutput = this.outputSchema.safeParse(outcome.output);
        if (!parsedOutput.success) {
          throw new AgentError(this.key, "output failed schema validation", parsedOutput.error.flatten());
        }

        const validation = this.validationRules.map((rule) => {
          let passed = false;
          try {
            passed = rule.check(parsedOutput.data);
          } catch {
            passed = false;
          }
          return { name: rule.name, passed, message: rule.message, severity: rule.severity ?? "ERROR" };
        });
        const hardFailure = validation.find((v) => !v.passed && v.severity === "ERROR");
        if (hardFailure) {
          throw new AgentError(this.key, `validation rule "${hardFailure.name}" failed: ${hardFailure.message}`, validation);
        }

        const escalated = outcome.confidence < identity.confidenceThreshold;
        const latencyMs = Date.now() - started;

        await prisma.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: escalated ? "ESCALATED" : "SUCCEEDED",
            outputSummary: outcome.summary.slice(0, 1000),
            outputJson: writeJson(parsedOutput.data),
            toolsUsedJson: writeJson(toolsUsed),
            skillsUsedJson: writeJson(skills.map((s) => s.key)),
            tokensIn,
            tokensOut,
            costUsd,
            latencyMs,
            confidence: outcome.confidence,
            nextAction: outcome.nextAction,
            isMock: sawMock,
            endedAt: new Date(),
          },
        });

        if (escalated) {
          logger.warn("confidence below threshold - escalating", {
            confidence: outcome.confidence,
            threshold: identity.confidenceThreshold,
          });
        }
        logger.info("run succeeded", { latencyMs, toolsUsed, confidence: outcome.confidence, isMock: sawMock });

        return {
          ok: true,
          agentRunId: agentRun.id,
          output: parsedOutput.data,
          confidence: outcome.confidence,
          summary: outcome.summary,
          nextAction: outcome.nextAction,
          escalated,
          toolsUsed,
          tokensIn,
          tokensOut,
          costUsd,
          latencyMs,
          isMock: sawMock,
          validation,
        };
      } catch (e) {
        lastError = e;
        const appErr = toAppError(e);
        const willRetry = attempt < maxAttempts && appErr.retryable;
        logger.error(`attempt ${attempt} failed`, { error: appErr.message, code: appErr.code, willRetry });
        if (!willRetry) break;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }

    const message = describeError(lastError);
    const latencyMs = Date.now() - started;
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: toAppError(lastError).code === "AGENT_TIMEOUT" ? "TIMEOUT" : "FAILED",
        error: message.slice(0, 2000),
        toolsUsedJson: writeJson(toolsUsed),
        tokensIn,
        tokensOut,
        costUsd,
        latencyMs,
        isMock: sawMock,
        endedAt: new Date(),
      },
    });

    return {
      ok: false,
      agentRunId: agentRun.id,
      confidence: 0,
      summary: `Failed: ${message}`,
      error: message,
      escalated: false,
      toolsUsed,
      tokensIn,
      tokensOut,
      costUsd,
      latencyMs,
      isMock: sawMock,
      validation: [],
    };
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, agentKey: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AgentTimeoutError(agentKey, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function summarise(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 400);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 8)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : typeof v === "object" ? "{…}" : String(v).slice(0, 60)}`);
    return entries.join(", ").slice(0, 400);
  }
  return String(value).slice(0, 400);
}
