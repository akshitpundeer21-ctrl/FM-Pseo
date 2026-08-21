/**
 * POST /api/search — the flight search experience.
 *
 * This is where the search product and the SEO pages meet:
 *   1. resolve the route from reference data
 *   2. attempt live offers from a credentialed provider
 *   3. find the corresponding published landing page and link to it
 *   4. record the search so demand can inform the content plan
 *
 * If no live provider is connected the response says so explicitly and returns
 * zero offers. It never fabricates inventory or prices.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { activeProject, fail, ok, parseBody, guardRead } from "@/app/api/_lib/handler";
import { assertRateLimit } from "@/control-plane/budget";
import { loadAirports, loadRoutes } from "@/engine/data/adapters/static-dataset";
import { AmadeusAdapter } from "@/engine/data/adapters/amadeus";
import { resolveCredentials } from "@/integrations/service";

const Body = z.object({
  origin: z.string().min(2).max(60),
  destination: z.string().min(2).max(60),
  departDate: z.string().optional(),
  returnDate: z.string().optional(),
  passengers: z.number().int().min(1).max(9).optional(),
  cabin: z.string().optional(),
});

function toIata(value: string): string | null {
  const airports = loadAirports();
  const v = value.trim();
  return (
    airports.find((a) => a.iata.toLowerCase() === v.toLowerCase())?.iata ??
    airports.find((a) => a.city.toLowerCase() === v.toLowerCase())?.iata ??
    null
  );
}

export async function POST(req: Request) {
  try {
    const auth = await guardRead();
    assertRateLimit({ key: `search:${auth.userId}`, limit: 60, windowMs: 60_000 });

    const body = await parseBody(req, Body);
    const project = await activeProject(auth);

    const origin = toIata(body.origin);
    const destination = toIata(body.destination);
    if (!origin || !destination) {
      return ok({
        ok: false,
        error: `Unknown airport: ${!origin ? body.origin : body.destination}. Use an IATA code or a city in the reference dataset.`,
      });
    }

    const airports = loadAirports();
    const route = loadRoutes().find((r) => r.origin === origin && r.destination === destination) ?? null;

    // --- live offers -------------------------------------------------------
    const creds = await resolveCredentials(auth.organizationId, "amadeus", project.id).catch(() => null);
    const adapter = new AmadeusAdapter(creds?.values.clientId, creds?.values.clientSecret);

    let offers: unknown[] = [];
    let liveAvailable = false;
    let liveMessage =
      "No live flight data provider is connected, so no prices or availability are shown. Connect Amadeus or Duffel in Integrations to enable live results.";

    if (adapter.isAvailable()) {
      try {
        const points = await adapter.resolve("offers", {
          origin,
          destination,
          departDate: body.departDate ?? "",
          returnDate: body.returnDate ?? "",
          passengers: String(body.passengers ?? 1),
          ...(body.cabin ? { cabin: body.cabin } : {}),
        });
        offers = (points.find((p) => p.path === "offers.items")?.value as unknown[]) ?? [];
        liveAvailable = true;
        liveMessage = `${offers.length} live offer(s) from Amadeus.`;
      } catch (e) {
        liveMessage = `Live provider error: ${(e as Error).message}`;
      }
    }

    // --- matching SEO landing page ----------------------------------------
    const landingUrl = `/flights/${origin.toLowerCase()}/${destination.toLowerCase()}`;
    const page = await prisma.page.findFirst({
      where: { projectId: project.id, url: landingUrl },
      select: { id: true, url: true, title: true, status: true, qualityScore: true },
    });

    // --- record the search -------------------------------------------------
    await prisma.flightSearch.create({
      data: {
        projectId: project.id,
        origin,
        destination,
        departDate: body.departDate,
        returnDate: body.returnDate,
        passengers: body.passengers ?? 1,
        cabin: body.cabin ?? "ECONOMY",
        resultsCount: offers.length,
        matchedPageId: page?.id,
        provider: liveAvailable ? "amadeus" : "none",
        isMock: !liveAvailable,
      },
    });

    return ok({
      ok: true,
      origin: airports.find((a) => a.iata === origin),
      destination: airports.find((a) => a.iata === destination),
      route,
      routeIsReferenceData: Boolean(route),
      offers,
      liveAvailable,
      liveMessage,
      landingPage: page
        ? { ...page, published: page.status === "PUBLISHED", href: page.status === "PUBLISHED" ? `/site${page.url}` : null }
        : null,
      landingUrl,
    });
  } catch (e) {
    return fail(e);
  }
}
