import { prisma } from "@/core/db/client";
import { requireProject } from "@/app/(console)/_lib/data";
import { SearchPanel } from "@/app/(console)/search/search-panel";
import { loadAirports } from "@/engine/data/adapters/static-dataset";
import { Badge, Callout, Card, EmptyState, Mono, PageHeader, Table, timeAgo } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function FlightSearchPage() {
  const { project } = await requireProject();

  const [searches, topRoutes] = await Promise.all([
    prisma.flightSearch.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { matchedPage: { select: { url: true, status: true } } },
    }),
    prisma.flightSearch.groupBy({
      by: ["origin", "destination"],
      where: { projectId: project.id },
      _count: { _all: true },
      orderBy: { _count: { origin: "desc" } },
      take: 10,
    }),
  ]);

  const airports = loadAirports()
    .map((a) => ({ iata: a.iata, city: a.city, name: a.name }))
    .sort((a, b) => a.city.localeCompare(b.city));

  return (
    <>
      <PageHeader
        title="Flight search"
        description="Where the search product meets the SEO pages: a search resolves the route, attempts live offers, links to the corresponding landing page, and records the demand."
        meta={<Badge tone="neutral">{searches.length} recent searches</Badge>}
      />

      <div className="mb-5">
        <Callout tone="warn" title="No live inventory is faked">
          Priced results appear only when a credentialed travel data provider (Amadeus or Duffel) is connected. Without one,
          this panel shows route reference data and says plainly that there are no live results — it never invents fares,
          schedules or seat availability.
        </Callout>
      </div>

      <SearchPanel airports={airports} />

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Recent searches" description="Recorded demand — an input to the opportunity gate." padded={false}>
          {searches.length ? (
            <Table head={["Route", "Dates", "Pax", "Results", "Landing page", "When"]}>
              {searches.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Mono className="!text-[var(--color-ink)]">
                      {s.origin} → {s.destination}
                    </Mono>
                  </td>
                  <td className="text-[12px] text-[var(--color-ink-3)]">
                    {s.departDate ?? "—"}
                    {s.returnDate ? ` / ${s.returnDate}` : ""}
                  </td>
                  <td className="fm-mono">{s.passengers}</td>
                  <td className="fm-mono">{s.resultsCount}</td>
                  <td className="text-[12px]">
                    {s.matchedPage ? (
                      <span className="text-[var(--color-ok)]">{s.matchedPage.status.toLowerCase()}</span>
                    ) : (
                      <span className="text-[var(--color-warn)]">no page</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(s.createdAt)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No searches recorded" hint="Run a search above to record demand." />
          )}
        </Card>

        <Card title="Most searched routes" padded={false}>
          {topRoutes.length ? (
            <Table head={["Route", "Searches"]}>
              {topRoutes.map((r) => (
                <tr key={`${r.origin}-${r.destination}`}>
                  <td>
                    <Mono className="!text-[var(--color-ink)]">
                      {r.origin} → {r.destination}
                    </Mono>
                  </td>
                  <td className="fm-mono">{r._count._all}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No demand recorded yet" />
          )}
        </Card>
      </div>
    </>
  );
}
