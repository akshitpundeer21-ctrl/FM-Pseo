/**
 * Typed error hierarchy.
 *
 * Rule of the house: nothing fails silently. Every error carries a machine
 * `code`, a human `message`, an HTTP `status` for the API layer, and optional
 * structured `details` that end up in the dashboard's error surface.
 */

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "BUDGET_EXCEEDED"
  | "INTEGRATION_NOT_CONFIGURED"
  | "INTEGRATION_ERROR"
  | "TOOL_NOT_PERMITTED"
  | "TOOL_ERROR"
  | "AGENT_ERROR"
  | "AGENT_TIMEOUT"
  | "WORKFLOW_ERROR"
  | "APPROVAL_REQUIRED"
  | "QUALITY_GATE_FAILED"
  | "PUBLISH_ERROR"
  | "LLM_ERROR"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.details = opts.details;
    this.retryable = opts.retryable ?? defaultRetryable(code);
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.message, details: this.details ?? null, retryable: this.retryable },
    };
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
    case "TOOL_NOT_PERMITTED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
    case "QUALITY_GATE_FAILED":
      return 422;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "BUDGET_EXCEEDED":
    case "APPROVAL_REQUIRED":
    case "INTEGRATION_NOT_CONFIGURED":
      return 400;
    case "AGENT_TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  return code === "RATE_LIMITED" || code === "AGENT_TIMEOUT" || code === "INTEGRATION_ERROR" || code === "LLM_ERROR";
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHENTICATED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that", details?: unknown) {
    super("FORBIDDEN", message, { details });
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super("NOT_FOUND", id ? `${entity} ${id} was not found` : `${entity} was not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_FAILED", message, { details });
  }
}

export class BudgetExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super("BUDGET_EXCEEDED", message, { details });
  }
}

/**
 * Raised when an adapter is asked to do real work but has no credentials and
 * demo mode is off. We never silently fabricate a result in that case.
 */
export class IntegrationNotConfiguredError extends AppError {
  constructor(provider: string, missing: string[]) {
    super(
      "INTEGRATION_NOT_CONFIGURED",
      `Integration "${provider}" is not configured. Missing: ${missing.join(", ")}.`,
      { details: { provider, missing } },
    );
  }
}

export class IntegrationError extends AppError {
  constructor(provider: string, message: string, details?: unknown) {
    super("INTEGRATION_ERROR", `[${provider}] ${message}`, { details });
  }
}

export class ToolNotPermittedError extends AppError {
  constructor(agentKey: string, toolKey: string) {
    super("TOOL_NOT_PERMITTED", `Agent "${agentKey}" is not permitted to use tool "${toolKey}"`, {
      details: { agentKey, toolKey },
    });
  }
}

export class ToolError extends AppError {
  constructor(toolKey: string, message: string, details?: unknown) {
    super("TOOL_ERROR", `Tool "${toolKey}" failed: ${message}`, { details });
  }
}

export class AgentError extends AppError {
  constructor(agentKey: string, message: string, details?: unknown) {
    super("AGENT_ERROR", `Agent "${agentKey}" failed: ${message}`, { details });
  }
}

export class AgentTimeoutError extends AppError {
  constructor(agentKey: string, ms: number) {
    super("AGENT_TIMEOUT", `Agent "${agentKey}" timed out after ${ms}ms`, { details: { agentKey, ms } });
  }
}

export class ApprovalRequiredError extends AppError {
  constructor(action: string, approvalId?: string) {
    super("APPROVAL_REQUIRED", `Human approval is required before: ${action}`, { details: { action, approvalId } });
  }
}

export class QualityGateFailedError extends AppError {
  constructor(message: string, details?: unknown) {
    super("QUALITY_GATE_FAILED", message, { details });
  }
}

export class PublishError extends AppError {
  constructor(adapter: string, message: string, details?: unknown) {
    super("PUBLISH_ERROR", `Publishing via "${adapter}" failed: ${message}`, { details });
  }
}

export class LlmError extends AppError {
  constructor(provider: string, message: string, details?: unknown) {
    super("LLM_ERROR", `[llm:${provider}] ${message}`, { details });
  }
}

/** Normalise anything thrown into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error) return new AppError("INTERNAL", e.message, { cause: e, details: { name: e.name } });
  return new AppError("INTERNAL", String(e));
}

/** Compact single-line description used in run summaries and log rows. */
export function describeError(e: unknown): string {
  const err = toAppError(e);
  return `${err.code}: ${err.message}`;
}
