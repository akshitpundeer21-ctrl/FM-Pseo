/**
 * Travel Data Layer ingestion.
 *
 * Takes normalized records from a TravelDataProvider and writes them into the
 * travel tables, carrying the provider's provenance onto every row.
 *
 * The one rule that matters here:
 *
 *   A LOWER-TRUST SOURCE MAY NEVER OVERWRITE A HIGHER-TRUST ONE.
 *
 * Concretely: re-running the bundled dataset must not clobber a row that came
 * from a credentialed provider. Those rows are skipped and counted, never
 * silently downgraded. This is what makes ingest safe to re-run.
 */
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { scopedLogger } from "@/core/logging/logger";
import { bump, type IngestReport, type TravelDataProvider, type TravelDataset, type TravelProvenance } from "@/modules/travel/types";

const log = scopedLogger("travel.ingest");

/** Provenance columns shared by every travel table. */
function provenanceColumns(p: TravelProvenance) {
  return {
    source: p.source,
    sourceType: p.sourceType,
    sourceUrl: p.sourceUrl ?? null,
    provider: p.provider ?? null,
    providerRecordId: p.providerRecordId ?? null,
    confidence: p.confidence,
    isMock: p.isMock,
    retrievedAt: p.retrievedAt,
    expiresAt: p.expiresAt ?? null,
    lastVerifiedAt: p.lastVerifiedAt ?? null,
  };
}

/**
 * Decides whether an incoming record may replace what is already stored.
 *
 * Real data outranks approximate data, and within the same class the more
 * confident source wins. Equal-provenance re-ingest is allowed so a refresh
 * updates retrievedAt.
 */
export function mayOverwrite(
  existing: { isMock: boolean; confidence: number } | null,
  incoming: { isMock: boolean; confidence: number },
): boolean {
  if (!existing) return true;
  if (existing.isMock && !incoming.isMock) return true;
  if (!existing.isMock && incoming.isMock) return false;
  return incoming.confidence >= existing.confidence;
}

export interface IngestOptions {
  /** Limit to specific entity kinds. Defaults to everything the provider has. */
  kinds?: (keyof TravelDataset)[];
  /** Report what would happen without writing. */
  dryRun?: boolean;
}

