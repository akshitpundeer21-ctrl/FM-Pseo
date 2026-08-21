/**
 * Pure-logic tests: scoring, expressions, clustering, quality gates, crypto,
 * linking, brand compliance and answer-engine extraction.
 *
 * These are the rules that decide whether a page gets built and published, so
 * they are tested directly rather than only through the workflow.
 */
import { describe, expect, it } from "vitest";
import { buildUrl, patternVariables, scoreOpportunity } from "@/engine/pseo/scoring";
import { evaluateCondition, interpolate } from "@/engine/templates/expression";
import { clusterKeywords, detectCannibalisation, entityKeyFor } from "@/modules/keywords/clustering";
import { classifyIntent } from "@/modules/keywords/providers";
import { computeComposition } from "@/engine/templates/renderer";
import { checkBrandCompliance, DEFAULT_BRAND, type BrandKnowledge } from "@/modules/brand/brand";
import { decryptSecret, encryptSecret, hashPassword, secretHint, verifyPassword } from "@/core/security/crypto";
import { proposeLinks, routeEntities, findOrphans } from "@/engine/linking/linker";
import { extractCitations, extractMentions, isOwnedUrl } from "@/modules/ai-visibility/platforms";
import { extractClaims } from "@/agents/fact-verification.agent";
import { classifyObjective, parseEntities } from "@/agents/master-orchestrator.agent";
import { generateSchemas } from "@/engine/schema/generator";
import { runQualityGate } from "@/engine/quality/gate";
import { roleHas } from "@/core/security/rbac";

const brand: BrandKnowledge = { ...DEFAULT_BRAND, brandName: "FaresMatch", version: 1 };

