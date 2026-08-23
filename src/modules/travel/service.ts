/**
 * Travel Data Layer read API.
 *
 * The single place anything in the OS asks "what do we know about this airport /
 * airline / route / city / destination / policy". Agents do not call this
 * directly - they go through the existing `data.resolve` tool, which reaches
 * this layer via the TravelDbAdapter. The dashboard and ingest tooling use it
 * directly.
 *
 * Every lookup returns the row's provenance alongside its values, because a
 * travel value without a source is not usable by this system.
 */
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import type { TravelProvenance } from "@/modules/travel/types";

/** Pulls the shared provenance columns off any travel row. */
export function provenanceOf(row: {
  source: string;
  sourceType: string;
  sourceUrl?: string | null;
  provider?: string | null;
  providerRecordId?: string | null;
  confidence: number;
  isMock: boolean;
  retrievedAt: Date;
  expiresAt?: Date | null;
  lastVerifiedAt?: Date | null;
}): TravelProvenance {
  return {
    source: row.source,
    sourceType: row.sourceType as TravelProvenance["sourceType"],
    sourceUrl: row.sourceUrl ?? null,
    provider: row.provider ?? null,
    providerRecordId: row.providerRecordId ?? null,
    confidence: row.confidence,
    isMock: row.isMock,
    retrievedAt: row.retrievedAt,
    expiresAt: row.expiresAt ?? null,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
  };
}

/** True when a row has an expiry that has passed. Callers decide what to do. */
export function isStale(p: TravelProvenance, now = new Date()): boolean {
  return Boolean(p.expiresAt && p.expiresAt.getTime() <= now.getTime());
}

// ---------------------------------------------------------------------------

export async function findCountry(iso2: string) {
  return prisma.country.findUnique({ where: { iso2: iso2.toUpperCase() } });
}

export async function findAirport(iata: string) {
  return prisma.airport.findUnique({
    where: { iata: iata.toUpperCase() },
    include: { city: true, country: true },
  });
}

export async function findAirline(iata: string) {
  return prisma.airline.findUnique({
    where: { iata: iata.toUpperCase() },
    include: { country: true },
  });
}

export async function findCity(name: string, countryIso2?: string) {
  if (countryIso2) {
    const country = await findCountry(countryIso2);
    if (!country) return null;
    return prisma.city.findUnique({
      where: { countryId_name: { countryId: country.id, name } },
      include: { country: true, region: true, airports: true },
    });
  }
  return prisma.city.findFirst({
    where: { name },
    include: { country: true, region: true, airports: true },
    orderBy: { confidence: "desc" },
  });
}

/**
 * A route by airport pair, with its carriers. Direction matters: DEL-YYZ and
 * YYZ-DEL are distinct rows, matching how the rest of the OS keys routes.
 */
export async function findRoute(originIata: string, destinationIata: string) {
  const [origin, destination] = await Promise.all([
    prisma.airport.findUnique({ where: { iata: originIata.toUpperCase() }, select: { id: true } }),
    prisma.airport.findUnique({ where: { iata: destinationIata.toUpperCase() }, select: { id: true } }),
  ]);
  if (!origin || !destination) return null;

  return prisma.route.findUnique({
    where: {
      originAirportId_destinationAirportId: {
        originAirportId: origin.id,
        destinationAirportId: destination.id,
      },
    },
    include: {
      originAirport: { include: { city: true, country: true } },
      destinationAirport: { include: { city: true, country: true } },
      originCity: true,
      destinationCity: true,
      airlines: { include: { airline: true } },
    },
  });
}

export async function findDestination(cityName: string, countryIso2?: string) {
  const city = await findCity(cityName, countryIso2);
  if (!city) return null;
  return prisma.destination.findFirst({
    where: { cityId: city.id },
    include: { city: { include: { country: true } }, country: true },
    orderBy: { confidence: "desc" },
  });
}

/**
 * Policies for a subject. Expired and withdrawn rows are excluded by default -
 * a lapsed visa rule is worse than no rule.
 */
export async function findPolicies(params: {
  subjectType: string;
  subjectKey: string;
  policyType?: string;
  counterpartKey?: string;
  includeExpired?: boolean;
}) {
  const now = new Date();
  return prisma.travelPolicy.findMany({
    where: {
      subjectType: params.subjectType.toUpperCase(),
      subjectKey: params.subjectKey.toUpperCase(),
      ...(params.policyType ? { policyType: params.policyType.toUpperCase() } : {}),
      ...(params.counterpartKey ? { counterpartKey: params.counterpartKey.toUpperCase() } : {}),
      ...(params.includeExpired
        ? {}
        : {
            status: "ACTIVE",
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          }),
    },
    orderBy: [{ confidence: "desc" }, { retrievedAt: "desc" }],
  });
}

/** Airports serving a city, best-confidence first. */
export async function airportsForCity(cityName: string, countryIso2?: string) {
  const city = await findCity(cityName, countryIso2);
  if (!city) return [];
  return prisma.airport.findMany({
    where: { cityId: city.id, status: "ACTIVE" },
    orderBy: [{ isHub: "desc" }, { confidence: "desc" }],
  });
}

/** Other routes from the same origin - used for sibling-page linking. */
export async function routesFromAirport(originIata: string, limit = 10) {
  const origin = await prisma.airport.findUnique({
    where: { iata: originIata.toUpperCase() },
    select: { id: true },
  });
  if (!origin) return [];
  return prisma.route.findMany({
    where: { originAirportId: origin.id, status: "ACTIVE" },
    include: { destinationAirport: { include: { city: true } } },
    orderBy: { distanceKm: "asc" },
    take: limit,
  });
}

export function aliasesOf(row: { aliasesJson: string }): string[] {
  return readJson<string[]>(row.aliasesJson, []);
}

export function hubsOf(row: { hubsJson: string }): string[] {
  return readJson<string[]>(row.hubsJson, []);
}

export function travelAttributesOf(row: { travelAttributesJson: string }): Record<string, unknown> {
  return readJson<Record<string, unknown>>(row.travelAttributesJson, {});
}

/** Counts + provenance mix, for the dashboard and for tests. */
export async function travelDataStats() {
  const [countries, regions, cities, airports, airlines, routes, routeAirlines, destinations, policies] =
    await Promise.all([
      prisma.country.count(),
      prisma.region.count(),
      prisma.city.count(),
      prisma.airport.count(),
      prisma.airline.count(),
      prisma.route.count(),
      prisma.routeAirline.count(),
      prisma.destination.count(),
      prisma.travelPolicy.count(),
    ]);

  const [mockAirports, mockRoutes] = await Promise.all([
    prisma.airport.count({ where: { isMock: true } }),
    prisma.route.count({ where: { isMock: true } }),
  ]);

  return {
    counts: { countries, regions, cities, airports, airlines, routes, routeAirlines, destinations, policies },
    provenance: {
      mockAirports,
      mockRoutes,
      /** True while nothing has been ingested from a credentialed provider. */
      allReferenceData: mockAirports === airports && mockRoutes === routes,
    },
  };
}
