/**
 * Programmatic page quality gate.
 *
 * Runs every check the spec requires before a programmatic page may publish.
 * A gate result is not advisory: a FAIL at ERROR severity blocks publication
 * outright, and a page that only reaches REVIEW cannot be auto-published in any
 * approval mode.
 */
import { clamp, tokenSimilarity, wordCount } from "@/core/utils/text";
import { checkBrandCompliance, type BrandKnowledge } from "@/modules/brand/brand";
import type { RenderResult } from "@/engine/templates/renderer";

export interface GateResult {
  gate: string;
  passed: boolean;
  severity: "ERROR" | "WARNING" | "INFO";
  score: number; // 0..100 contribution for this gate
  message: string;
  details?: Record<string, unknown>;
}

export interface QualityInput {
  render: RenderResult;
  title: string;
  metaDescription: string;
  brand: BrandKnowledge;
  /** Body text of sibling pages in the same family, for differentiation. */
  siblingTexts: string[];
  /** Titles already used in the project, for duplicate-title detection. */
  existingTitles: string[];
  /** Claim-level verification verdicts from the Fact Verification Agent. */
  factVerdicts: { claim: string; status: string; isTimeSensitive: boolean; source?: string }[];
  /** Internal links proposed for this page. */
  internalLinkCount: number;
  /** JSON-LD blocks with their validity. */
  schemas: { type: string; valid: boolean; issues: string[] }[];
  /** Question/answer pairs on the page. */
  faqs: { question: string; answer: string }[];
  /** Family thresholds; falls back to brand quality standards. */
  thresholds?: { minScore?: number; minDifferentiation?: number; minWordCount?: number };
}

export interface QualityReport {
  gates: GateResult[];
  score: number;
  decision: "PASS" | "REVIEW" | "REJECT";
  blockingReasons: string[];
  warnings: string[];
  differentiation: number;
}

const WEIGHTS: Record<string, number> = {
  required_blocks: 14,
  data_availability: 12,
  composition_policy: 8,
  differentiation: 14,
  content_depth: 8,
  brand_compliance: 10,
  fact_support: 16,
  aeo_answer: 6,
  internal_links: 5,
  structured_data: 4,
  metadata: 3,
};