describe("opportunity scoring", () => {
  const baseKeywords = [
    { keyword: "delhi to toronto flights", volume: 3500, difficulty: 60, intent: "TRANSACTIONAL" as const, businessValue: 95 },
    { keyword: "how long is the flight", volume: 600, difficulty: 25, intent: "QUESTION" as const, businessValue: 45 },
  ];

  it("approves a well-supported, in-demand candidate", () => {
    const r = scoreOpportunity({
      keywords: baseKeywords,
      dataAvailability: 1,
      distinctDataPoints: 14,
      existingPageTitles: [],
      candidateTitle: "Delhi to Toronto flights",
      questionCount: 4,
      minScoreToBuild: 55,
    });
    expect(r.decision).toBe("BUILD");
    expect(r.totalScore).toBeGreaterThan(55);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("rejects a candidate whose data does not resolve, however strong the demand", () => {
    const r = scoreOpportunity({
      keywords: [{ keyword: "huge", volume: 500_000, difficulty: 10, intent: "TRANSACTIONAL", businessValue: 100 }],
      dataAvailability: 0.2,
      distinctDataPoints: 2,
      existingPageTitles: [],
      candidateTitle: "Somewhere to Nowhere flights",
      questionCount: 0,
      minScoreToBuild: 55,
    });
    expect(r.decision).toBe("REJECT");
    expect(r.reasons.join(" ")).toMatch(/data bindings/i);
  });

  it("rejects a near-duplicate of an existing page", () => {
    const r = scoreOpportunity({
      keywords: baseKeywords,
      dataAvailability: 1,
      distinctDataPoints: 14,
      existingPageTitles: ["Delhi to Toronto flights"],
      candidateTitle: "Delhi to Toronto flights",
      questionCount: 4,
      minScoreToBuild: 55,
    });
    expect(r.decision).toBe("REJECT");
    expect(r.duplicationRisk).toBeGreaterThan(70);
  });

  it("sends a mid-strength candidate to human review rather than building it", () => {
    const r = scoreOpportunity({
      keywords: [{ keyword: "niche route", volume: 120, difficulty: 55, intent: "INFORMATIONAL", businessValue: 40 }],
      dataAvailability: 0.7,
      distinctDataPoints: 7,
      existingPageTitles: [],
      candidateTitle: "Somewhere to Elsewhere flights",
      questionCount: 1,
      minScoreToBuild: 55,
    });
    expect(["REVIEW", "REJECT"]).toContain(r.decision);
  });
});

describe("url patterns", () => {
  it("expands variables and slugifies them", () => {
    expect(buildUrl("/flights/{origin}/{destination}", { origin: "DEL", destination: "YYZ" })).toBe("/flights/del/yyz");
    expect(buildUrl("/destinations/{city}", { city: "New York" })).toBe("/destinations/new-york");
  });

  it("lists the variables a pattern needs", () => {
    expect(patternVariables("/flights/{origin}/{destination}")).toEqual(["origin", "destination"]);
  });

  it("refuses to build a URL with a missing variable", () => {
    expect(() => buildUrl("/flights/{origin}/{destination}", { origin: "DEL" })).toThrow();
  });
});

describe("condition expressions", () => {
  const values = { route: { stops: 1, airlines: [{ name: "AC" }], nonstop: false }, offers: {} };

  it("evaluates truthiness, comparisons and boolean logic", () => {
    expect(evaluateCondition("route.airlines", values)).toBe(true);
    expect(evaluateCondition("route.stops > 0", values)).toBe(true);
    expect(evaluateCondition("route.stops > 5", values)).toBe(false);
    expect(evaluateCondition("route.nonstop", values)).toBe(false);
    expect(evaluateCondition("!route.nonstop", values)).toBe(true);
    expect(evaluateCondition("route.stops > 0 && route.airlines", values)).toBe(true);
    expect(evaluateCondition("route.stops > 5 || route.airlines", values)).toBe(true);
  });

  it("treats unresolved data as false so the block simply hides", () => {
    expect(evaluateCondition("offers.items", values)).toBe(false);
    expect(evaluateCondition("nothing.here.at.all", values)).toBe(false);
  });

  it("never executes code from an expression", () => {
    expect(evaluateCondition("process.exit(1)", values)).toBe(false);
    expect(evaluateCondition("constructor.constructor('return 1')()", values)).toBe(false);
  });

  it("interpolates and reports missing paths", () => {
    const r = interpolate("{{route.stops}} stop to {{missing.value}}", values);
    expect(r.text).toContain("1 stop");
    expect(r.missing).toContain("missing.value");
  });
});

describe("intent classification and clustering", () => {
  it("classifies intent deterministically", () => {
    expect(classifyIntent("how long is the flight from delhi to toronto")).toBe("QUESTION");
    expect(classifyIntent("book delhi to toronto tickets")).toBe("TRANSACTIONAL");
    expect(classifyIntent("cheapest flights delhi toronto")).toBe("COMMERCIAL");
    expect(classifyIntent("air canada web check in")).toBe("NAVIGATIONAL");
    expect(classifyIntent("delhi airport terminal layout")).toBe("INFORMATIONAL");
  });

  it("groups keywords about the same route into one cluster", () => {
    const clusters = clusterKeywords([
      { keyword: "delhi to toronto flights", intent: "TRANSACTIONAL", entityType: "ROUTE", origin: "DEL", destination: "YYZ", pageType: "ROUTE", volume: 3500, difficulty: 60, businessValue: 95 },
      { keyword: "how long is the flight from delhi to toronto", intent: "QUESTION", entityType: "ROUTE", origin: "DEL", destination: "YYZ", pageType: "ROUTE", volume: 600, difficulty: 25, businessValue: 45 },
      { keyword: "mumbai to london flights", intent: "TRANSACTIONAL", entityType: "ROUTE", origin: "BOM", destination: "LHR", pageType: "ROUTE", volume: 2000, difficulty: 58, businessValue: 95 },
    ]);
    expect(clusters).toHaveLength(2);
    const delYyz = clusters.find((c) => c.entityKey === "ROUTE:DEL-YYZ");
    expect(delYyz?.keywords).toHaveLength(2);
    expect(delYyz?.questionKeywords).toHaveLength(1);
    expect(delYyz?.intent).toBe("TRANSACTIONAL");
  });

  it("derives a stable entity key", () => {
    expect(entityKeyFor({ keyword: "x", intent: "QUESTION", entityType: null, origin: "DEL", destination: "YYZ", pageType: null, volume: 0, difficulty: 0, businessValue: 0 })).toBe("ROUTE:DEL-YYZ");
  });

  it("reports cannibalisation between near-identical clusters", () => {
    const clusters = clusterKeywords([
      { keyword: "delhi to toronto flights", intent: "TRANSACTIONAL", entityType: "ROUTE", origin: "DEL", destination: "YYZ", pageType: "ROUTE", volume: 3000, difficulty: 60, businessValue: 95 },
      { keyword: "delhi to toronto flight", intent: "TRANSACTIONAL", entityType: "ROUTE", origin: "DEL", destination: "YYZ", pageType: "AIRPORT", volume: 900, difficulty: 60, businessValue: 95 },
    ]);
    const findings = detectCannibalisation(clusters);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].recommendation).toBeTruthy();
  });
});

