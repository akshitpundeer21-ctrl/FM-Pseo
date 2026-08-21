/**
 * Shared server-side data access for console pages.
 * Every query is scoped to the caller's organization via `requireProject`.
 */
import { redirect } from "next/navigation";
import { prisma } from "@/core/db/client";
import { currentAuth, type AuthContext } from "@/core/security/auth";

export async function requireProject(): Promise<{ auth: AuthContext; project: NonNullable<Awaited<ReturnType<typeof prisma.project.findFirst>>> }> {
  const auth = await currentAuth();
  if (!auth) redirect("/login");

  const project = await prisma.project.findFirst({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: "asc" },
  });
  if (!project) redirect("/projects");

  return { auth, project };
}

export async function overviewCounts(projectId: string) {
  const [
    keywords,
    clusters,
    opportunities,
    buildOpportunities,
    pages,
    publishedPages,
    reviewPages,
    pendingApprovals,
    runningTasks,
    failedTasks,
    agentRuns,
    errors,
    recommendations,
    aiRuns,
  ] = await Promise.all([
    prisma.keyword.count({ where: { projectId } }),
    prisma.keywordCluster.count({ where: { projectId } }),
    prisma.opportunity.count({ where: { projectId } }),
    prisma.opportunity.count({ where: { projectId, decision: "BUILD" } }),
    prisma.page.count({ where: { projectId } }),
    prisma.page.count({ where: { projectId, status: "PUBLISHED" } }),
    prisma.page.count({ where: { projectId, status: { in: ["REVIEW", "VALIDATED"] } } }),
    prisma.approval.count({ where: { projectId, status: "PENDING" } }),
    prisma.task.count({ where: { projectId, status: { in: ["RUNNING", "QUEUED", "PENDING"] } } }),
    prisma.task.count({ where: { projectId, status: "FAILED" } }),
    prisma.agentRun.count({ where: { projectId } }),
    prisma.logEntry.count({ where: { projectId, level: "ERROR" } }),
    prisma.recommendation.count({ where: { projectId, status: "OPEN" } }),
    prisma.aIRun.count({ where: { prompt: { projectId } } }),
  ]);

  return {
    keywords,
    clusters,
    opportunities,
    buildOpportunities,
    pages,
    publishedPages,
    reviewPages,
    pendingApprovals,
    runningTasks,
    failedTasks,
    agentRuns,
    errors,
    recommendations,
    aiRuns,
  };
}
