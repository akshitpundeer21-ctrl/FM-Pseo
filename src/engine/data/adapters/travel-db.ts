/**
 * Travel Data Layer adapter.
 *
 * Serves the Dynamic Data Engine from the normalized travel tables instead of
 * the bundled JSON files. It emits exactly the same DataPoint paths the
 * StaticDatasetAdapter emits, so every existing component, template and
 * composition rule keeps working untouched - this adapter answers the same
 * questions from a better-normalized store.
 *
 * Two deliberate properties:
 *
 *   1. It NEVER supports a time-sensitive namespace. Prices, schedules, seat
 *      maps and fare rules are not in these tables and cannot be served from
 *      them. That rule lives in TIME_SENSITIVE_NAMESPACES and this adapter does
 *      not go near it.
 *
 *   2. Its own `isMock` is a conservative TRUE, but every point it emits
 *      carries the ROW'S provenance - source, confidence and isMock - not the
 *      adapter's. A row ingested from a credentialed provider is reported as
 *      real even though the adapter is labelled mock, because the row is what
 *      the composer, the fact gate and the evidence block actually read.
 *
 * If a lookup misses, it returns [] and the engine falls through to the next
 * candidate - which is the bundled StaticDatasetAdapter. An empty travel
 * database therefore behaves EXACTLY as the system did before this layer
 * existed. That is what makes it safe to add.
 */
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import type { DataPoint, DataSourceAdapter } from "@/engine/data/types";
import { point } from "@/engine/data/types";

const SUPPORTED = ["route", "airport", "airline", "destination", "city", "country", "policy"];

interface RowProvenance {
  source: string;
  sourceUrl?: string | null;
  confidence: number;
  isMock: boolean;
  retrievedAt: Date;
}

export class TravelDbAdapter implements DataSourceAdapter {
  readonly key = "travel_data_layer";
  readonly name = "Travel Data Layer";
  /** Conservative. Per-point provenance is the value that is actually read. */
  readonly isMock = true;
  /** Above the bundled dataset (0.55) so normalized rows win where they exist. */
  readonly trustLevel = 0.7;

  async isAvailable() {
    try {
      // Cheap existence probe: an empty layer is "unavailable" so the engine
      // moves straight on to the bundled dataset rather than resolving nothing.
      const anyAirport = await prisma.airport.findFirst({ select: { id: true } });
      return Boolean(anyAirport);
    } catch {
      return false;
    }
  }

  supports(namespace: string) {
    return SUPPORTED.includes(namespace);
  }

  async resolve(namespace: string, params: Record<string, string>): Promise<DataPoint[]> {
    switch (namespace) {
      case "route":
        return this.route(params.origin, params.destination);
      case "airport":
        return this.airport(params.iata, params.prefix ?? "airport");
      case "airline":
        return this.airline(params.iata);
      case "destination":
        return this.destination(params.iata, params.city, params.country);
      case "city":
        return this.city(params.name, params.country);
      case "country":
        return this.country(params.iso2);
      case "policy":
        return this.policy(params);
      default:
        return [];
    }
  }

  /** Builds a DataPoint base from the row's own provenance, not the adapter's. */
  private base(row: RowProvenance, overrides: Partial<{ confidence: number; method: string }> = {}) {
    return {
      sourceKey: this.key,
      sourceName: row.source || this.name,
      sourceUrl: row.sourceUrl ?? undefined,
      retrievedAt: row.retrievedAt.toISOString(),
      confidence: overrides.confidence ?? row.confidence,
      isMock: row.isMock,
      ...(overrides.method ? { method: overrides.method } : {}),
    };
  }

  private async airport(iata: string | undefined, prefix: string): Promise<DataPoint[]> {
    if (!iata) return [];
    const a = await prisma.airport.findUnique({
      where: { iata: iata.toUpperCase() },
      include: { city: true, country: true },
    });
    if (!a) return [];

    const b = this.base(a);
    const points: DataPoint[] = [
      point(`${prefix}.iata`, a.iata, b),
      point(`${prefix}.airportName`, a.name, b),
      point(`${prefix}.name`, a.name, b),
    ];

    if (a.icao) points.push(point(`${prefix}.icao`, a.icao, b));
    if (a.city) points.push(point(`${prefix}.city`, a.city.name, b));
    if (a.country) {
      points.push(point(`${prefix}.country`, a.country.name, b));
      points.push(point(`${prefix}.countryCode`, a.country.iso2, b));
    }
    if (a.timezone) points.push(point(`${prefix}.timezone`, a.timezone, b));
    if (a.terminals !== null) {
      points.push(point(`${prefix}.terminals`, a.terminals, this.base(a, { confidence: Math.min(a.confidence, 0.6) })));
    }
    points.push(point(`${prefix}.isHub`, a.isHub, b));
    if (a.latitude !== null && a.longitude !== null) {
      points.push(point(`${prefix}.latitude`, a.latitude, b));
      points.push(point(`${prefix}.longitude`, a.longitude, b));
    }
    return points;
  }

