import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readRecord } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { recentAudit } from "@/control-plane/audit";
import { describeAuditEvent } from "@/control-plane/audit-describe";
import { Badge, Card, EmptyState, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";

export const dynamic = "force-dynamic";

const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];

export default async function LogsPage({ searchParams }: { searchParams: Promise<{ level?: string; scope?: string }> }) {
  const { auth, project } = await requireProject();
  const sp = await searchParams;

  const [logs, counts, audit, toolCalls] = await Promise.all([
    prisma.logEntry.findMany({
      where: { projectId: project.id, ...(sp.level ? { level: sp.level } : {}), ...(sp.scope ? { scope: { contains: sp.scope } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.logEntry.groupBy({ by: ["level"], where: { projectId: project.id }, _count: { _all: true } }),
    recentAudit(auth.organizationId, 60),
    prisma.toolInvocation.findMany({
      where: { agentRun: { projectId: project.id } },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { agentRun: { include: { agent: { select: { name: true } } } } },
    }),
  ]);

  const countByLevel = Object.fromEntries(counts.map((c) => [c.level, c._count._all]));
  const users = await prisma.user.findMany({ select: { id: true, name: true } });
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));

  return (
    <>
      <PageHeader
        title="Logs & audit"
        description="Structured logs from every agent, tool and workflow, plus the append-only audit trail of who did what."
        meta={
          <>
            {LEVELS.filter((l) => countByLevel[l]).map((l) => (
              <Link key={l} href={`/logs?level=${l}`}>
                <Badge tone={l === "ERROR" ? "danger" : l === "WARN" ? "warn" : "neutral"}>
                  {l} {countByLevel[l]}
                </Badge>
              </Link>
            ))}
          </>
        }
        actions={
          sp.level || sp.scope ? (
            <Link href="/logs" className="fm-btn">
              Clear filter
            </Link>
          ) : undefined
        }
      />

      <Card title="Application log" description={`${logs.length} entries shown`} padded={false} className="mb-5">
        {logs.length ? (
          <Table head={["Level", "Scope", "Message", "Context", "When"]}>
            {logs.map((l) => {
              const ctx = readRecord(l.contextJson);
              const keys = Object.keys(ctx).slice(0, 5);
              return (
                <tr key={l.id}>
                  <td>
                    <Badge tone={l.level === "ERROR" ? "danger" : l.level === "WARN" ? "warn" : l.level === "INFO" ? "info" : "neutral"}>
                      {l.level}
                    </Badge>
                  </td>
                  <td>
                    <Link href={`/logs?scope=${encodeURIComponent(l.scope)}`}>
                      <Mono className="hover:underline">{l.scope}</Mono>
                    </Link>
                  </td>
                  <td className="max-w-[460px] text-[12px]">{l.message}</td>
                  <td className="max-w-[300px] text-[11px] text-[var(--color-ink-3)]">
                    {keys.length ? keys.map((k) => `${k}=${String(ctx[k]).slice(0, 40)}`).join(" · ") : "—"}
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(l.createdAt)}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title="No log entries match" />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Audit trail" description="Every state change, with the actor that made it." padded={false}>
          {audit.length ? (
            <div className="divide-y divide-[var(--color-border)]">
              {audit.map((a) => (
                <div key={a.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[12.5px] text-[var(--color-ink)]">{describeAuditEvent(a, userNames)}</span>
                    <span className="shrink-0 text-[11px] text-[var(--color-ink-3)]">{timeAgo(a.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <Badge tone={a.actorType === "USER" ? "brand" : a.actorType === "AGENT" ? "info" : "neutral"}>{a.actorType}</Badge>
                    <Mono className="!text-[10.5px]">{a.action}</Mono>
                    {a.entityType ? <Mono className="!text-[10.5px]">{a.entityType}</Mono> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No audit entries" />
          )}
        </Card>

        <Card title="Tool invocations" description="Latency, cost and whether a mock adapter served the call." padded={false}>
          {toolCalls.length ? (
            <Table head={["Tool", "Agent", "Status", "Latency", "Mock"]}>
              {toolCalls.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Mono className="!text-[var(--color-ink)]">{t.toolKey}</Mono>
                    {t.error ? <div className="mt-0.5 max-w-[280px] text-[11px] text-[var(--color-danger)]">{t.error}</div> : null}
                  </td>
                  <td className="text-[12px]">{t.agentRun?.agent.name ?? "—"}</td>
                  <td>
                    <StatusBadge status={t.status === "SUCCESS" ? "SUCCEEDED" : t.status} />
                  </td>
                  <td className="fm-mono">{t.latencyMs}ms</td>
                  <td>{t.isMock ? <Badge tone="mock">mock</Badge> : <span className="text-[12px] text-[var(--color-ink-4)]">—</span>}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No tool invocations recorded" />
          )}
        </Card>
      </div>
    </>
  );
}
