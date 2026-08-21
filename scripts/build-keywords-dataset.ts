/**
 * Regenerates data/mock/keywords.json - the corpus the mock KeywordDataProvider
 * serves when no real keyword API is connected.
 *
 * The volumes are SYNTHETIC and derived deterministically from each route's
 * demandIndex and the query template's typical share of route demand. They are
 * plausible for exercising scoring logic; they are not measurements. Every row
 * carries isMock:true and the UI labels them MOCK.
 *
 * Run:  npx tsx scripts/build-keywords-dataset.ts
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const routes = JSON.parse(fs.readFileSync(path.join(root, "data", "mock", "routes.json"), "utf8")).routes as any[];
const airports = JSON.parse(fs.readFileSync(path.join(root, "data", "mock", "airports.json"), "utf8")).airports as any[];
const airlines = JSON.parse(fs.readFileSync(path.join(root, "data", "mock", "airlines.json"), "utf8")).airlines as any[];

type Intent = "INFORMATIONAL" | "NAVIGATIONAL" | "COMMERCIAL" | "TRANSACTIONAL" | "QUESTION";

interface Template {
  id: string;
  build: (ctx: any) => string;
  intent: Intent;
  pageType: string;
  /** Share of the route's total demand this phrasing typically captures. */
  share: number;
  difficulty: number;
  cpc: number;
  businessValue: number;
}

const routeTemplates: Template[] = [
  { id: "route_core", build: (r) => `${r.originCity} to ${r.destinationCity} flights`, intent: "TRANSACTIONAL", pageType: "ROUTE", share: 0.30, difficulty: 62, cpc: 1.9, businessValue: 95 },
  { id: "route_from", build: (r) => `flights from ${r.originCity} to ${r.destinationCity}`, intent: "TRANSACTIONAL", pageType: "ROUTE", share: 0.22, difficulty: 60, cpc: 1.8, businessValue: 93 },
  { id: "route_cheap", build: (r) => `cheap flights ${r.originCity} to ${r.destinationCity}`, intent: "COMMERCIAL", pageType: "ROUTE", share: 0.14, difficulty: 66, cpc: 2.3, businessValue: 90 },
  { id: "route_iata", build: (r) => `${r.origin} to ${r.destination} flights`, intent: "TRANSACTIONAL", pageType: "ROUTE", share: 0.05, difficulty: 44, cpc: 1.5, businessValue: 80 },
  { id: "route_direct", build: (r) => `direct flights ${r.originCity} to ${r.destinationCity}`, intent: "COMMERCIAL", pageType: "ROUTE", share: 0.07, difficulty: 48, cpc: 1.6, businessValue: 78 },
  { id: "route_time", build: (r) => `${r.originCity} to ${r.destinationCity} flight time`, intent: "INFORMATIONAL", pageType: "ROUTE", share: 0.09, difficulty: 31, cpc: 0.4, businessValue: 45 },
  { id: "route_howlong", build: (r) => `how long is the flight from ${r.originCity} to ${r.destinationCity}`, intent: "QUESTION", pageType: "ROUTE", share: 0.06, difficulty: 26, cpc: 0.3, businessValue: 40 },
  { id: "route_airlines", build: (r) => `which airlines fly from ${r.originCity} to ${r.destinationCity}`, intent: "QUESTION", pageType: "ROUTE", share: 0.04, difficulty: 28, cpc: 0.4, businessValue: 52 },
  { id: "route_cheapest_time", build: (r) => `cheapest time to fly ${r.originCity} to ${r.destinationCity}`, intent: "INFORMATIONAL", pageType: "ROUTE", share: 0.03, difficulty: 35, cpc: 0.9, businessValue: 62 },
];

const airportTemplates: Template[] = [
  { id: "apt_core", build: (a) => `${a.city} airport`, intent: "NAVIGATIONAL", pageType: "AIRPORT", share: 1, difficulty: 55, cpc: 0.5, businessValue: 40 },
  { id: "apt_code", build: (a) => `${a.iata} airport terminals`, intent: "INFORMATIONAL", pageType: "AIRPORT", share: 0.3, difficulty: 34, cpc: 0.3, businessValue: 35 },
  { id: "apt_transfers", build: (a) => `${a.city} airport to city centre transfer`, intent: "COMMERCIAL", pageType: "AIRPORT_TRANSFERS", share: 0.25, difficulty: 41, cpc: 1.2, businessValue: 55 },
  { id: "apt_flights", build: (a) => `flights to ${a.city}`, intent: "TRANSACTIONAL", pageType: "DESTINATION", share: 0.8, difficulty: 64, cpc: 1.7, businessValue: 85 },
];