describe("composition accounting", () => {
  const block = (source: string, text: string, aiChars = 0) => ({
    blockKey: `${source}-${text.length}`,
    componentKey: "x",
    componentVersion: 1,
    sequence: 0,
    source: source as never,
    html: "",
    text,
    usedPaths: [],
    slots: {},
    rendered: true,
    isRequired: false,
    aiChars,
    wordCount: text.split(" ").length,
  });

  it("measures the actual mix rather than assuming one", () => {
    const report = computeComposition([block("TEMPLATE", "a".repeat(100)), block("DYNAMIC", "b".repeat(100)), block("AI", "c".repeat(200))], 10);
    expect(report.templateShare).toBeCloseTo(0.25, 2);
    expect(report.dynamicShare).toBeCloseTo(0.25, 2);
    expect(report.aiShare).toBeCloseTo(0.5, 2);
  });

  it("splits a hybrid block by how much of it was generated", () => {
    const report = computeComposition([block("HYBRID", "x".repeat(100), 40)], 5);
    expect(report.aiShare).toBeCloseTo(0.4, 2);
    expect(report.dynamicShare).toBeCloseTo(0.6, 2);
  });

  it("flags a page that breaches the family policy", () => {
    const report = computeComposition([block("TEMPLATE", "t".repeat(900)), block("AI", "a".repeat(100))], 3, {
      minUniqueShare: 0.45,
      minDistinctDataPoints: 8,
    });
    expect(report.withinPolicy).toBe(false);
    expect(report.policyNotes.join(" ")).toMatch(/page-specific share/i);
    expect(report.policyNotes.join(" ")).toMatch(/distinct data points/i);
  });
});

describe("brand compliance", () => {
  it("blocks banned phrases", () => {
    const findings = checkBrandCompliance("This is an unbeatable deal you cannot miss.", brand);
    expect(findings.some((f) => f.rule === "avoid_words" && f.severity === "ERROR")).toBe(true);
  });

  it("blocks unsupportable superlatives", () => {
    const findings = checkBrandCompliance("We always have the cheapest fares.", brand);
    expect(findings.some((f) => f.rule === "avoid_claims")).toBe(true);
  });

  it("blocks price-shaped values in generated prose", () => {
    const findings = checkBrandCompliance("Fares start from $420 return.", brand);
    expect(findings.some((f) => f.message.includes("price-like"))).toBe(true);
  });

  it("passes compliant copy", () => {
    const findings = checkBrandCompliance(
      "Non-stop services take around 15h. Compare a few date combinations before booking.",
      brand,
    );
    expect(findings.filter((f) => f.severity === "ERROR")).toHaveLength(0);
  });
});

