"use client";

import { useState } from "react";
import { Loader2, Search } from "lucide-react";

interface SearchResult {
  ok: boolean;
  error?: string;
  origin?: { iata: string; name: string; city: string; country: string };
  destination?: { iata: string; name: string; city: string; country: string };
  route?: {
    distanceKm: number;
    typicalDurationMinutes: number;
    typicalStops: number;
    nonstopAvailable: boolean;
    airlines: string[];
  } | null;
  offers: any[];
  liveAvailable: boolean;
  liveMessage: string;
  landingPage?: { url: string; title: string; status: string; published: boolean; href: string | null; qualityScore: number } | null;
  landingUrl?: string;
}

export function SearchPanel({ airports }: { airports: { iata: string; city: string; name: string }[] }) {
  const [origin, setOrigin] = useState("DEL");
  const [destination, setDestination] = useState("YYZ");
  const [departDate, setDepartDate] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [passengers, setPassengers] = useState(1);
  const [cabin, setCabin] = useState("ECONOMY");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin, destination, departDate: departDate || undefined, returnDate: returnDate || undefined, passengers, cabin }),
      });
      setResult(await res.json());
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message, offers: [], liveAvailable: false, liveMessage: "" });
    } finally {
      setBusy(false);
    }
  }

  const humanDuration = (m?: number) => (m ? `${Math.floor(m / 60)}h ${m % 60}m` : "—");

  return (
    <>
      <form onSubmit={search} className="fm-card mb-5 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-1">
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="from">
              From
            </label>
            <select id="from" className="fm-input" value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {airports.map((a) => (
                <option key={a.iata} value={a.iata}>
                  {a.city} ({a.iata})
                </option>
              ))}
            </select>
          </div>
          <div className="lg:col-span-1">
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="to">
              To
            </label>
            <select id="to" className="fm-input" value={destination} onChange={(e) => setDestination(e.target.value)}>
              {airports.map((a) => (
                <option key={a.iata} value={a.iata}>
                  {a.city} ({a.iata})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="depart">
              Departure
            </label>
            <input id="depart" type="date" className="fm-input" value={departDate} onChange={(e) => setDepartDate(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="ret">
              Return
            </label>
            <input id="ret" type="date" className="fm-input" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="pax">
              Passengers
            </label>
            <input
              id="pax"
              type="number"
              min={1}
              max={9}
              className="fm-input"
              value={passengers}
              onChange={(e) => setPassengers(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="cabin">
              Cabin
            </label>
            <select id="cabin" className="fm-input" value={cabin} onChange={(e) => setCabin(e.target.value)}>
              <option>ECONOMY</option>
              <option>PREMIUM_ECONOMY</option>
              <option>BUSINESS</option>
            </select>
          </div>
        </div>
        <div className="mt-3">
          <button type="submit" className="fm-btn fm-btn-primary" disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Search flights
          </button>
        </div>
      </form>

      {result ? (
        result.ok ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
            <div className="fm-card overflow-hidden">
              <div className="border-b border-[var(--color-border)] px-4 py-3">
                <h2 className="text-[14px] font-semibold">
                  {result.origin?.city} ({result.origin?.iata}) → {result.destination?.city} ({result.destination?.iata})
                </h2>
                <p className="text-[12px] text-[var(--color-ink-3)]">
                  {result.origin?.name} → {result.destination?.name}
                </p>
              </div>

              <div
                className="border-b px-4 py-2.5 text-[12px]"
                style={{
                  background: result.liveAvailable ? "var(--color-ok-soft)" : "var(--color-warn-soft)",
                  borderColor: "var(--color-border)",
                  color: result.liveAvailable ? "var(--color-ok)" : "var(--color-warn)",
                }}
              >
                {result.liveMessage}
              </div>

              {result.offers.length ? (
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>Carrier</th>
                      <th>Stops</th>
                      <th>Duration</th>
                      <th>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.offers.map((o, i) => (
                      <tr key={i}>
                        <td>{o.carrier}</td>
                        <td>{o.stops}</td>
                        <td>{o.duration}</td>
                        <td className="fm-mono">
                          {o.priceTotal} {o.currency}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="px-4 py-5 text-center text-[12.5px] text-[var(--color-ink-3)]">
                  No priced results are shown because no live flight data provider is connected. The system deliberately does
                  not generate placeholder fares.
                </div>
              )}

              {result.route ? (
                <div className="border-t border-[var(--color-border)] px-4 py-3">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                    Route reference data
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
                    <Cell label="Distance" value={`${result.route.distanceKm.toLocaleString()} km`} />
                    <Cell label="Typical duration" value={humanDuration(result.route.typicalDurationMinutes)} />
                    <Cell
                      label="Typical stops"
                      value={result.route.typicalStops === 0 ? "non-stop available" : `${result.route.typicalStops}`}
                    />
                    <Cell label="Carriers" value={String(result.route.airlines?.length ?? 0)} />
                  </div>
                  <p className="mt-2 text-[11px] text-[var(--color-mock)]">
                    Reference data from the bundled dataset (approximate; durations are estimated, not scheduled).
                  </p>
                </div>
              ) : (
                <div className="border-t border-[var(--color-border)] px-4 py-3 text-[12px] text-[var(--color-ink-3)]">
                  This city pair is not in the reference dataset, so no route attributes are available.
                </div>
              )}
            </div>

            <div className="fm-card p-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                Matching SEO landing page
              </div>
              {result.landingPage ? (
                <>
                  <div className="text-[13.5px] font-semibold">{result.landingPage.title}</div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-[var(--color-ink-3)]">{result.landingPage.url}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                    <span
                      className="rounded-full border px-2 py-[1px] text-[11px] font-semibold"
                      style={{
                        background: result.landingPage.published ? "var(--color-ok-soft)" : "var(--color-surface-2)",
                        borderColor: result.landingPage.published ? "var(--color-ok)" : "var(--color-border-strong)",
                        color: result.landingPage.published ? "var(--color-ok)" : "var(--color-ink-2)",
                      }}
                    >
                      {result.landingPage.status}
                    </span>
                    <span className="text-[var(--color-ink-3)]">quality {result.landingPage.qualityScore.toFixed(0)}/100</span>
                  </div>
                  {result.landingPage.href ? (
                    <a href={result.landingPage.href} target="_blank" rel="noreferrer" className="fm-btn mt-3">
                      Open the live page
                    </a>
                  ) : null}
                  <p className="mt-3 text-[11.5px] text-[var(--color-ink-3)]">
                    This search was recorded against the route, so demand from the search product feeds the content plan.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[12.5px] text-[var(--color-ink-2)]">
                    No landing page exists for this route yet. Expected URL:
                  </p>
                  <div className="mt-1 font-mono text-[12px]">{result.landingUrl}</div>
                  <p className="mt-3 text-[11.5px] text-[var(--color-ink-3)]">
                    The search is still recorded. Repeated demand for a route with no page is exactly the signal the
                    opportunity gate uses.
                  </p>
                  <a href="/goals" className="fm-btn mt-3">
                    Create a strategy for this route
                  </a>
                </>
              )}
            </div>
          </div>
        ) : (
          <div
            className="rounded-lg border p-3 text-[12.5px]"
            style={{ background: "var(--color-danger-soft)", borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
          >
            {result.error}
          </div>
        )
      ) : null}
    </>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wide text-[var(--color-ink-4)]">{label}</div>
      <div className="text-[var(--color-ink)]">{value}</div>
    </div>
  );
}
