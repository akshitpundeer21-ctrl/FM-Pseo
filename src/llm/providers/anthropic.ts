/**
 * Anthropic Messages API provider (real HTTP).
 *
 * Requires ANTHROPIC_API_KEY. If the key is absent `isConfigured()` returns
 * false and the router will not select it - we never pretend to be connected.
 */
import { env } from "@/core/config/env";
import { IntegrationNotConfiguredError, LlmError } from "@/core/errors";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/llm/types";
import { estimateTokens, priceFor } from "@/llm/types";
import type { ModelTier } from "@/core/types/enums";

export class AnthropicProvider implements LlmProvider {
  readonly key = "anthropic";
  readonly label = "Anthropic";

  constructor(private readonly apiKey?: string) {}

  private resolvedKey(): string {
    return this.apiKey || env().ANTHROPIC_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.resolvedKey());
  }

  modelFor(tier: ModelTier): string {
    const e = env();
    if (tier === "fast") return e.LLM_MODEL_FAST;
    if (tier === "deep") return e.LLM_MODEL_DEEP;
    return e.LLM_MODEL_BALANCED;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const apiKey = this.resolvedKey();
    if (!apiKey) throw new IntegrationNotConfiguredError("anthropic", ["ANTHROPIC_API_KEY"]);

    const model = req.model ?? this.modelFor(req.tier ?? "balanced");
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env().AGENT_TIMEOUT_MS);

    try {
      const res = await fetch(`${env().ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 1500,
          temperature: req.temperature ?? 0.5,
          ...(system ? { system } : {}),
          messages: messages.length ? messages : [{ role: "user", content: "Continue." }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new LlmError(this.key, `HTTP ${res.status}: ${body.slice(0, 400)}`, { status: res.status });
      }

      const data: any = await res.json();
      const text = Array.isArray(data?.content)
        ? data.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim()
        : "";
      const tokensIn = data?.usage?.input_tokens ?? estimateTokens(system + JSON.stringify(messages));
      const tokensOut = data?.usage?.output_tokens ?? estimateTokens(text);

      return {
        text,
        provider: this.key,
        model,
        tokensIn,
        tokensOut,
        costUsd: priceFor(model, tokensIn, tokensOut),
        latencyMs: Date.now() - started,
        isMock: false,
        finishReason: data?.stop_reason ?? "stop",
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if ((e as Error)?.name === "AbortError") throw new LlmError(this.key, "request timed out");
      throw new LlmError(this.key, (e as Error).message ?? "request failed", { cause: e });
    } finally {
      clearTimeout(timeout);
    }
  }
}
