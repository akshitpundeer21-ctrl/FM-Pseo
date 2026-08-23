/**
 * Travel Data Layer contracts.
 *
 * The layer sits between provider adapters and the existing Dynamic Data
 * Engine. It owns normalized travel entities (countries, regions, cities,
 * airports, airlines, routes, destinations, policies) and the provenance of
 * every one of them.
 *
 * It deliberately does NOT own live operational data. Prices, schedules, seat
 * availability and fare rules stay in the time-sensitive namespaces that only a
 * credentialed adapter may serve - see TIME_SENSITIVE_NAMESPACES in
 * src/engine/data/engine.ts. Nothing here weakens that rule.
 */

/**
 * The provenance every travel row carries, mirroring the columns on the Prisma
 * models and the shape of the existing `Fact` model.
 */
export interface TravelProvenance {
  /** Human-readable source name, shown in the published evidence block. */
  source: string;
  /** STATIC_DATASET | PROVIDER_API | MANUAL | CRAWL */
  sourceType: TravelSourceType;
  sourceUrl?: string | null;
  /** Adapter key that produced the row, e.g. "bundled_reference" or "amadeus". */
  provider?: string | null;
  /** The provider's own identifier for the record, for reconciliation. */
  providerRecordId?: string | null;
  /** 0..1 */
  confidence: number;
  /**
   * True when the row came from an approximate/bundled source. Load-bearing:
   * the composer, the fact gate and the published evidence block all read it.
   */
  isMock: boolean;
  retrievedAt: Date;
  expiresAt?: Date | null;
  lastVerifiedAt?: Date | null;
}

export type TravelSourceType = "STATIC_DATASET" | "PROVIDER_API" | "MANUAL" | "CRAWL";

/** Namespaces the Travel Data Layer can answer. Never a time-sensitive one. */
export const TRAVEL_NAMESPACES = ["country", "city", "airport", "airline", "route", "destination", "policy"] as const;
export type TravelNamespace = (typeof TRAVEL_NAMESPACES)[number];

// ---------------------------------------------------------------------------
// Normalized records a provider returns. Deliberately plain data: a provider
// never touches Prisma, and ingest never talks to an external API.
// ---------------------------------------------------------------------------

export interface CountryRecord {
  iso2: string;
  name: string;
  officialName?: string;
  iso3?: string;
  continent?: string;
  region?: string;
  currencyCode?: string;
}

export interface RegionRecord {
  countryIso2: string;
  name: string;
  code?: string;
  type?: string;
}

export interface CityRecord {
  name: string;
  countryIso2: string;
  regionName?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  population?: number;
  aliases?: string[];
}

export interface AirportRecord {
  iata: string;
  name: string;
  icao?: string;
  cityName?: string;
  countryIso2?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  type?: string;
  terminals?: number;
  isHub?: boolean;
  aliases?: string[];
}

export interface AirlineRecord {
  name: string;
  iata?: string;
  icao?: string;
  countryIso2?: string;
  callsign?: string;
  alliance?: string;
  type?: string;
  hubs?: string[];
}

export interface RouteRecord {
  originIata: string;
  destinationIata: string;
  routeType?: string;
  distanceKm?: number;
  typicalDurationMinutes?: number;
  typicalStops?: number;
  nonstopAvailable?: boolean;
  frequency?: number;
  cabinClasses?: string[];
  /** IATA codes of carriers observed on the pair. */
  airlineIatas?: string[];
  /** How distance/duration were derived. Estimates are never sold as schedules. */
  method?: string;
}

export interface DestinationRecord {
  cityName: string;
  countryIso2: string;
  name: string;
  description?: string;
  aliases?: string[];
  travelAttributes?: Record<string, unknown>;
}

export interface TravelPolicyRecord {
  policyType: string;
  subjectType: string;
  subjectKey: string;
  counterpartKey?: string;
  title: string;
  body?: string;
  detail?: Record<string, unknown>;
  effectiveFrom?: Date;
  effectiveTo?: Date;
}

/** Everything a provider can contribute in one pull. All parts optional. */
export interface TravelDataset {
  countries?: CountryRecord[];
  regions?: RegionRecord[];
  cities?: CityRecord[];
  airports?: AirportRecord[];
  airlines?: AirlineRecord[];
  routes?: RouteRecord[];
  destinations?: DestinationRecord[];
  policies?: TravelPolicyRecord[];
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

/**
 * A source of travel reference data.
 *
 * Mirrors the shape of the existing `DataSourceAdapter` in
 * src/engine/data/types.ts on purpose: same vocabulary, same availability
 * contract, so the two layers stay legible together. This one supplies rows to
 * ingest; that one answers a namespace at render time.
 *
 * A provider must never fabricate. If it cannot reach its source it reports
 * unavailable and returns nothing.
 */
export interface TravelDataProvider {
  readonly key: string;
  readonly name: string;
  /** True for approximate/bundled sources. Propagates onto every row it writes. */
  readonly isMock: boolean;
  /** 0..1 - used to decide which provider's value wins on conflict. */
  readonly trustLevel: number;
  /** Whether the provider can serve right now (credentials present, file readable). */
  isAvailable(): Promise<boolean> | boolean;
  /** Pull the entity kinds this provider knows about. */
  fetch(kinds?: (keyof TravelDataset)[]): Promise<TravelDataset>;
  /** Provenance stamped on every row this provider contributes. */
  provenance(): TravelProvenance;
}

/** What an ingest run did, per entity kind. */
export interface IngestReport {
  provider: string;
  isMock: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  counts: Record<string, { created: number; updated: number; skipped: number }>;
  /** Rows refused, with the reason. Never silently dropped. */
  rejected: { kind: string; key: string; reason: string }[];
  available: boolean;
  /** Set when the provider could not run at all. */
  unavailableReason?: string;
}

export function emptyCounts(): IngestReport["counts"] {
  return {};
}

export function bump(
  counts: IngestReport["counts"],
  kind: string,
  outcome: "created" | "updated" | "skipped",
): void {
  const row = (counts[kind] ??= { created: 0, updated: 0, skipped: 0 });
  row[outcome] += 1;
}
