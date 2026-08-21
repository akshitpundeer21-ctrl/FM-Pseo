/**
 * Publishing Agent.
 *
 * The only agent holding the `publish` capability. Before it acts it re-checks,
 * from the database rather than from the caller's word:
 *   1. the quality gate decision is PASS
 *   2. an APPROVED approval record exists (unless the project explicitly
 *      allowlisted unattended publishing for this action)
 *
 * It records which adapter actually ran - including a fallback - so nothing ever
 * appears to have reached a CMS that it did not.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readJson, writeJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { ApprovalRequiredError, QualityGateFailedError } from "@/core/errors";
import { audit } from "@/control-plane/audit";
import { env } from "@/core/config/env";

const InputSchema = z.object({
  pageVersionId: z.string(),
  adapter: z.enum(["local_static", "webhook", "wordpress"]).optional(),
  /** Publishing an update to an already-live page. */
  isUpdate: z.boolean().optional(),
});

const OutputSchema = z.object({
  published: z.boolean(),
  pageId: z.string(),
  pageVersionId: z.string(),
  url: z.string(),
  remoteUrl: z.string(),
  remoteId: z.string(),
  adapterUsed: z.string(),
  requestedAdapter: z.string(),
  fellBack: z.boolean(),
  reason: z.string(),
  publishRecordId: z.string(),
});

export type PublishingInput = z.infer<typeof InputSchema>;
export type PublishingOutput = z.infer<typeof OutputSchema>;

export class PublishingAgent extends BaseAgent<PublishingInput, PublishingOutput> {
  readonly key = "publishing";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;
  protected readonly needsBrand = false;

  readonly validationRules: ValidationRule<PublishingOutput>[] = [
    { name: "published", check: (o) => o.published, message: "Publishing did not complete" },
    { name: "has_remote_url", check: (o) => o.remoteUrl.length > 0, message: "Publisher returned no destination URL" },
  ];

  protected async perform(input: PublishingInput, ctx: AgentRunContext): Promise<AgentOutcome<PublishingOutput>> {
    const version = await prisma.pageVersion.findUnique({
      where: { id: input.pageVersionId },
      include: { page: { include: { website: true } } },
    });
    if (!version) throw new Error(`Page version ${input.pageVersionId} not found`);

    // --- gate 1: quality ---------------------------------------------------
    const quality = readJson<{ decision?: string; score?: number; blockingReasons?: string[] }>(version.qualityJson, {});
    if (quality.decision !== "PASS") {
      throw new QualityGateFailedError(
        `Refusing to publish ${version.page.url}: quality gate decision is ${quality.decision ?? "not run"}.`,
        { blockingReasons: quality.blockingReasons ?? [], score: quality.score },
      );
    }

    // --- gate 2: approval --------------------------------------------------
    const decision = ctx.controlPlane.decideApproval({ action: "publish", confidence: (quality.score ?? 0) / 100 });
    if (decision.requiresApproval) {
      const approval = await prisma.approval.findFirst({
        where: { projectId: ctx.projectId, entityType: "PAGE_VERSION", entityId: version.id },
        orderBy: { createdAt: "desc" },
      });
      if (!approval || approval.status !== "APPROVED") {
        await ctx.controlPlane.logDecision({
          action: "publish",
          agentKey: this.key,
          allowed: false,
          reason: approval ? `Approval ${approval.id} is ${approval.status}` : "No approval record exists",
          entityType: "PAGE_VERSION",
          entityId: version.id,
        });
        throw new ApprovalRequiredError(`publish ${version.page.url}`, approval?.id);
      }
    }

    // --- publish -----------------------------------------------------------
    const requestedAdapter = input.adapter ?? version.page.website?.cms ?? env().PUBLISH_ADAPTER;
    const schemas = await prisma.schemaMarkup.findMany({ where: { pageId: version.pageId, validationStatus: "VALID" } });
    const jsonLd = schemas.map((s) => JSON.parse(s.jsonld));

    const result = await ctx.tool<{
      remoteId: string;
      remoteUrl: string;
      adapterUsed: string;
      requestedAdapter: string;
      fellBack: boolean;
      reason: string;
    }>("cms.publish", {
      adapter: requestedAdapter,
      payload: {
        url: version.page.url,
        title: version.title,
        metaDescription: version.metaDescription,
        html: version.html,
        markdown: version.markdown,
        jsonLd,
      },
    });

    const record = await prisma.publishRecord.create({
      data: {
        pageVersionId: version.id,
        adapter: result.adapterUsed,
        status: "PUBLISHED",
        remoteId: result.remoteId,
        remoteUrl: result.remoteUrl,
        requestJson: writeJson({ requestedAdapter, url: version.page.url, schemaCount: jsonLd.length }),
        responseJson: writeJson({ fellBack: result.fellBack, reason: result.reason }),
        actor: this.key,
      },
    });

    await prisma.pageVersion.update({ where: { id: version.id }, data: { status: "PUBLISHED" } });
    await prisma.page.update({
      where: { id: version.pageId },
      data: { status: "PUBLISHED", publishedAt: new Date(), unpublishedAt: null },
    });
    await prisma.internalLink.updateMany({
      where: { projectId: ctx.projectId, fromPageId: version.pageId, status: "PROPOSED" },
      data: { status: "LIVE" },
    });

    await audit({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      actorType: "AGENT",
      actorId: this.key,
      action: "page.published",
      entityType: "PAGE_VERSION",
      entityId: version.id,
      meta: { url: version.page.url, adapter: result.adapterUsed, remoteUrl: result.remoteUrl, fellBack: result.fellBack },
    });

    if (result.fellBack) {
      ctx.logger.warn("published via fallback adapter", { requestedAdapter, used: result.adapterUsed, reason: result.reason });
    }

    return {
      output: {
        published: true,
        pageId: version.pageId,
        pageVersionId: version.id,
        url: version.page.url,
        remoteUrl: result.remoteUrl,
        remoteId: result.remoteId,
        adapterUsed: result.adapterUsed,
        requestedAdapter: result.requestedAdapter,
        fellBack: result.fellBack,
        reason: result.reason,
        publishRecordId: record.id,
      },
      confidence: result.fellBack ? 0.75 : 0.95,
      summary: `Published ${version.page.url} via ${result.adapterUsed}${result.fellBack ? ` (fallback: ${result.reason})` : ""} → ${result.remoteUrl}`,
      nextAction: "Crawl the published URL and start monitoring search + AI visibility",
    };
  }
}