describe("credential encryption", () => {
  it("round-trips a secret and never stores it in the clear", () => {
    const secret = "sk-ant-super-secret-value-123";
    const enc = encryptSecret(secret);
    expect(enc.ciphertext).not.toContain("secret");
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("fails closed when the ciphertext is tampered with", () => {
    const enc = encryptSecret("value");
    expect(() => decryptSecret({ ...enc, ciphertext: Buffer.from("tampered").toString("base64") })).toThrow();
  });

  it("produces a display hint that is not the secret", () => {
    const hint = secretHint("sk-ant-abcdefghijklmnop");
    expect(hint).not.toContain("abcdefghijk");
    expect(hint).toContain("sk-");
  });

  it("verifies passwords with a per-user salt", () => {
    const { hash, salt } = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash, salt)).toBe(true);
    expect(verifyPassword("wrong password", hash, salt)).toBe(false);
  });
});

describe("rbac", () => {
  it("keeps publishing away from viewers and editors", () => {
    expect(roleHas("OWNER", "publish:execute")).toBe(true);
    expect(roleHas("ADMIN", "publish:execute")).toBe(true);
    expect(roleHas("EDITOR", "publish:execute")).toBe(false);
    expect(roleHas("VIEWER", "content:write")).toBe(false);
  });
});

describe("internal linking", () => {
  const pageA = {
    id: "a",
    url: "/flights/del/yyz",
    title: "Delhi to Toronto flights",
    pageType: "ROUTE",
    status: "PUBLISHED",
    entities: routeEntities({ origin: "DEL", destination: "YYZ", originCity: "Delhi", destinationCity: "Toronto" }),
  };
  const pageB = {
    id: "b",
    url: "/flights/del/yvr",
    title: "Delhi to Vancouver flights",
    pageType: "ROUTE",
    status: "PUBLISHED",
    entities: routeEntities({ origin: "DEL", destination: "YVR", originCity: "Delhi", destinationCity: "Vancouver" }),
  };
  const unrelated = {
    id: "c",
    url: "/flights/bom/sin",
    title: "Mumbai to Singapore flights",
    pageType: "ROUTE",
    status: "PUBLISHED",
    entities: routeEntities({ origin: "BOM", destination: "SIN", originCity: "Mumbai", destinationCity: "Singapore" }),
  };

  it("links pages that share an endpoint and skips unrelated ones", () => {
    const { proposals } = proposeLinks(pageA, [pageB, unrelated], { relevanceFloor: 0.35 });
    expect(proposals.map((p) => p.targetUrl)).toContain("/flights/del/yvr");
    expect(proposals.map((p) => p.targetUrl)).not.toContain("/flights/bom/sin");
    expect(proposals[0].reason).toMatch(/entit/i);
  });

  it("never links to an unpublished page", () => {
    const draft = { ...pageB, id: "d", status: "DRAFT" };
    const { proposals } = proposeLinks(pageA, [draft], { relevanceFloor: 0.2 });
    expect(proposals).toHaveLength(0);
  });

  it("finds orphaned published pages", () => {
    const orphans = findOrphans([pageA, pageB], [{ toPageId: "a" }]);
    expect(orphans.map((o) => o.id)).toEqual(["b"]);
  });
});

describe("answer-engine extraction", () => {
  const answer =
    "For Delhi to Toronto, travellers often compare Skyscanner and Kayak. FaresMatch is another option people use.\n\nSources:\n- https://faresmatch.com/flights/del/yyz\n- https://skyscanner.net/routes";

  it("finds brand and competitor mentions with position and context", () => {
    const mentions = extractMentions(answer, { name: "FaresMatch", domain: "faresmatch.com" }, [
      { name: "Skyscanner", domain: "skyscanner.net" },
      { name: "Kayak", domain: "kayak.com" },
    ]);
    const brandMention = mentions.find((m) => m.entityType === "BRAND");
    expect(brandMention).toBeTruthy();
    expect(mentions.filter((m) => m.entityType === "COMPETITOR")).toHaveLength(2);
    expect(mentions[0].position).toBe(1);
  });

  it("extracts cited URLs", () => {
    const citations = extractCitations(answer);
    expect(citations).toHaveLength(2);
    expect(citations[0].url).toContain("faresmatch.com");
  });

  it("recognises an owned citation even when the brand domain carries a port", () => {
    expect(isOwnedUrl("http://localhost:3000/site/x", "localhost:3000")).toBe(true);
    expect(isOwnedUrl("https://www.faresmatch.com/x", "faresmatch.com")).toBe(true);
    expect(isOwnedUrl("https://skyscanner.net/x", "faresmatch.com")).toBe(false);
  });
});