export function runQualityGate(input: QualityInput): QualityReport {
  const gates: GateResult[] = [];
  const brandStd = input.brand.qualityStandards ?? {};
  const minScore = input.thresholds?.minScore ?? brandStd.minQualityScore ?? 70;
  const minDifferentiation = input.thresholds?.minDifferentiation ?? brandStd.minDifferentiation ?? 0.3;
  const minWords = input.thresholds?.minWordCount ?? input.brand.seoRules?.minWordCount ?? 450;

  // 1. Required blocks rendered ---------------------------------------------
  const missing = input.render.missingRequiredBlocks;
  gates.push({
    gate: "required_blocks",
    passed: missing.length === 0,
    severity: "ERROR",
    score: missing.length === 0 ? 100 : 0,
    message: missing.length ? `Required blocks did not render: ${missing.join(", ")}` : "All required blocks rendered",
    details: {
      missing,
      skipped: input.render.blocks.filter((b) => !b.rendered).map((b) => ({ block: b.blockKey, reason: b.skippedReason })),
    },
  });

  // 2. Data availability ----------------------------------------------------
  const distinct = input.render.distinctDataPoints.length;
  const dataScore = clamp(distinct / 12, 0, 1) * 100;
  gates.push({
    gate: "data_availability",
    passed: distinct >= 6,
    severity: distinct >= 6 ? "INFO" : "ERROR",
    score: dataScore,
    message:
      distinct >= 6
        ? `${distinct} distinct data points resolved`
        : `Only ${distinct} distinct data points resolved - not enough to justify a page`,
    details: { distinctDataPoints: input.render.distinctDataPoints },
  });

  // 3. Composition policy ---------------------------------------------------
  const comp = input.render.composition;
  gates.push({
    gate: "composition_policy",
    passed: comp.withinPolicy,
    severity: comp.withinPolicy ? "INFO" : "WARNING",
    score: comp.withinPolicy ? 100 : 45,
    message: comp.withinPolicy
      ? `Composition within policy (template ${(comp.templateShare * 100).toFixed(0)}% / dynamic ${(comp.dynamicShare * 100).toFixed(0)}% / generated ${(comp.aiShare * 100).toFixed(0)}%)`
      : comp.policyNotes.join(" "),
    details: comp as unknown as Record<string, unknown>,
  });

  // 4. Differentiation vs siblings -----------------------------------------
  const body = input.render.text;
  const maxSimilarity = input.siblingTexts.length
    ? Math.max(...input.siblingTexts.map((t) => tokenSimilarity(t, body)))
    : 0;
  const differentiation = 1 - maxSimilarity;
  const diffPass = differentiation >= minDifferentiation;
  gates.push({
    gate: "differentiation",
    passed: diffPass,
    severity: diffPass ? "INFO" : "ERROR",
    score: clamp(differentiation / Math.max(minDifferentiation, 0.01), 0, 1) * 100,
    message: diffPass
      ? `Differentiation ${(differentiation * 100).toFixed(0)}% against ${input.siblingTexts.length} sibling page(s)`
      : `Only ${(differentiation * 100).toFixed(0)}% different from an existing sibling page (floor ${(minDifferentiation * 100).toFixed(0)}%) - this is a near-duplicate`,
    details: { maxSimilarity, siblingsCompared: input.siblingTexts.length },
  });

  // 5. Content depth --------------------------------------------------------
  const words = wordCount(body);
  gates.push({
    gate: "content_depth",
    passed: words >= minWords,
    severity: words >= minWords ? "INFO" : "WARNING",
    score: clamp(words / minWords, 0, 1) * 100,
    message: words >= minWords ? `${words} words` : `${words} words is below the ${minWords}-word floor for this family`,
    details: { words, minWords },
  });

  // 6. Brand compliance -----------------------------------------------------
  const brandFindings = checkBrandCompliance(body, input.brand);
  const brandErrors = brandFindings.filter((f) => f.severity === "ERROR");
  gates.push({
    gate: "brand_compliance",
    passed: brandErrors.length === 0,
    severity: brandErrors.length ? "ERROR" : "INFO",
    score: brandErrors.length ? 0 : brandFindings.length ? 75 : 100,
    message: brandErrors.length
      ? `${brandErrors.length} brand rule violation(s): ${brandErrors.map((f) => f.message).join("; ")}`
      : brandFindings.length
        ? `${brandFindings.length} formatting warning(s)`
        : "No brand rule violations",
    details: { findings: brandFindings },
  });

  // 7. Fact support ---------------------------------------------------------
  const unsupported = input.factVerdicts.filter((v) => v.status === "UNSUPPORTED");
  const needsLive = input.factVerdicts.filter((v) => v.status === "REQUIRES_LIVE_SOURCE");
  const factPass = unsupported.length === 0 && needsLive.length === 0;
  gates.push({
    gate: "fact_support",
    passed: factPass,
    severity: factPass ? "INFO" : "ERROR",
    score: factPass ? 100 : 0,
    message: factPass
      ? `All ${input.factVerdicts.length} checked claims are supported`
      : `${unsupported.length} unsupported claim(s)${needsLive.length ? ` and ${needsLive.length} time-sensitive claim(s) without a live source` : ""}`,
    details: { unsupported, needsLive },
  });

  // 8. AEO answer block -----------------------------------------------------
  const answerBlock = input.render.blocks.find((b) => b.componentKey === "answer_block" && b.rendered);
  const answerWords = answerBlock ? wordCount(answerBlock.text) : 0;
  const min = input.brand.aeoRules?.answerWordsMin ?? 35;
  const max = input.brand.aeoRules?.answerWordsMax ?? 70;
  const answerOk = Boolean(answerBlock) && answerWords >= min - 10 && answerWords <= max + 25;
  gates.push({
    gate: "aeo_answer",
    passed: answerOk,
    severity: answerOk ? "INFO" : "WARNING",
    score: answerOk ? 100 : answerBlock ? 55 : 0,
    message: !answerBlock
      ? "No direct answer block was rendered - answer engines have nothing to extract"
      : answerOk
        ? `Direct answer is ${answerWords} words`
        : `Direct answer is ${answerWords} words, outside the ${min}-${max} target band`,
    details: { answerWords, min, max, faqCount: input.faqs.length },
  });

  // 9. Internal links -------------------------------------------------------
  const minLinks = input.brand.linkingRules?.minInternalLinks ?? 3;
  gates.push({
    gate: "internal_links",
    passed: input.internalLinkCount >= minLinks,
    severity: input.internalLinkCount >= minLinks ? "INFO" : "WARNING",
    score: clamp(input.internalLinkCount / minLinks, 0, 1) * 100,
    message:
      input.internalLinkCount >= minLinks
        ? `${input.internalLinkCount} internal links proposed`
        : `${input.internalLinkCount} internal links is below the minimum of ${minLinks}`,
    details: { internalLinkCount: input.internalLinkCount, minLinks },
  });

  // 10. Structured data -----------------------------------------------------
  const invalidSchemas = input.schemas.filter((s) => !s.valid);
  const schemaRequired = input.brand.publishingRules?.requireSchema ?? true;
  const schemaPass = invalidSchemas.length === 0 && (!schemaRequired || input.schemas.length > 0);
  gates.push({
    gate: "structured_data",
    passed: schemaPass,
    severity: invalidSchemas.length ? "ERROR" : schemaPass ? "INFO" : "WARNING",
    score: schemaPass ? 100 : invalidSchemas.length ? 0 : 50,
    message: invalidSchemas.length
      ? `Invalid JSON-LD: ${invalidSchemas.map((s) => `${s.type} (${s.issues.join(", ")})`).join("; ")}`
      : input.schemas.length
        ? `${input.schemas.length} valid schema block(s): ${input.schemas.map((s) => s.type).join(", ")}`
        : "No structured data emitted",
    details: { schemas: input.schemas },
  });

  // 11. Metadata ------------------------------------------------------------
  const titleMax = input.brand.seoRules?.titleMaxChars ?? 60;
  const metaMax = input.brand.seoRules?.metaMaxChars ?? 158;
  const titleDuplicate = input.existingTitles.some((t) => t.trim().toLowerCase() === input.title.trim().toLowerCase());
  const metaIssues: string[] = [];
  if (!input.title.trim()) metaIssues.push("missing title");
  if (input.title.length > titleMax) metaIssues.push(`title is ${input.title.length} chars (max ${titleMax})`);
  if (!input.metaDescription.trim()) metaIssues.push("missing meta description");
  if (input.metaDescription.length > metaMax) metaIssues.push(`meta description is ${input.metaDescription.length} chars (max ${metaMax})`);
  if (titleDuplicate) metaIssues.push("title duplicates an existing page");

  gates.push({
    gate: "metadata",
    passed: metaIssues.length === 0,
    severity: titleDuplicate || !input.title.trim() ? "ERROR" : metaIssues.length ? "WARNING" : "INFO",
    score: metaIssues.length ? Math.max(0, 100 - metaIssues.length * 30) : 100,
    message: metaIssues.length ? metaIssues.join("; ") : "Title and meta description are within limits and unique",
    details: { titleLength: input.title.length, metaLength: input.metaDescription.length, titleDuplicate },
  });

  // --- aggregate -----------------------------------------------------------
  const totalWeight = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  const score =
    Math.round(
      (gates.reduce((sum, g) => sum + g.score * (WEIGHTS[g.gate] ?? 0), 0) / totalWeight) * 10,
    ) / 10;

  const blockingReasons = gates.filter((g) => !g.passed && g.severity === "ERROR").map((g) => `${g.gate}: ${g.message}`);
  const warnings = gates.filter((g) => !g.passed && g.severity === "WARNING").map((g) => `${g.gate}: ${g.message}`);

  const decision: QualityReport["decision"] = blockingReasons.length
    ? "REJECT"
    : score >= minScore
      ? "PASS"
      : "REVIEW";

  return { gates, score, decision, blockingReasons, warnings, differentiation };
}
