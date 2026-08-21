/**
 * Tool contracts.
 *
 * An agent never imports an adapter directly. It asks the Tool Registry for a
 * tool by key; the registry checks the agent's allowlist and capabilities with
 * the Control Plane, resolves credentials server-side, executes, and records a
 * ToolInvocation row. Credentials are handed to the tool implementation only -
 * they are never returned to the agent or placed in a prompt.
 */
import type { z } from "zod";
import type { Capability } from "@/core/types/enums";
import type { ControlPlane } from "@/control-plane/control-plane";
import type { ResolvedCredentials } from "@/integrations/service";
import type { Logger } from "@/core/logging/logger";

export interface ToolContext {
  organizationId: string;
  projectId: string;
  agentKey: string;
  agentRunId?: string;
  taskId?: string;
  controlPlane: ControlPlane;
  logger: Logger;
  /** Resolved server-side. Empty object when the tool needs no integration. */
  credentials: ResolvedCredentials | null;
  /** True when the tool had to fall back to a mock adapter. Set by the tool. */
  markMock: () => void;
  /** Report vendor cost so the control plane can bill it to the org budget. */
  charge: (usd: number, meta?: { tokensIn?: number; tokensOut?: number; category?: string }) => Promise<void>;
}

export interface ToolDefinition<I = any, O = any> {
  key: string;
  name: string;
  description: string;
  category: "research" | "data" | "content" | "technical" | "publishing" | "analytics" | "visibility";
  /** Capability the calling agent must hold. */
  requiredCapability: Capability;
  /** Integration whose credentials this tool needs (optional). */
  integrationProvider?: string;
  /** When true and the integration is missing, the tool may use a mock adapter. */
  allowMockFallback: boolean;
  /** Tools that can spend vendor money are budget-checked before execution. */
  costly?: boolean;
  retries?: number;
  timeoutMs?: number;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  execute: (input: I, ctx: ToolContext) => Promise<O>;
}

export interface ToolResult<O = any> {
  ok: boolean;
  output?: O;
  error?: string;
  toolKey: string;
  latencyMs: number;
  isMock: boolean;
  costUsd: number;
}
