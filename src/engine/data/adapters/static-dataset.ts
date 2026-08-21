/**
 * Static reference dataset adapter.
 *
 * Serves airport / airline / route reference attributes from data/mock/*.json.
 * These files are approximate reference data, never live operational data, so:
 *   - every point it emits is `isMock: true`
 *   - it refuses the "offers" namespace entirely (no invented prices)
 *   - confidence is capped well below a verified live source
 */
import fs from "node:fs";
import path from "node:path";
import type { DataPoint, DataSourceAdapter } from "@/engine/data/types";
import { point } from "@/engine/data/types";

interface Dataset {
  $meta: { sourceName: string; retrievedAt: string; note?: string };
  [key: string]: any;
}

const cache = new Map<string, Dataset>();

function load(name: string): Dataset {
  const cached = cache.get(name);
  if (cached) return cached;
  const file = path.join(process.cwd(), "data", "mock", `${name}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Dataset;
  cache.set(name, parsed);
  return parsed;
}

export function loadAirports() {
  return load("airports").airports as any[];
}
export function loadAirlines() {
  return load("airlines").airlines as any[];
}
export function loadRoutes() {
  return load("routes").routes as any[];
}
export function loadCompetitors() {
  return load("competitors").competitors as any[];
}
export function datasetMeta(name: string) {
  return load(name).$meta;
}

const SUPPORTED = ["route", "airport", "airline", "destination"];

export class StaticDatasetAdapter implements DataSourceAdapter {
  readonly key = "static_reference";
  readonly name = "Bundled static reference dataset";
  readonly isMock = true;
  readonly trustLevel = 0.55;

  isAvailable() {
    return true;
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
        return this.airport(params.iata, "destination");
      default:
        return [];
    }
  }

  private base(dataset: string) {
    const meta = datasetMeta(dataset);
    return {
      sourceKey: this.key,
      sourceName: meta.sourceName,
      retrievedAt: meta.retrievedAt,
      isMock: true,
    };
  }

  private airportRow(iata?: string) {
    if (!iata) return undefined;
    return loadAirports().find((a) => a.iata === iata.toUpperCase());
  }

  private airport(iata: string | undefined, prefix: string): DataPoint[] {
    const a = this.airportRow(iata);
    if (!a) return [];
    const b = { ...this.base("airports"), confidence: 0.7 };
    return [
      point(`${prefix}.iata`, a.iata, b),
      point(`${prefix}.icao`, a.icao, b),
      point(`${prefix}.airportName`, a.name, b),
      point(`${prefix}.name`, a.name, b),
      point(`${prefix}.city`, a.city, b),
      point(`${prefix}.country`, a.country, b),
      point(`${prefix}.countryCode`, a.countryCode, b),
      point(`${prefix}.timezone`, a.timezone, b),
      point(`${prefix}.terminals`, a.terminals, { ...b, confidence: 0.6 }),
      point(`${prefix}.isHub`, a.isHub, b),
    ];
  }

  private airline(iata?: string): DataPoint[] {
    if (!iata) return [];
    const a = loadAirlines().find((x) => x.iata === iata.toUpperCase());
    if (!a) return [];
    const b = { ...this.base("airlines"), confidence: 0.7 };
    return [
      point("airline.iata", a.iata, b),
      point("airline.name", a.name, b),
      point("airline.country", a.country, b),
      point("airline.alliance", a.alliance, b),
      point("airline.hub", a.hub, b),
      point("airline.type", a.type, b),
    ];
  }

  private route(origin?: string, destination?: string): DataPoint[] {
    if (!origin || !destination) return [];
    const o = origin.toUpperCase();
    const d = destination.toUpperCase();
    const r = loadRoutes().find((x) => x.origin === o && x.destination === d);
    if (!r) return [];

    const meta = datasetMeta("routes");
    const b = { ...this.base("routes"), confidence: 0.65 };
    const carriers = loadAirlines().filter((a) => r.airlines.includes(a.iata));

    return [
      point("route.id", r.id, b),
      point("route.origin", r.origin, b),
      point("route.destination", r.destination, b),
      point("route.distanceKm", r.distanceKm, {
        ...b,
        confidence: 0.9,
        unit: "km",
        method: "Great-circle distance computed from published airport coordinates",
      }),
      point("route.typicalDurationMinutes", r.typicalDurationMinutes, {
        ...b,
        confidence: 0.5,
        unit: "minutes",
        method: meta.note ?? "Estimated from distance; not a published schedule",
      }),
      point("route.typicalStops", r.typicalStops, { ...b, confidence: 0.55 }),
      point("route.nonstopAvailable", r.nonstopAvailable, { ...b, confidence: 0.55 }),
      point(
        "route.airlines",
        carriers.map((c) => ({ iata: c.iata, name: c.name, alliance: c.alliance })),
        { ...b, confidence: 0.6 },
      ),
      point("route.cabinClasses", r.cabinClasses, b),
      point("route.demandIndex", r.demandIndex, { ...b, confidence: 0.4, method: "Synthetic relative demand index" }),
      point("route.peakMonths", r.peakMonths, { ...b, confidence: 0.4 }),
    ];
  }
}
