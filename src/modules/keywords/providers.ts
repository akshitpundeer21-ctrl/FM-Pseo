/**
 * Keyword data providers.
 *
 * `MockKeywordProvider` serves the deterministic synthetic corpus so keyword
 * research, clustering and opportunity scoring are fully exercisable with no
 * paid API. Its rows are flagged isMock and the dashboard labels them.
 *
 * `DataForSeoProvider` is a real HTTP client. It is selected only when
 * credentials resolve; there is no silent substitution in either direction.
 */
import fs from "node:fs";
import path from "node:path";
import { IntegrationError, IntegrationNotConfiguredError } from "@/core/errors";
import { tokenSimilarity } from "@/core/utils/text";
import type { SearchIntent } from "@/core/types/enums";

export interface KeywordRow {
  keyword: string;
  intent: SearchIntent;
  entityType: string | null;
  origin: string | null;
  destination: string | null;
  airport?: string | null;
  airline?: string | null;
  pageType: string | null;
  volume: number;
  difficulty: number;
  cpc: number;
  businessValue: number;
  source: string;
  isMock: boolean;
}

export interface DiscoverParams {
  seeds: string[];
  origin?: string;
  destination?: string;
  entityTypes?: string[];
  limit?: number;
  minVolume?: number;
}

export interface KeywordProvider {
  readonly key: string;
  readonly isMock: boolean;
  isConfigured(): boolean;
  discover(params: DiscoverParams): Promise<KeywordRow[]>;
}

// ---------------------------------------------------------------------------

let corpusCache: KeywordRow[] | null = null;

function loadCorpus(): KeywordRow[] {
  if (corpusCache) return corpusCache;
  const file = path.join(process.cwd(), "data", "mock", "keywords.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  corpusCache = (parsed.keywords as any[]).map((k) => ({
    keyword: k.keyword,
    intent: k.intent as SearchIntent,
    entityType: k.entityType ?? null,
    origin: k.origin ?? null,
    destination: k.destination ?? null,
    airport: k.airport ?? null,
    airline: k.airline ?? null,
    pageType: k.pageType ?? null,
    volume: k.volume,
    difficulty: k.difficulty,
    cpc: k.cpc,
    businessValue: k.businessValue,
    source: "mock_corpus",
    isMock: true,
  }));
  return corpusCache;
}

export class MockKeywordProvider implements KeywordProvider {
  readonly key = "mock";
  readonly isMock = true;

  isConfigured() {
    return true;
  }

  async discover(params: DiscoverParams): Promise<KeywordRow[]> {
    const limit = params.limit ?? 60;
    const minVolume = params.minVolume ?? 0;
    const corpus = loadCorpus();

    const scored = corpus
      .filter((row) => {
        if (row.volume < minVolume) return false;
        if (params.origin && row.origin && row.origin !== params.origin.toUpperCase()) return false;
        if (params.destination && row.destination && row.destination !== params.destination.toUpperCase()) return false;
        if (params.entityTypes?.length && row.entityType && !params.entityTypes.includes(row.entityType)) return false;
        return true;
      })
      .map((row) => {
        // Exact entity match on the requested pair is the strongest signal.
        const entityMatch =
          params.origin && params.destination && row.origin === params.origin.toUpperCase() && row.destination === params.destination.toUpperCase()
            ? 1
            : 0;
        const textMatch = params.seeds.length
          ? Math.max(...params.seeds.map((s) => tokenSimilarity(s, row.keyword)))
          : 0;
        const volumeSignal = Math.log10(Math.max(row.volume, 10)) / 5;
        return { row, score: entityMatch * 2 + textMatch * 1.5 + volumeSignal };
      })
      .filter((s) => s.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => s.row);
  }
}

// ---------------------------------------------------------------------------

/**
 * DataForSEO Google Ads search-volume endpoint.
 * Docs: https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/
 */
export class DataForSeoProvider implements KeywordProvider {
  readonly key = "dataforseo";
  readonly isMock = false;

  constructor(
    private readonly login?: string,
    private readonly password?: string,
    private readonly locationCode = 2840, // United States
    private readonly languageCode = "en",
  ) {}

  isConfigured() {
    return Boolean(this.login && this.password);
  }

  async discover(params: DiscoverParams): Promise<KeywordRow[]> {
    if (!this.isConfigured()) throw new IntegrationNotConfiguredError("dataforseo", ["login", "password"]);

    const auth = Buffer.from(`${this.login}:${this.password}`).toString("base64");
    const body = [
      {
        keywords: params.seeds.slice(0, 700),
        location_code: this.locationCode,
        language_code: this.languageCode,
        search_partners: false,
      },
    ];

    const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntegrationError("dataforseo", `HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data: any = await res.json();
    const items: any[] = data?.tasks?.[0]?.result ?? [];

    return items.map((item) => ({
      keyword: item.keyword,
      intent: classifyIntent(item.keyword),
      entityType: null,
      origin: params.origin ?? null,
      destination: params.destination ?? null,
      pageType: null,
      volume: item.search_volume ?? 0,
      difficulty: Math.round((item.competition_index ?? 0) as number),
      cpc: Number(item.cpc ?? 0),
      businessValue: 0,
      source: "dataforseo",
      isMock: false,
    }));
  }
}

/**
 * Rule-based search-intent classifier.
 *
 * Deliberately deterministic rather than model-driven: intent classification
 * drives page-type routing, and a stable, auditable rule set is more useful
 * here than a probabilistic one. The Keyword Research Agent can layer an LLM
 * second opinion on top when a provider is configured.
 */
export function classifyIntent(keyword: string): SearchIntent {
  const k = keyword.toLowerCase();
  if (/^(what|how|why|when|where|which|who|is|are|do|does|can)\b/.test(k) || k.includes("?")) return "QUESTION";
  if (/\b(book|buy|booking|reserve|deal|deals|ticket|tickets|fare|fares)\b/.test(k)) return "TRANSACTIONAL";
  if (/\b(cheap|cheapest|best|compare|comparison|vs|top|review|reviews)\b/.test(k)) return "COMMERCIAL";
  if (/\b(login|check in|check-in|official|website|contact|status|app)\b/.test(k)) return "NAVIGATIONAL";
  if (/\bflights?\b/.test(k) && /\bto\b/.test(k)) return "TRANSACTIONAL";
  return "INFORMATIONAL";
}

/** Question variants used to expand a route into AEO-friendly targets. */
export function questionVariants(originCity: string, destinationCity: string): string[] {
  return [
    `how long is the flight from ${originCity} to ${destinationCity}`,
    `which airlines fly from ${originCity} to ${destinationCity}`,
    `are there direct flights from ${originCity} to ${destinationCity}`,
    `what is the cheapest month to fly ${originCity} to ${destinationCity}`,
    `how far is ${destinationCity} from ${originCity}`,
    `do I need a transit visa flying ${originCity} to ${destinationCity}`,
  ];
}

export function seedTermsFor(originCity: string, destinationCity: string): string[] {
  return [
    `${originCity} to ${destinationCity} flights`,
    `flights from ${originCity} to ${destinationCity}`,
    `cheap flights ${originCity} to ${destinationCity}`,
    `direct flights ${originCity} to ${destinationCity}`,
    ...questionVariants(originCity, destinationCity),
  ];
}
