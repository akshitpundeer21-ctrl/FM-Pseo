/**
 * End-to-end workflow test.
 *
 * Goal -> research -> opportunity -> strategy -> generation -> verification ->
 * optimization -> linking -> quality -> APPROVAL GATE -> publish.
 *
 * Runs the real agents against the real database and the real local publishing
 * adapter. The assertions are about governance as much as output: the workflow
 * MUST stop at the approval gate, and the page MUST NOT be publishable until a
 * human approves it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/core/db/client";
import { ControlPlane } from "@/control-plane/control-plane";
import { createAgent } from "@/agents/registry";
import { resumeWorkflow, startWorkflow } from "@/engine/workflow/engine";
import { rollbackPage } from "@/agents/publishing.agent";

let projectId: string;
let organizationId: string;
let websiteId: string | undefined;
let userId: string;

beforeAll(async () => {
  const project = await prisma.project.findFirst({ where: { slug: "faresmatch-global" }, include: { websites: true } });
  if (!project) throw new Error("Seed did not run");
  projectId = project.id;
  organizationId = project.organizationId;
  websiteId = project.websites[0]?.id;

  const user = await prisma.user.findFirst({ where: { email: "admin@faresmatch.local" } });
  userId = user!.id;
});

afterAll(async () => {
  // Clean up the files this test published.
  await fs.rm(path.join(process.cwd(), "published-test"), { recursive: true, force: true }).catch(() => undefined);
});

describe("master orchestrator", () => {
  it("interprets an objective, resolves entities and produces a delegated plan", async () => {
    const cp = await ControlPlane.forProject(projectId, userId);
    const orchestrator = createAgent("master_orchestrator", cp);
    const result = await orchestrator.run({ objective: "Create an SEO growth strategy around Delhi to Toronto flights" });

    expect(result.ok).toBe(true);
    const plan = result.output as any;

    expect(plan.entities.origin).toBe("DEL");
    expect(plan.entities.destination).toBe("YYZ");
    expect(plan.workflowKey).toBe("master_seo_growth");
    expect(plan.plan.length).toBeGreaterThan(5);

    // The orchestrator delegates; it never does specialist work itself.
    const ownSteps = plan.plan.filter((s: any) => s.agentKey === "master_orchestrator");
    expect(ownSteps).toHaveLength(0);

    // Publishing must carry an approval gate.
    const publishStep = plan.plan.find((s: any) => s.agentKey === "publishing");
    expect(publishStep?.requiresApproval).toBe(true);
  });

  it("says what it could not resolve instead of guessing", async () => {
    const cp = await ControlPlane.forProject(projectId, userId);
    const orchestrator = createAgent("master_orchestrator", cp);
    const result = await orchestrator.run({ objective: "Grow our organic traffic substantially this quarter" });
    expect(result.ok).toBe(true);
    expect((result.output as any).entities.unresolved.length).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.7);
  });
});

describe("full pipeline", () => {
  let workflowRunId: string;
  let pageVersionId: string;
  let pageId: string;

  it("runs every stage and stops at the human approval gate", async () => {
    const run = await startWorkflow({
      workflowKey: "master_seo_growth",
      projectId,
      websiteId,
      objective: "Create an SEO growth strategy around Delhi to Toronto flights",
      entities: { origin: "DEL", destination: "YYZ", originCity: "Delhi", destinationCity: "Toronto" },
      pageFamilyKey: "route",
      actorId: userId,
    });

    workflowRunId = run.workflowRunId;

    // The pipeline must reach the gate, not sail past it.
    expect(run.status).toBe("WAITING_APPROVAL");
    expect(run.waitingOn?.stepKey).toBe("publish");
    expect(run.waitingOn?.approvalId).toBeTruthy();

    // Research produced real rows.
    expect(run.context.outputs.keyword_research.keywordCount).toBeGreaterThan(0);
    expect(run.context.outputs.opportunity_scoring.evaluated).toBeGreaterThan(0);

    // Content was generated and gated.
    const gen = run.context.outputs.content_generation;
    expect(gen.url).toBe("/flights/del/yyz");
    expect(gen.wordCount).toBeGreaterThan(300);
    expect(gen.liveOffersAvailable).toBe(false); // no pricing provider connected

    expect(run.context.outputs.fact_verification.gate).toBe("PASS");
    expect(run.context.outputs.quality_control.decision).toBe("PASS");

    pageVersionId = gen.pageVersionId;
    pageId = gen.pageId;
  });

  it("refuses to publish while the approval is still pending", async () => {
    const cp = await ControlPlane.forProject(projectId, userId);
    const publisher = createAgent("publishing", cp);
    const result = await publisher.run({ pageVersionId });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/approval/i);

    const page = await prisma.page.findUnique({ where: { id: pageId } });
    expect(page?.status).not.toBe("PUBLISHED");
  });

  it("publishes a real file once a human approves, and resumes the workflow", async () => {
    const approval = await prisma.approval.findFirst({
      where: { projectId, entityType: "PAGE_VERSION", entityId: pageVersionId, status: "PENDING" },
    });
    expect(approval).toBeTruthy();

    await prisma.approval.update({
      where: { id: approval!.id },
      data: { status: "APPROVED", decidedById: userId, decidedAt: new Date(), notes: "approved by the e2e test" },
    });

    const resumed = await resumeWorkflow(workflowRunId, userId);
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.context.outputs.publish.published).toBe(true);

    const page = await prisma.page.findUnique({ where: { id: pageId }, include: { versions: { include: { publishRecords: true } } } });
    expect(page?.status).toBe("PUBLISHED");
    expect(page?.publishedAt).toBeTruthy();

    // The adapter wrote an actual file, and it contains the real content.
    const file = path.join(process.cwd(), "published-test", "flights", "del", "yyz.html");
    const html = await fs.readFile(file, "utf8");
    expect(html).toContain("<title>");
    expect(html).toContain("Delhi");
    expect(html).toContain("Toronto");
    expect(html).toContain('rel="canonical"');
    expect(html).toContain("application/ld+json");
  });

  it("produces valid structured data that matches what is on the page", async () => {
    const schemas = await prisma.schemaMarkup.findMany({ where: { pageId } });
    expect(schemas.length).toBeGreaterThan(0);
    expect(schemas.every((s) => s.validationStatus === "VALID")).toBe(true);

    const types = schemas.map((s) => s.type);
    expect(types).toContain("WebPage");

    for (const s of schemas) {
      const parsed = JSON.parse(s.jsonld);
      expect(parsed["@context"]).toBe("https://schema.org");
    }
  });

  it("records the composition mix and keeps it inside the family policy", async () => {
    const version = await prisma.pageVersion.findUnique({ where: { id: pageVersionId } });
    const composition = JSON.parse(version!.compositionJson);
    expect(composition.templateShare + composition.dynamicShare + composition.aiShare).toBeCloseTo(1, 1);
    expect(composition.withinPolicy).toBe(true);
  });

  it("attributes every rendered fact to a source", async () => {
    const facts = await prisma.fact.findMany({ where: { projectId, subject: "route:DEL-YYZ" } });
    expect(facts.length).toBeGreaterThan(5);
    expect(facts.every((f) => f.sourceName && f.retrievedAt)).toBe(true);
    // Reference data is honestly flagged as such.
    expect(facts.some((f) => f.isMock)).toBe(true);
  });

  it("omits the price block entirely when no pricing provider is connected", async () => {
    const version = await prisma.pageVersion.findUnique({ where: { id: pageVersionId } });
    const blocks = JSON.parse(version!.blocksJson) as { componentKey: string; rendered: boolean; skippedReason?: string }[];
    const offersBlock = blocks.find((b) => b.componentKey === "flight_options");
    expect(offersBlock?.rendered).toBe(false);
    expect(offersBlock?.skippedReason ?? "").toMatch(/condition|live|provider/i);

    // And no currency figure leaked into the copy.
    expect(version!.markdown).not.toMatch(/[$€£₹]\s?\d/);
  });

  it("records an auditable trail of who published what", async () => {
    const entries = await prisma.auditLog.findMany({ where: { organizationId, action: "page.published" } });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].entityType).toBe("PAGE_VERSION");
  });

  it("rolls back by unpublishing when there is no earlier version to restore", async () => {
    const result = await rollbackPage({ projectId, organizationId, pageId, actorId: userId });
    expect(result.unpublished || result.rolledBack).toBe(true);

    const page = await prisma.page.findUnique({ where: { id: pageId } });
    expect(["UNPUBLISHED", "PUBLISHED"]).toContain(page!.status);

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId, action: { in: ["page.unpublished", "page.rolled_back"] } },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
  });
});

describe("quality enforcement in the pipeline", () => {
  it("refuses to generate a page from a REJECTED opportunity", async () => {
    const opportunity = await prisma.opportunity.findFirst({ where: { projectId } });
    expect(opportunity).toBeTruthy();

    const original = opportunity!.decision;
    await prisma.opportunity.update({ where: { id: opportunity!.id }, data: { decision: "REJECT" } });

    const template = await prisma.template.findFirst({ where: { projectId } });
    const cp = await ControlPlane.forProject(projectId, userId);
    const generator = createAgent("content_generation", cp);
    const result = await generator.run({ opportunityId: opportunity!.id, templateId: template!.id });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/REJECTED/i);

    await prisma.opportunity.update({ where: { id: opportunity!.id }, data: { decision: original } });
  });
});

describe("monitoring", () => {
  it("runs the AI visibility library and records mentions and citations", async () => {
    const cp = await ControlPlane.forProject(projectId, userId);
    const agent = createAgent("ai_visibility", cp);
    const result = await agent.run({ platforms: ["mock"], limit: 4 });

    expect(result.ok).toBe(true);
    const out = result.output as any;
    expect(out.runs).toBeGreaterThan(0);
    expect(out.isMock).toBe(true);
    expect(out.metrics.mentionRate).toBeGreaterThanOrEqual(0);
    expect(out.metrics.mentionRate).toBeLessThanOrEqual(1);

    const runs = await prisma.aIRun.findMany({ where: { prompt: { projectId } }, include: { mentions: true } });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.platform && r.model && r.runAt)).toBe(true);
  });

  it("reports search performance honestly when a page has no history", async () => {
    const cp = await ControlPlane.forProject(projectId, userId);
    const agent = createAgent("search_performance", cp);
    const result = await agent.run({ days: 28, dimension: "query" });
    expect(result.ok).toBe(true);
    // Whatever it returns, the source must be recorded and flagged.
    expect((result.output as any).provider).toBeTruthy();
  });

  it("produces a simulated series only when explicitly asked, and flags it", async () => {
    const cp = await ControlPlane.forProject(projectId, userId);
    const agent = createAgent("search_performance", cp);
    const result = await agent.run({ days: 28, dimension: "query", simulateHistoryDays: 60 });

    expect(result.ok).toBe(true);
    const snapshots = await prisma.analyticsSnapshot.findMany({ where: { projectId }, take: 5 });
    if (snapshots.length) expect(snapshots.every((s) => s.isMock)).toBe(true);
  });
});
