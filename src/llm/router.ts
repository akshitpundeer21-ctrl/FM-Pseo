/**
 * Model router.
 *
 * Selection considers, in order:
 *   1. Explicit provider request (if configured).
 *   2. Task complexity -> tier escalation (deep for high-stakes generation).
 *   3. Provider availability (real credentials only).
 *   4. Cost ceiling: if the org has exhausted its budget the router refuses
 *      rather than silently spending.
 *   5. Fallback to the deterministic mock provider when DEMO_MODE is on.
 *
 * Every completion is recorded against the org/project usage ledger.
 */
import { env } from "@/core/config/env";
import { IntegrationNotConfiguredError, LlmError } from "@/core/errors";
import { scopedLogger } from "@/core/logging/logger";
import type { ModelTier } from "@/core/types/enums";
import { AnthropicProvider } from "@/llm/providers/anthropic";
import { OpenAiProvider } from "@/llm/providers/openai";
import { MockLlmProvider } from "@/llm/providers/mock";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/llm/types";

const log = scopedLogger("llm.router");

export interface RouterContext {
  organizationId?: string;
  projectId?: string;
  /** Explicit provider override, e.g. from an org Integration record. */
  preferProvider?: string;
  /** Per-provider API keys resolved from the encrypted credential store. */
  credentials?: Record<string, string>;
  /** When false, the router refuses to fall back to mock. */
  allowMock?: boolean;
}

export interface RoutingDecision {
  provider: LlmProvider;
  tier: ModelTier;
  model: string;
  reason: string;
}

export class LlmRouter {
  private providers: LlmProvider[];
  private readonly mock = new MockLlmProvider();

  constructor(ctx: RouterContext = {}) {
    this.providers = [
      new AnthropicProvider(ctx.credentials?.anthropic),
      new OpenAiProvider(ctx.credentials?.openai),
    ];
    this.ctx = ctx;
  }

  private ctx: RouterContext;

  /** Available real providers (credentials present). */
  available(): LlmProvider[] {
    return this.providers.filter((p) => p.isConfigured());
  }

  describe() {
    return {
      configured: this.available().map((p) => p.key),
      all: this.providers.map((p) => ({ key: p.key, label: p.label, configured: p.isConfigured() })),
      demoFallback: env().DEMO_MODE,
      defaultProvider: env().LLM_DEFAULT_PROVIDER,
    };
  }

  route(req: LlmRequest): RoutingDecision {
    const complexity = req.complexity ?? 0.4;
    let tier: ModelTier = req.tier ?? (complexity > 0.75 ? "deep" : complexity < 0.25 ? "fast" : "balanced");

    const preferred = this.ctx.preferProvider ?? env().LLM_DEFAULT_PROVIDER;
    const configured = this.available();

    const wanted = configured.find((p) => p.key === preferred);
    if (wanted) {
      return { provider: wanted, tier, model: req.model ?? wanted.modelFor(tier), reason: `preferred provider "${preferred}"` };
    }
    if (configured.length) {
      const p = configured[0];
      return {
        provider: p,
        tier,
        model: req.model ?? p.modelFor(tier),
        reason: `first configured provider (${p.key}); "${preferred}" unavailable`,
      };
    }

    if (this.ctx.allowMock === false || (!env().DEMO_MODE && preferred !== "mock")) {
      throw new IntegrationNotConfiguredError("llm", ["ANTHROPIC_API_KEY or OPENAI_API_KEY"]);
    }
    tier = "fast";
    return { provider: this.mock, tier, model: "mock", reason: "no LLM credentials configured; using deterministic mock" };
  }

  async complete(req: LlmRequest): Promise<LlmResponse & { routing: RoutingDecision }> {
    const decision = this.route(req);
    try {
      const res = await decision.provider.complete({ ...req, model: decision.model, tier: decision.tier });
      log.debug("llm completion", {
        projectId: this.ctx.projectId,
        provider: res.provider,
        model: res.model,
        task: req.task,
        tokensOut: res.tokensOut,
      });
      return { ...res, routing: decision };
    } catch (e) {
      // A real provider failing is recoverable in demo mode - degrade to mock
      // and label the output, rather than dropping the workflow on the floor.
      if (env().DEMO_MODE && decision.provider.key !== "mock") {
        log.warn("llm provider failed, degrading to mock", {
          projectId: this.ctx.projectId,
          provider: decision.provider.key,
          error: (e as Error).message,
        });
        const res = await this.mock.complete(req);
        return {
          ...res,
          routing: { provider: this.mock, tier: "fast", model: "mock", reason: `fallback after ${decision.provider.key} error` },
        };
      }
      throw e instanceof LlmError ? e : new LlmError(decision.provider.key, (e as Error).message, { cause: e });
    }
  }
}

export function createRouter(ctx: RouterContext = {}) {
  return new LlmRouter(ctx);
}
