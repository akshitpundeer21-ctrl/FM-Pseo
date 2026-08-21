/**
 * Fact Verification Agent.
 *
 * Extracts checkable claims from a draft and matches each against the project's
 * attributed fact store. A claim with no matching source is UNSUPPORTED; a
 * time-sensitive claim backed only by reference/mock data is
 * REQUIRES_LIVE_SOURCE. Either verdict blocks publication.
 *
 * Extraction is regex-driven rather than model-driven on purpose: verification
 * must be deterministic and reproducible, and a model that hallucinated the
 * check would defeat the entire point of the gate.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readJson, writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";

const InputSchema = z.object({ pageVersionId: z.string() });

const VerdictSchema = z.object({
  claim: z.string(),
  kind: z.string(),
  status: z.enum(["VERIFIED", "UNSUPPORTED", "REQUIRES_LIVE_SOURCE", "STALE"]),
  source: z.string().nullable(),
  confidence: z.number(),
  isTimeSensitive: z.boolean(),
  evidence: z.string().nullable(),
});

const OutputSchema = z.object({
  pageVersionId: z.string(),
  checked: z.number(),
  verified: z.number(),
  unsupported: z.number(),
  requiresLiveSource: z.number(),
  gate: z.enum(["PASS", "FAIL"]),
  blocking: z.array(z.string()),
  verdicts: z.array(VerdictSchema),
});

export type FactVerificationInput = z.infer<typeof InputSchema>;
export type FactVerificationOutput = z.infer<typeof OutputSchema>;

interface ExtractedClaim {
  claim: string;
  kind: string;
  /**
   * Fact predicates that could support this claim. A claim is satisfied when
   * ANY candidate agrees - "3 passenger terminals" may refer to either endpoint.
   */
  predicates: string[];
  /** Numeric value asserted, when the claim is quantitative. */
  value: number | null;
  isTimeSensitive: boolean;
}

/**
 * Components whose text is NOT a claim about this page's primary entity:
 * comparison/related blocks describe sibling entities, and the evidence block
 * quotes methodology (which itself contains numbers). Verifying those against
 * this route's facts would produce false positives.
 */
const NON_CLAIM_COMPONENTS = new Set([
  "comparison_table",
  "related_routes",
  "related_destinations",
  "source_evidence",
  "breadcrumb",
  "author_trust",
  "search_box",
]);

export class FactVerificationAgent extends BaseAgent<FactVerificationInput, FactVerificationOutput> {
  readonly key = "fact_verification";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;
  protected readonly needsBrand = false;

  readonly validationRules: ValidationRule<FactVerificationOutput>[] = [
    {
      name: "all_claims_judged",
      check: (o) => o.verdicts.length === o.checked,
      message: "A claim was extracted but received no verdict",
    },
    {
      name: "fail_lists_blocking",
      check: (o) => o.gate === "PASS" || o.blocking.length > 0,
      message: "Gate failed without naming a blocking claim",
    },
  ];

