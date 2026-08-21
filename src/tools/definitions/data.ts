/**
 * Data tools: reference lookups, dynamic data resolution, live offers.
 *
 * `travel.offers` deliberately sets allowMockFallback:false. Live prices and
 * availability are time-sensitive; if no credentialed provider is connected the
 * tool fails loudly and the page simply omits the price block.
 */
import { z } from "zod";
import { registerTool } from "@/tools/registry";
import { prisma } from "@/core/db/client";
import { DynamicDataEngine } from "@/engine/data/engine";
import { AmadeusAdapter } from "@/engine/data/adapters/amadeus";
import { loadAirlines, loadAirports, loadRoutes } from "@/engine/data/adapters/static-dataset";

const DataPointSchema = z.object({
  path: z.string(),
  value: z.unknown(),
  unit: z.string().optional(),
  sourceKey: z.string(),
  sourceName: z.string(),
  sourceUrl: z.string().optional(),
  retrievedAt: z.string(),
  confidence: z.number(),
  verificationStatus: z.string(),
  isTimeSensitive: z.boolean(),
  isMock: z.boolean(),
  method: z.string().optional(),
});

export const travelReferenceTool = registerTool({
  key: "travel.reference",
  name: "Travel reference lookup",
  description: "Airport, airline and route reference attributes from the connected reference dataset.",
  category: "data",
  requiredCapability: "read_project",
  allowMockFallback: true,
  inputSchema: z.object({
    kind: z.enum(["airport", "airline", "route", "list_routes", "list_airports"]),
    iata: z.string().optional(),
    origin: z.string().optional(),
    destination: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  outputSchema: z.object({ isMock: z.boolean(), result: z.unknown() }),
  async execute(input, ctx) {
    ctx.markMock();
    switch (input.kind) {
      case "airport":
        return { isMock: true, result: loadAirports().find((a) => a.iata === input.iata?.toUpperCase()) ?? null };
      case "airline":
        return { isMock: true, result: loadAirlines().find((a) => a.iata === input.iata?.toUpperCase()) ?? null };
      case "route":
        return {
          isMock: true,
          result:
            loadRoutes().find(
              (r) => r.origin === input.origin?.toUpperCase() && r.destination === input.destination?.toUpperCase(),
            ) ?? null,
        };
      case "list_airports":
        return { isMock: true, result: loadAirports().slice(0, input.limit ?? 100) };
      case "list_routes":
      default:
        return { isMock: true, result: loadRoutes().slice(0, input.limit ?? 200) };
    }
  },
});

export const resolveDataTool = registerTool({
  key: "data.resolve",
  name: "Resolve dynamic data bindings",
  description:
    "Runs the Dynamic Data Engine for a set of namespaces and returns fully-attributed data points (value + source + confidence).",
  category: "data",
  requiredCapability: "read_project",
  allowMockFallback: true,
  inputSchema: z.object({
    requests: z.array(z.object({ namespace: z.string(), params: z.record(z.string(), z.string()) })).min(1),
    persistAs: z.string().optional(),
  }),
  outputSchema: z.object({
    values: z.record(z.string(), z.unknown()),
    points: z.array(DataPointSchema),
    missing: z.array(z.string()),
    containsMock: z.boolean(),
    factIds: z.array(z.string()),
  }),
  async execute(input, ctx) {
    const engine = await DynamicDataEngine.forProject(ctx.projectId, ctx.organizationId);
    const context = await engine.resolve(input.requests);
    if (context.containsMock) ctx.markMock();

    let factIds: string[] = [];
    if (input.persistAs) factIds = await engine.persistFacts(context, input.persistAs);

    if (context.missing.length) {
      ctx.logger.warn("data bindings unresolved", { missing: context.missing });
    }
    return { ...context, values: context.values as Record<string, unknown>, factIds };
  },
});

export const flightOffersTool = registerTool({
  key: "travel.offers",
  name: "Live flight offers",
  description:
    "Live priced flight offers. Requires a credentialed travel data provider - there is NO mock fallback, because prices must never be invented.",
  category: "data",
  requiredCapability: "call_external_api",
  integrationProvider: "amadeus",
  allowMockFallback: false,
  costly: true,
  inputSchema: z.object({
    origin: z.string().length(3),
    destination: z.string().length(3),
    departDate: z.string().optional(),
    returnDate: z.string().optional(),
    passengers: z.number().int().min(1).max(9).default(1),
    cabin: z.string().optional(),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    reason: z.string().optional(),
    offers: z.array(z.record(z.string(), z.unknown())),
    points: z.array(DataPointSchema),
  }),
  async execute(input, ctx) {
    const creds = ctx.credentials;
    const adapter = new AmadeusAdapter(creds?.values.clientId, creds?.values.clientSecret);
    if (!adapter.isAvailable()) {
      return {
        available: false,
        reason:
          "No live flight data provider is connected. Connect Amadeus or Duffel in Integrations to enable live offers. No prices are generated without one.",
        offers: [],
        points: [],
      };
    }
    const points = await adapter.resolve("offers", {
      origin: input.origin,
      destination: input.destination,
      departDate: input.departDate ?? "",
      returnDate: input.returnDate ?? "",
      passengers: String(input.passengers),
      ...(input.cabin ? { cabin: input.cabin } : {}),
    });
    await ctx.charge(0.005, { category: "travel_data" });
    const items = (points.find((p) => p.path === "offers.items")?.value as any[]) ?? [];
    return { available: true, offers: items, points };
  },
});

export const factLookupTool = registerTool({
  key: "facts.lookup",
  name: "Fact store lookup",
  description: "Reads previously-resolved, attributed facts for a subject from the project fact store.",
  category: "data",
  requiredCapability: "read_project",
  allowMockFallback: true,
  inputSchema: z.object({ subject: z.string(), predicate: z.string().optional(), limit: z.number().int().max(200).optional() }),
  outputSchema: z.object({
    facts: z.array(
      z.object({
        id: z.string(),
        subject: z.string(),
        predicate: z.string(),
        value: z.string(),
        sourceName: z.string(),
        confidence: z.number(),
        verificationStatus: z.string(),
        isTimeSensitive: z.boolean(),
        isMock: z.boolean(),
        retrievedAt: z.string(),
      }),
    ),
  }),
  async execute(input, ctx) {
    const rows = await prisma.fact.findMany({
      where: {
        projectId: ctx.projectId,
        subject: input.subject,
        ...(input.predicate ? { predicate: input.predicate } : {}),
      },
      orderBy: { retrievedAt: "desc" },
      take: input.limit ?? 100,
    });
    if (rows.some((r) => r.isMock)) ctx.markMock();
    return {
      facts: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        predicate: r.predicate,
        value: r.value,
        sourceName: r.sourceName,
        confidence: r.confidence,
        verificationStatus: r.verificationStatus,
        isTimeSensitive: r.isTimeSensitive,
        isMock: r.isMock,
        retrievedAt: r.retrievedAt.toISOString(),
      })),
    };
  },
});