/**
 * Rollback / unpublish. Kept as a service rather than an agent action so the
 * dashboard can trigger it directly with an audit trail.
 */
export async function rollbackPage(params: {
  projectId: string;
  organizationId: string;
  pageId: string;
  actorId?: string;
  toVersion?: number;
}) {
  const page = await prisma.page.findUnique({
    where: { id: params.pageId },
    include: { versions: { orderBy: { version: "desc" }, include: { publishRecords: true } } },
  });
  if (!page) throw new Error(`Page ${params.pageId} not found`);

  const current = page.versions.find((v) => v.status === "PUBLISHED") ?? page.versions[0];
  const target = params.toVersion
    ? page.versions.find((v) => v.version === params.toVersion)
    : page.versions.find((v) => v.version < (current?.version ?? 0) && v.publishRecords.length > 0);

  if (!target) {
    // Nothing to roll back to: unpublish instead.
    const record = current?.publishRecords[0];
    if (record) {
      const { selectAdapter } = await import("@/modules/publishing/adapters");
      await selectAdapter(record.adapter).adapter.unpublish(record.remoteId ?? "");
      await prisma.publishRecord.update({ where: { id: record.id }, data: { status: "UNPUBLISHED", rolledBackAt: new Date() } });
    }
    await prisma.page.update({ where: { id: page.id }, data: { status: "UNPUBLISHED", unpublishedAt: new Date() } });
    await audit({
      organizationId: params.organizationId,
      projectId: params.projectId,
      actorType: "USER",
      actorId: params.actorId,
      action: "page.unpublished",
      entityType: "PAGE",
      entityId: page.id,
      meta: { url: page.url, reason: "no earlier published version to restore" },
    });
    return { rolledBack: false, unpublished: true, restoredVersion: null as number | null };
  }

  const { selectAdapter } = await import("@/modules/publishing/adapters");
  const adapterKey = target.publishRecords[0]?.adapter ?? "local_static";
  const selection = selectAdapter(adapterKey as "local_static" | "webhook" | "wordpress");
  const schemas = await prisma.schemaMarkup.findMany({ where: { pageId: page.id, validationStatus: "VALID" } });

  const outcome = await selection.adapter.publish({
    url: page.url,
    title: target.title,
    metaDescription: target.metaDescription,
    html: target.html,
    jsonLd: schemas.map((s) => JSON.parse(s.jsonld)),
  });

  await prisma.publishRecord.create({
    data: {
      pageVersionId: target.id,
      adapter: selection.adapter.key,
      status: "PUBLISHED",
      remoteId: outcome.remoteId,
      remoteUrl: outcome.remoteUrl,
      requestJson: writeJson({ rollbackTo: target.version }),
      responseJson: writeJson(outcome.raw),
      actor: params.actorId ?? "rollback",
    },
  });
  if (current) {
    await prisma.pageVersion.update({ where: { id: current.id }, data: { status: "ROLLED_BACK" } });
  }
  await prisma.pageVersion.update({ where: { id: target.id }, data: { status: "PUBLISHED" } });
  await prisma.page.update({ where: { id: page.id }, data: { status: "PUBLISHED", currentVersion: target.version } });

  await audit({
    organizationId: params.organizationId,
    projectId: params.projectId,
    actorType: "USER",
    actorId: params.actorId,
    action: "page.rolled_back",
    entityType: "PAGE",
    entityId: page.id,
    meta: { url: page.url, from: current?.version, to: target.version },
  });

  return { rolledBack: true, unpublished: false, restoredVersion: target.version };
}