  protected async perform(input: FactVerificationInput, ctx: AgentRunContext): Promise<AgentOutcome<FactVerificationOutput>> {
    const version = await prisma.pageVersion.findUnique({
      where: { id: input.pageVersionId },
      include: { page: true },
    });
    if (!version) throw new Error(`Page version ${input.pageVersionId} not found`);

    const vars = readJson<{ origin?: string; destination?: string }>(version.page.variablesJson, {});
    const subject = `route:${vars.origin}-${vars.destination}`;

    const stored = await ctx.tool<{
      facts: {
        id: string;
        predicate: string;
        value: string;
        sourceName: string;
        confidence: number;
        verificationStatus: string;
        isTimeSensitive: boolean;
        isMock: boolean;
        retrievedAt: string;
      }[];
    }>("facts.lookup", { subject, limit: 200 });

    // Latest fact wins per predicate.
    const byPredicate = new Map<string, (typeof stored.facts)[number]>();
    for (const f of stored.facts) if (!byPredicate.has(f.predicate)) byPredicate.set(f.predicate, f);

    // Verify only the blocks that make claims about THIS page's entity.
    const items = await prisma.contentItem.findMany({
      where: { pageVersionId: version.id },
      orderBy: { sequence: "asc" },
    });
    const claimBearing = items.filter((i) => !NON_CLAIM_COMPONENTS.has(i.componentKey) && i.text.trim());
    const text = claimBearing.length
      ? claimBearing.map((i) => i.text).join("\n\n")
      : version.markdown || version.html.replace(/<[^>]+>/g, " ");

    ctx.logger.info("verifying claim-bearing content", {
      blocks: claimBearing.length,
      excluded: items.length - claimBearing.length,
    });

    const claims = extractClaims(text);

    const verdicts: z.infer<typeof VerdictSchema>[] = [];

    for (const claim of claims) {
      // Any candidate predicate whose value agrees satisfies the claim.
      const candidates = claim.predicates.map((p) => byPredicate.get(p)).filter(Boolean) as NonNullable<
        ReturnType<typeof byPredicate.get>
      >[];
      const fact =
        candidates.find((f) => (claim.value === null ? true : valuesAgree(claim.value!, Number(f.value), claim.kind))) ??
        candidates[0];

      // 1. Time-sensitive claims need a live, non-mock source. No exceptions.
      if (claim.isTimeSensitive) {
        const liveFact = fact && !fact.isMock ? fact : undefined;
        if (!liveFact) {
          verdicts.push({
            claim: claim.claim,
            kind: claim.kind,
            status: "REQUIRES_LIVE_SOURCE",
            source: fact?.sourceName ?? null,
            confidence: 0,
            isTimeSensitive: true,
            evidence: fact
              ? `Only a reference-dataset value exists (${fact.sourceName}); this claim needs a live provider.`
              : "No source of any kind backs this claim.",
          });
          continue;
        }
        verdicts.push({
          claim: claim.claim,
          kind: claim.kind,
          status: "VERIFIED",
          source: liveFact.sourceName,
          confidence: liveFact.confidence,
          isTimeSensitive: true,
          evidence: `${liveFact.predicate} = ${liveFact.value} (${liveFact.sourceName}, ${liveFact.retrievedAt.slice(0, 10)})`,
        });
        await recordVerification(liveFact.id, "VERIFIED", ctx.agentRunId, liveFact.confidence, claim.claim);
        continue;
      }

      // 2. Structural claims may rest on reference data, but must match it.
      if (!fact) {
        verdicts.push({
          claim: claim.claim,
          kind: claim.kind,
          status: "UNSUPPORTED",
          source: null,
          confidence: 0,
          isTimeSensitive: false,
          evidence: `No fact matching ${claim.predicates.join(" | ") || "?"} exists for ${subject}.`,
        });
        continue;
      }

      const matches = claim.value === null ? true : valuesAgree(claim.value, Number(fact.value), claim.kind);
      if (!matches) {
        verdicts.push({
          claim: claim.claim,
          kind: claim.kind,
          status: "UNSUPPORTED",
          source: fact.sourceName,
          confidence: 0,
          isTimeSensitive: false,
          evidence: `Page states ${claim.value} but the source records ${fact.value}.`,
        });
        await recordVerification(fact.id, "DISPUTED", ctx.agentRunId, 0, claim.claim);
        continue;
      }

      verdicts.push({
        claim: claim.claim,
        kind: claim.kind,
        status: "VERIFIED",
        source: fact.sourceName,
        confidence: fact.confidence,
        isTimeSensitive: false,
        evidence: `${fact.predicate} = ${fact.value} (${fact.sourceName}, ${fact.retrievedAt.slice(0, 10)})`,
      });
      await recordVerification(fact.id, "VERIFIED", ctx.agentRunId, fact.confidence, claim.claim);
    }

    const unsupported = verdicts.filter((v) => v.status === "UNSUPPORTED");
    const requiresLive = verdicts.filter((v) => v.status === "REQUIRES_LIVE_SOURCE");
    const blocking = [...unsupported, ...requiresLive].map((v) => `${v.status}: ${v.claim}`);
    const gate = blocking.length ? "FAIL" : "PASS";

    // Persist verdicts onto the version so the quality gate and the dashboard
    // read the same record.
    await prisma.pageVersion.update({
      where: { id: version.id },
      data: {
        factsJson: writeJson({
          factIds: readJson<string[]>(version.factsJson, []),
          verdicts,
          checkedAt: new Date().toISOString(),
        }),
      },
    });

    ctx.logger.info("fact verification complete", { checked: claims.length, gate, blocking: blocking.length });

    return {
      output: {
        pageVersionId: version.id,
        checked: claims.length,
        verified: verdicts.filter((v) => v.status === "VERIFIED").length,
        unsupported: unsupported.length,
        requiresLiveSource: requiresLive.length,
        gate,
        blocking,
        verdicts,
      },
      confidence: gate === "PASS" ? 0.88 : 0.8,
      summary:
        gate === "PASS"
          ? `All ${claims.length} checkable claims are supported by an attributed source.`
          : `${blocking.length} of ${claims.length} claims are not publishable: ${unsupported.length} unsupported, ${requiresLive.length} need a live source.`,
      nextAction: gate === "PASS" ? "Run SEO/AEO/GEO optimization" : "Remove or re-source the blocking claims before publishing",
    };
  }
}

