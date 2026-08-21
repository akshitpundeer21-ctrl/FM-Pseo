/**
 * Deterministic mock LLM provider.
 *
 * Purpose: the whole OS must be runnable and testable end-to-end with zero API
 * keys. This provider is NOT an imitation of a model - it is a deterministic
 * text composer that assembles copy from the structured variables the caller
 * already supplies (dynamic data, brand rules, verified facts).
 *
 * Hard rules it obeys, matching the product spec:
 *  - It never invents a price, schedule, baggage allowance or policy. If the
 *    caller did not pass the datum, the sentence is simply not written.
 *  - Every response is flagged `isMock: true` and surfaces as MOCK in the UI.
 */
import { stableHash } from "@/core/security/crypto";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/llm/types";
import { estimateTokens } from "@/llm/types";
import type { ModelTier } from "@/core/types/enums";

type Vars = Record<string, any>;

function seedPick<T>(items: T[], seed: number, offset = 0): T {
  return items[(seed + offset) % items.length];
}

const get = (v: Vars, path: string, fallback = ""): string => {
  const parts = path.split(".");
  let cur: any = v;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  if (cur == null) return fallback;
  return String(cur);
};

const num = (v: Vars, path: string): number | null => {
  const parts = path.split(".");
  let cur: any = v;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  const n = Number(cur);
  return Number.isFinite(n) ? n : null;
};

const list = (v: Vars, path: string): any[] => {
  const parts = path.split(".");
  let cur: any = v;
  for (const p of parts) {
    if (cur == null) return [];
    cur = cur[p];
  }
  return Array.isArray(cur) ? cur : [];
};

function joinSentences(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(" ").replace(/\s+/g, " ").trim();
}