  private async airline(iata?: string): Promise<DataPoint[]> {
    if (!iata) return [];
    const a = await prisma.airline.findUnique({
      where: { iata: iata.toUpperCase() },
      include: { country: true },
    });
    if (!a) return [];

    const b = this.base(a);
    const points: DataPoint[] = [point("airline.name", a.name, b)];
    if (a.iata) points.push(point("airline.iata", a.iata, b));
    if (a.icao) points.push(point("airline.icao", a.icao, b));
    if (a.country) points.push(point("airline.country", a.country.name, b));
    if (a.alliance) points.push(point("airline.alliance", a.alliance, b));
    if (a.callsign) points.push(point("airline.callsign", a.callsign, b));
    points.push(point("airline.type", a.type, b));

    const hubs = readJson<string[]>(a.hubsJson, []);
    if (hubs.length) {
      points.push(point("airline.hub", hubs[0], b));
      points.push(point("airline.hubs", hubs, b));
    }
    return points;
  }

  private async route(origin?: string, destination?: string): Promise<DataPoint[]> {
    if (!origin || !destination) return [];
    const [o, d] = await Promise.all([
      prisma.airport.findUnique({ where: { iata: origin.toUpperCase() }, select: { id: true } }),
      prisma.airport.findUnique({ where: { iata: destination.toUpperCase() }, select: { id: true } }),
    ]);
    if (!o || !d) return [];

    const r = await prisma.route.findUnique({
      where: { originAirportId_destinationAirportId: { originAirportId: o.id, destinationAirportId: d.id } },
      include: {
        originAirport: true,
        destinationAirport: true,
        airlines: { include: { airline: true }, where: { status: "ACTIVE" } },
      },
    });
    if (!r) return [];

    const b = this.base(r);
    const points: DataPoint[] = [
      point("route.id", r.id, b),
      point("route.origin", r.originAirport.iata, b),
      point("route.destination", r.destinationAirport.iata, b),
    ];

    if (r.distanceKm !== null) {
      points.push(
        point("route.distanceKm", r.distanceKm, {
          ...this.base(r, { confidence: Math.max(r.confidence, 0.9) }),
          unit: "km",
          method: "Great-circle distance computed from published airport coordinates",
        }),
      );
    }
    if (r.typicalDurationMinutes !== null) {
      points.push(
        point("route.typicalDurationMinutes", r.typicalDurationMinutes, {
          ...this.base(r, { confidence: Math.min(r.confidence, 0.5) }),
          unit: "minutes",
          method: r.method ?? "Estimated from distance; not a published schedule",
        }),
      );
    }
    if (r.typicalStops !== null) {
      points.push(point("route.typicalStops", r.typicalStops, this.base(r, { confidence: Math.min(r.confidence, 0.55) })));
    }
    points.push(point("route.nonstopAvailable", r.nonstopAvailable, this.base(r, { confidence: Math.min(r.confidence, 0.55) })));
    points.push(point("route.routeType", r.routeType, b));
    if (r.frequency !== null) points.push(point("route.frequency", r.frequency, b));

    const carriers = r.airlines
      .map((ra) => ({ iata: ra.airline.iata, name: ra.airline.name, alliance: ra.airline.alliance }))
      .filter((c) => c.name);
    if (carriers.length) {
      // Carrier confidence is the weakest link across the join rows, not the
      // route's - the list is only as good as the worst attribution in it.
      const weakest = Math.min(...r.airlines.map((ra) => ra.confidence));
      const anyMock = r.airlines.some((ra) => ra.isMock);
      points.push(
        point("route.airlines", carriers, {
          ...this.base(r, { confidence: weakest }),
          isMock: anyMock || r.isMock,
        }),
      );
    }

    const cabins = readJson<string[]>(r.cabinClassesJson, []);
    if (cabins.length) points.push(point("route.cabinClasses", cabins, b));

    return points;
  }