async function recordVerification(factId: string, verdict: string, agentRunId: string, confidence: number, claim: string) {
  await prisma.verification.create({
    data: {
      factId,
      method: "data_store_match",
      verdict,
      evidenceJson: writeJson({ claim }),
      confidence,
      agentRunId,
    },
  });
  await prisma.fact.update({
    where: { id: factId },
    data: { verificationStatus: verdict === "VERIFIED" ? "VERIFIED" : verdict === "DISPUTED" ? "DISPUTED" : "UNVERIFIED" },
  });
}

/** Numeric agreement, with tolerance appropriate to the claim kind. */
function valuesAgree(claimed: number, source: number, kind: string): boolean {
  if (!Number.isFinite(source)) return false;
  if (kind === "duration") return Math.abs(claimed - source) <= 15; // minutes
  if (kind === "distance") return Math.abs(claimed - source) / Math.max(source, 1) <= 0.02;
  return claimed === source;
}

/**
 * Extract checkable claims. Each pattern maps a surface form back to the fact
 * predicate that must support it.
 */
export function extractClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const seen = new Set<string>();

  const push = (c: ExtractedClaim) => {
    const key = `${c.kind}:${c.value ?? c.claim}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push(c);
  };

  // Distance: "11,640 km". Excludes rates like "850 km/h".
  for (const m of text.matchAll(/([\d,]{3,})\s?km\b(?!\s*\/\s*h|\/h)/gi)) {
    push({
      claim: m[0],
      kind: "distance",
      predicates: ["route.distanceKm"],
      value: Number(m[1].replace(/,/g, "")),
      isTimeSensitive: false,
    });
  }

  // Duration: "15h 22m" / "about 15h"
  for (const m of text.matchAll(/\b(\d{1,2})h(?:\s?(\d{1,2})m)?\b/g)) {
    const minutes = Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
    push({ claim: m[0], kind: "duration", predicates: ["route.typicalDurationMinutes"], value: minutes, isTimeSensitive: false });
  }

  // Stops: "1 stop", "2 stops"
  for (const m of text.matchAll(/\b(\d)\s+stops?\b/gi)) {
    push({ claim: m[0], kind: "stops", predicates: ["route.typicalStops"], value: Number(m[1]), isTimeSensitive: false });
  }

  // Non-stop assertion.
  if (/\bnon-?stop\s+(services?|flights?|options?)\s+(operate|are available|exist)/i.test(text)) {
    push({
      claim: "non-stop service operates on this route",
      kind: "nonstop",
      predicates: ["route.nonstopAvailable"],
      value: null,
      isTimeSensitive: false,
    });
  }

  // Terminals: either endpoint may be the subject.
  for (const m of text.matchAll(/\b(\d{1,2})\s+passenger\s+terminals?\b/gi)) {
    push({
      claim: m[0],
      kind: "terminals",
      predicates: ["origin.terminals", "destination.terminals"],
      value: Number(m[1]),
      isTimeSensitive: false,
    });
  }

  // Prices - always time-sensitive.
  for (const m of text.matchAll(/(?:[$€£₹]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|EUR|GBP|INR|CAD)\b)/gi)) {
    push({ claim: m[0], kind: "price", predicates: ["offers.cheapestPrice"], value: null, isTimeSensitive: true });
  }

  // Baggage allowances - time-sensitive carrier policy.
  for (const m of text.matchAll(/\b(\d{1,3})\s?kg\b/gi)) {
    push({ claim: m[0], kind: "baggage", predicates: ["airline.baggageAllowanceKg"], value: Number(m[1]), isTimeSensitive: true });
  }

  // Departure times - time-sensitive schedule data.
  for (const m of text.matchAll(/\b(?:departs?|arrives?|leaves)\s+at\s+\d{1,2}[:.]\d{2}\b/gi)) {
    push({ claim: m[0], kind: "schedule", predicates: ["schedule.departureTime"], value: null, isTimeSensitive: true });
  }

  return claims;
}