function humanDuration(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---------------------------------------------------------------------------
// Writers - one per generation task
// ---------------------------------------------------------------------------

const writers: Record<string, (v: Vars, seed: number) => string> = {
  route_overview(v, seed) {
    const oc = get(v, "origin.city", "the origin city");
    const dc = get(v, "destination.city", "the destination city");
    const oa = get(v, "origin.airportName");
    const da = get(v, "destination.airportName");
    const oi = get(v, "origin.iata");
    const di = get(v, "destination.iata");
    const dur = humanDuration(num(v, "route.typicalDurationMinutes"));
    const dist = num(v, "route.distanceKm");
    const stops = num(v, "route.typicalStops");
    const airlines = list(v, "route.airlines").map((a: any) => a.name ?? a).filter(Boolean);

    const opener = seedPick(
      [
        `Flying from ${oc} to ${dc} is a long-haul journey that most travellers plan around cabin comfort, connection quality and total door-to-door time.`,
        `The ${oc} to ${dc} route connects two major travel markets, and the right itinerary depends as much on your connection as on the headline fare.`,
        `Travellers searching for ${oc} to ${dc} flights are usually weighing three things: how long the journey takes, where it connects, and which airline offers the best value in their cabin.`,
      ],
      seed,
    );

    const airportLine =
      oa && da
        ? `Departures are handled by ${oa}${oi ? ` (${oi})` : ""}, and arrivals land at ${da}${di ? ` (${di})` : ""}.`
        : null;

    const distanceLine = dist ? `The great-circle distance is roughly ${Math.round(dist).toLocaleString("en-US")} km.` : null;

    const durationLine =
      dur && stops !== null
        ? stops === 0
          ? `Non-stop services take around ${dur} in the air.`
          : `Typical itineraries take about ${dur} in total and involve ${stops} stop${stops === 1 ? "" : "s"}.`
        : dur
          ? `Typical total travel time is around ${dur}.`
          : null;

    const airlineLine = airlines.length
      ? `Carriers seen on this route include ${airlines.slice(0, 4).join(", ")}${airlines.length > 4 ? " and others" : ""}.`
      : null;

    const closer = seedPick(
      [
        `Fares move with season, day of week and how far ahead you book, so compare a few date combinations before committing.`,
        `Because availability shifts constantly, check live results for your exact dates rather than relying on a single quoted fare.`,
        `Flexible dates usually reveal meaningfully different pricing, so it is worth checking the days either side of your preferred departure.`,
      ],
      seed,
      1,
    );

    return joinSentences([opener, airportLine, distanceLine, durationLine, airlineLine, closer]);
  },

  route_travel_tips(v, seed) {
    const oc = get(v, "origin.city", "your departure city");
    const dc = get(v, "destination.city", "your destination");
    const stops = num(v, "route.typicalStops");
    const tips: string[] = [];
    tips.push(
      seedPick(
        [
          `Give yourself a realistic connection buffer — on multi-stop itineraries, a 60-minute layover looks efficient on paper and stressful in practice.`,
          `When comparing itineraries, look at the layover airport as well as the layover length; a comfortable transit hub can matter more than an hour saved.`,
        ],
        seed,
      ),
    );
    if (stops !== null && stops > 0) {
      tips.push(
        `Because most ${oc}–${dc} itineraries connect, confirm whether your bags are checked through to the final destination and whether you need a transit visa for the connecting country.`,
      );
    }
    tips.push(
      seedPick(
        [
          `Check the arrival time in ${dc} against your onward plans — long-haul arrivals often land early morning or late evening.`,
          `Plan ground transport in ${dc} before you fly; arrival-hall taxi queues are the least pleasant part of a long journey.`,
        ],
        seed,
        2,
      ),
    );
    tips.push(
      `Baggage allowances, seat selection charges and change rules vary by airline and fare family — read the fare conditions before booking rather than after.`,
    );
    return tips.join(" ");
  },

  airline_context(v, seed) {
    const name = get(v, "airline.name", "the airline");
    const country = get(v, "airline.country");
    const alliance = get(v, "airline.alliance");
    const hub = get(v, "airline.hub");
    const parts = [
      `${name}${country ? ` is a carrier based in ${country}` : " is one of the carriers on this route"}${
        hub ? `, operating a hub at ${hub}` : ""
      }.`,
    ];
    if (alliance && alliance !== "None") parts.push(`It is a member of ${alliance}, which affects through-fares and mileage earning.`);
    parts.push(
      seedPick(
        [
          `Cabin layout, baggage rules and change fees depend on the fare family you buy, so compare the conditions rather than only the price.`,
          `Fare families differ in what they include — checked bags, seat selection and changes are the usual differentiators.`,
        ],
        seed,
      ),
    );
    return joinSentences(parts);
  },

  airport_context(v, seed) {
    const name = get(v, "airport.name", "the airport");
    const iata = get(v, "airport.iata");
    const city = get(v, "airport.city");
    const country = get(v, "airport.country");
    const terminals = num(v, "airport.terminals");
    const parts = [
      `${name}${iata ? ` (${iata})` : ""} serves ${city || "the surrounding metropolitan area"}${country ? `, ${country}` : ""}.`,
    ];
    if (terminals) parts.push(`It operates ${terminals} passenger terminal${terminals === 1 ? "" : "s"}.`);
    parts.push(
      seedPick(
        [
          `Allow extra time at check-in during peak departure banks, and confirm your terminal before travelling — inter-terminal transfers can add 20–30 minutes.`,
          `Confirm the departure terminal on your booking; large hubs often split airlines across terminals and transfers are not instantaneous.`,
        ],
        seed,
      ),
    );
    return joinSentences(parts);
  },

  destination_overview(v, seed) {
    const city = get(v, "destination.city", "this destination");
    const country = get(v, "destination.country");
    const parts = [
      seedPick(
        [
          `${city}${country ? `, ${country},` : ""} draws a steady mix of leisure travellers, students and people visiting family, which shapes both fares and the busiest travel windows.`,
          `${city}${country ? ` in ${country}` : ""} sees demand peak around holidays and academic terms, and fares generally follow that pattern.`,
        ],
        seed,
      ),
      `Weather, public holidays and school terms are the three factors most likely to change what you pay and how full flights are.`,
      `Booking further ahead usually helps on long-haul routes, particularly if you need specific dates.`,
    ];
    return joinSentences(parts);
  },

  faq_answer(v, seed) {
    const q = get(v, "question", "").toLowerCase();
    const oc = get(v, "origin.city", "the origin");
    const dc = get(v, "destination.city", "the destination");
    const dur = humanDuration(num(v, "route.typicalDurationMinutes"));
    const stops = num(v, "route.typicalStops");
    const airlines = list(v, "route.airlines").map((a: any) => a.name ?? a).filter(Boolean);

    if (q.includes("how long")) {
      return dur
        ? `Typical ${oc} to ${dc} itineraries take about ${dur} in total${
            stops ? `, including ${stops} stop${stops === 1 ? "" : "s"}` : " when flown non-stop"
          }. Actual times vary by routing and connection length, so check the duration shown on your specific itinerary.`
        : `Total journey time depends on the routing and connection length. Check the duration shown on your specific itinerary before booking.`;
    }
    if (q.includes("which airline") || q.includes("what airlines") || q.includes("who flies")) {
      return airlines.length
        ? `Carriers observed on the ${oc}–${dc} route include ${airlines.slice(0, 5).join(", ")}. Availability changes by season and by date, so the airlines shown in a live search for your dates are the authoritative list.`
        : `Airline availability on this route changes by season. Run a live search for your dates to see which carriers are currently selling.`;
    }
    if (q.includes("cheapest") || q.includes("best time") || q.includes("when")) {
      return `The cheapest departures are usually mid-week and outside school holidays, but this route's pricing depends on seasonal demand. Compare a few date combinations rather than relying on a single quoted fare — we do not publish a fixed "cheapest day" because it changes.`;
    }
    if (q.includes("non-stop") || q.includes("direct")) {
      return stops === 0
        ? `Yes — non-stop services operate on this route, though frequency varies by season and day of week.`
        : `Most itineraries on this route connect at least once. Whether a non-stop option exists on your dates depends on the season and the carriers selling at the time, so confirm in a live search.`;
    }
    if (q.includes("baggage") || q.includes("luggage")) {
      return `Baggage allowance depends on the airline and the fare family you book, not on the route. Check the allowance shown in your booking confirmation, and confirm on the operating carrier's own baggage page before you travel.`;
    }
    if (q.includes("visa")) {
      return `Visa and transit requirements depend on your nationality, your destination and any country you connect through. Check the official government source for your passport before booking — we do not treat visa rules as route-level information.`;
    }
    return joinSentences([
      `This depends on your exact dates and itinerary.`,
      `For ${oc} to ${dc}, compare a few date combinations and read the fare conditions carefully before booking.`,
      seedPick(
        [`Live availability is the authoritative source for anything time-sensitive.`, `Check the operating carrier's own page for policy details.`],
        seed,
      ),
    ]);
  },

  meta_description(v) {
    const oc = get(v, "origin.city", "");
    const dc = get(v, "destination.city", "");
    const dur = humanDuration(num(v, "route.typicalDurationMinutes"));
    if (oc && dc) {
      return `Compare ${oc} to ${dc} flights: airlines, typical routings${dur ? `, around ${dur} travel time` : ""}, airport details and booking tips. Search live fares for your dates.`;
    }
    return get(v, "fallback", "Compare flights, routes and airline options, then search live fares for your dates.");
  },

  answer_block(v) {
    // AEO: a direct, extractable answer of 40-60 words.
    const oc = get(v, "origin.city", "the origin");
    const dc = get(v, "destination.city", "the destination");
    const dur = humanDuration(num(v, "route.typicalDurationMinutes"));
    const stops = num(v, "route.typicalStops");
    const airlines = list(v, "route.airlines").map((a: any) => a.name ?? a).filter(Boolean);
    return joinSentences([
      `Flights from ${oc} to ${dc}${dur ? ` take approximately ${dur} in total` : ""}${
        stops !== null ? (stops === 0 ? " when flown non-stop" : `, typically with ${stops} stop${stops === 1 ? "" : "s"}`) : ""
      }.`,
      airlines.length ? `Carriers on this route include ${airlines.slice(0, 3).join(", ")}.` : "",
      `Fares vary by season and booking window, so compare live results for your specific dates.`,
    ]);
  },

  orchestrator_reasoning(v) {
    const objective = get(v, "objective", "the stated objective");
    const steps = list(v, "steps");
    const lines = [
      `Objective interpreted as: ${objective}.`,
      steps.length
        ? `Planned ${steps.length} stages: ${steps.map((s: any) => s.name ?? s).join(" -> ")}.`
        : `No stages were planned; the objective did not map to a known workflow.`,
      `Human approval is enforced at the publishing gate according to the project's approval mode.`,
    ];
    return lines.join(" ");
  },

  skill_test(v, seed) {
    // Used by the skill sandbox. Composes a plausible, clearly-labelled response
    // from the skill's declared output contract and the supplied sample input,
    // so a skill can be exercised end-to-end with no LLM provider configured.
    const skill = (v.skill ?? {}) as { name?: string; outputs?: any[]; outputContract?: Record<string, string> };
    const input = (v.input ?? {}) as Record<string, unknown>;
    const outputs: any[] = Array.isArray(skill.outputs) && skill.outputs.length
      ? skill.outputs
      : Object.entries(skill.outputContract ?? {}).map(([name, description]) => ({ name, description, required: true }));

    const inputLines = Object.entries(input).map(
      ([k, val]) => `- ${k}: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`,
    );

    const sections = outputs.map((o: any) => {
      const label = String(o.name);
      const hint = String(o.description ?? o.type ?? "");
      const detail = hint.toLowerCase().startsWith("array")
        ? `Would return a list here, derived from ${inputLines.length ? "the supplied input" : "the resolved data context"}.`
        : `Would return the ${label} value here, derived from ${inputLines.length ? "the supplied input" : "the resolved data context"}.`;
      return `${label}: ${detail}`;
    });

    const opener = seedPick(
      [
        `Applying "${skill.name ?? "this skill"}" to the supplied input.`,
        `Running "${skill.name ?? "this skill"}" against the sample input.`,
      ],
      seed,
    );

    return [
      "[MOCK SANDBOX OUTPUT - no LLM provider is connected, so this response is composed deterministically from the skill's own output contract. It exercises the skill's schema and validation, not a model's reasoning.]",
      "",
      opener,
      inputLines.length ? `\nInput received:\n${inputLines.join("\n")}` : "",
      sections.length ? `\nOutput:\n${sections.join("\n")}` : "\nThis skill declares no output contract, so there is nothing to shape a response around.",
    ]
      .filter(Boolean)
      .join("\n");
  },

  ai_assistant_answer(v, seed) {
    // Used ONLY by AI Visibility in mock mode: a synthetic assistant answer so
    // mention/citation extraction has something to parse. Clearly labelled mock.
    const prompt = get(v, "prompt", "");
    const brand = get(v, "brand", "");
    const brandDomain = get(v, "brandDomain", "");
    const competitors = list(v, "competitors");
    const mentionBrand = seed % 10 < 4; // deterministic ~40% mention rate
    const citeBrand = mentionBrand && seed % 10 < 2; // ~20% citation rate

    const named = competitors.slice(0, 3).map((c: any) => c.name ?? c);
    const body = [
      `For a query like "${prompt}", most travellers start by comparing itineraries across a few booking sites and the airlines' own pages.`,
      named.length ? `Commonly used options include ${named.join(", ")}${mentionBrand && brand ? `, and ${brand}` : ""}.` : "",
      mentionBrand && brand
        ? `${brand} is one of the online travel agencies people use for this kind of search.`
        : `Airline websites are usually the most reliable source for baggage and change policies.`,
      `Prices and availability change frequently, so check live results before booking.`,
    ];
    const sources = [
      ...(citeBrand && brandDomain ? [`https://${brandDomain}/`] : []),
      ...named.slice(0, 2).map((n: string) => `https://${String(n).toLowerCase().replace(/[^a-z0-9]/g, "")}.com/`),
    ];
    return joinSentences(body) + (sources.length ? `\n\nSources:\n${sources.map((s) => `- ${s}`).join("\n")}` : "");
  },
};

function fallbackWriter(req: LlmRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const topic = (lastUser?.content ?? "").slice(0, 180).replace(/\s+/g, " ").trim();
  return joinSentences([
    `[MOCK OUTPUT] No deterministic writer is registered for task "${req.task ?? "unspecified"}".`,
    topic ? `Prompt began: "${topic}".` : "",
    `Configure a real LLM provider (ANTHROPIC_API_KEY or OPENAI_API_KEY) to generate this content.`,
  ]);
}

export class MockLlmProvider implements LlmProvider {
  readonly key = "mock";
  readonly label = "Mock (deterministic, no API key)";

  isConfigured(): boolean {
    return false;
  }

  modelFor(_tier: ModelTier): string {
    return "mock";
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const vars = req.variables ?? {};
    const seed = stableHash(`${req.task ?? ""}|${JSON.stringify(vars).slice(0, 400)}`) % 997;
    const writer = req.task ? writers[req.task] : undefined;
    const text = writer ? writer(vars, seed) : fallbackWriter(req);
    const promptText = req.messages.map((m) => m.content).join("\n");
    return {
      text,
      provider: this.key,
      model: "mock",
      tokensIn: estimateTokens(promptText),
      tokensOut: estimateTokens(text),
      costUsd: 0,
      latencyMs: Date.now() - started,
      isMock: true,
      finishReason: "stop",
    };
  }
}

export const MOCK_TASKS = Object.keys(writers);
