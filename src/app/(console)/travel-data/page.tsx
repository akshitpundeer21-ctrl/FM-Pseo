import { prisma } from "@/core/db/client";
import { requireProject } from "@/app/(console)/_lib/data";
import { readJson } from "@/core/db/json";
import { travelDataStats } from "@/modules/travel/service";
import { cacheStats } from "@/modules/travel/cache";
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  Grid,
  MockBadge,
  Mono,
  PageHeader,
  Stat,
  Table,
  timeAgo,
} from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function TravelDataPage() {
  // Reference data is global rather than project-scoped, but the page still
  // runs behind the same auth/project guard as every other console route.
  await requireProject();

  const [stats, cache, airports, airlines, routes, destinations, policies] = await Promise.all([
    travelDataStats(),
    cacheStats(),
    prisma.airport.findMany({
      include: { city: true, country: true },
      orderBy: [{ isHub: "desc" }, { iata: "asc" }],
      take: 30,
    }),
    prisma.airline.findMany({ include: { country: true }, orderBy: { name: "asc" }, take: 25 }),
    prisma.route.findMany({
      include: {
        originAirport: true,
        destinationAirport: true,
        airlines: { include: { airline: true } },
      },
      orderBy: { distanceKm: "desc" },
      take: 25,
    }),
    prisma.destination.findMany({ include: { city: true, country: true }, orderBy: { name: "asc" }, take: 20 }),
    prisma.travelPolicy.findMany({ orderBy: { retrievedAt: "desc" }, take: 20 }),
  ]);

  const { counts, provenance } = stats;
  const empty = counts.airports === 0;

  return (
    <>
      <PageHeader
        title="Travel data"
        description="The normalized source of truth for countries, cities, airports, airlines, routes, destinations and travel policies. Agents read it through data.resolve."
        meta={
          <>
            <Badge tone="neutral">{counts.airports} airports</Badge>
            <Badge tone="neutral">{counts.routes} routes</Badge>
            {provenance.allReferenceData ? <MockBadge label="REFERENCE DATA" /> : null}
          </>
        }
      />

      <div className="mb-5">
        <Callout tone={provenance.allReferenceData ? "warn" : "info"} title="Where this data comes from">
          {provenance.allReferenceData ? (
            <>
              Every row here was ingested from the bundled reference dataset and is marked{" "}
              <Mono>isMock</Mono>. It carries approximate attributes only — no fares, no schedules, no seat
              availability. Connect a travel provider in <Mono>Integrations</Mono> and ingest from it to
              replace these rows with sourced data; a reference row can be overwritten by a real one, never
              the other way round.
            </>
          ) : (
            <>
              {provenance.mockAirports} of {counts.airports} airports and {provenance.mockRoutes} of{" "}
              {counts.routes} routes are still bundled reference data. The rest came from a connected
              provider. Every row carries its own source, confidence and retrieval date.
            </>
          )}
        </Callout>
      </div>

      <Grid cols={4} className="mb-5">
        <Stat label="Countries" value={counts.countries} />
        <Stat label="Cities" value={counts.cities} />
        <Stat label="Airports" value={counts.airports} />
        <Stat label="Airlines" value={counts.airlines} />
      </Grid>

      <Grid cols={4} className="mb-5">
        <Stat label="Routes" value={counts.routes} sub={`${counts.routeAirlines} carrier links`} />
        <Stat label="Destinations" value={counts.destinations} />
        <Stat label="Travel policies" value={counts.policies} sub={counts.policies === 0 ? "none ingested" : undefined} />
        <Stat
          label="Provider cache"
          value={cache.fresh}
          sub={`${cache.total} total · ${cache.stale} stale · ${cache.errored} errored`}
        />
      </Grid>

      {empty ? (
        <Card>
          <EmptyState
            title="The travel data layer is empty"
            hint="Run npx tsx scripts/ingest-travel.ts to populate it from the bundled reference dataset. Until then, data.resolve falls through to the bundled files exactly as it did before."
          />
        </Card>
      ) : null}

      <Card
        title="Airports"
        description="Hub airports first. Every row carries the source it came from."
        className="mb-5"
      >
        <Table head={["IATA", "Name", "City", "Country", "Terminals", "Source", "Confidence", "Retrieved"]}>
          {airports.map((a) => (
            <tr key={a.id}>
              <td>
                <Mono>{a.iata}</Mono>
                {a.isHub ? (
                  <>
                    {" "}
                    <Badge tone="neutral">hub</Badge>
                  </>
                ) : null}
              </td>
              <td>{a.name}</td>
              <td>{a.city?.name ?? "—"}</td>
              <td>{a.country ? `${a.country.name} (${a.country.iso2})` : "—"}</td>
              <td>{a.terminals ?? "—"}</td>
              <td>
                {a.source || "—"} {a.isMock ? <MockBadge /> : null}
              </td>
              <td>{a.confidence.toFixed(2)}</td>
              <td>{timeAgo(a.retrievedAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card
        title="Routes"
        description="One row per airport pair. Carriers hang off the route rather than duplicating it."
        className="mb-5"
      >
        <Table head={["Pair", "Distance", "Typical duration", "Stops", "Carriers", "Source", "Confidence"]}>
          {routes.map((r) => (
            <tr key={r.id}>
              <td>
                <Mono>
                  {r.originAirport.iata}→{r.destinationAirport.iata}
                </Mono>
              </td>
              <td>{r.distanceKm ? `${Math.round(r.distanceKm).toLocaleString("en-US")} km` : "—"}</td>
              <td title={r.method ?? undefined}>
                {r.typicalDurationMinutes ? `${r.typicalDurationMinutes} min` : "—"}
                {r.method ? (
                  <>
                    {" "}
                    <Badge tone="warn">estimated</Badge>
                  </>
                ) : null}
              </td>
              <td>{r.typicalStops ?? "—"}</td>
              <td>
                <Mono>{r.airlines.map((ra) => ra.airline.iata ?? ra.airline.name).join(" ") || "—"}</Mono>
              </td>
              <td>
                {r.source || "—"} {r.isMock ? <MockBadge /> : null}
              </td>
              <td>{r.confidence.toFixed(2)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Grid cols={2} className="mb-5">
        <Card title="Airlines" description="Carrier identity and hubs. No baggage or fare rules — those are policies.">
          <Table head={["IATA", "Name", "Alliance", "Hubs"]}>
            {airlines.map((a) => (
              <tr key={a.id}>
                <td>
                  <Mono>{a.iata ?? "—"}</Mono>
                </td>
                <td>{a.name}</td>
                <td>{a.alliance ?? "—"}</td>
                <td>
                  <Mono>{readJson<string[]>(a.hubsJson, []).join(" ") || "—"}</Mono>
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Destinations" description="City-level attributes. Descriptions are only ever ingested, never generated here.">
          {destinations.length ? (
            <Table head={["Destination", "City", "Country", "Description"]}>
              {destinations.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{d.city.name}</td>
                  <td>{d.country?.iso2 ?? "—"}</td>
                  <td>{d.description || <span className="text-[var(--color-ink-4)]">none supplied</span>}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No destinations ingested" />
          )}
        </Card>
      </Grid>

      <Card
        title="Travel policies"
        description="Visa, passport, baggage, airport and advisory rules. Treated as time-sensitive: never published without a verified live source."
      >
        {policies.length ? (
          <Table head={["Type", "Subject", "Title", "Source", "Confidence", "Verified"]}>
            {policies.map((p) => (
              <tr key={p.id}>
                <td>
                  <Badge tone="neutral">{p.policyType}</Badge>
                </td>
                <td>
                  <Mono>
                    {p.subjectType}:{p.subjectKey}
                  </Mono>
                </td>
                <td>{p.title}</td>
                <td>
                  {p.source || "—"} {p.isMock ? <MockBadge /> : null}
                </td>
                <td>{p.confidence.toFixed(2)}</td>
                <td>{p.lastVerifiedAt ? timeAgo(p.lastVerifiedAt) : <Badge tone="warn">never</Badge>}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            title="No travel policies ingested"
            hint="Nothing here is generated. Visa, baggage and entry rules only appear once a source supplies them, because inventing them would be exactly the failure this system is built to avoid."
          />
        )}
      </Card>
    </>
  );
}
