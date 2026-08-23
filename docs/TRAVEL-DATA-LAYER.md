# Travel Data Layer

A normalized, provenance-carrying source of truth for travel reference data: countries, regions, cities,
airports, airlines, routes, destinations and travel policies.

It was added **alongside** the existing Dynamic Data Engine, not in place of it. Agents still call
`data.resolve`; that tool still goes through `DynamicDataEngine`; the layer is simply a new adapter behind
it that reads normalized tables instead of JSON files.

---

## Where it sits

```
Amadeus (credentialed)          trust 0.9   ← live offers only
        │
Travel Data Layer               trust 0.70  ← countries, cities, airports, airlines,
        │                                      routes, destinations, policies
Bundled static dataset          trust 0.55  ← the original JSON files
        │
        ▼
   data.resolve  →  agents
```

The engine picks the highest-trust adapter that can serve a namespace. A miss returns `[]` and the engine
falls through to the next candidate, so **an empty travel database behaves exactly as the system did
before this layer existed**. That is what makes it safe to add.

---

## Entities

| Model | Notes |
| --- | --- |
| `Country` | ISO2 unique. Regions, cities, airports, airlines and destinations hang off it. |
| `Region` | States, provinces, administrative regions. Unique per `(country, name)`. |
| `City` | Unique per `(country, name)`. The spec's `airport_ids` is the `airports` relation, kept normalized. |
| `Airport` | IATA unique — the system's primary airport key. |
| `Airline` | IATA unique when present; `hubsJson` holds IATA codes. |
| `Route` | **One row per airport pair.** Unique on `(originAirportId, destinationAirportId)`. |
| `RouteAirline` | Which carriers operate a route. This is why a route is never duplicated per airline or per provider. |
| `Destination` | City-level editorial and travel attributes. |
| `TravelPolicy` | Visa, passport, baggage, airport, airline, advisory and entry rules. |
| `ProviderCache` | Provider response cache, keyed by a hash of the credential-free request. |

All of it is **global rather than project-scoped**: an airport is the same airport for every tenant, and
duplicating it per project would fragment provenance.

---

## Provenance

Every entity carries the same columns, mirroring the existing `Fact` model:

```
source            human-readable source name, shown in the published evidence block
sourceType        STATIC_DATASET | PROVIDER_API | MANUAL | CRAWL
sourceUrl         where it can be checked
provider          adapter key that produced it
providerRecordId  the provider's own id, for reconciliation
confidence        0..1
isMock            true for approximate / bundled sources
retrievedAt       when it was pulled
expiresAt         when it should no longer be trusted
lastVerifiedAt    when it was last checked against its source
```

`isMock` is load-bearing, not cosmetic. Rows ingested from the bundled dataset keep `isMock: true`
**forever**. Moving approximate data from a file into a table does not make it true, and the composer, the
fact gate and the published evidence block all keep reading the row's own flag.

### The adapter's isMock is deliberately not the row's

`TravelDbAdapter.isMock` is a conservative `true`, but every `DataPoint` it emits carries the **row's**
provenance. A row ingested from a credentialed provider is reported as real even though the adapter is
labelled mock, because the row is what everything downstream actually reads. The adapter-level flag only
gates time-sensitive namespaces — which this adapter never serves.

---

## What it will not do

The layer **never** serves `offers`, `schedule`, `seatmap` or `fare_rules`. Those namespaces stay in
`TIME_SENSITIVE_NAMESPACES` and remain served only by a credentialed adapter. Asking the travel layer for
live prices returns nothing, and the binding is reported missing — the same behaviour as before.

Travel policies are stored but every policy `DataPoint` is marked `isTimeSensitive: true`, so the existing
fact gate treats a baggage rule exactly as it treats a fare: publishable only with a live, verified source
behind it.

---

## Ingestion

```bash
npx tsx scripts/ingest-travel.ts              # from the bundled reference dataset
npx tsx scripts/ingest-travel.ts --dry-run    # report without writing
```

`npm run seed` runs the same ingest, so a fresh install has the layer populated.

### The rule that makes it re-runnable

```
A LOWER-TRUST SOURCE MAY NEVER OVERWRITE A HIGHER-TRUST ONE.
```

Real data replaces reference data; reference data never replaces real data; within the same class the more
confident source wins. Re-running the bundled ingest after connecting Amadeus will **skip** every row
Amadeus supplied rather than silently downgrading it. Skipped rows are counted, and rows that cannot be
resolved at all are reported as `rejected` with a reason — nothing is dropped quietly.

### Adding a provider

Implement `TravelDataProvider` (`src/modules/travel/types.ts`) and register it in
`scripts/ingest-travel.ts`. A provider returns plain normalized records and never touches Prisma; ingest
never calls an external API. That split is what keeps providers swappable.

```ts
interface TravelDataProvider {
  key: string; name: string; isMock: boolean; trustLevel: number;
  isAvailable(): Promise<boolean> | boolean;
  fetch(kinds?: (keyof TravelDataset)[]): Promise<TravelDataset>;
  provenance(): TravelProvenance;
}
```

A provider that cannot reach its source reports unavailable and writes nothing. It never fabricates.

---

## Provider cache

`src/modules/travel/cache.ts`. Keyed by `sha256(provider + namespace + canonicalised params)`, so key
order does not matter.

- **Nothing credential-shaped is ever written.** Params are scrubbed before they are hashed or stored:
  by key (`apiKey`, `client_secret`, `Authorization`, `token`, …) and by value shape (`sk-`, `ghp_`,
  `Bearer …`). A key cannot reach the table even if a caller passes one by mistake.
- An expired row is a miss and is marked `STALE` rather than deleted, so the fact a call was made survives.
- A failed call is cached briefly as `ERROR`, so a hot failure is not retried in a loop.

```ts
const { value, fromCache } = await cached("amadeus", "route", params, 3600, () => callProvider());
```

---

## Namespaces

Existing, now served from the layer: `route`, `airport`, `airline`, `destination`.
Added: `city`, `country`, `policy`.

The route/airport/airline/destination points use **exactly the same paths** the bundled adapter emitted,
so every existing component, template and composition rule keeps working untouched.

---

## Reading it

`src/modules/travel/service.ts` — `findCountry`, `findCity`, `findAirport`, `findAirline`, `findRoute`,
`findDestination`, `findPolicies`, `airportsForCity`, `routesFromAirport`, `travelDataStats`.

Agents do **not** call these directly; they go through `data.resolve`. The dashboard
(`/travel-data`) and the ingest tooling use them.

---

## What was changed to add this

Two existing files, both minimally:

| File | Change |
| --- | --- |
| `src/engine/data/engine.ts` | +2 lines: import `TravelDbAdapter`, push it between Amadeus and the static dataset |
| `scripts/seed.ts` | +1 block: run the bundled ingest |
| `src/ui/sidebar.tsx` | +1 nav entry |
| `prisma/schema.prisma` | +10 models, appended. The migration is 10 `CREATE TABLE` and **zero** `DROP`/`ALTER` |

No existing model, tool, agent, skill, workflow, capability or permission was modified.

---

## Tests

`tests/travel-data-layer.test.ts` — 36 tests covering ingestion, idempotence, rejection reporting, the
no-downgrade rule, every lookup, provenance, staleness, the cache (hashing, secret scrubbing, expiry,
fetch-through, error recording, pruning), adapter resolution, and integration with the existing engine
including the proof that live offers are still refused.
