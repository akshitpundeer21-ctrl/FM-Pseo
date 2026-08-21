/**
 * Brand / Content Knowledge layer.
 *
 * Skills say HOW to do the work. This says WHAT the output must be like. Agents
 * retrieve it once per run and inject it, so the operator never re-states voice,
 * banned terms or SEO rules on a per-task basis.
 *
 * It is also enforced, not merely suggested: `checkBrandCompliance` runs after
 * generation and its findings feed the quality gate.
 */
import { prisma } from "@/core/db/client";
import { readJson, readStringArray } from "@/core/db/json";
import { NotFoundError } from "@/core/errors";

export interface BrandKnowledge {
  brandName: string;
  voice: string;
  tone: string;
  targetAudience: string;
  writingStyle: string;
  readingLevel: string;
  preferredTerms: string[];
  avoidWords: string[];
  avoidClaims: string[];
  ctaStyle: string;
  formatting: {
    maxParagraphSentences?: number;
    useBulletsFor?: string[];
    headingStyle?: string;
    maxSectionWords?: number;
  };
  seoRules: {
    titleMaxChars?: number;
    metaMaxChars?: number;
    onePerH1?: boolean;
    keywordInTitle?: boolean;
    minWordCount?: number;
  };
  aeoRules: { answerWordsMin?: number; answerWordsMax?: number; requireFaq?: boolean; questionHeadings?: boolean };
  geoRules: { requireEvidenceBlock?: boolean; entityDisambiguation?: boolean; requireSourceDates?: boolean };
  qualityStandards: { minQualityScore?: number; minDifferentiation?: number; requireVerifiedFacts?: boolean };
  linkingRules: { minInternalLinks?: number; maxInternalLinks?: number; relevanceFloor?: number };
  publishingRules: { requireApproval?: boolean; requireSchema?: boolean; requireCanonical?: boolean };
  editorialRules: string[];
  version: number;
}

export const DEFAULT_BRAND: Omit<BrandKnowledge, "brandName" | "version"> = {
  voice: "Knowledgeable, direct and helpful - a well-travelled friend who books a lot of flights.",
  tone: "Practical and calm. Confident without hype.",
  targetAudience:
    "Value-conscious international travellers, students and people visiting family, comparing long-haul options across several dates.",
  writingStyle: "Short paragraphs, concrete specifics, active voice, no marketing filler.",
  readingLevel: "Grade 8-9",
  preferredTerms: ["non-stop", "one-stop", "checked bag", "cabin baggage", "fare conditions", "operating carrier"],
  avoidWords: ["cheapest ever", "unbeatable", "guaranteed", "always", "never fails", "insane deal", "hack", "secret"],
  avoidClaims: [
    "Specific fares or prices without a live pricing source",
    "Flight schedules or departure times without a live schedule source",
    "Baggage allowances, fees or fare rules without the operating carrier as source",
    "Visa or entry requirements as route-level facts",
    "Any claim that we are the cheapest or best",
  ],
  ctaStyle: "Low-pressure and specific: invite the reader to compare live results for their dates.",
  formatting: {
    maxParagraphSentences: 4,
    useBulletsFor: ["travel tips", "what to check before booking", "comparison points"],
    headingStyle: "Sentence case, question form for FAQ headings",
    maxSectionWords: 220,
  },
  seoRules: { titleMaxChars: 60, metaMaxChars: 158, onePerH1: true, keywordInTitle: true, minWordCount: 450 },
  aeoRules: { answerWordsMin: 35, answerWordsMax: 70, requireFaq: true, questionHeadings: true },
  geoRules: { requireEvidenceBlock: true, entityDisambiguation: true, requireSourceDates: true },
  qualityStandards: { minQualityScore: 70, minDifferentiation: 0.3, requireVerifiedFacts: true },
  linkingRules: { minInternalLinks: 3, maxInternalLinks: 12, relevanceFloor: 0.35 },
  publishingRules: { requireApproval: true, requireSchema: true, requireCanonical: true },
  editorialRules: [
    "If a datum did not resolve, drop the sentence rather than hedging around it.",
    "Every page must be useful to someone who never scrolls past the first screen.",
    "Never imply we control what search or answer engines do.",
    "Prefer one strong specific over three vague generalities.",
  ],
};