describe("claim extraction", () => {
  it("extracts quantitative claims and maps them to fact predicates", () => {
    const claims = extractClaims("The great-circle distance is roughly 11,640 km and the flight takes about 15h 22m with 1 stop.");
    const kinds = claims.map((c) => c.kind);
    expect(kinds).toContain("distance");
    expect(kinds).toContain("duration");
    expect(kinds).toContain("stops");
    expect(claims.find((c) => c.kind === "duration")?.value).toBe(922);
  });

  it("marks prices, baggage and schedules as time-sensitive", () => {
    const claims = extractClaims("Fares from $499. Checked baggage is 23 kg. Departs at 02:15.");
    expect(claims.every((c) => c.isTimeSensitive)).toBe(true);
  });

  it("does not mistake a speed for a distance", () => {
    const claims = extractClaims("Estimated using a cruise speed of 850 km/h.");
    expect(claims.filter((c) => c.kind === "distance")).toHaveLength(0);
  });

  it("accepts either endpoint as the subject of a terminal count", () => {
    const claims = extractClaims("It operates 2 passenger terminals.");
    expect(claims[0].predicates).toContain("origin.terminals");
    expect(claims[0].predicates).toContain("destination.terminals");
  });
});

describe("objective interpretation", () => {
  it("classifies objectives", () => {
    expect(classifyObjective("Create an SEO growth strategy around Delhi to Toronto flights")).toBe("GROWTH");
    expect(classifyObjective("Research keyword opportunities for Mumbai to London")).toBe("RESEARCH");
    expect(classifyObjective("Monitor search and AI visibility this week")).toBe("MONITORING");
  });

  it("parses entities from natural language and from IATA codes", () => {
    expect(parseEntities("Create an SEO growth strategy around Delhi to Toronto flights")).toEqual({ origin: "DEL", destination: "YYZ" });
    expect(parseEntities("Plan content for BOM to LHR")).toEqual({ origin: "BOM", destination: "LHR" });
  });

  it("reports what it could not resolve rather than guessing", () => {
    expect(parseEntities("Grow organic traffic")).toEqual({ origin: null, destination: null });
  });
});

describe("structured data", () => {
  const base = {
    url: "/flights/del/yyz",
    absoluteUrl: "http://localhost:3000/site/flights/del/yyz",
    title: "Delhi to Toronto Flights",
    metaDescription: "Compare options.",
    brandName: "FaresMatch",
    brandUrl: "http://localhost:3000",
    lastUpdated: new Date().toISOString(),
    values: { origin: { city: "Delhi", airportName: "IGI" }, destination: { city: "Toronto", airportName: "Pearson" } },
  };

  it("emits FAQPage only when a visible FAQ block rendered", () => {
    const withFaq = generateSchemas({
      ...base,
      blocks: [{ componentKey: "faq", rendered: true } as never],
      faqs: [{ question: "How long?", answer: "About 15h." }],
      breadcrumbs: [],
    });
    expect(withFaq.map((s) => s.type)).toContain("FAQPage");

    const withoutFaq = generateSchemas({ ...base, blocks: [], faqs: [{ question: "q", answer: "a" }], breadcrumbs: [] });
    expect(withoutFaq.map((s) => s.type)).not.toContain("FAQPage");
  });

  it("validates required properties", () => {
    const schemas = generateSchemas({ ...base, blocks: [], faqs: [], breadcrumbs: [] });
    expect(schemas.every((s) => s.valid)).toBe(true);
  });

  it("omits breadcrumbs when there is no real trail", () => {
    const schemas = generateSchemas({ ...base, blocks: [], faqs: [], breadcrumbs: [{ url: "/", label: "Home" }] });
    expect(schemas.map((s) => s.type)).not.toContain("BreadcrumbList");
  });
});

