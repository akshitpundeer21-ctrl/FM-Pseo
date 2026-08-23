/**
 * Semrush and Ahrefs keyword providers.
 *
 * Both implement the SAME `KeywordProvider` interface DataForSEO and the mock
 * corpus already implement, so `keyword.discover` selects between them without
 * the Keyword Research Agent knowing any provider exists. Credentials are
 * resolved by the tool layer and passed in; nothing here reads the database or
 * the environment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY NOTE — READ BEFORE TRUSTING THESE
 *
 * Both clients are written against the providers' published API documentation
 * and have NEVER been executed against the live services, because no Semrush or
 * Ahrefs credentials exist in this environment. The request shapes, the CSV/JSON
 * parsing and the field names are unverified.
 *
 * They are wired to fail loudly rather than quietly: an unparseable response
 * throws instead of returning an empty list that would look like "no keywords
 * found", and neither will ever fall back to synthetic numbers. If you connect
 * one and it errors, the parsing here is the first place to look.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { IntegrationError } from "@/core/errors";
import { scopedLogger } from "@/core/logging/logger";
import { classifyIntent, type DiscoverParams, type KeywordProvider, type KeywordRow } from "@/modules/keywords/providers";

const log = scopedLogger("keywords.seo-providers");

/** Shared shaping so every provider returns rows the rest of the OS understands. */
function toRow(params: {
  keyword: string;
  volume: number;
  difficulty: number;
  cpc: number;
  source: string;
  discover: DiscoverParams;
}): KeywordRow {
  return {
    keyword: params.keyword,
    intent: classifyIntent(params.keyword),
    entityType: null,
    origin: params.discover.origin ?? null,
    destination: params.discover.destination ?? null,
    airport: null,
    airline: null,
    pageType: null,
    volume: Math.max(0, Math.round(params.volume)),
    difficulty: Math.min(100, Math.max(0, Math.round(params.difficulty))),
    cpc: Number.isFinite(params.cpc) ? Number(params.cpc.toFixed(2)) : 0,
    // Business value is this system's own judgement, not the provider's.
    businessValue: 0,
    source: params.source,
    isMock: false,
  };
}

// ---------------------------------------------------------------------------

/**
 * Semrush `phrase_related` via the Analytics v1 API.
 *
 * Semrush answers in semicolon-delimited CSV with a header row, not JSON.
 */
export class SemrushProvider implements KeywordProvider {
  readonly key = "semrush";
  readonly isMock = false;

  constructor(
    private readonly apiKey?: string,
    private readonly database = "us",
  ) {}

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async discover(params: DiscoverParams): Promise<KeywordRow[]> {
    if (!this.apiKey) throw new IntegrationError("semrush", "No API key configured.");
    const limit = params.limit ?? 100;
    const perSeed = Math.max(10, Math.ceil(limit / Math.max(1, params.seeds.length)));
    const rows: KeywordRow[] = [];

    for (const seed of params.seeds) {
      const url = new URL("https://api.semrush.com/");
      url.searchParams.set("type", "phrase_related");
      url.searchParams.set("key", this.apiKey);
      url.searchParams.set("phrase", seed);
      url.searchParams.set("database", this.database);
      url.searchParams.set("export_columns", "Ph,Nq,Kd,Cp");
      url.searchParams.set("display_limit", String(perSeed));

      const res = await fetch(url);
      const text = await res.text();

      if (!res.ok) throw new IntegrationError("semrush", `HTTP ${res.status}: ${text.slice(0, 200)}`);
      // Semrush signals problems with a 200 and an ERROR body.
      if (/^ERROR\s/i.test(text.trim())) {
        if (/NOTHING FOUND/i.test(text)) continue;
        throw new IntegrationError("semrush", text.trim().slice(0, 200));
      }

      rows.push(...parseSemrushCsv(text, params));
      if (rows.length >= limit) break;
    }

    log.info("semrush discovery", { seeds: params.seeds.length, rows: rows.length });
    return dedupe(rows).slice(0, limit);
  }
}

/** Exported for testing: the CSV shape is the part most likely to be wrong. */
export function parseSemrushCsv(text: string, params: DiscoverParams): KeywordRow[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(";").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [kw, nq, kd, cp] = [col("Keyword"), col("Search Volume"), col("Keyword Difficulty"), col("CPC")];
  if (kw === -1) {
    throw new IntegrationError("semrush", `Unexpected response columns: ${header.join(", ")}`);
  }

  return lines.slice(1).flatMap((line) => {
    const cells = line.split(";");
    const keyword = (cells[kw] ?? "").trim();
    if (!keyword) return [];
    return [
      toRow({
        keyword,
        volume: Number(cells[nq] ?? 0),
        difficulty: Number(cells[kd] ?? 0),
        cpc: Number(cells[cp] ?? 0),
        source: "semrush",
        discover: params,
      }),
    ];
  });
}

// ---------------------------------------------------------------------------

/** Ahrefs Keywords Explorer, v3 JSON API. */
export class AhrefsProvider implements KeywordProvider {
  readonly key = "ahrefs";
  readonly isMock = false;

  constructor(
    private readonly apiKey?: string,
    private readonly country = "us",
  ) {}

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async discover(params: DiscoverParams): Promise<KeywordRow[]> {
    if (!this.apiKey) throw new IntegrationError("ahrefs", "No API token configured.");
    const limit = params.limit ?? 100;

    const url = new URL("https://api.ahrefs.com/v3/keywords-explorer/matching-terms");
    url.searchParams.set("select", "keyword,volume_monthly,difficulty,cpc");
    url.searchParams.set("keywords", params.seeds.join(","));
    url.searchParams.set("country", this.country);
    url.searchParams.set("limit", String(limit));

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
    });
    if (!res.ok) {
      throw new IntegrationError("ahrefs", `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const body = (await res.json()) as { keywords?: unknown };
    const rows = parseAhrefsResponse(body, params);
    log.info("ahrefs discovery", { seeds: params.seeds.length, rows: rows.length });
    return dedupe(rows).slice(0, limit);
  }
}

/** Exported for testing: the JSON shape is the part most likely to be wrong. */
export function parseAhrefsResponse(body: unknown, params: DiscoverParams): KeywordRow[] {
  const container = body as { keywords?: unknown[] };
  const list = container?.keywords;
  if (!Array.isArray(list)) {
    throw new IntegrationError("ahrefs", "Response did not contain a `keywords` array.");
  }

  return list.flatMap((raw) => {
    const item = raw as Record<string, unknown>;
    const keyword = String(item.keyword ?? "").trim();
    if (!keyword) return [];
    return [
      toRow({
        keyword,
        volume: Number(item.volume_monthly ?? item.volume ?? 0),
        difficulty: Number(item.difficulty ?? 0),
        cpc: Number(item.cpc ?? 0) / 100, // Ahrefs reports CPC in cents.
        source: "ahrefs",
        discover: params,
      }),
    ];
  });
}

function dedupe(rows: KeywordRow[]): KeywordRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = r.keyword.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
