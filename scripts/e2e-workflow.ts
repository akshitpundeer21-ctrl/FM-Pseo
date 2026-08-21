/**
 * End-to-end workflow exercise.
 *
 *   goal -> orchestrator plan -> research -> opportunity -> strategy ->
 *   generation -> verification -> optimization -> linking -> quality ->
 *   APPROVAL GATE -> (approve) -> publish -> post-publish audit ->
 *   search monitoring -> AI visibility
 *
 * Everything runs against the real services, the real database and the real
 * local publishing adapter. Where an external API is not configured the labelled
 * mock adapter is used, and the script says so.
 *
 * Run:  npm run e2e
 */
import "dotenv/config";
import { prisma } from "../src/core/db/client";
import { ControlPlane } from "../src/control-plane/control-plane";
import { createAgent } from "../src/agents/registry";
import { resumeWorkflow, startWorkflow } from "../src/engine/workflow/engine";

const OBJECTIVE = process.argv.slice(2).join(" ") || "Create an SEO growth strategy around Delhi to Toronto flights";

function heading(text: string) {
  console.log(`\n${"=".repeat(76)}\n${text}\n${"=".repeat(76)}`);
}

async function main() {
  const project = await prisma.project.findFirst({ where: { slug: "faresmatch-global" }, include: { websites: true } });
  if (!project) throw new Error("No seeded project found. Run `npm run seed` first.");

  const website = project.websites[0];
  const controlPlane = await ControlPlane.forProject(project.id);

  // ---------------------------------------------------------------- 1. PLAN
  heading("1. MASTER ORCHESTRATOR — interpret the objective and plan");
  console.log(`Objective: "${OBJECTIVE}"\n`);

  const orchestrator = createAgent("master_orchestrator", controlPlane);
  const planResult = await orchestrator.run({ objective: OBJECTIVE });

  if (!planResult.ok) throw new Error(`Orchestrator failed: ${planResult.error}`);
  const plan = planResult.output as any;

  console.log(`Workflow selected : ${plan.workflowName} (${plan.workflowKey})`);
  console.log(`Objective type    : ${plan.objectiveType}`);
  console.log(`Entities resolved : ${plan.entities.originCity} (${plan.entities.origin}) -> ${plan.entities.destinationCity} (${plan.entities.destination})`);
  console.log(`Approval mode     : ${plan.approvalMode}`);
  console.log(`Approval gates    : ${plan.approvalGates.join(", ") || "none"}`);
  console.log(`Confidence        : ${planResult.confidence.toFixed(2)}\n`);
  console.log("Delegated plan:");
  for (const [i, step] of plan.plan.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${step.name.padEnd(42)} -> ${step.agentName}${step.requiresApproval ? "  [APPROVAL REQUIRED]" : ""}${step.optional ? "  (optional)" : ""}`);
  }
  console.log(`\nNarrative: ${plan.narrative}`);

  // ------------------------------------------------------------ 2. EXECUTE
  heading("2. WORKFLOW EXECUTION — orchestrator delegates to specialist agents");

  let run = await startWorkflow({
    workflowKey: plan.workflowKey,
    projectId: project.id,
    goalId: plan.goalId,
    websiteId: website?.id,
    objective: OBJECTIVE,
    entities: {
      origin: plan.entities.origin,
      destination: plan.entities.destination,
      originCity: plan.entities.originCity,
      destinationCity: plan.entities.destinationCity,
    },
    pageFamilyKey: "route",
  });

  await printRun(run.workflowRunId);

  // ------------------------------------------------------------ 3. APPROVAL
  if (run.status === "WAITING_APPROVAL" && run.waitingOn?.approvalId) {
    heading("3. HUMAN APPROVAL GATE — the workflow stopped and is waiting");

    const approval = await prisma.approval.findUnique({ where: { id: run.waitingOn.approvalId } });
    console.log(`Approval required : ${approval?.title}`);
    console.log(`Risk level        : ${approval?.riskLevel}`);
    console.log(`Summary           : ${approval?.summary}`);
    console.log(`Status            : ${approval?.status}`);

    const user = await prisma.user.findFirst({ where: { email: "admin@faresmatch.local" } });
    await prisma.approval.update({
      where: { id: run.waitingOn.approvalId },
      data: { status: "APPROVED", decidedById: user?.id, decidedAt: new Date(), notes: "Approved by the e2e script" },
    });
    console.log("\n-> Approving as the demo operator and resuming…\n");

    run = await resumeWorkflow(run.workflowRunId, user?.id);
    await printRun(run.workflowRunId);
  }

  // ------------------------------------------------------------- 4. RESULTS
  heading("4. RESULT");
  console.log(`Workflow status : ${run.status}`);
  if (run.error) console.log(`Error           : ${run.error}`);

  const outputs = run.context.outputs;
  if (outputs.keyword_research) {
    console.log(`\nKeywords        : ${outputs.keyword_research.keywordCount} in ${outputs.keyword_research.clusterCount} clusters${outputs.keyword_research.isMock ? "  [MOCK DATA]" : ""}`);
  }
  if (outputs.opportunity_scoring) {
    const o = outputs.opportunity_scoring;
    console.log(`Opportunities   : ${o.evaluated} evaluated -> ${o.build} BUILD / ${o.review} REVIEW / ${o.reject} REJECT`);
    console.log(`Selected        : ${o.selectedUrl} (${o.selectedDecision})`);
  }
  if (outputs.content_generation) {
    const c = outputs.content_generation;
    console.log(`Page generated  : ${c.url} — ${c.wordCount} words`);
    console.log(`Composition     : template ${(c.composition.templateShare * 100).toFixed(0)}% / dynamic ${(c.composition.dynamicShare * 100).toFixed(0)}% / generated ${(c.composition.aiShare * 100).toFixed(0)}%  (within policy: ${c.composition.withinPolicy})`);
    console.log(`Live offers     : ${c.liveOffersAvailable ? "available" : "NOT AVAILABLE — no live pricing provider connected, price block omitted"}`);
  }
  if (outputs.fact_verification) {
    console.log(`Fact gate       : ${outputs.fact_verification.gate} (${outputs.fact_verification.checked} claims checked, ${outputs.fact_verification.blocking.length} blocking)`);
  }
  if (outputs.optimization) {
    console.log(`Optimization    : "${outputs.optimization.title}" — schemas: ${outputs.optimization.schemas.join(", ")}`);
    if (outputs.optimization.coverageGaps?.length) console.log(`Coverage gaps   : ${outputs.optimization.coverageGaps.join("; ")}`);
  }
  if (outputs.quality_control) {
    console.log(`Quality gate    : ${outputs.quality_control.decision} — score ${outputs.quality_control.score}/100`);
    if (outputs.quality_control.blockingReasons?.length) {
      console.log(`Blocking        : ${outputs.quality_control.blockingReasons.join("; ")}`);
    }
  }
  if (outputs.publish) {
    console.log(`Published       : ${outputs.publish.remoteUrl} via ${outputs.publish.adapterUsed}${outputs.publish.fellBack ? " (FALLBACK)" : ""}`);
  }
  if (outputs.post_publish_audit) {
    console.log(`Post-publish    : crawled ${outputs.post_publish_audit.crawled}, ${outputs.post_publish_audit.errors} error(s)`);
  }
  if (outputs.search_monitoring) {
    const s = outputs.search_monitoring;
    console.log(`Search perf     : ${s.clicks} clicks / ${s.impressions} impressions via ${s.provider}${s.isMock ? "  [MOCK SERIES]" : ""}`);
  }
  if (outputs.ai_visibility) {
    const a = outputs.ai_visibility;
    console.log(`AI visibility   : ${a.runs} runs — mention ${(a.metrics.mentionRate * 100).toFixed(0)}%, citation ${(a.metrics.citationRate * 100).toFixed(0)}%, score ${a.metrics.visibilityScore}${a.isMock ? "  [MOCK]" : ""}`);
  }

  // Observability summary
  const runs = await prisma.agentRun.findMany({
    where: { projectId: project.id },
    orderBy: { startedAt: "desc" },
    take: 20,
    include: { agent: { select: { name: true } } },
  });
  console.log(`\nAgent runs recorded (most recent ${runs.length}):`);
  for (const r of runs.reverse()) {
    console.log(
      `  ${r.agent.name.padEnd(38)} ${r.status.padEnd(10)} ${String(r.latencyMs).padStart(6)}ms  conf=${r.confidence?.toFixed(2) ?? "n/a"}  $${r.costUsd.toFixed(4)}${r.isMock ? "  [mock]" : ""}`,
    );
    if (r.error) console.log(`      error: ${r.error.slice(0, 140)}`);
  }

  const cost = runs.reduce((s, r) => s + r.costUsd, 0);
  const tokens = runs.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
  console.log(`\nTotals: ${tokens.toLocaleString()} tokens, $${cost.toFixed(4)} estimated cost.`);
}

async function printRun(workflowRunId: string) {
  const steps = await prisma.workflowStepRun.findMany({ where: { workflowRunId }, orderBy: { sequence: "asc" } });
  console.log("");
  for (const s of steps) {
    const icon = s.status === "COMPLETED" ? "OK  " : s.status === "SKIPPED" ? "SKIP" : s.status === "WAITING" ? "WAIT" : s.status === "FAILED" ? "FAIL" : "... ";
    console.log(`  [${icon}] ${s.stepName.padEnd(46)} ${s.durationMs ? `${s.durationMs}ms` : ""}${s.error ? `  ${s.error.slice(0, 120)}` : ""}`);
  }
}

main()
  .catch((e) => {
    console.error("\nE2E failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
