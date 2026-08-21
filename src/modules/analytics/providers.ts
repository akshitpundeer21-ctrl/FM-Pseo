/**
 * Search-performance providers.
 *
 * `GoogleSearchConsoleProvider` is a real client (OAuth refresh-token flow ->
 * Search Analytics query API). `MockSearchPerformanceProvider` generates a
 * deterministic synthetic series so the Search Performance dashboard, the
 * feedback loop and the recommendation engine are all exercisable offline.
 *
 * The mock series is derived from each page's publish date and its keyword
 * cluster volume, and every row is flagged isMock. It is never presented as
 * measured traffic.
 */
import { IntegrationError, IntegrationNotConfiguredError } from "@/core/errors";
import { stableHash } from "@/core/security/crypto";

export interface PerformanceRow {
  date: string; // YYYY-MM-DD
  dimension: "query" | "page";
  dimensionValue: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  isMock: boolean;
  source: string;
}

export interface PerformanceQuery {
  siteUrl?: string;
  startDate: string;
  endDate: string;
  dimension: "query" | "page";
  /** Mock provider only: the universe to synthesise a series for. */
  seeds?: { value: string; weight: number; since?: string }[];
  rowLimit?: number;
}

export interface SearchPerformanceProvider {
  readonly key: string;
  readonly isMock: boolean;
  isConfigured(): boolean;
  fetchPerformance(query: PerformanceQuery): Promise<PerformanceRow[]>;
}

// ---------------------------------------------------------------------------

export class MockSearchPerformanceProvider implements SearchPerformanceProvider {
  readonly key = "mock";
  readonly isMock = true;

  isConfigured() {
    return true;
  }

  async fetchPerformance(query: PerformanceQuery): Promise<PerformanceRow[]> {
    const rows: PerformanceRow[] = [];
    const start = new Date(`${query.startDate}T00:00:00Z`);
    const end = new Date(`${query.endDate}T00:00:00Z`);
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
    const seeds = query.seeds ?? [];

    for (const seed of seeds) {
      const h = stableHash(seed.value);
      const since = seed.since ? new Date(seed.since) : start;
      for (let d = 0; d < days; d++) {
        const day = new Date(start.getTime() + d * 86_400_000);
        if (day < since) continue;
        const ageDays = Math.max(0, Math.round((day.getTime() - since.getTime()) / 86_400_000));

        // Ramp: new pages accrue impressions over ~8 weeks, then plateau.
        const ramp = 1 - Math.exp(-ageDays / 18);
        // Weekly seasonality: quieter at weekends for travel research.
        const dow = day.getUTCDay();
        const weekly = dow === 0 || dow === 6 ? 0.78 : 1.05;
        const noise = 0.85 + ((h + d * 31) % 30) / 100;

        const impressions = Math.round(seed.weight * ramp * weekly * noise);
        if (impressions <= 0) continue;
        const position = Math.max(2.4, 24 - ramp * 15 + ((h % 7) - 3) * 0.4);
        const ctr = Math.max(0.004, 0.31 * Math.exp(-0.28 * (position - 1)));
        const clicks = Math.round(impressions * ctr);

        rows.push({
          date: day.toISOString().slice(0, 10),
          dimension: query.dimension,
          dimensionValue: seed.value,
          clicks,
          impressions,
          ctr: impressions ? clicks / impressions : 0,
          position: Number(position.toFixed(1)),
          isMock: true,
          source: "mock",
        });
      }
    }
    return rows;
  }
}

// ---------------------------------------------------------------------------

export class GoogleSearchConsoleProvider implements SearchPerformanceProvider {
  readonly key = "gsc";
  readonly isMock = false;

  constructor(
    private readonly creds: { clientId?: string; clientSecret?: string; refreshToken?: string; serviceAccountJson?: string },
    private readonly siteUrl?: string,
  ) {}

  isConfigured() {
    return Boolean(
      this.siteUrl && ((this.creds.clientId && this.creds.clientSecret && this.creds.refreshToken) || this.creds.serviceAccountJson),
    );
  }

  private async accessToken(): Promise<string> {
    if (this.creds.refreshToken && this.creds.clientId && this.creds.clientSecret) {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          refresh_token: this.creds.refreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new IntegrationError("google_search_console", `token exchange failed: HTTP ${res.status} ${t.slice(0, 200)}`);
      }
      const data: any = await res.json();
      return data.access_token as string;
    }
    // Service-account JWT flow needs a signing step; surfaced rather than faked.
    throw new IntegrationNotConfiguredError("google_search_console", [
      "OAuth refresh token (clientId + clientSecret + refreshToken)",
    ]);
  }

  async fetchPerformance(query: PerformanceQuery): Promise<PerformanceRow[]> {
    if (!this.isConfigured()) {
      throw new IntegrationNotConfiguredError("google_search_console", ["siteUrl", "OAuth credentials"]);
    }
    const token = await this.accessToken();
    const site = encodeURIComponent(query.siteUrl ?? this.siteUrl!);

    const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        startDate: query.startDate,
        endDate: query.endDate,
        dimensions: ["date", query.dimension],
        rowLimit: query.rowLimit ?? 5000,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new IntegrationError("google_search_console", `searchAnalytics failed: HTTP ${res.status} ${t.slice(0, 300)}`);
    }
    const data: any = await res.json();
    return (data.rows ?? []).map((r: any) => ({
      date: r.keys?.[0],
      dimension: query.dimension,
      dimensionValue: r.keys?.[1] ?? "",
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
      isMock: false,
      source: "gsc",
    }));
  }
}
