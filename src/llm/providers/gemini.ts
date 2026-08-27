/**
 * Google Gemini API provider (real HTTP).
 * Requires GOOGLE_AI_API_KEY; otherwise `isConfigured()` is false and the
 * router skips it.
 */
import { env } from "@/core/config/env";
import { IntegrationNotConfiguredError, LlmError } from "@/core/errors";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/llm/types";
import { estimateTokens, priceFor } from "@/llm/types";
import type { ModelTier } from "@/core/types/enums";

export class GeminiProvider implements LlmProvider {
  readonly key = "gemini";
  readonly label = "Google Gemini";

  constructor(private readonly apiKey?: string) {}

  private resolvedKey(): string {
    return this.apiKey || env().GOOGLE_AI_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.resolvedKey());
  }

  modelFor(tier: ModelTier): string {
    if (tier === "fast") return "gemini-2.0-flash";
    if (tier === "deep") return "gemini-2.5-pro";
    return "gemini-2.0-flash";
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const apiKey = this.resolvedKey();
    if (!apiKey) throw new IntegrationNotConfiguredError("gemini", ["GOOGLE_AI_API_KEY"]);

    const model = req.model ?? this.modelFor(req.tier ?? "balanced");
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env().AGENT_TIMEOUT_MS);

    const systemParts = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    if (!contents.length) {
      contents.push({ role: "user", parts: [{ text: "Continue." }] });
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.5,
        maxOutputTokens: req.maxTokens ?? 1500,
      },
    };

    if (systemParts) {
      body.systemInstruction = { parts: [{ text: systemParts }] };
    }

    const url = `${env().GEMINI_BASE_URL}/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new LlmError(this.key, `HTTP ${res.status}: ${errBody.slice(0, 400)}`, { status: res.status });
      }

      const data: any = await res.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts
        ?.filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join("\n")
        .trim() ?? "";

      const tokensIn = data?.usageMetadata?.promptTokenCount ?? estimateTokens(systemParts + JSON.stringify(contents));
      const tokensOut = data?.usageMetadata?.candidatesTokenCount ?? estimateTokens(text);

      return {
        text,
        provider: this.key,
        model,
        tokensIn,
        tokensOut,
        costUsd: priceFor(model, tokensIn, tokensOut),
        latencyMs: Date.now() - started,
        isMock: false,
        finishReason: candidate?.finishReason?.toLowerCase() ?? "stop",
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
