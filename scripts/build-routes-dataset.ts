/**
 * Regenerates data/mock/routes.json from airports.json.
 *
 * Distances are computed (great-circle). Durations are ESTIMATED from distance
 * using a documented formula - they are not schedule data. The output dataset is
 * flagged isMock:true and the estimation method is written into $meta so the UI
 * can show users exactly how the number was produced.
 *
 * Run:  npx tsx scripts/build-routes-dataset.ts
 */
import fs from "node:fs";
import path from "node:path";

interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
}

const root = process.cwd();
const airportsFile = path.join(root, "data", "mock", "airports.json");
const outFile = path.join(root, "data", "mock", "routes.json");

const airports: Airport[] = JSON.parse(fs.readFileSync(airportsFile, "utf8")).airports;
const byIata = new Map(airports.map((a) => [a.iata, a]));

/** Great-circle distance in km. */
function haversine(a: Airport, b: Airport): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * Estimated block time. Cruise 850 km/h, +35 min taxi/climb/descent overhead,
 * +8% routing inefficiency vs great circle.
 */
function nonstopMinutes(distanceKm: number): number {
  return Math.round((distanceKm * 1.08) / 850 * 60 + 35);
}

/** One-stop itinerary: flying detour factor + a typical connection window. */
function oneStopMinutes(distanceKm: number): number {
  return Math.round(nonstopMinutes(distanceKm * 1.18) + 150);
}

interface RouteSeed {
  o: string;
  d: string;
  nonstop: boolean;
  airlines: string[];
  demandIndex: number; // 0-100 relative search demand (approximate)
  peakMonths: string[];
}

