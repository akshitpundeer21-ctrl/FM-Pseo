import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { GoalConsole } from "@/app/(console)/goals/goal-console";
import { Card, EmptyState, PageHeader, StatusBadge, Table, timeAgo, Mono } from "@/ui/primitives";
import { WORKFLOWS } from "@/engine/workflow/definitions";
import { formatDuration } from "@/core/utils/text";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
  const { project } = await requireProject();

  const [goals, runs] = await Promise.all([
    prisma.goal.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "desc" }, take: 15 }),
    prisma.workflowRun.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { workflow: { select: { name: true, key: true } }, steps: { orderBy: { sequence: "asc" } } },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Goals & workflows"
        description="Give the Master Orchestrator a business objective. It decides what research is needed, which agents to delegate to, what data is required, and where a human must approve."
      />

      <div className="mb-6">
        <GoalConsole workflows={WORKFLOWS.map((w) => ({ key: w.key, name: w.name, description: w.description }))} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Workflow runs" description="Each run records every step, its agent and its duration." padded={false}>
          {runs.length ? (
            <div className="divide-y divide-[var(--color-border)]">
              {runs.map((run) => {
                const done = run.steps.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").length;
                return (
                  <div key={run.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium">{run.workflow.name}</span>
                          <StatusBadge status={run.status} />
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-[var(--color-ink-3)]">
                          {done}/{run.steps.length} steps · started {timeAgo(run.startedAt ?? run.createdAt)}
                          {run.currentStep ? ` · current: ${run.currentStep}` : ""}
                        </div>
                      </div>
                      {run.status === "WAITING_APPROVAL" ? (
                        <Link href="/approvals" className="fm-btn !py-1 !text-[12px]">
                          Approve to continue
                        </Link>
                      ) : null}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1">
                      {run.steps.map((s) => (
                        <span
                          key={s.id}
                          title={`${s.stepName} — ${s.status}${s.durationMs ? ` (${formatDuration(s.durationMs)})` : ""}${s.error ? `: ${s.error}` : ""}`}
                          className="h-1.5 w-9 rounded-full"
                          style={{
                            background:
                              s.status === "COMPLETED"
                                ? "var(--color-ok)"
                                : s.status === "FAILED"
                                  ? "var(--color-danger)"
                                  : s.status === "WAITING"
                                    ? "var(--color-warn)"
                                    : s.status === "SKIPPED"
                                      ? "var(--color-border-strong)"
                                      : "var(--color-info)",
                          }}
                        />
                      ))}
                    </div>

                    {run.error ? <p className="mt-1.5 text-[11.5px] text-[var(--color-danger)]">{run.error}</p> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No workflow runs yet" hint="Submit an objective above to start one." />
          )}
        </Card>

        <Card title="Goals" padded={false}>
          {goals.length ? (
            <Table head={["Objective", "Status", "When"]}>
              {goals.map((g) => {
                const plan = readJson<{ workflowKey?: string; plan?: unknown[] }>(g.planJson, {});
                return (
                  <tr key={g.id}>
                    <td>
                      <div className="max-w-[320px] text-[12.5px] font-medium">{g.objective}</div>
                      <Mono>{plan.workflowKey ?? "—"} · {plan.plan?.length ?? 0} steps</Mono>
                    </td>
                    <td>
                      <StatusBadge status={g.status} />
                    </td>
                    <td className="text-[12px] text-[var(--color-ink-3)]">{timeAgo(g.createdAt)}</td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <EmptyState title="No goals recorded" />
          )}
        </Card>
      </div>
    </>
  );
}
