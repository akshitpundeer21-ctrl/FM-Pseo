import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Card, EmptyState, Grid, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";
import { taskCounts } from "@/engine/tasks/task-service";
import { formatDuration } from "@/core/utils/text";

export const dynamic = "force-dynamic";

const ALL_STATUSES = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING",
  "REVIEW",
  "APPROVED",
  "REJECTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { project } = await requireProject();
  const sp = await searchParams;

  const [tasks, counts] = await Promise.all([
    prisma.task.findMany({
      where: { projectId: project.id, ...(sp.status ? { status: sp.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 120,
      include: {
        agent: { select: { name: true, key: true } },
        runs: { select: { id: true, status: true, latencyMs: true, costUsd: true, confidence: true, isMock: true }, orderBy: { startedAt: "desc" }, take: 1 },
        workflowRun: { select: { id: true, workflow: { select: { name: true } } } },
      },
    }),
    taskCounts(project.id),
  ]);

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Every meaningful action becomes a structured task before it runs: goal, agent, input, dependencies, approval requirement, validation status and result."
        meta={
          <>
            {ALL_STATUSES.filter((s) => counts[s]).map((s) => (
              <Link key={s} href={`/tasks?status=${s}`}>
                <StatusBadge status={s} />
              </Link>
            ))}
          </>
        }
        actions={
          sp.status ? (
            <Link href="/tasks" className="fm-btn">
              Clear filter
            </Link>
          ) : undefined
        }
      />

      <Card padded={false}>
        {tasks.length ? (
          <Table head={["Task", "Agent", "Status", "Validation", "Approval", "Result", "Created"]}>
            {tasks.map((t) => {
              const run = t.runs[0];
              const input = readJson<Record<string, unknown>>(t.inputJson, {});
              const inputKeys = Object.keys(input).slice(0, 4);
              return (
                <tr key={t.id}>
                  <td className="max-w-[260px]">
                    <div className="truncate font-medium">{t.title}</div>
                    <div className="mt-0.5 truncate text-[11.5px] text-[var(--color-ink-3)]" title={t.goal}>
                      {t.goal}
                    </div>
                    {inputKeys.length ? (
                      <Mono className="mt-0.5 block truncate">
                        {inputKeys.map((k) => `${k}=${JSON.stringify(input[k]).slice(0, 22)}`).join(" ")}
                      </Mono>
                    ) : null}
                    {t.workflowRun ? (
                      <div className="mt-0.5 text-[11px] text-[var(--color-ink-4)]">via {t.workflowRun.workflow.name}</div>
                    ) : null}
                  </td>
                  <td className="text-[12px]">
                    {t.agent ? (
                      <Link href={`/agents/${t.agent.key}`} className="hover:underline">
                        {t.agent.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <StatusBadge status={t.status} />
                    {t.attempts > 1 ? <div className="mt-1 text-[11px] text-[var(--color-ink-4)]">{t.attempts} attempts</div> : null}
                  </td>
                  <td>
                    <StatusBadge status={t.validationStatus} />
                  </td>
                  <td>{t.requiresApproval ? <Badge tone="warn">required</Badge> : <span className="text-[12px] text-[var(--color-ink-4)]">—</span>}</td>
                  <td className="max-w-[280px] text-[12px]">
                    {t.error ? (
                      <span className="text-[var(--color-danger)]">{t.error}</span>
                    ) : run ? (
                      <span className="text-[var(--color-ink-3)]">
                        {run.confidence !== null ? `conf ${run.confidence.toFixed(2)} · ` : ""}
                        {formatDuration(run.latencyMs)}
                        {run.isMock ? " · mock" : ""}
                      </span>
                    ) : (
                      <span className="text-[var(--color-ink-4)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(t.createdAt)}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title="No tasks" hint="Tasks are created automatically when a workflow or an agent runs." />
        )}
      </Card>
    </>
  );
}
