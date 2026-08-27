/**
 * LLM provider abstraction.
 *
 * Nothing in the OS talks to a model vendor directly. Agents call
 * `llm.complete()` through the router, which selects a provider by tier,
 * availability and cost. Provider API keys never leave this layer and are never
 * interpolated into prompts.
 */
import type { ModelTier } from "@/core/types/enums";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  /** Routing hint. The router maps tier -> concrete model per provider. */
  tier?: ModelTier;
  /** Force a specific model id (skips tier mapping). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Semantic label for the generation, e.g. "route_overview". Used for
   * telemetry and by the deterministic mock generator to pick a writer.
   */
  task?: string;
  /** Structured inputs available to the generator (never secrets). */
  variables?: Record<string, unknown>;
  /** Estimated complexity 0..1 - influences tier escalation. */
  complexity?: number;
}

export interface LlmResponse {
  text: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  isMock: boolean;
  finishReason: string;
}

export interface LlmProvider {
  readonly key: string;
  readonly label: string;
  /** True when real credentials exist. Mock provider reports false. */
  isConfigured(): boolean;
  /** Models this provider exposes per tier. */
  modelFor(tier: ModelTier): string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** USD per 1M tokens. Used for budget accounting and the cost column. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gemini-2.0-flash": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  mock: { inputPerMTok: 0, outputPerMTok: 0 },
};

export function priceFor(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model] ?? { inputPerMTok: 0, outputPerMTok: 0 };
  return (tokensIn / 1_000_000) * p.inputPerMTok + (tokensOut / 1_000_000) * p.outputPerMTok;
}

/** Rough token estimate (~4 chars/token) - good enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