export async function ingestFromProvider(
  provider: TravelDataProvider,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const startedAt = new Date();
  const report: IngestReport = {
    provider: provider.key,
    isMock: provider.isMock,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    counts: {},
    rejected: [],
    available: true,
  };

  const finish = () => {
    const finishedAt = new Date();
    report.finishedAt = finishedAt.toISOString();
    report.durationMs = finishedAt.getTime() - startedAt.getTime();
    return report;
  };

  if (!(await provider.isAvailable())) {
    report.available = false;
    report.unavailableReason = `Provider "${provider.key}" is not available (no credentials, or its source could not be read). Nothing was written.`;
    log.warn("travel provider unavailable", { provider: provider.key });
    return finish();
  }

  const dataset = await provider.fetch(options.kinds);
  const prov = provider.provenance();
  const cols = provenanceColumns(prov);

  if (options.dryRun) {
    for (const [kind, rows] of Object.entries(dataset)) {
      if (Array.isArray(rows)) for (let i = 0; i < rows.length; i++) bump(report.counts, kind, "skipped");
    }
    log.info("travel ingest dry run", { provider: provider.key, counts: report.counts });
    return finish();
  }

  // --- countries ----------------------------------------------------------
  const countryIdByIso2 = new Map<string, string>();
  for (const c of dataset.countries ?? []) {
    const iso2 = c.iso2.toUpperCase();
    const existing = await prisma.country.findUnique({ where: { iso2 } });
    if (existing && !mayOverwrite(existing, prov)) {
      countryIdByIso2.set(iso2, existing.id);
      bump(report.counts, "countries", "skipped");
      continue;
    }
    const data = {
      name: c.name,
      officialName: c.officialName ?? null,
      iso3: c.iso3 ?? null,
      continent: c.continent ?? null,
      region: c.region ?? null,
      currencyCode: c.currencyCode ?? null,
      ...cols,
    };
    const row = existing
      ? await prisma.country.update({ where: { iso2 }, data })
      : await prisma.country.create({ data: { iso2, ...data } });
    countryIdByIso2.set(iso2, row.id);
    bump(report.counts, "countries", existing ? "updated" : "created");
  }

  const countryId = async (iso2?: string): Promise<string | null> => {
    if (!iso2) return null;
    const key = iso2.toUpperCase();
    if (countryIdByIso2.has(key)) return countryIdByIso2.get(key)!;
    const found = await prisma.country.findUnique({ where: { iso2: key }, select: { id: true } });
    if (found) countryIdByIso2.set(key, found.id);
    return found?.id ?? null;
  };

  // --- regions ------------------------------------------------------------
  for (const r of dataset.regions ?? []) {
    const cid = await countryId(r.countryIso2);
    if (!cid) {
      report.rejected.push({ kind: "regions", key: r.name, reason: `Unknown country ${r.countryIso2}` });
      continue;
    }
    const existing = await prisma.region.findUnique({ where: { countryId_name: { countryId: cid, name: r.name } } });
    if (existing && !mayOverwrite(existing, prov)) {
      bump(report.counts, "regions", "skipped");
      continue;
    }
    const data = { code: r.code ?? null, type: r.type ?? "REGION", ...cols };
    if (existing) await prisma.region.update({ where: { id: existing.id }, data });
    else await prisma.region.create({ data: { countryId: cid, name: r.name, ...data } });
    bump(report.counts, "regions", existing ? "updated" : "created");
  }

  // --- cities -------------------------------------------------------------
  const cityIdByKey = new Map<string, string>();
  for (const c of dataset.cities ?? []) {
    const cid = await countryId(c.countryIso2);
    if (!cid) {
      report.rejected.push({ kind: "cities", key: c.name, reason: `Unknown country ${c.countryIso2}` });
      continue;
    }
    const key = `${c.countryIso2.toUpperCase()}::${c.name}`;
    const existing = await prisma.city.findUnique({ where: { countryId_name: { countryId: cid, name: c.name } } });
    if (existing && !mayOverwrite(existing, prov)) {
      cityIdByKey.set(key, existing.id);
      bump(report.counts, "cities", "skipped");
      continue;
    }
    const data = {
      latitude: c.latitude ?? null,
      longitude: c.longitude ?? null,
      timezone: c.timezone ?? null,
      population: c.population ?? null,
      aliasesJson: writeJson(c.aliases ?? []),
      ...cols,
    };
    const row = existing
      ? await prisma.city.update({ where: { id: existing.id }, data })
      : await prisma.city.create({ data: { countryId: cid, name: c.name, ...data } });
    cityIdByKey.set(key, row.id);
    bump(report.counts, "cities", existing ? "updated" : "created");
  }

  const cityId = async (name?: string, iso2?: string): Promise<string | null> => {
    if (!name || !iso2) return null;
    const key = `${iso2.toUpperCase()}::${name}`;
    if (cityIdByKey.has(key)) return cityIdByKey.get(key)!;
    const cid = await countryId(iso2);
    if (!cid) return null;
    const found = await prisma.city.findUnique({
      where: { countryId_name: { countryId: cid, name } },
      select: { id: true },
    });
    if (found) cityIdByKey.set(key, found.id);
    return found?.id ?? null;
  };

  // --- airports -----------------------------------------------------------
  const airportIdByIata = new Map<string, string>();
  for (const a of dataset.airports ?? []) {
    const iata = a.iata.toUpperCase();
    const existing = await prisma.airport.findUnique({ where: { iata } });
    if (existing && !mayOverwrite(existing, prov)) {
      airportIdByIata.set(iata, existing.id);
      bump(report.counts, "airports", "skipped");
      continue;
    }
    const data = {
      name: a.name,
      icao: a.icao ?? null,
      cityId: await cityId(a.cityName, a.countryIso2),
      countryId: await countryId(a.countryIso2),
      latitude: a.latitude ?? null,
      longitude: a.longitude ?? null,
      timezone: a.timezone ?? null,
      type: a.type ?? "INTERNATIONAL",
      terminals: a.terminals ?? null,
      isHub: a.isHub ?? false,
      aliasesJson: writeJson(a.aliases ?? []),
      ...cols,
    };
    const row = existing
      ? await prisma.airport.update({ where: { iata }, data })
      : await prisma.airport.create({ data: { iata, ...data } });
    airportIdByIata.set(iata, row.id);
    bump(report.counts, "airports", existing ? "updated" : "created");
  }

  const airportId = async (iata?: string): Promise<string | null> => {
    if (!iata) return null;
    const key = iata.toUpperCase();
    if (airportIdByIata.has(key)) return airportIdByIata.get(key)!;
    const found = await prisma.airport.findUnique({ where: { iata: key }, select: { id: true } });
    if (found) airportIdByIata.set(key, found.id);
    return found?.id ?? null;
  };

  // --- airlines -----------------------------------------------------------
  const airlineIdByIata = new Map<string, string>();
  for (const a of dataset.airlines ?? []) {
    const iata = a.iata?.toUpperCase();
    const existing = iata
      ? await prisma.airline.findUnique({ where: { iata } })
      : await prisma.airline.findFirst({ where: { name: a.name } });
    if (existing && !mayOverwrite(existing, prov)) {
      if (iata) airlineIdByIata.set(iata, existing.id);
      bump(report.counts, "airlines", "skipped");
      continue;
    }
    const data = {
      name: a.name,
      icao: a.icao ?? null,
      countryId: await countryId(a.countryIso2),
      callsign: a.callsign ?? null,
      alliance: a.alliance ?? null,
      type: a.type ?? "FULL_SERVICE",
      hubsJson: writeJson(a.hubs ?? []),
      ...cols,
    };
    const row = existing
      ? await prisma.airline.update({ where: { id: existing.id }, data })
      : await prisma.airline.create({ data: { iata: iata ?? null, ...data } });
    if (iata) airlineIdByIata.set(iata, row.id);
    bump(report.counts, "airlines", existing ? "updated" : "created");
  }

  const airlineId = async (iata?: string): Promise<string | null> => {
    if (!iata) return null;
    const key = iata.toUpperCase();
    if (airlineIdByIata.has(key)) return airlineIdByIata.get(key)!;
    const found = await prisma.airline.findUnique({ where: { iata: key }, select: { id: true } });
    if (found) airlineIdByIata.set(key, found.id);
    return found?.id ?? null;
  };

  // --- routes + carriers --------------------------------------------------
  for (const r of dataset.routes ?? []) {
    const originId = await airportId(r.originIata);
    const destinationId = await airportId(r.destinationIata);
    if (!originId || !destinationId) {
      report.rejected.push({
        kind: "routes",
        key: `${r.originIata}-${r.destinationIata}`,
        reason: `Unknown airport ${!originId ? r.originIata : r.destinationIata}`,
      });
      continue;
    }

    const [origin, destination] = await Promise.all([
      prisma.airport.findUnique({ where: { id: originId }, select: { cityId: true } }),
      prisma.airport.findUnique({ where: { id: destinationId }, select: { cityId: true } }),
    ]);

    const existing = await prisma.route.findUnique({
      where: { originAirportId_destinationAirportId: { originAirportId: originId, destinationAirportId: destinationId } },
    });

    let routeId = existing?.id ?? null;
    if (existing && !mayOverwrite(existing, prov)) {
      bump(report.counts, "routes", "skipped");
    } else {
      const data = {
        originCityId: origin?.cityId ?? null,
        destinationCityId: destination?.cityId ?? null,
        routeType: r.routeType ?? "MIXED",
        distanceKm: r.distanceKm ?? null,
        typicalDurationMinutes: r.typicalDurationMinutes ?? null,
        typicalStops: r.typicalStops ?? null,
        nonstopAvailable: r.nonstopAvailable ?? false,
        frequency: r.frequency ?? null,
        cabinClassesJson: writeJson(r.cabinClasses ?? []),
        method: r.method ?? null,
        ...cols,
      };
      const row = existing
        ? await prisma.route.update({ where: { id: existing.id }, data })
        : await prisma.route.create({
            data: { originAirportId: originId, destinationAirportId: destinationId, ...data },
          });
      routeId = row.id;
      bump(report.counts, "routes", existing ? "updated" : "created");
    }

    if (!routeId) continue;
    for (const carrier of r.airlineIatas ?? []) {
      const alId = await airlineId(carrier);
      if (!alId) {
        report.rejected.push({
          kind: "routeAirlines",
          key: `${r.originIata}-${r.destinationIata}/${carrier}`,
          reason: `Unknown airline ${carrier}`,
        });
        continue;
      }
      const link = await prisma.routeAirline.findUnique({
        where: { routeId_airlineId: { routeId, airlineId: alId } },
      });
      if (link && !mayOverwrite(link, prov)) {
        bump(report.counts, "routeAirlines", "skipped");
        continue;
      }
      const data = {
        serviceType: r.nonstopAvailable ? "NONSTOP" : "ONE_STOP",
        frequency: r.frequency ?? null,
        source: prov.source,
        sourceType: prov.sourceType,
        provider: prov.provider ?? null,
        providerRecordId: prov.providerRecordId ?? null,
        confidence: prov.confidence,
        isMock: prov.isMock,
        retrievedAt: prov.retrievedAt,
      };
      if (link) await prisma.routeAirline.update({ where: { id: link.id }, data });
      else await prisma.routeAirline.create({ data: { routeId, airlineId: alId, ...data } });
      bump(report.counts, "routeAirlines", link ? "updated" : "created");
    }
  }

  // --- destinations -------------------------------------------------------
  for (const d of dataset.destinations ?? []) {
    const cid = await cityId(d.cityName, d.countryIso2);
    if (!cid) {
      report.rejected.push({ kind: "destinations", key: d.name, reason: `Unknown city ${d.cityName}` });
      continue;
    }
    const existing = await prisma.destination.findUnique({
      where: { cityId_name: { cityId: cid, name: d.name } },
    });
    if (existing && !mayOverwrite(existing, prov)) {
      bump(report.counts, "destinations", "skipped");
      continue;
    }
    const data = {
      countryId: await countryId(d.countryIso2),
      description: d.description ?? "",
      aliasesJson: writeJson(d.aliases ?? []),
      travelAttributesJson: writeJson(d.travelAttributes ?? {}),
      ...cols,
    };
    if (existing) await prisma.destination.update({ where: { id: existing.id }, data });
    else await prisma.destination.create({ data: { cityId: cid, name: d.name, ...data } });
    bump(report.counts, "destinations", existing ? "updated" : "created");
  }

  // --- policies -----------------------------------------------------------
  for (const p of dataset.policies ?? []) {
    // counterpartKey is nullable, and Prisma refuses findUnique on a compound
    // unique that contains a nullable column - so match with findFirst.
    const existing = await prisma.travelPolicy.findFirst({
      where: {
        policyType: p.policyType,
        subjectType: p.subjectType,
        subjectKey: p.subjectKey,
        counterpartKey: p.counterpartKey ?? null,
      },
    });
    if (existing && !mayOverwrite(existing, prov)) {
      bump(report.counts, "policies", "skipped");
      continue;
    }
    const data = {
      title: p.title,
      body: p.body ?? "",
      detailJson: writeJson(p.detail ?? {}),
      effectiveFrom: p.effectiveFrom ?? null,
      effectiveTo: p.effectiveTo ?? null,
      ...cols,
    };
    if (existing) await prisma.travelPolicy.update({ where: { id: existing.id }, data });
    else
      await prisma.travelPolicy.create({
        data: {
          policyType: p.policyType,
          subjectType: p.subjectType,
          subjectKey: p.subjectKey,
          counterpartKey: p.counterpartKey ?? null,
          ...data,
        },
      });
    bump(report.counts, "policies", existing ? "updated" : "created");
  }

  log.info("travel ingest complete", {
    provider: provider.key,
    counts: report.counts,
    rejected: report.rejected.length,
  });
  return finish();
}
