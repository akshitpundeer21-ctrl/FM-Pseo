/**
 * AI visibility probing + mention/citation extraction.
 *
 * IMPORTANT FRAMING (enforced in the UI copy too): answer engines do not "rank"
 * pages the way a search engine does. What this module measures is whether a
 * brand/domain is *mentioned* and whether a URL is *cited* in a generated
 * answer, sampled over a prompt library. Those are the only claims it makes.
 *
 * Platforms:
 *   - anthropic / openai: real completions through the LLM router.
 *   - perplexity: real answer-engine call including its citation list.
 *   - mock: deterministic synthetic answers so the module is demonstrable
 *     offline. Rows are flagged isMock and labelled MOCK in the dashboard.
 */
import { IntegrationError, IntegrationNotConfiguredError } from "@/core/errors";
import { createRouter } from "@/llm/router";
import { estimateTokens } from "@/llm/types";

export interface ProbeResult {
  platform: string;
  model: string;
  text: string;
  citations: { url: string; position: number }[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  isMock: boolean;
  error?: string;
}

export interface ProbeOptions {
  brandName: string;
  brandDomain: string;
  competitors: { name: string; domain: string }[];
  credentials?: Record<string, string>;
}

const SYSTEM_PROMPT =
  "You are answering a traveller's question. Be concise and practical. " +
  "Where you recommend booking channels or sources, name them explicitly and list any URLs you relied on under a 'Sources:' heading.";

export async function probe(platform: string, prompt: string, opts: ProbeOptions): Promise<ProbeResult> {
  const started = Date.now();

  if (platform === "perplexity") {
    return probePerplexity(prompt, opts, started);
  }

  if (platform === "mock") {
    const router = createRouter({ allowMock: true, preferProvider: "mock" });
    const res = await router.complete({
      task: "ai_assistant_answer",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      variables: { prompt, brand: opts.brandName, brandDomain: opts.brandDomain, competitors: opts.competitors },
    });
    return {
      platform: "mock",
      model: "mock",
      text: res.text,
      citations: extractCitations(res.text),
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      costUsd: 0,
      latencyMs: Date.now() - started,
      isMock: true,
    };
  }

  // anthropic / openai via the router (real credentials required for a real probe)
  const router = createRouter({ preferProvider: platform, credentials: opts.credentials, allowMock: false });
  const res = await router.complete({
    task: "ai_assistant_answer",
    tier: "balanced",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    variables: { prompt, brand: opts.brandName, brandDomain: opts.brandDomain, competitors: opts.competitors },
  });

  return {
    platform,
    model: res.model,
    text: res.text,
    citations: extractCitations(res.text),
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    costUsd: res.costUsd,
    latencyMs: Date.now() - started,
    isMock: res.isMock,
  };
}

async function probePerplexity(prompt: string, opts: ProbeOptions, started: number): Promise<ProbeResult> {
  const apiKey = opts.credentials?.apiKey;
  if (!apiKey) throw new IntegrationNotConfiguredError("perplexity", ["apiKey"]);

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonar",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new IntegrationError("perplexity", `HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  const apiCitations: string[] = Array.isArray(data?.citations) ? data.citations : [];

  return {
    platform: "perplexity",
    model: data?.model ?? "sonar",
    text,
    citations: apiCitations.length
      ? apiCitations.map((url, i) => ({ url, position: i + 1 }))
      : extractCitations(text),
    tokensIn: data?.usage?.prompt_tokens ?? estimateTokens(prompt),
    tokensOut: data?.usage?.completion_tokens ?? estimateTokens(text),
    costUsd: 0,
    latencyMs: Date.now() - started,
    isMock: false,
  };
}

// --- extraction ------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export function extractCitations(text: string): { url: string; position: number }[] {
  const seen = new Set<string>();
  const out: { url: string; position: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, position: out.length + 1 });
  }
  return out;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Whether a cited URL belongs to the brand.
 *
 * Compares hostnames with the port and www stripped from both sides - a brand
 * configured as "localhost:3000" must still match a citation of
 * "http://localhost:3000/page", which a naive substring test gets wrong.
 */
