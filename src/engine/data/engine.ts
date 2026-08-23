/**
 * Dynamic Data Engine.
 *
 * Resolves the data bindings a template's components declare, from the highest
 * trust adapter that can serve each namespace. Guarantees:
 *
 *  - Time-sensitive namespaces ("offers": live prices/availability) are served
 *    ONLY by credentialed adapters. If none is available the binding is
 *    reported as missing. Nothing is invented, ever.
 *  - Every resolved leaf carries provenance (source, retrievedAt, confidence).
 *  - Resolved points are persisted as Facts so verification and the audit trail
 *    have something durable to point at.
 */
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { scopedLogger } from "@/core/logging/logger";
import { resolveCredentials } from "@/integrations/service";
import { AmadeusAdapter } from "@/engine/data/adapters/amadeus";
import { StaticDatasetAdapter } from "@/engine/data/adapters/static-dataset";
import { TravelDbAdapter } from "@/engine/data/adapters/travel-db";
import type { DataContext, DataPoint, DataSourceAdapter } from "@/engine/data/types";
import { materialise } from "@/engine/data/types";

const log = scopedLogger("data.engine");

/** Namespaces that must never be served by a mock/static source. */
export const TIME_SENSITIVE_NAMESPACES = new Set(["offers", "schedule", "seatmap", "fare_rules"]);

export interface ResolveRequest {
  /** e.g. [{ namespace: "route", params: { origin: "DEL", destination: "YYZ" } }] */
  namespace: string;
  params: Record<string, string>;
}

export class DynamicDataEngine {
  private constructor(
    private readonly adapters: DataSourceAdapter[],
    private readonly projectId: string,
  ) {}

  static async forProject(projectId: string, organizationId: string): Promise<DynamicDataEngine> {
    const adapters: DataSourceAdapter[] = [];

    // Credentialed adapters first - highest trust wins per namespace.
    const amadeus = await resolveCredentials(organizationId, "amadeus", projectId).catch(() => null);
    if (amadeus?.configured) {
      adapters.push(new AmadeusAdapter(amadeus.values.clientId, amadeus.values.clientSecret));
    }

    // The Travel Data Layer sits between credentialed providers and the bundled
    // files: normalized rows win where they exist, and a miss falls straight
    // through to the static dataset, so an empty layer behaves exactly as the
    // system did before it was added.
    adapters.push(new TravelDbAdapter());

    adapters.push(new StaticDatasetAdapter());
    return new DynamicDataEngine(adapters, projectId);
  }

  /** Adapters available for a namespace, best-trust first. */
  private candidates(namespace: string): DataSourceAdapter[] {
    return this.adapters
      .filter((a) => a.supports(namespace))
      .filter((a) => !(TIME_SENSITIVE_NAMESPACES.has(namespace) && a.isMock))
      .sort((a, b) => b.trustLevel - a.trustLevel);
  }

  describeSources() {
    return this.adapters.map((a) => ({ key: a.key, name: a.name, isMock: a.isMock, trustLevel: a.trustLevel }));
  }

  async resolve(requests: ResolveRequest[]): Promise<DataContext> {
    const points: DataPoint[] = [];
    const missing: string[] = [];

    for (const req of requests) {
      const candidates = this.candidates(req.namespace);
      if (!candidates.length) {
        missing.push(req.namespace);
        log.warn("no adapter can serve namespace", {
          projectId: this.projectId,
          namespace: req.namespace,
          reason: TIME_SENSITIVE_NAMESPACES.has(req.namespace)
            ? "time-sensitive namespace requires a credentialed provider"
            : "no adapter registered",
        });
        continue;
      }

      let served = false;
      for (const adapter of candidates) {
        try {
          if (!(await adapter.isAvailable())) continue;
          const resolved = await adapter.resolve(req.namespace, req.params);
          if (resolved.length) {
            points.push(...resolved);
            served = true;
            break;
          }
        } catch (e) {
          log.error("data adapter failed", {
            projectId: this.projectId,
            adapter: adapter.key,
            namespace: req.namespace,
            error: (e as Error).message,
          });
        }
      }
      if (!served) missing.push(req.namespace);
    }

    return {
      values: materialise(points),
      points,
      missing,
      containsMock: points.some((p) => p.isMock),
    };
  }

  /** Persist resolved points as Facts so they can be verified and audited. */
  async persistFacts(ctx: DataContext, subjectPrefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (const p of ctx.points) {
      // Scalars are stored verbatim; arrays/objects (carrier lists, cabin
      // classes) are stored as JSON so they keep provenance too.
      const value = typeof p.value === "object" && p.value !== null ? JSON.stringify(p.value) : String(p.value);
      const source = await prisma.dataSource.findFirst({ where: { projectId: this.projectId, key: p.sourceKey } });
      const fact = await prisma.fact.create({
        data: {
          projectId: this.projectId,
          dataSourceId: source?.id,
          subject: `${subjectPrefix}`,
          predicate: p.path,
          value,
          unit: p.unit,
          scopeJson: writeJson({ method: p.method ?? null }),
          sourceName: p.sourceName,
          sourceUrl: p.sourceUrl,
          retrievedAt: new Date(p.retrievedAt),
          confidence: p.confidence,
          verificationStatus: p.verificationStatus,
          isTimeSensitive: p.isTimeSensitive,
          isMock: p.isMock,
        },
      });
      ids.push(fact.id);
    }
    return ids;
  }
}

/** Convenience: standard bindings for a route page. */
export function routeBindings(origin: string, destination: string): ResolveRequest[] {
  return [
    { namespace: "route", params: { origin, destination } },
    { namespace: "airport", params: { iata: origin, prefix: "origin" } },
    { namespace: "airport", params: { iata: destination, prefix: "destination" } },
    { namespace: "offers", params: { origin, destination } },
  ];
}
