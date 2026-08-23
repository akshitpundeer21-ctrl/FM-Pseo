/**
 * Bundled reference data provider.
 *
 * Reads the same data/mock/*.json files the existing StaticDatasetAdapter reads
 * - through its own loaders, so there is exactly one parser for those files -
 * and normalizes them into Travel Data Layer records.
 *
 * Everything it produces is `isMock: true` and stays that way in the database.
 * These files are approximate reference attributes: no fares, no schedules, no
 * seat availability. Ingesting them into tables does not upgrade their truth,
 * and nothing here pretends otherwise.
 */
import {
  datasetMeta,
  loadAirlines,
  loadAirports,
  loadRoutes,
} from "@/engine/data/adapters/static-dataset";
import type {
  AirlineRecord,
  AirportRecord,
  CityRecord,
  CountryRecord,
  DestinationRecord,
  RouteRecord,
  TravelDataProvider,
  TravelDataset,
  TravelProvenance,
} from "@/modules/travel/types";

export class BundledReferenceProvider implements TravelDataProvider {
  readonly key = "bundled_reference";
  readonly name = "Bundled static reference dataset";
  readonly isMock = true;
  readonly trustLevel = 0.55;

  isAvailable() {
    try {
      return loadAirports().length > 0;
    } catch {
      return false;
    }
  }

  provenance(): TravelProvenance {
    const meta = datasetMeta("airports");
    return {
      source: meta.sourceName,
      sourceType: "STATIC_DATASET",
      provider: this.key,
      confidence: 0.6,
      isMock: true,
      retrievedAt: new Date(meta.retrievedAt),
    };
  }