export function isOwnedUrl(url: string, brandDomain: string): boolean {
  const cited = domainOf(url);
  const brand = brandDomain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0];
  if (!cited || !brand) return false;
  return cited === brand || cited.endsWith(`.${brand}`);
}

export interface ExtractedMention {
  entityName: string;
  entityType: "BRAND" | "COMPETITOR" | "DOMAIN" | "OTHER";
  context: string;
  /** 1-based ordinal of this entity's first appearance relative to others. */
  position: number;
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
}

const POSITIVE = /\b(best|recommend(?:ed)?|reliable|great|good|popular|trusted|convenient)\b/i;
const NEGATIVE = /\b(avoid|worst|unreliable|poor|complaints?|scam|hidden fees)\b/i;

/**
 * Find brand/competitor mentions in a generated answer.
 * Matching is name- and domain-based with word boundaries; no model call is
 * needed, which keeps measurement deterministic and auditable.
 */
export function extractMentions(
  text: string,
  brand: { name: string; domain: string },
  competitors: { name: string; domain: string }[],
): ExtractedMention[] {
  const candidates: { name: string; domain: string; type: "BRAND" | "COMPETITOR" }[] = [
    { ...brand, type: "BRAND" },
    ...competitors.map((c) => ({ ...c, type: "COMPETITOR" as const })),
  ];

  const found: (ExtractedMention & { index: number })[] = [];

  for (const c of candidates) {
    const patterns = [c.name, c.domain].filter(Boolean).map((v) => escapeRegex(v));
    let bestIndex = -1;
    for (const p of patterns) {
      const re = new RegExp(`(?<![\\w.])${p}(?![\\w])`, "i");
      const m = text.match(re);
      if (m && m.index !== undefined && (bestIndex === -1 || m.index < bestIndex)) bestIndex = m.index;
    }
    if (bestIndex === -1) continue;

    const context = text.slice(Math.max(0, bestIndex - 90), bestIndex + 130).replace(/\s+/g, " ").trim();
    found.push({
      entityName: c.name,
      entityType: c.type,
      context,
      position: 0,
      sentiment: NEGATIVE.test(context) ? "NEGATIVE" : POSITIVE.test(context) ? "POSITIVE" : "NEUTRAL",
      index: bestIndex,
    });
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index: _index, ...m }, i) => ({ ...m, position: i + 1 }));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Default prompt library seeded for a new travel project. */
export function defaultPromptLibrary(origin: string, destination: string, brand: string): { prompt: string; category: string; intent: string }[] {
  return [
    { prompt: `What are the best ways to fly from ${origin} to ${destination}?`, category: "ROUTE", intent: "INFORMATIONAL" },
    { prompt: `What airlines operate flights between ${origin} and ${destination}?`, category: "ROUTE", intent: "QUESTION" },
    { prompt: `How long is the flight from ${origin} to ${destination}?`, category: "ROUTE", intent: "QUESTION" },
    { prompt: `Which travel websites are good for booking flights from ${origin} to ${destination}?`, category: "BOOKING", intent: "COMMERCIAL" },
    { prompt: `What is the cheapest time of year to fly ${origin} to ${destination}?`, category: "ROUTE", intent: "INFORMATIONAL" },
    { prompt: `Is ${brand} a legitimate site for booking international flights?`, category: "BRAND", intent: "NAVIGATIONAL" },
    { prompt: `What should I know before booking a long-haul flight to ${destination}?`, category: "DESTINATION", intent: "INFORMATIONAL" },
    { prompt: `Compare online travel agencies for booking flights to ${destination}.`, category: "COMPETITIVE", intent: "COMMERCIAL" },
  ];
}