// Carrier lists reflect commonly-operated services on each city pair. They are
// approximate reference data, not a live schedule.
const seeds: RouteSeed[] = [
  { o: "DEL", d: "YYZ", nonstop: true, airlines: ["AC", "AI"], demandIndex: 88, peakMonths: ["Jun", "Jul", "Dec"] },
  { o: "DEL", d: "YVR", nonstop: true, airlines: ["AC", "AI"], demandIndex: 71, peakMonths: ["Jun", "Jul", "Dec"] },
  { o: "DEL", d: "YUL", nonstop: false, airlines: ["AC", "LH", "BA", "EK"], demandIndex: 54, peakMonths: ["Jun", "Dec"] },
  { o: "DEL", d: "DXB", nonstop: true, airlines: ["EK", "AI", "6E", "EK2"], demandIndex: 95, peakMonths: ["Jan", "Nov", "Dec"] },
  { o: "DEL", d: "LHR", nonstop: true, airlines: ["BA", "AI", "VS"], demandIndex: 93, peakMonths: ["Jul", "Aug", "Dec"] },
  { o: "DEL", d: "JFK", nonstop: true, airlines: ["AI"], demandIndex: 86, peakMonths: ["Jun", "Jul", "Dec"] },
  { o: "DEL", d: "EWR", nonstop: true, airlines: ["AI", "UA"], demandIndex: 74, peakMonths: ["Jun", "Dec"] },
  { o: "DEL", d: "SFO", nonstop: true, airlines: ["AI", "UA"], demandIndex: 78, peakMonths: ["May", "Jun", "Dec"] },
  { o: "DEL", d: "ORD", nonstop: true, airlines: ["AI"], demandIndex: 62, peakMonths: ["Jun", "Dec"] },
  { o: "DEL", d: "SIN", nonstop: true, airlines: ["SQ", "AI", "6E"], demandIndex: 80, peakMonths: ["Mar", "Oct", "Dec"] },
  { o: "DEL", d: "SYD", nonstop: true, airlines: ["AI", "QF"], demandIndex: 66, peakMonths: ["Dec", "Jan", "Jun"] },
  { o: "DEL", d: "MEL", nonstop: false, airlines: ["SQ", "QF", "TK", "EK"], demandIndex: 58, peakMonths: ["Dec", "Jan"] },
  { o: "DEL", d: "FRA", nonstop: true, airlines: ["LH", "AI"], demandIndex: 69, peakMonths: ["Jun", "Sep"] },
  { o: "DEL", d: "IST", nonstop: true, airlines: ["TK", "AI"], demandIndex: 61, peakMonths: ["Apr", "Sep"] },
  { o: "DEL", d: "DOH", nonstop: true, airlines: ["QR", "AI", "6E"], demandIndex: 72, peakMonths: ["Jan", "Nov"] },
  { o: "DEL", d: "AUH", nonstop: true, airlines: ["EY", "AI", "6E"], demandIndex: 65, peakMonths: ["Jan", "Nov"] },
  { o: "BOM", d: "YYZ", nonstop: true, airlines: ["AC", "AI"], demandIndex: 70, peakMonths: ["Jun", "Dec"] },
  { o: "BOM", d: "LHR", nonstop: true, airlines: ["BA", "AI", "VS"], demandIndex: 84, peakMonths: ["Jul", "Dec"] },
  { o: "BOM", d: "JFK", nonstop: true, airlines: ["AI"], demandIndex: 76, peakMonths: ["Jun", "Dec"] },
  { o: "BOM", d: "DXB", nonstop: true, airlines: ["EK", "AI", "6E", "EK2"], demandIndex: 91, peakMonths: ["Jan", "Nov"] },
  { o: "BOM", d: "SIN", nonstop: true, airlines: ["SQ", "AI", "6E"], demandIndex: 68, peakMonths: ["Mar", "Dec"] },
  { o: "BLR", d: "SFO", nonstop: true, airlines: ["AI"], demandIndex: 67, peakMonths: ["May", "Sep"] },
  { o: "BLR", d: "YYZ", nonstop: false, airlines: ["AC", "EK", "QR", "LH"], demandIndex: 52, peakMonths: ["Jun", "Dec"] },
  { o: "BLR", d: "LHR", nonstop: true, airlines: ["BA", "AI"], demandIndex: 64, peakMonths: ["Jul", "Dec"] },
  { o: "BLR", d: "DXB", nonstop: true, airlines: ["EK", "AI", "6E"], demandIndex: 73, peakMonths: ["Jan", "Nov"] },
  { o: "HYD", d: "YYZ", nonstop: false, airlines: ["AC", "QR", "EK", "LH"], demandIndex: 46, peakMonths: ["Jun", "Dec"] },
  { o: "HYD", d: "DXB", nonstop: true, airlines: ["EK", "AI", "6E"], demandIndex: 62, peakMonths: ["Jan", "Nov"] },
  { o: "MAA", d: "SIN", nonstop: true, airlines: ["SQ", "AI", "6E"], demandIndex: 59, peakMonths: ["Mar", "Dec"] },
  { o: "MAA", d: "YYZ", nonstop: false, airlines: ["AC", "EK", "QR"], demandIndex: 43, peakMonths: ["Jun", "Dec"] },
  { o: "AMD", d: "YYZ", nonstop: false, airlines: ["AC", "EK", "QR", "TK"], demandIndex: 41, peakMonths: ["Jun", "Dec"] },
  { o: "COK", d: "DXB", nonstop: true, airlines: ["EK", "AI", "6E"], demandIndex: 57, peakMonths: ["Jan", "Nov"] },
  { o: "DEL", d: "BOM", nonstop: true, airlines: ["AI", "6E", "UK"], demandIndex: 97, peakMonths: ["Oct", "Dec"] },
  { o: "DEL", d: "BLR", nonstop: true, airlines: ["AI", "6E", "UK"], demandIndex: 94, peakMonths: ["Oct", "Dec"] },
  { o: "YYZ", d: "LHR", nonstop: true, airlines: ["AC", "BA", "WS"], demandIndex: 82, peakMonths: ["Jul", "Aug"] },
  { o: "YYZ", d: "DXB", nonstop: true, airlines: ["EK", "AC"], demandIndex: 60, peakMonths: ["Dec", "Feb"] },
];

const routes = seeds.map((s) => {
  const a = byIata.get(s.o)!;
  const b = byIata.get(s.d)!;
  const distanceKm = haversine(a, b);
  const stops = s.nonstop ? 0 : 1;
  const minutes = s.nonstop ? nonstopMinutes(distanceKm) : oneStopMinutes(distanceKm);
  return {
    id: `${s.o}-${s.d}`,
    origin: s.o,
    destination: s.d,
    originCity: a.city,
    destinationCity: b.city,
    originCountry: a.country,
    destinationCountry: b.country,
    distanceKm,
    typicalStops: stops,
    typicalDurationMinutes: minutes,
    nonstopAvailable: s.nonstop,
    airlines: s.airlines,
    demandIndex: s.demandIndex,
    peakMonths: s.peakMonths,
    cabinClasses: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS"],
  };
});

const payload = {
  $meta: {
    dataset: "routes",
    isMock: true,
    sourceName: "Bundled static reference dataset (computed + approximate)",
    note:
      "distanceKm is computed great-circle from airport coordinates. typicalDurationMinutes is ESTIMATED, not scheduled: nonstop = (distance x 1.08) / 850km/h + 35min; one-stop = nonstop(distance x 1.18) + 150min connection. Contains NO fares, no live schedules and no seat availability.",
    generatedBy: "scripts/build-routes-dataset.ts",
    retrievedAt: "2026-01-01T00:00:00.000Z",
  },
  routes,
};

fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${routes.length} routes to ${path.relative(root, outFile)}`);