const airlineTemplates: Template[] = [
  { id: "air_core", build: (a) => `${a.name} flights`, intent: "NAVIGATIONAL", pageType: "AIRLINE", share: 1, difficulty: 58, cpc: 1.1, businessValue: 60 },
  { id: "air_baggage", build: (a) => `${a.name} baggage allowance`, intent: "QUESTION", pageType: "AIRLINE_BAGGAGE", share: 0.45, difficulty: 39, cpc: 0.5, businessValue: 48 },
  { id: "air_checkin", build: (a) => `${a.name} web check in`, intent: "NAVIGATIONAL", pageType: "AIRLINE", share: 0.35, difficulty: 42, cpc: 0.4, businessValue: 30 },
  { id: "air_review", build: (a) => `is ${a.name} good for long haul`, intent: "QUESTION", pageType: "AIRLINE", share: 0.12, difficulty: 30, cpc: 0.3, businessValue: 38 },
];

/** Deterministic jitter in [1-amount, 1+amount] from a string seed. */
function jitter(seed: string, amount = 0.25): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const unit = (Math.abs(h) % 1000) / 1000;
  return 1 - amount + unit * amount * 2;
}

function roundVolume(v: number): number {
  if (v < 50) return Math.max(10, Math.round(v / 10) * 10);
  if (v < 1000) return Math.round(v / 10) * 10;
  return Math.round(v / 100) * 100;
}

const rows: any[] = [];
const seen = new Set<string>();

function push(row: any) {
  const key = row.keyword.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  rows.push(row);
}

// Route keywords: base volume scales with demandIndex.
for (const r of routes) {
  const baseVolume = Math.round(Math.pow(r.demandIndex, 2.1) * 0.9);
  for (const t of routeTemplates) {
    const kw = t.build(r);
    push({
      keyword: kw,
      intent: t.intent,
      entityType: "ROUTE",
      origin: r.origin,
      destination: r.destination,
      pageType: t.pageType,
      volume: roundVolume(baseVolume * t.share * jitter(kw)),
      difficulty: Math.round(t.difficulty * jitter(`d${kw}`, 0.12)),
      cpc: Number((t.cpc * jitter(`c${kw}`, 0.2)).toFixed(2)),
      businessValue: t.businessValue,
      template: t.id,
      isMock: true,
    });
  }
}

// Airport keywords.
for (const a of airports) {
  const baseVolume = Math.round((a.annualPassengersM ?? 10) * 260);
  for (const t of airportTemplates) {
    const kw = t.build(a);
    push({
      keyword: kw,
      intent: t.intent,
      entityType: t.pageType === "DESTINATION" ? "DESTINATION" : "AIRPORT",
      origin: null,
      destination: t.pageType === "DESTINATION" ? a.iata : null,
      airport: a.iata,
      pageType: t.pageType,
      volume: roundVolume(baseVolume * t.share * jitter(kw)),
      difficulty: Math.round(t.difficulty * jitter(`d${kw}`, 0.12)),
      cpc: Number((t.cpc * jitter(`c${kw}`, 0.2)).toFixed(2)),
      businessValue: t.businessValue,
      template: t.id,
      isMock: true,
    });
  }
}

// Airline keywords.
for (const a of airlines) {
  const baseVolume = 14000;
  for (const t of airlineTemplates) {
    const kw = t.build(a);
    push({
      keyword: kw,
      intent: t.intent,
      entityType: "AIRLINE",
      airline: a.iata,
      origin: null,
      destination: null,
      pageType: t.pageType,
      volume: roundVolume(baseVolume * t.share * jitter(kw, 0.5)),
      difficulty: Math.round(t.difficulty * jitter(`d${kw}`, 0.12)),
      cpc: Number((t.cpc * jitter(`c${kw}`, 0.2)).toFixed(2)),
      businessValue: t.businessValue,
      template: t.id,
      isMock: true,
    });
  }
}

const payload = {
  $meta: {
    dataset: "keywords",
    isMock: true,
    sourceName: "Synthetic keyword corpus (deterministic)",
    note:
      "Volumes/difficulty/CPC are SYNTHETIC values derived from route demand indices and query-template shares. They exist so scoring and clustering logic can be exercised without a paid keyword API. They are NOT measurements and must never be reported as real search volume.",
    generatedBy: "scripts/build-keywords-dataset.ts",
    retrievedAt: "2026-01-01T00:00:00.000Z",
  },
  keywords: rows.sort((a, b) => b.volume - a.volume),
};

fs.writeFileSync(path.join(root, "data", "mock", "keywords.json"), `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${rows.length} keywords to data/mock/keywords.json`);