  async fetch(kinds?: (keyof TravelDataset)[]): Promise<TravelDataset> {
    const want = (k: keyof TravelDataset) => !kinds || kinds.includes(k);
    const airports = loadAirports();
    const airlines = loadAirlines();
    const routes = loadRoutes();

    // country name -> ISO2, learned from the airport rows. Airlines carry a
    // country name only, so anything not seen on an airport stays unmapped
    // rather than being guessed.
    const iso2ByCountryName = new Map<string, string>();
    for (const a of airports) {
      if (a.country && a.countryCode) iso2ByCountryName.set(String(a.country), String(a.countryCode).toUpperCase());
    }

    const dataset: TravelDataset = {};

    if (want("countries")) {
      const seen = new Map<string, CountryRecord>();
      for (const a of airports) {
        const iso2 = String(a.countryCode ?? "").toUpperCase();
        if (!iso2 || seen.has(iso2)) continue;
        seen.set(iso2, { iso2, name: String(a.country ?? iso2) });
      }
      dataset.countries = [...seen.values()];
    }

    if (want("cities")) {
      const seen = new Map<string, CityRecord>();
      for (const a of airports) {
        const iso2 = String(a.countryCode ?? "").toUpperCase();
        const name = String(a.city ?? "").trim();
        if (!iso2 || !name) continue;
        const key = `${iso2}::${name}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          name,
          countryIso2: iso2,
          // The airport's coordinates are the only geo signal in the dataset.
          // They locate the airport, not the city centre, so they are carried
          // as an approximation and the row stays isMock.
          latitude: typeof a.lat === "number" ? a.lat : undefined,
          longitude: typeof a.lon === "number" ? a.lon : undefined,
          timezone: a.timezone ? String(a.timezone) : undefined,
        });
      }
      dataset.cities = [...seen.values()];
    }

    if (want("airports")) {
      dataset.airports = airports.map(
        (a): AirportRecord => ({
          iata: String(a.iata).toUpperCase(),
          icao: a.icao ? String(a.icao).toUpperCase() : undefined,
          name: String(a.name),
          cityName: a.city ? String(a.city) : undefined,
          countryIso2: a.countryCode ? String(a.countryCode).toUpperCase() : undefined,
          latitude: typeof a.lat === "number" ? a.lat : undefined,
          longitude: typeof a.lon === "number" ? a.lon : undefined,
          timezone: a.timezone ? String(a.timezone) : undefined,
          terminals: typeof a.terminals === "number" ? a.terminals : undefined,
          isHub: Boolean(a.isHub),
          type: "INTERNATIONAL",
        }),
      );
    }

    if (want("airlines")) {
      dataset.airlines = airlines.map(
        (a): AirlineRecord => ({
          name: String(a.name),
          iata: a.iata ? String(a.iata).toUpperCase() : undefined,
          icao: a.icao ? String(a.icao).toUpperCase() : undefined,
          countryIso2: a.country ? iso2ByCountryName.get(String(a.country)) : undefined,
          alliance: a.alliance ? String(a.alliance) : undefined,
          type: normaliseAirlineType(a.type),
          hubs: hubIatas(a.hub),
        }),
      );
    }

    if (want("routes")) {
      const meta = datasetMeta("routes");
      dataset.routes = routes.map(
        (r): RouteRecord => ({
          originIata: String(r.origin).toUpperCase(),
          destinationIata: String(r.destination).toUpperCase(),
          routeType: r.nonstopAvailable ? "NONSTOP" : r.typicalStops === 1 ? "ONE_STOP" : "MIXED",
          distanceKm: typeof r.distanceKm === "number" ? r.distanceKm : undefined,
          typicalDurationMinutes:
            typeof r.typicalDurationMinutes === "number" ? r.typicalDurationMinutes : undefined,
          typicalStops: typeof r.typicalStops === "number" ? r.typicalStops : undefined,
          nonstopAvailable: Boolean(r.nonstopAvailable),
          cabinClasses: Array.isArray(r.cabinClasses) ? r.cabinClasses.map(String) : [],
          airlineIatas: Array.isArray(r.airlines) ? r.airlines.map((x: unknown) => String(x).toUpperCase()) : [],
          // Carries the dataset's own note forward, which states plainly that
          // duration is estimated rather than scheduled.
          method: meta.note,
        }),
      );
    }

    if (want("destinations")) {
      // One destination per city that a route actually arrives at. Description
      // is left empty on purpose: the dataset has none, and inventing one is
      // exactly what this system refuses to do.
      const byCity = new Map<string, DestinationRecord>();
      const airportByIata = new Map(airports.map((a) => [String(a.iata).toUpperCase(), a]));
      for (const r of routes) {
        const arrival = airportByIata.get(String(r.destination).toUpperCase());
        if (!arrival?.city || !arrival?.countryCode) continue;
        const key = `${String(arrival.countryCode).toUpperCase()}::${arrival.city}`;
        if (byCity.has(key)) continue;
        byCity.set(key, {
          cityName: String(arrival.city),
          countryIso2: String(arrival.countryCode).toUpperCase(),
          name: String(arrival.city),
          description: "",
          travelAttributes: {
            ...(Array.isArray(r.peakMonths) && r.peakMonths.length
              ? { peakMonths: r.peakMonths, peakMonthsNote: "Synthetic seasonality signal from the bundled dataset." }
              : {}),
            primaryAirport: String(arrival.iata).toUpperCase(),
          },
        });
      }
      dataset.destinations = [...byCity.values()];
    }

    // No policies. The bundled files contain no visa, baggage or entry rules,
    // and this provider will not manufacture any.
    return dataset;
  }
}

/**
 * The bundled dataset writes a hub as a display label - "Toronto Pearson (YYZ)".
 * The schema promises IATA codes, so pull the code out of the parentheses.
 * A label with no recoverable code contributes no hub rather than a wrong one.
 */
function hubIatas(raw: unknown): string[] {
  const label = String(raw ?? "").trim();
  if (!label) return [];

  const parenthesised = label.match(/\(([A-Za-z]{3})\)\s*$/);
  if (parenthesised) return [parenthesised[1].toUpperCase()];

  // Already a bare code.
  if (/^[A-Za-z]{3}$/.test(label)) return [label.toUpperCase()];

  return [];
}

function normaliseAirlineType(raw: unknown): string {
  const value = String(raw ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const allowed = ["FULL_SERVICE", "LOW_COST", "REGIONAL", "CHARTER", "CARGO"];
  return allowed.includes(value) ? value : "OTHER";
}
