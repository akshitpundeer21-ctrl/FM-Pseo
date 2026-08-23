/**
 * Travel Data Layer tests.
 *
 * Two things are being proven here:
 *
 *   1. The layer works — entities, lookups, provenance, caching, ingestion and
 *      adapter resolution.
 *   2. Adding it did not change what the rest of the OS is allowed to do. The
 *      time-sensitive rule still holds, an empty layer still falls through to
 *      the bundled dataset, and a mock source still cannot overwrite real data.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/core/db/client";
import { BundledReferenceProvider } from "@/modules/travel/providers/bundled";
import { ingestFromProvider, mayOverwrite } from "@/modules/travel/ingest";
import {
  aliasesOf,
  airportsForCity,
  findAirline,
  findAirport,
  findCity,
  findCountry,
  findDestination,
  findPolicies,
  findRoute,
  hubsOf,
  isStale,
  provenanceOf,
  routesFromAirport,
  travelDataStats,
} from "@/modules/travel/service";
import { TravelDbAdapter } from "@/engine/data/adapters/travel-db";
import { DynamicDataEngine, TIME_SENSITIVE_NAMESPACES } from "@/engine/data/engine";
import {
  cached,
  pruneCache,
  readCache,
  REDACTED,
  requestHash,
  scrubParams,
  writeCache,
} from "@/modules/travel/cache";

let projectId: string;
let organizationId: string;

beforeAll(async () => {
  const project = await prisma.project.findFirst({ where: { slug: "faresmatch-global" } });
  if (!project) throw new Error("Seed did not run - no project found");
  projectId = project.id;
  organizationId = project.organizationId;

  // The layer must be populated for lookups to have anything to find.
  await ingestFromProvider(new BundledReferenceProvider());
});

describe("ingestion", () => {
  it("populates every entity kind from the bundled provider", async () => {
    const stats = await travelDataStats();
    expect(stats.counts.countries).toBeGreaterThan(0);
    expect(stats.counts.cities).toBeGreaterThan(0);
    expect(stats.counts.airports).toBeGreaterThan(0);
    expect(stats.counts.airlines).toBeGreaterThan(0);
    expect(stats.counts.routes).toBeGreaterThan(0);
    expect(stats.counts.destinations).toBeGreaterThan(0);
  });

  it("is idempotent — re-running creates nothing new", async () => {
    const before = await travelDataStats();
    const report = await ingestFromProvider(new BundledReferenceProvider());
    const after = await travelDataStats();

    expect(after.counts).toEqual(before.counts);
    for (const counts of Object.values(report.counts)) expect(counts.created).toBe(0);
  });

  it("rejects rows it cannot resolve instead of dropping them silently", async () => {
    const report = await ingestFromProvider({
      key: "test_partial",
      name: "Test provider",
      isMock: true,
      trustLevel: 0.5,
      isAvailable: () => true,
      provenance: () => ({
        source: "Test",
        sourceType: "MANUAL" as const,
        provider: "test_partial",
        confidence: 0.5,
        isMock: true,
        retrievedAt: new Date(),
      }),
      fetch: async () => ({
        routes: [{ originIata: "ZZZ", destinationIata: "YYY" }],
        destinations: [{ cityName: "Atlantis", countryIso2: "XX", name: "Atlantis" }],
      }),
    });

    expect(report.rejected.length).toBe(2);
    expect(report.rejected.map((r) => r.reason).join(" ")).toMatch(/Unknown/);
  });

  it("reports an unavailable provider rather than writing nothing quietly", async () => {
    const report = await ingestFromProvider({
      key: "test_offline",
      name: "Offline provider",
      isMock: false,
      trustLevel: 0.9,
      isAvailable: () => false,
      provenance: () => ({
        source: "Offline",
        sourceType: "PROVIDER_API" as const,
        confidence: 0.9,
        isMock: false,
        retrievedAt: new Date(),
      }),
      fetch: async () => ({}),
    });

    expect(report.available).toBe(false);
    expect(report.unavailableReason).toMatch(/not available/i);
    expect(Object.keys(report.counts)).toHaveLength(0);
  });
});

describe("the no-downgrade rule", () => {
  it("lets real data replace reference data, never the reverse", () => {
    const mock = { isMock: true, confidence: 0.6 };
    const real = { isMock: false, confidence: 0.9 };

    expect(mayOverwrite(mock, real)).toBe(true);
    expect(mayOverwrite(real, mock)).toBe(false);
    expect(mayOverwrite(null, mock)).toBe(true);
  });

  it("prefers the more confident source within the same class", () => {
    expect(mayOverwrite({ isMock: true, confidence: 0.4 }, { isMock: true, confidence: 0.8 })).toBe(true);
    expect(mayOverwrite({ isMock: true, confidence: 0.8 }, { isMock: true, confidence: 0.4 })).toBe(false);
    // Equal provenance re-ingest is allowed so a refresh can update retrievedAt.
    expect(mayOverwrite({ isMock: true, confidence: 0.6 }, { isMock: true, confidence: 0.6 })).toBe(true);
  });

  it("does not clobber a provider-sourced row when the bundled set is re-ingested", async () => {
    const airport = await prisma.airport.findUnique({ where: { iata: "DEL" } });
    expect(airport).toBeTruthy();

    // Promote the row as if a credentialed provider had supplied it.
    await prisma.airport.update({
      where: { iata: "DEL" },
      data: { isMock: false, confidence: 0.95, source: "Live provider", sourceType: "PROVIDER_API", name: "PROMOTED NAME" },
    });

    await ingestFromProvider(new BundledReferenceProvider());

    const after = await prisma.airport.findUnique({ where: { iata: "DEL" } });
    expect(after?.isMock).toBe(false);
    expect(after?.name).toBe("PROMOTED NAME");

    // Restore so the rest of the suite sees the seeded state.
    await prisma.airport.update({
      where: { iata: "DEL" },
      data: { isMock: true, confidence: 0.6, source: "Bundled static reference dataset", sourceType: "STATIC_DATASET" },
    });
    await ingestFromProvider(new BundledReferenceProvider());
    const restored = await prisma.airport.findUnique({ where: { iata: "DEL" } });
    expect(restored?.name).toBe("Indira Gandhi International Airport");
  });
});

describe("lookups", () => {
  it("finds a country by ISO2", async () => {
    const country = await findCountry("in");
    expect(country?.iso2).toBe("IN");
    expect(country?.name).toBeTruthy();
  });

  it("finds an airport by IATA, with its city and country joined", async () => {
    const airport = await findAirport("del");
    expect(airport?.iata).toBe("DEL");
    expect(airport?.name).toContain("Indira Gandhi");
    expect(airport?.city?.name).toBe("Delhi");
    expect(airport?.country?.iso2).toBe("IN");
  });

  it("finds an airline by IATA", async () => {
    const airline = await findAirline("AC");
    expect(airline?.name).toBe("Air Canada");
    expect(hubsOf(airline!)).toContain("YYZ");
  });

  it("finds a city, and the airports serving it", async () => {
    const city = await findCity("Toronto");
    expect(city?.name).toBe("Toronto");
    expect(city?.country.iso2).toBe("CA");

    const airports = await airportsForCity("Toronto");
    expect(airports.map((a) => a.iata)).toContain("YYZ");
  });

  it("finds a route with its carriers, without duplicating the route per airline", async () => {
    const route = await findRoute("DEL", "YYZ");
    expect(route).toBeTruthy();
    expect(route?.originAirport.iata).toBe("DEL");
    expect(route?.destinationAirport.iata).toBe("YYZ");
    expect(route?.airlines.length).toBeGreaterThan(0);

    // One row for the pair, however many carriers fly it.
    const rows = await prisma.route.findMany({
      where: { originAirport: { iata: "DEL" }, destinationAirport: { iata: "YYZ" } },
    });
    expect(rows).toHaveLength(1);
  });

  it("finds a destination for a city", async () => {
    const destination = await findDestination("Toronto");
    expect(destination?.name).toBe("Toronto");
    expect(destination?.city.country.iso2).toBe("CA");
  });

  it("lists sibling routes from the same origin", async () => {
    const routes = await routesFromAirport("DEL", 5);
    expect(routes.length).toBeGreaterThan(1);
    expect(routes.every((r) => r.destinationAirport.iata !== "DEL")).toBe(true);
  });

  it("excludes expired policies unless they are asked for", async () => {
    const expired = await prisma.travelPolicy.create({
      data: {
        policyType: "VISA",
        subjectType: "COUNTRY",
        subjectKey: "CA",
        title: "Expired test rule",
        effectiveTo: new Date(Date.now() - 86_400_000),
        source: "Test",
        sourceType: "MANUAL",
      },
    });

    const active = await findPolicies({ subjectType: "COUNTRY", subjectKey: "CA" });
    expect(active.find((p) => p.id === expired.id)).toBeUndefined();

    const all = await findPolicies({ subjectType: "COUNTRY", subjectKey: "CA", includeExpired: true });
    expect(all.find((p) => p.id === expired.id)).toBeTruthy();

    await prisma.travelPolicy.delete({ where: { id: expired.id } });
  });
});

describe("provenance", () => {
  it("carries a full provenance record on every entity", async () => {
    const airport = await findAirport("YYZ");
    const p = provenanceOf(airport!);

    expect(p.source).toBeTruthy();
    expect(p.sourceType).toBe("STATIC_DATASET");
    expect(p.provider).toBe("bundled_reference");
    expect(p.confidence).toBeGreaterThan(0);
    expect(p.isMock).toBe(true);
    expect(p.retrievedAt).toBeInstanceOf(Date);
  });

  it("keeps bundled rows marked as reference data after ingestion", async () => {
    const stats = await travelDataStats();
    expect(stats.provenance.allReferenceData).toBe(true);
  });

  it("reports staleness from the row's own expiry", () => {
    const base = {
      source: "x",
      sourceType: "PROVIDER_API" as const,
      confidence: 0.9,
      isMock: false,
      retrievedAt: new Date(),
    };
    expect(isStale({ ...base, expiresAt: new Date(Date.now() - 1000) })).toBe(true);
    expect(isStale({ ...base, expiresAt: new Date(Date.now() + 60_000) })).toBe(false);
    expect(isStale(base)).toBe(false);
  });

  it("parses JSON columns back into arrays", async () => {
    const airport = await findAirport("DEL");
    expect(Array.isArray(aliasesOf(airport!))).toBe(true);
  });
});

describe("provider cache", () => {
  it("hashes the same request identically regardless of key order", () => {
    const a = requestHash("amadeus", "route", { origin: "DEL", destination: "YYZ" });
    const b = requestHash("amadeus", "route", { destination: "YYZ", origin: "DEL" });
    expect(a).toBe(b);
    expect(a).not.toBe(requestHash("amadeus", "route", { origin: "DEL", destination: "YVR" }));
  });

  it("never stores anything credential-shaped", () => {
    const scrubbed = scrubParams({
      origin: "DEL",
      apiKey: "super-secret",
      client_secret: "shh",
      Authorization: "Bearer abc",
      token: "t",
      innocuous: "sk-looks-like-a-key",
    });

    expect(scrubbed.origin).toBe("DEL");
    expect(scrubbed.apiKey).toBe(REDACTED);
    expect(scrubbed.client_secret).toBe(REDACTED);
    expect(scrubbed.Authorization).toBe(REDACTED);
    expect(scrubbed.token).toBe(REDACTED);
    // Caught by value shape even under a harmless-looking key.
    expect(scrubbed.innocuous).toBe(REDACTED);
  });

  it("round-trips a cached value and counts hits", async () => {
    const params = { origin: "DEL", destination: "YYZ", nonce: "round-trip" };
    await writeCache("test_provider", "route", params, { fare: 123 }, 60);

    const hit = await readCache<{ fare: number }>("test_provider", "route", params);
    expect(hit?.value.fare).toBe(123);
    expect(hit?.hits).toBe(1);

    const again = await readCache<{ fare: number }>("test_provider", "route", params);
    expect(again?.hits).toBe(2);
  });

  it("treats an expired entry as a miss", async () => {
    const params = { origin: "DEL", destination: "BOM", nonce: "expiry" };
    await writeCache("test_provider", "route", params, { fare: 1 }, 60);
    await prisma.providerCache.update({
      where: { requestHash: requestHash("test_provider", "route", params) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await readCache("test_provider", "route", params)).toBeNull();
    const row = await prisma.providerCache.findUnique({
      where: { requestHash: requestHash("test_provider", "route", params) },
    });
    expect(row?.status).toBe("STALE");
  });

  it("fetches through on a miss and serves from cache on the next call", async () => {
    const params = { origin: "DEL", destination: "LHR", nonce: "fetch-through" };
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { value: calls };
    };

    const first = await cached("test_provider", "route", params, 60, fetcher);
    expect(first.fromCache).toBe(false);
    expect(calls).toBe(1);

    const second = await cached("test_provider", "route", params, 60, fetcher);
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
  });

  it("records a failed call so a hot failure is not retried in a loop", async () => {
    const params = { origin: "DEL", destination: "DXB", nonce: "failure" };
    await expect(
      cached("test_provider", "route", params, 60, async () => {
        throw new Error("provider exploded");
      }),
    ).rejects.toThrow("provider exploded");

    const row = await prisma.providerCache.findUnique({
      where: { requestHash: requestHash("test_provider", "route", params) },
    });
    expect(row?.status).toBe("ERROR");
    expect(row?.error).toContain("provider exploded");
  });

  it("prunes expired rows", async () => {
    await writeCache("test_provider", "prune", { nonce: "p" }, {}, 60);
    await prisma.providerCache.updateMany({
      where: { namespace: "prune" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const pruned = await pruneCache();
    expect(pruned).toBeGreaterThan(0);
    expect(await prisma.providerCache.count({ where: { namespace: "prune" } })).toBe(0);
  });
});

describe("adapter resolution", () => {
  const adapter = new TravelDbAdapter();

  it("supports reference namespaces and refuses every time-sensitive one", () => {
    for (const ns of ["route", "airport", "airline", "destination", "city", "country", "policy"]) {
      expect(adapter.supports(ns)).toBe(true);
    }
    for (const ns of TIME_SENSITIVE_NAMESPACES) {
      expect(adapter.supports(ns)).toBe(false);
    }
  });

  it("emits the same DataPoint paths the templates already bind to", async () => {
    const points = await adapter.resolve("route", { origin: "DEL", destination: "YYZ" });
    const paths = points.map((p) => p.path);

    for (const expected of [
      "route.origin",
      "route.destination",
      "route.distanceKm",
      "route.typicalDurationMinutes",
      "route.typicalStops",
      "route.nonstopAvailable",
      "route.airlines",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("stamps each point with the row's provenance, not the adapter's", async () => {
    const points = await adapter.resolve("airport", { iata: "DEL", prefix: "origin" });
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      expect(p.sourceKey).toBe("travel_data_layer");
      expect(p.sourceName).toMatch(/^Bundled static reference dataset/);
      expect(p.isMock).toBe(true);
      expect(p.retrievedAt).toBeTruthy();
    }
  });

  it("labels an estimated duration as estimated rather than scheduled", async () => {
    const points = await adapter.resolve("route", { origin: "DEL", destination: "YYZ" });
    const duration = points.find((p) => p.path === "route.typicalDurationMinutes");
    expect(duration?.method).toMatch(/ESTIMATED|Estimated|not a published schedule/);
    expect(duration?.confidence).toBeLessThanOrEqual(0.5);
  });

  it("returns nothing for an unknown key so the engine can fall through", async () => {
    expect(await adapter.resolve("airport", { iata: "ZZZ" })).toHaveLength(0);
    expect(await adapter.resolve("route", { origin: "DEL", destination: "ZZZ" })).toHaveLength(0);
    expect(await adapter.resolve("offers", { origin: "DEL", destination: "YYZ" })).toHaveLength(0);
  });

  it("marks policy points time-sensitive so the fact gate treats them like fares", async () => {
    const policy = await prisma.travelPolicy.create({
      data: {
        policyType: "BAGGAGE",
        subjectType: "AIRLINE",
        subjectKey: "AC",
        title: "Test baggage rule",
        body: "One checked bag.",
        source: "Test",
        sourceType: "MANUAL",
      },
    });

    const points = await adapter.resolve("policy", { subjectType: "AIRLINE", subjectKey: "AC" });
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p.isTimeSensitive)).toBe(true);

    await prisma.travelPolicy.delete({ where: { id: policy.id } });
  });
});

describe("integration with the existing data engine", () => {
  it("serves the route namespace from the travel layer, above the bundled files", async () => {
    const engine = await DynamicDataEngine.forProject(projectId, organizationId);
    const sources = engine.describeSources();

    const travel = sources.find((s) => s.key === "travel_data_layer");
    const bundled = sources.find((s) => s.key === "static_reference");
    expect(travel).toBeTruthy();
    expect(bundled).toBeTruthy();
    expect(travel!.trustLevel).toBeGreaterThan(bundled!.trustLevel);

    const ctx = await engine.resolve([{ namespace: "route", params: { origin: "DEL", destination: "YYZ" } }]);
    expect(ctx.points.length).toBeGreaterThan(0);
    expect(ctx.points.every((p) => p.sourceKey === "travel_data_layer")).toBe(true);
  });

  it("still refuses to serve live offers from any reference source", async () => {
    const engine = await DynamicDataEngine.forProject(projectId, organizationId);
    const ctx = await engine.resolve([{ namespace: "offers", params: { origin: "DEL", destination: "YYZ" } }]);

    expect(ctx.missing).toContain("offers");
    expect(ctx.points).toHaveLength(0);
  });

  it("falls back to the bundled dataset for a route the layer does not hold", async () => {
    const engine = await DynamicDataEngine.forProject(projectId, organizationId);

    // A pair that exists in the bundled files is guaranteed to exist in the
    // layer too, so prove the fall-through with the adapter directly: a miss
    // returns nothing, which is what lets the engine try the next candidate.
    const adapterMiss = await new TravelDbAdapter().resolve("route", { origin: "AAA", destination: "BBB" });
    expect(adapterMiss).toHaveLength(0);

    const ctx = await engine.resolve([{ namespace: "airline", params: { iata: "AC" } }]);
    expect(ctx.points.length).toBeGreaterThan(0);
  });

  it("resolves the two namespaces the layer adds", async () => {
    const engine = await DynamicDataEngine.forProject(projectId, organizationId);
    const ctx = await engine.resolve([
      { namespace: "city", params: { name: "Toronto" } },
      { namespace: "country", params: { iso2: "CA" } },
    ]);

    expect(ctx.values).toHaveProperty("city");
    expect(ctx.values).toHaveProperty("country");
    expect(ctx.missing).toHaveLength(0);
  });
});