export async function loadBrand(projectId: string): Promise<BrandKnowledge> {
  const row = await prisma.brandProfile.findUnique({ where: { projectId } });
  if (!row) throw new NotFoundError("Brand profile for project", projectId);

  return {
    brandName: row.brandName,
    voice: row.voice,
    tone: row.tone,
    targetAudience: row.targetAudience,
    writingStyle: row.writingStyle,
    readingLevel: row.readingLevel,
    preferredTerms: readStringArray(row.preferredTermsJson),
    avoidWords: readStringArray(row.avoidWordsJson),
    avoidClaims: readStringArray(row.avoidClaimsJson),
    ctaStyle: row.ctaStyle,
    formatting: readJson(row.formattingJson, DEFAULT_BRAND.formatting),
    seoRules: readJson(row.seoRulesJson, DEFAULT_BRAND.seoRules),
    aeoRules: readJson(row.aeoRulesJson, DEFAULT_BRAND.aeoRules),
    geoRules: readJson(row.geoRulesJson, DEFAULT_BRAND.geoRules),
    qualityStandards: readJson(row.qualityStandardsJson, DEFAULT_BRAND.qualityStandards),
    linkingRules: readJson(row.linkingRulesJson, DEFAULT_BRAND.linkingRules),
    publishingRules: readJson(row.publishingRulesJson, DEFAULT_BRAND.publishingRules),
    editorialRules: readStringArray(row.editorialRulesJson),
    version: row.version,
  };
}

/** Render the brand knowledge as a system-prompt section. */
export function renderBrand(brand: BrandKnowledge): string {
  return [
    `## Brand & content standards (v${brand.version})`,
    `Brand: ${brand.brandName}`,
    `Voice: ${brand.voice}`,
    `Tone: ${brand.tone}`,
    `Audience: ${brand.targetAudience}`,
    `Style: ${brand.writingStyle}`,
    `Reading level: ${brand.readingLevel}`,
    brand.preferredTerms.length ? `Preferred terminology: ${brand.preferredTerms.join(", ")}` : "",
    brand.avoidWords.length ? `Never use these words/phrases: ${brand.avoidWords.join(", ")}` : "",
    brand.avoidClaims.length ? `Never make these claims:\n${brand.avoidClaims.map((c) => `  - ${c}`).join("\n")}` : "",
    `CTA style: ${brand.ctaStyle}`,
    `Formatting: max ${brand.formatting.maxParagraphSentences ?? 4} sentences per paragraph; ${brand.formatting.headingStyle ?? "sentence case headings"}; sections under ${brand.formatting.maxSectionWords ?? 220} words.`,
    brand.editorialRules.length ? `Editorial rules:\n${brand.editorialRules.map((r) => `  - ${r}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface BrandFinding {
  rule: string;
  severity: "ERROR" | "WARNING";
  message: string;
  evidence?: string;
}

/**
 * Post-generation compliance check. Deterministic and cheap, so it runs on every
 * generated block rather than only on request.
 */
export function checkBrandCompliance(text: string, brand: BrandKnowledge): BrandFinding[] {
  const findings: BrandFinding[] = [];
  const lower = text.toLowerCase();

  for (const word of brand.avoidWords) {
    const w = word.toLowerCase();
    if (!w) continue;
    const re = new RegExp(`(?<![\\w])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i");
    const m = text.match(re);
    if (m) {
      findings.push({
        rule: "avoid_words",
        severity: "ERROR",
        message: `Uses banned phrase "${word}"`,
        evidence: context(text, m.index ?? 0),
      });
    }
  }

  // Unsupported superlatives are the most common brand-safety failure.
  const superlatives = /\b(cheapest|best price|lowest fare|guaranteed|always the|never pay)\b/i;
  const sup = text.match(superlatives);
  if (sup) {
    findings.push({
      rule: "avoid_claims",
      severity: "ERROR",
      message: `Unsupportable superlative claim: "${sup[0]}"`,
      evidence: context(text, sup.index ?? 0),
    });
  }

  // Currency amounts must never appear unless a live pricing source produced them.
  const price = text.match(/(?:[$€£₹]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|EUR|GBP|INR|CAD)\b)/i);
  if (price) {
    findings.push({
      rule: "avoid_claims",
      severity: "ERROR",
      message: `Contains a price-like value ("${price[0]}"). Prices may only come from a live pricing source.`,
      evidence: context(text, price.index ?? 0),
    });
  }

  const paragraphs = text.split(/\n{2,}/);
  const maxSentences = brand.formatting.maxParagraphSentences ?? 4;
  for (const p of paragraphs) {
    const sentences = p.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 3);
    if (sentences.length > maxSentences + 1) {
      findings.push({
        rule: "formatting",
        severity: "WARNING",
        message: `Paragraph has ${sentences.length} sentences (limit ${maxSentences})`,
      });
    }
  }

  return findings;
}

function context(text: string, index: number): string {
  return text.slice(Math.max(0, index - 60), index + 90).replace(/\s+/g, " ").trim();
}
