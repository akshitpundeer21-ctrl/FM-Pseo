import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readStringArray } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Card, EmptyState, Grid, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";
import { describeTools } from "@/tools/definitions";
import { formatMoney } from "@/core/utils/text";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const { project } = await requireProject();

  const agents = await prisma.agent.findMany({
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    include: {
      skills: { include: { skill: { select: { key: true, name: true } } } },
      runs: {
        where: { projectId: project.id },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { status: true, startedAt: true, confidence: true, isMock: true },
      },
      _count: { select: { runs: true } },
    },
  });

  const stats = await prisma.agentRun.groupBy({
    by: ["agentId"],
    where: { projectId: project.id },
    _sum: { costUsd: true, tokensIn: true, tokensOut: true },
    _avg: { latencyMs: true, confidence: true },
  });
  const statByAgent = new Map(stats.map((s) => [s.agentId, s]));
  const tools = describeTools();

  const orchestrators = agents.filter((a) => a.kind === "ORCHESTRATOR");
  const guardians = agents.filter((a) => a.kind === "GUARDIAN");
  const specialists = agents.filter((a) => a.kind === "SPECIALIST");

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent has an explicit identity, skill set, tool allowlist and capability set. The Control Plane enforces them at runtime — an agent cannot use a tool that is not on its list, whatever it asks for."
        meta={
          <>
            <Badge tone="brand">{agents.length} agents</Badge>
            <Badge tone="neutral">{tools.length} registered tools</Badge>
          </>
        }
      />

      {[
        { label: "Orchestrator", items: orchestrators, note: "Plans and delegates. Performs no specialist work." },
        { label: "Guardians", items: guardians, note: "Gate quality, facts and opportunity before anything ships." },
        { label: "Specialists", items: specialists, note: "One job each, with a typed input/output contract." },
      ].map((group) =>
        group.items.length ? (
          <section key={group.label} className="mb-6">
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold">{group.label}</h2>
              <span className="text-[12px] text-[var(--color-ink-3)]">{group.note}</span>
            </div>
            <Grid cols={2}>
              {group.items.map((agent) => {
                const s = statByAgent.get(agent.id);
                const last = agent.runs[0];
                const allowedTools = readStringArray(agent.allowedToolsJson);
                const caps = readStringArray(agent.permissionsJson);
                return (
                  <Link key={agent.id} href={`/agents/${agent.key}`} className="block">
                    <div className="fm-card h-full p-4 transition-colors hover:border-[var(--color-border-strong)]">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-[13.5px] font-semibold">{agent.name}</h3>
                          <Mono>{agent.key}</Mono>
                        </div>
                        {last ? <StatusBadge status={last.status} /> : <Badge tone="neutral">never run</Badge>}
                      </div>

                      <p className="mt-2 line-clamp-2 text-[12px] text-[var(--color-ink-2)]">{agent.description}</p>

                      <div className="mt-3 flex flex-wrap gap-1">
                        {agent.skills.slice(0, 4).map((as) => (
                          <Badge key={as.id} tone="brand">
                            {as.skill.name}
                          </Badge>
                        ))}
                        {agent.skills.length > 4 ? <Badge tone="neutral">+{agent.skills.length - 4}</Badge> : null}
                      </div>

                      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[var(--color-border)] pt-2.5 text-[11px] text-[var(--color-ink-3)]">
                        <div>
                          <div className="uppercase tracking-wide">Runs</div>
                          <div className="text-[13px] font-semibold text-[var(--color-ink)]">{agent._count.runs}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-wide">Avg conf.</div>
                          <div className="text-[13px] font-semibold text-[var(--color-ink)]">
                            {s?._avg.confidence ? s._avg.confidence.toFixed(2) : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="uppercase tracking-wide">Avg time</div>
                          <div className="text-[13px] font-semibold text-[var(--color-ink)]">
                            {s?._avg.latencyMs ? `${Math.round(s._avg.latencyMs)}ms` : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="uppercase tracking-wide">Cost</div>
                          <div className="text-[13px] font-semibold text-[var(--color-ink)]">{formatMoney(s?._sum.costUsd ?? 0)}</div>
                        </div>
                      </div>

                      <div className="mt-2.5 flex flex-wrap gap-1 text-[10.5px]">
                        {allowedTools.length ? (
                          allowedTools.map((t) => (
                            <span key={t} className="rounded border border-[var(--color-border)] px-1.5 py-[1px] font-mono text-[var(--color-ink-3)]">
                              {t}
                            </span>
                          ))
                        ) : (
                          <span className="text-[var(--color-ink-4)]">no external tools</span>
                        )}
                      </div>

                      {caps.includes("publish") ? (
                        <div className="mt-2">
                          <Badge tone="danger">holds publish capability</Badge>
                        </div>
                      ) : null}

                      {last ? (
                        <div className="mt-2 text-[11px] text-[var(--color-ink-4)]">last run {timeAgo(last.startedAt)}</div>
                      ) : null}
                    </div>
                  </Link>
                );
              })}
            </Grid>
          </section>
        ) : null,
      )}

      <Card title="Tool registry" description="Every tool an agent can request, and what it needs to work for real." padded={false}>
        {tools.length ? (
          <Table head={["Tool", "Category", "Requires capability", "Integration", "Mock fallback", "Billable"]}>
            {tools.map((t) => (
              <tr key={t.key}>
                <td>
                  <Mono className="!text-[var(--color-ink)]">{t.key}</Mono>
                  <div className="mt-0.5 max-w-[420px] text-[11.5px] text-[var(--color-ink-3)]">{t.description}</div>
                </td>
                <td className="text-[12px]">{t.category}</td>
                <td>
                  <Mono>{t.requiredCapability}</Mono>
                </td>
                <td className="text-[12px]">{t.integrationProvider ?? "—"}</td>
                <td>{t.allowMockFallback ? <Badge tone="mock">yes</Badge> : <Badge tone="danger">never</Badge>}</td>
                <td>{t.costly ? <Badge tone="warn">yes</Badge> : <Badge tone="neutral">no</Badge>}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No tools registered" />
        )}
      </Card>
    </>
  );
}
