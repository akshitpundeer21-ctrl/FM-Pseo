/**
 * Clears everything the agents PRODUCED, keeping the configuration they need.
 *
 * Removed: keywords, clusters, opportunities, pages, versions, content, quality
 * checks, schemas, links, facts, crawl results, analytics, AI runs, tasks,
 * workflow runs, agent runs, approvals, recommendations, logs and published
 * files.
 *
 * Kept: organization, users, project, website, brand profile, agents, skills,
 * components, page families, data sources, competitors, AI prompts,
 * integrations and credentials.
 *
 * Run:  npx tsx scripts/reset-run-data.ts
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/core/db/client";

async function main() {
  console.log("Clearing agent-produced data (configuration is preserved)…\n");

  const steps: [string, () => Promise<{ count: number }>][] = [
    ["ai citations", () => prisma.aICitation.deleteMany()],
    ["ai mentions", () => prisma.aIMention.deleteMany()],
    ["ai runs", () => prisma.aIRun.deleteMany()],
    ["analytics snapshots", () => prisma.analyticsSnapshot.deleteMany()],
    ["publish records", () => prisma.publishRecord.deleteMany()],
    ["quality checks", () => prisma.qualityCheck.deleteMany()],
    ["content items", () => prisma.contentItem.deleteMany()],
    ["page versions", () => prisma.pageVersion.deleteMany()],
    ["schema markup", () => prisma.schemaMarkup.deleteMany()],
    ["internal links", () => prisma.internalLink.deleteMany()],
    ["approvals", () => prisma.approval.deleteMany()],
    ["pages", () => prisma.page.deleteMany()],
    ["template blocks", () => prisma.templateBlock.deleteMany()],
    ["templates", () => prisma.template.deleteMany()],
    ["opportunities", () => prisma.opportunity.deleteMany()],
    ["keywords", () => prisma.keyword.deleteMany()],
    ["keyword clusters", () => prisma.keywordCluster.deleteMany()],
    ["verifications", () => prisma.verification.deleteMany()],
    ["facts", () => prisma.fact.deleteMany()],
    ["crawl results", () => prisma.crawlResult.deleteMany()],
    ["crawl runs", () => prisma.crawlRun.deleteMany()],
    ["tool invocations", () => prisma.toolInvocation.deleteMany()],
    ["agent runs", () => prisma.agentRun.deleteMany()],
    ["workflow step runs", () => prisma.workflowStepRun.deleteMany()],
    ["tasks", () => prisma.task.deleteMany()],
    ["workflow runs", () => prisma.workflowRun.deleteMany()],
    ["goals", () => prisma.goal.deleteMany()],
    ["recommendations", () => prisma.recommendation.deleteMany()],
    ["usage records", () => prisma.usageRecord.deleteMany()],
    ["audit logs", () => prisma.auditLog.deleteMany()],
    ["log entries", () => prisma.logEntry.deleteMany()],
  ];

  for (const [label, run] of steps) {
    const res = await run();
    if (res.count) console.log(`  ${String(res.count).padStart(5)} ${label}`);
  }

  // Published static files produced by the local_static adapter.
  const dir = path.join(process.cwd(), process.env.PUBLISH_LOCAL_DIR ?? "./published");
  try {
    const entries = await fs.readdir(dir);
    let removed = 0;
    for (const entry of entries) {
      if (entry === ".gitkeep") continue;
      await fs.rm(path.join(dir, entry), { recursive: true, force: true });
      removed++;
    }
    if (removed) console.log(`  ${String(removed).padStart(5)} published files`);
  } catch {
    /* directory may not exist yet */
  }

  console.log("\nDone. Configuration and credentials are untouched.");
}

main()
  .catch((e) => {
    console.error("Reset failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
