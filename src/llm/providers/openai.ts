/**
 * OpenAI Chat Completions provider (real HTTP).
 * Requires OPENAI_API_KEY; otherwise `isConfigured()` is false and the router
 * skips it.
 */
import { env } from "@/core/config/env";
import { IntegrationNotConfiguredError, LlmError } from "@/core/errors";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/llm/types";
import { estimateTokens, priceFor } from "@/llm/types";
import type { ModelTier } from "@/core/types/enums";

export class OpenAiProvider implements LlmProvider {
  readonly key = "openai";
  readonly label = "OpenAI";

  constructor(private readonly apiKey?: string) {}

  private resolvedKey(): string {
    return this.apiKey || env().OPENAI_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.resolvedKey());
  }

  modelFor(tier: ModelTier): string {
    if (tier === "fast") return "gpt-4o-mini";
    if (tier === "deep") return "gpt-4.1";
    return "gpt-4.1-mini";
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const apiKey = this.resolvedKey();
    if (!apiKey) throw new IntegrationNotConfiguredError("openai", ["OPENAI_API_KEY"]);

    const model = req.model ?? this.modelFor(req.tier ?? "balanced");
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env().AGENT_TIMEOUT_MS);

    try {
      const res = await fetch(`${env().OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 1500,
          temperature: req.temperature ?? 0.5,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new LlmError(this.key, `HTTP ${res.status}: ${body.slice(0, 400)}`, { status: res.status });
      }

      const data: any = await res.json();
      const text: string = data?.choices?.[0]?.message?.content ?? "";
      const tokensIn = data?.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(req.messages));
      const tokensOut = data?.usage?.completion_tokens ?? estimateTokens(text);

      return {
        text: text.trim(),
        provider: this.key,
        model,
        tokensIn,
        tokensOut,
        costUsd: priceFor(model, tokensIn, tokensOut),
        latencyMs: Date.now() - started,
        isMock: false,
        finishReason: data?.choices?.[0]?.finish_reason ?? "stop",
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