  private async destination(iata?: string, cityName?: string, countryIso2?: string): Promise<DataPoint[]> {
    // The route pages ask for a destination by arrival airport, so resolve the
    // airport first and fall back to an explicit city name.
    let city: { id: string; name: string } | null = null;
    if (iata) {
      const airport = await prisma.airport.findUnique({
        where: { iata: iata.toUpperCase() },
        include: { city: true },
      });
      city = airport?.city ?? null;
    }
    if (!city && cityName) {
      const country = countryIso2
        ? await prisma.country.findUnique({ where: { iso2: countryIso2.toUpperCase() }, select: { id: true } })
        : null;
      city = country
        ? await prisma.city.findUnique({ where: { countryId_name: { countryId: country.id, name: cityName } } })
        : await prisma.city.findFirst({ where: { name: cityName }, orderBy: { confidence: "desc" } });
    }
    if (!city) return iata ? this.airport(iata, "destination") : [];

    const dest = await prisma.destination.findFirst({
      where: { cityId: city.id, status: "ACTIVE" },
      include: { country: true },
      orderBy: { confidence: "desc" },
    });

    // Always emit the airport-shaped facts the existing templates bind to, then
    // layer destination attributes on top when a row exists.
    const points = iata ? await this.airport(iata, "destination") : [];
    if (!dest) return points;

    const b = this.base(dest);
    points.push(point("destination.name", dest.name, b));
    if (dest.description) points.push(point("destination.description", dest.description, b));
    if (dest.country) points.push(point("destination.country", dest.country.name, b));

    const attrs = readJson<Record<string, unknown>>(dest.travelAttributesJson, {});
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      points.push(point(`destination.${key}`, value, this.base(dest, { confidence: Math.min(dest.confidence, 0.5) })));
    }
    return points;
  }

  private async city(name?: string, countryIso2?: string): Promise<DataPoint[]> {
    if (!name) return [];
    const country = countryIso2
      ? await prisma.country.findUnique({ where: { iso2: countryIso2.toUpperCase() }, select: { id: true } })
      : null;
    const c = country
      ? await prisma.city.findUnique({
          where: { countryId_name: { countryId: country.id, name } },
          include: { country: true, region: true, airports: true },
        })
      : await prisma.city.findFirst({
          where: { name },
          include: { country: true, region: true, airports: true },
          orderBy: { confidence: "desc" },
        });
    if (!c) return [];

    const b = this.base(c);
    const points: DataPoint[] = [point("city.name", c.name, b), point("city.country", c.country.name, b), point("city.countryCode", c.country.iso2, b)];
    if (c.region) points.push(point("city.region", c.region.name, b));
    if (c.timezone) points.push(point("city.timezone", c.timezone, b));
    if (c.population !== null) points.push(point("city.population", c.population, b));
    if (c.latitude !== null && c.longitude !== null) {
      points.push(point("city.latitude", c.latitude, b));
      points.push(point("city.longitude", c.longitude, b));
    }
    if (c.airports.length) {
      points.push(point("city.airports", c.airports.map((a) => ({ iata: a.iata, name: a.name })), b));
    }
    return points;
  }

  private async country(iso2?: string): Promise<DataPoint[]> {
    if (!iso2) return [];
    const c = await prisma.country.findUnique({ where: { iso2: iso2.toUpperCase() } });
    if (!c) return [];
    const b = this.base(c);
    const points: DataPoint[] = [point("country.name", c.name, b), point("country.iso2", c.iso2, b)];
    if (c.officialName) points.push(point("country.officialName", c.officialName, b));
    if (c.iso3) points.push(point("country.iso3", c.iso3, b));
    if (c.continent) points.push(point("country.continent", c.continent, b));
    if (c.currencyCode) points.push(point("country.currencyCode", c.currencyCode, b));
    return points;
  }

  /**
   * Policies are attributable but inherently perishable. Every point is marked
   * time-sensitive so the existing fact gate treats it the way it treats a
   * fare: publishable only with a live, verified source behind it.
   */
  private async policy(params: Record<string, string>): Promise<DataPoint[]> {
    const { subjectType, subjectKey } = params;
    if (!subjectType || !subjectKey) return [];

    const now = new Date();
    const rows = await prisma.travelPolicy.findMany({
      where: {
        subjectType: subjectType.toUpperCase(),
        subjectKey: subjectKey.toUpperCase(),
        ...(params.policyType ? { policyType: params.policyType.toUpperCase() } : {}),
        ...(params.counterpartKey ? { counterpartKey: params.counterpartKey.toUpperCase() } : {}),
        status: "ACTIVE",
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: [{ confidence: "desc" }, { retrievedAt: "desc" }],
      take: 20,
    });
    if (!rows.length) return [];

    return rows.map((p) =>
      point(
        `policy.${p.policyType.toLowerCase()}`,
        { title: p.title, body: p.body, detail: readJson<Record<string, unknown>>(p.detailJson, {}) },
        {
          ...this.base(p),
          isTimeSensitive: true,
          method: "Travel policy record - must be verified against the issuing authority before publication",
        },
      ),
    );
  }
}
