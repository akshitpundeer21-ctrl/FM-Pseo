/**
 * Quality Control Agent.
 *
 * Runs the full programmatic page quality gate and records the result on the
 * page version. On REVIEW or REJECT it does not publish and does not pretend the
 * page is fine: REVIEW raises an approval request for a human, REJECT marks the
 * page rejected with the blocking reasons attached.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readJson, writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { runQualityGate } from "@/engine/quality/gate";
import type { RenderResult } from "@/engine/templates/renderer";

const InputSchema = z.object({ pageVersionId: z.string() });

const OutputSchema = z.object({
  pageVersionId: z.string(),
  decision: z.enum(["PASS", "REVIEW", "REJECT"]),
  score: z.number(),
  differentiation: z.number(),
  blockingReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  approvalId: z.string().nullable(),
  gates: z.array(
    z.object({ gate: z.string(), passed: z.boolean(), severity: z.string(), score: z.number(), message: z.string() }),
  ),
});

export type QualityControlInput = z.infer<typeof InputSchema>;
export type QualityControlOutput = z.infer<typeof OutputSchema>;

export class QualityControlAgent extends BaseAgent<QualityControlInput, QualityControlOutput> {
  readonly key = "quality_control";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;

  readonly validationRules: ValidationRule<QualityControlOutput>[] = [
    { name: "gates_ran", check: (o) => o.gates.length > 0, message: "No quality gates were evaluated" },
    {
      name: "reject_has_reason",
      check: (o) => o.decision !== "REJECT" || o.blockingReasons.length > 0,
      message: "A REJECT decision must name at least one blocking reason",
    },
  ];

  protected async perform(input: QualityControlInput, ctx: AgentRunContext): Promise<AgentOutcome<QualityControlOutput>> {
    if (!ctx.brand) throw new Error("Brand profile is required for quality control");

    const version = await prisma.pageVersion.findUnique({
      where: { id: input.pageVersionId },
      include: { page: { include: { pageFamily: true } } },
    });
    if (!version) throw new Error(`Page version ${input.pageVersionId} not found`);

    // --- gather the gate inputs ---------------------------------------------
    // blocksJson stores structure + provenance; the text lives in ContentItem
    // (the canonical per-block store). Rehydrate both into the gate's shape.
    const blockMeta = readJson<RenderResult["blocks"]>(version.blocksJson, []);
    const items = await prisma.contentItem.findMany({ where: { pageVersionId: version.id } });
    const textByBlock = new Map(items.map((i) => [i.blockKey, i.text]));

    const blocks: RenderResult["blocks"] = blockMeta.map((b) => ({
      ...b,
      text: b.text ?? textByBlock.get(b.blockKey) ?? "",
      html: b.html ?? "",
      slots: b.slots ?? {},
      aiChars: b.aiChars ?? 0,
      isRequired: b.isRequired ?? false,
      usedPaths: b.usedPaths ?? [],
      wordCount: b.wordCount ?? 0,
    }));
    const composition = readJson<RenderResult["composition"]>(version.compositionJson, {
      templateChars: 0,
      dynamicChars: 0,
      aiChars: 0,
      totalChars: 1,
      templateShare: 0,
      dynamicShare: 0,
      aiShare: 0,
      withinPolicy: true,
      policyNotes: [],
    });
    const aeo = readJson<{ faqs: { question: string; answer: string }[] }>(version.aeoJson, { faqs: [] });
    const facts = readJson<{ verdicts?: { claim: string; status: string; isTimeSensitive: boolean; source?: string }[] }>(
      version.factsJson,
      {},
    );

    const distinctDataPoints = [...new Set(blocks.flatMap((b) => (b.rendered ? b.usedPaths : [])))];

    const siblings = await prisma.page.findMany({
      where: {
        projectId: ctx.projectId,
        pageFamilyId: version.page.pageFamilyId,
        id: { not: version.pageId },
        status: { in: ["PUBLISHED", "APPROVED", "VALIDATED", "GENERATED"] },
      },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      take: 20,
    });
    const siblingTexts = siblings.map((s) => s.versions[0]?.markdown ?? "").filter(Boolean);

    const existingTitles = (
      await prisma.page.findMany({
        where: { projectId: ctx.projectId, id: { not: version.pageId } },
        select: { title: true },
      })
    ).map((p) => p.title);

    const internalLinkCount = await prisma.internalLink.count({ where: { projectId: ctx.projectId, fromPageId: version.pageId } });

    const schemaRows = await prisma.schemaMarkup.findMany({ where: { pageId: version.pageId } });
    const schemas = schemaRows.map((s) => ({
      type: s.type,
      valid: s.validationStatus === "VALID",
      issues: readJson<string[]>(s.issuesJson, []),
    }));

    const familyThresholds = readJson<{ minScore?: number; minDifferentiation?: number; minWordCount?: number }>(
      version.page.pageFamily?.qualityThresholdsJson ?? "{}",
      {},
    );

    // --- run the gate --------------------------------------------------------
    const report = runQualityGate({
      render: {
        blocks,
        html: version.html,
        text: version.markdown,
        composition,
        missingRequiredBlocks: blocks.filter((b) => b.isRequired && !b.rendered).map((b) => b.blockKey),
        distinctDataPoints,
        wordCount: version.wordCount,
      },
      title: version.title,
      metaDescription: version.metaDescription,
      brand: ctx.brand,
      siblingTexts,
      existingTitles,
      factVerdicts: facts.verdicts ?? [],
      internalLinkCount,
      schemas,
      faqs: aeo.faqs ?? [],
      thresholds: familyThresholds,
    });

    // --- persist -------------------------------------------------------------
    await prisma.qualityCheck.deleteMany({ where: { pageVersionId: version.id } });
    for (const gate of report.gates) {
      await prisma.qualityCheck.create({
        data: {
          pageVersionId: version.id,
          gate: gate.gate,
          passed: gate.passed,
          severity: gate.severity,
          score: gate.score,
          message: gate.message,
          detailsJson: writeJson(gate.details ?? {}),
        },
      });
    }

    await prisma.pageVersion.update({
      where: { id: version.id },
      data: {
        status: report.decision === "PASS" ? "VALIDATED" : report.decision === "REVIEW" ? "REVIEW" : "REJECTED",
        qualityJson: writeJson(report),
      },
    });

    const pageStatus = report.decision === "PASS" ? "VALIDATED" : report.decision === "REVIEW" ? "REVIEW" : "REJECTED";
    await prisma.page.update({
      where: { id: version.pageId },
      data: { qualityScore: report.score, qualityStatus: report.decision, status: pageStatus },
    });

    // --- approval routing ----------------------------------------------------
    let approvalId: string | null = null;

    if (report.decision === "REJECT") {
      ctx.logger.error("page rejected by quality gate", { url: version.page.url, reasons: report.blockingReasons });
      await prisma.recommendation.create({
        data: {
          projectId: ctx.projectId,
          type: "CONTENT_QUALITY",
          title: `Quality gate rejected ${version.page.url}`,
          detail: report.blockingReasons.join("\n"),
          priority: 80,
          impact: "HIGH",
          effort: "MEDIUM",
          evidenceJson: writeJson({ pageVersionId: version.id, score: report.score }),
          sourceAgent: this.key,
        },
      });
    } else {
      // PASS still needs approval unless the project's policy says otherwise.
      const decision = ctx.controlPlane.decideApproval({ action: "publish", confidence: report.score / 100 });
      if (decision.requiresApproval || report.decision === "REVIEW") {
        approvalId = await ctx.controlPlane.requestApproval({
          entityType: "PAGE_VERSION",
          entityId: version.id,
          pageId: version.pageId,
          title: `Publish ${version.page.url}`,
          summary:
            report.decision === "REVIEW"
              ? `Quality score ${report.score} is below the auto-pass threshold. Warnings: ${report.warnings.join("; ") || "none"}`
              : `Quality score ${report.score}. ${decision.reason}`,
          risk: "HIGH",
          requestedBy: this.key,
          payload: {
            url: version.page.url,
            title: version.title,
            score: report.score,
            decision: report.decision,
            warnings: report.warnings,
            wordCount: version.wordCount,
          },
        });
      }
    }

    const confidence = report.decision === "PASS" ? 0.9 : report.decision === "REVIEW" ? 0.7 : 0.85;

    return {
      output: {
        pageVersionId: version.id,
        decision: report.decision,
        score: report.score,
        differentiation: Number(report.differentiation.toFixed(3)),
        blockingReasons: report.blockingReasons,
        warnings: report.warnings,
        approvalId,
        gates: report.gates.map((g) => ({ gate: g.gate, passed: g.passed, severity: g.severity, score: Math.round(g.score), message: g.message })),
      },
      confidence,
      summary: `Quality ${report.decision} with score ${report.score}/100 (${report.gates.filter((g) => g.passed).length}/${report.gates.length} gates passed).${report.blockingReasons.length ? ` Blocking: ${report.blockingReasons[0]}` : ""}`,
      nextAction:
        report.decision === "REJECT"
          ? "Do not publish. Fix the blocking issues and regenerate."
          : approvalId
            ? "Awaiting human approval before publishing"
            : "Ready to publish",
    };
  }
}
