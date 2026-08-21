/**
 * Amadeus Self-Service adapter (real HTTP, credential-gated).
 *
 * Implements the `offers` namespace - live flight offers - which the static
 * dataset deliberately refuses to serve. Without credentials `isAvailable()`
 * returns false, and the Dynamic Data Engine reports the datum as unavailable
 * rather than substituting a fabricated price.
 */
import { IntegrationError, IntegrationNotConfiguredError } from "@/core/errors";
import { scopedLogger } from "@/core/logging/logger";
import type { DataPoint, DataSourceAdapter } from "@/engine/data/types";
import { point } from "@/engine/data/types";

const log = scopedLogger("data.amadeus");
const SUPPORTED = ["offers", "route", "airport", "airline"];

interface Token {
  value: string;
  expiresAt: number;
}

export class AmadeusAdapter implements DataSourceAdapter {
  readonly key = "amadeus";
  readonly name = "Amadeus Self-Service API";
  readonly isMock = false;
  readonly trustLevel = 0.92;

  private token: Token | null = null;

  constructor(
    private readonly clientId?: string,
    private readonly clientSecret?: string,
    private readonly baseUrl = "https://test.api.amadeus.com",
  ) {}

  isAvailable(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  supports(namespace: string) {
    return SUPPORTED.includes(namespace);
  }

  private async accessToken(): Promise<string> {
    if (!this.isAvailable()) throw new IntegrationNotConfiguredError("amadeus", ["clientId", "clientSecret"]);
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;

    const res = await fetch(`${this.baseUrl}/v1/security/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new IntegrationError("amadeus", `token request failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 1799) * 1000 };
    return this.token.value;
  }

  async resolve(namespace: string, params: Record<string, string>): Promise<DataPoint[]> {
    if (!this.isAvailable()) throw new IntegrationNotConfiguredError("amadeus", ["clientId", "clientSecret"]);
    if (namespace !== "offers") return [];
    return this.offers(params);
  }

  /** Live, priced flight offers. The only source allowed to emit price points. */
  private async offers(params: Record<string, string>): Promise<DataPoint[]> {
    const token = await this.accessToken();
    const qs = new URLSearchParams({
      originLocationCode: (params.origin ?? "").toUpperCase(),
      destinationLocationCode: (params.destination ?? "").toUpperCase(),
      departureDate: params.departDate ?? "",
      adults: params.passengers ?? "1",
      currencyCode: params.currency ?? "USD",
      max: params.limit ?? "10",
      ...(params.returnDate ? { returnDate: params.returnDate } : {}),
      ...(params.cabin ? { travelClass: params.cabin } : {}),
    });

    const res = await fetch(`${this.baseUrl}/v2/shopping/flight-offers?${qs.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new IntegrationError("amadeus", `flight-offers failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const data: any = await res.json();
    const offers: any[] = Array.isArray(data?.data) ? data.data : [];
    const retrievedAt = new Date().toISOString();
    log.info("amadeus offers retrieved", { count: offers.length, origin: params.origin, destination: params.destination });

    const base = {
      sourceKey: this.key,
      sourceName: "Amadeus Self-Service flight-offers",
      retrievedAt,
      confidence: 0.92,
      isMock: false,
      isTimeSensitive: true,
      verificationStatus: "VERIFIED" as const,
      sourceUrl: "https://developers.amadeus.com/self-service",
    };

    const simplified = offers.map((o) => ({
      id: o.id,
      priceTotal: Number(o.price?.grandTotal ?? o.price?.total ?? 0),
      currency: o.price?.currency,
      carrier: o.validatingAirlineCodes?.[0],
      stops: (o.itineraries?.[0]?.segments?.length ?? 1) - 1,
      duration: o.itineraries?.[0]?.duration,
    }));

    const cheapest = simplified.reduce<null | (typeof simplified)[number]>(
      (min, cur) => (min === null || cur.priceTotal < min.priceTotal ? cur : min),
      null,
    );

    return [
      point("offers.count", simplified.length, base),
      point("offers.items", simplified, base),
      ...(cheapest
        ? [
            point("offers.cheapestPrice", cheapest.priceTotal, { ...base, unit: cheapest.currency }),
            point("offers.cheapestCarrier", cheapest.carrier, base),
          ]
        : []),
    ];
  }
}