describe("quality gate", () => {
  const render = (overrides: Partial<Parameters<typeof runQualityGate>[0]["render"]> = {}) => ({
    blocks: [
      {
        blockKey: "answer_block#1",
        componentKey: "answer_block",
        componentVersion: 1,
        sequence: 1,
        source: "AI" as never,
        html: "<p>x</p>",
        text: "Flights from Delhi to Toronto take approximately 15h 22m in total when flown non-stop. Carriers include Air Canada and Air India. Fares vary by season and booking window, so compare live results for your dates today.",
        usedPaths: ["route.typicalDurationMinutes"],
        slots: {},
        rendered: true,
        isRequired: true,
        aiChars: 100,
        wordCount: 38,
      },
    ],
    html: "<h1>x</h1>",
    text: `Delhi to Toronto route detail. ${"useful specific sentence about the route. ".repeat(60)}`,
    composition: {
      templateChars: 100,
      dynamicChars: 300,
      aiChars: 400,
      totalChars: 800,
      templateShare: 0.125,
      dynamicShare: 0.375,
      aiShare: 0.5,
      withinPolicy: true,
      policyNotes: [],
    },
    missingRequiredBlocks: [],
    distinctDataPoints: ["route.distanceKm", "route.typicalDurationMinutes", "route.typicalStops", "route.airlines", "origin.city", "destination.city", "origin.airportName", "destination.airportName"],
    wordCount: 500,
    ...overrides,
  });

  const baseInput = {
    render: render(),
    title: "Delhi to Toronto Flights | FaresMatch",
    metaDescription: "Compare Delhi to Toronto flights: airlines, typical routings, airport details and booking tips.",
    brand,
    siblingTexts: [],
    existingTitles: [],
    factVerdicts: [{ claim: "11,640 km", status: "VERIFIED", isTimeSensitive: false, source: "reference" }],
    internalLinkCount: 4,
    schemas: [{ type: "WebPage", valid: true, issues: [] }],
    faqs: [{ question: "How long?", answer: "About 15h." }],
  };

  it("passes a complete, verified page", () => {
    const report = runQualityGate(baseInput);
    expect(report.decision).toBe("PASS");
    expect(report.score).toBeGreaterThanOrEqual(70);
  });

  it("rejects a page with an unsupported claim", () => {
    const report = runQualityGate({
      ...baseInput,
      factVerdicts: [{ claim: "$499 fares", status: "UNSUPPORTED", isTimeSensitive: false }],
    });
    expect(report.decision).toBe("REJECT");
    expect(report.blockingReasons.join(" ")).toMatch(/unsupported/i);
  });

  it("rejects a time-sensitive claim with no live source", () => {
    const report = runQualityGate({
      ...baseInput,
      factVerdicts: [{ claim: "$499", status: "REQUIRES_LIVE_SOURCE", isTimeSensitive: true }],
    });
    expect(report.decision).toBe("REJECT");
  });

  it("rejects a near-duplicate of a sibling page", () => {
    const text = baseInput.render.text;
    const report = runQualityGate({ ...baseInput, siblingTexts: [text] });
    expect(report.decision).toBe("REJECT");
    expect(report.blockingReasons.join(" ")).toMatch(/near-duplicate/i);
  });

  it("rejects a page whose required block did not render", () => {
    const report = runQualityGate({ ...baseInput, render: render({ missingRequiredBlocks: ["route_summary#4"] }) });
    expect(report.decision).toBe("REJECT");
    expect(report.blockingReasons.join(" ")).toMatch(/required blocks/i);
  });

  it("rejects invalid structured data", () => {
    const report = runQualityGate({ ...baseInput, schemas: [{ type: "FAQPage", valid: false, issues: ["missing mainEntity"] }] });
    expect(report.decision).toBe("REJECT");
  });

  it("rejects a duplicate title", () => {
    const report = runQualityGate({ ...baseInput, existingTitles: ["Delhi to Toronto Flights | FaresMatch"] });
    expect(report.decision).toBe("REJECT");
  });
});
