import { notFound } from "next/navigation";
import { prisma } from "@/core/db/client";
import { readJson, readStringArray } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Card, EmptyState, Grid, KeyValue, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";
import { RunAgentButton } from "@/ui/run-agent-button";
import { AgentSkillManager, type AgentSkillRow } from "@/app/(console)/agents/[key]/agent-skill-manager";
import { roleHas } from "@/core/security/rbac";
import { computeEffectiveTools, parseSkillUsage } from "@/skills/types";
import { formatDuration, formatMoney, formatNumber } from "@/core/utils/text";

export const dynamic = "force-dynamic";

/** Sensible default inputs for a manual run, per agent. */
const MANUAL_INPUTS: Record<string, { label: string; input: Record<string, unknown> } | undefined> = {
  keyword_research: { label: "Run keyword research (DEL→YYZ)", input: { origin: "DEL", destination: "YYZ", limit: 120 } },
  programmatic_opportunity: { label: "Score route opportunities", input: { pageFamilyKey: "route", maxCandidates: 12 } },
  internal_linking: { label: "Re-link all pages", input: { projectWide: true } },
  search_performance: { label: "Refresh search performance", input: { days: 28, dimension: "query" } },
  ai_visibility: { label: "Run the prompt library", input: { limit: 8 } },
};

export default async function AgentDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { auth, project } = await requireProject();

  const agent = await prisma.agent.findUnique({
    where: { key },
    include: {
      skills: {
        include: {
          skill: { include: { activeVersion: true, versions: { orderBy: { version: "desc" } } } },
          pinnedVersion: true,
        },
        orderBy: { priority: "asc" },
      },
    },
  });
  if (!agent) notFound();

  // Resolve what each assigned skill would ACTUALLY run for this agent, and
  // which of its requested tools this agent cannot grant.
  const agentAllowedTools = readStringArray(agent.allowedToolsJson);

  const skillRows: AgentSkillRow[] = agent.skills.map((as) => {
    const resolved = as.pinnedVersion ?? as.skill.activeVersion;
    const requested = readStringArray(resolved?.allowedToolsJson ?? "[]");
    const scope = computeEffectiveTools(agentAllowedTools, [{ allowedTools: requested }]);
    return {
      skillId: as.skill.id,
      skillKey: as.skill.key,
      name: as.skill.name,
      description: as.skill.description,
      skillStatus: as.skill.status,
      resolvedVersion: resolved?.version ?? null,
      resolvedStatus: resolved?.status ?? null,
      pinnedVersionId: as.pinnedVersionId,
      enabled: as.isEnabled,
      updatedAt: as.skill.updatedAt.toISOString(),
      versions: as.skill.versions.map((v) => ({ id: v.id, version: v.version, status: v.status })),
      deniedTools: scope.deniedTools,
    };
  });

  const unassignedSkills = await prisma.skill.findMany({
    where: { status: "ACTIVE", agents: { none: { agentId: agent.id } } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const [runs, toolCalls, agg] = await Promise.all([
    prisma.agentRun.findMany({
      where: { agentId: agent.id, projectId: project.id },
      orderBy: { startedAt: "desc" },
      take: 25,
      include: { task: { select: { title: true } }, toolCalls: { select: { toolKey: true, status: true, latencyMs: true, isMock: true } } },
    }),
    prisma.toolInvocation.groupBy({
      by: ["toolKey", "status"],
      where: { agentRun: { agentId: agent.id, projectId: project.id } },
      _count: { _all: true },
      _avg: { latencyMs: true },
    }),
    prisma.agentRun.aggregate({
      where: { agentId: agent.id, projectId: project.id },
      _sum: { costUsd: true, tokensIn: true, tokensOut: true },
      _avg: { latencyMs: true, confidence: true },
      _count: { _all: true },
    }),
  ]);

  const inputContract = readJson<Record<string, string>>(agent.inputSchemaJson, {});
  const outputContract = readJson<Record<string, string>>(agent.outputSchemaJson, {});
  const validationRules = readStringArray(agent.validationRulesJson);
  const allowedTools = readStringArray(agent.allowedToolsJson);
  const capabilities = readStringArray(agent.permissionsJson);
  const manual = MANUAL_INPUTS[agent.key];

  const successRate = agg._count._all
    ? runs.filter((r) => r.status === "SUCCEEDED").length / Math.min(runs.length, agg._count._all)
    : 0;

  return (
    <>
      <PageHeader
        title={agent.name}
        description={agent.description}
        meta={
          <>
            <Mono>{agent.key}</Mono>
            <Badge tone={agent.kind === "GUARDIAN" ? "warn" : agent.kind === "ORCHESTRATOR" ? "brand" : "neutral"}>{agent.kind}</Badge>
            <Badge tone={agent.isEnabled ? "ok" : "danger"}>{agent.isEnabled ? "enabled" : "disabled"}</Badge>
            <Badge tone="neutral">model tier: {agent.modelTier}</Badge>
          </>
        }
        actions={manual ? <RunAgentButton agentKey={agent.key} input={manual.input} label={manual.label} variant="primary" /> : undefined}
      />

      <Grid cols={4} className="mb-5">
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Runs</div>
          <div className="text-[24px] font-semibold">{agg._count._all}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Recent success rate</div>
          <div className="text-[24px] font-semibold">{runs.length ? `${(successRate * 100).toFixed(0)}%` : "—"}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Avg latency</div>
          <div className="text-[24px] font-semibold">{agg._avg.latencyMs ? formatDuration(Math.round(agg._avg.latencyMs)) : "—"}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Cost / tokens</div>
          <div className="text-[24px] font-semibold">{formatMoney(agg._sum.costUsd ?? 0)}</div>
          <div className="text-[11.5px] text-[var(--color-ink-3)]">
            {formatNumber((agg._sum.tokensIn ?? 0) + (agg._sum.tokensOut ?? 0))} tokens
          </div>
        </div>
      </Grid>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Role & governance">
          <KeyValue
            rows={[
              { label: "Role", value: <span className="text-right">{agent.role}</span> },
              { label: "Confidence threshold", value: <Mono>{agent.confidenceThreshold}</Mono> },
              { label: "Max retries", value: <Mono>{agent.maxRetries}</Mono> },
              { label: "Timeout", value: <Mono>{formatDuration(agent.timeoutMs)}</Mono> },
            ]}
          />
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Capabilities</div>
            <div className="flex flex-wrap gap-1">
              {capabilities.map((c) => (
                <Badge key={c} tone={c === "publish" || c === "unpublish" ? "danger" : "neutral"}>
                  {c}
                </Badge>
              ))}
            </div>
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Allowed tools</div>
            <div className="flex flex-wrap gap-1">
              {allowedTools.length ? (
                allowedTools.map((t) => (
                  <Badge key={t} tone="info">
                    {t}
                  </Badge>
                ))
              ) : (
                <span className="text-[12px] text-[var(--color-ink-4)]">None — this agent works from the database only.</span>
              )}
            </div>
          </div>
        </Card>

        <Card
          title="Skills"
          description="Resolved agent → assignment → version. Each run records the exact version it used."
        >
          <AgentSkillManager
            agentKey={agent.key}
            skills={skillRows}
            availableSkills={unassignedSkills}
            canAssign={roleHas(auth.role, "skill:assign")}
            canTest={roleHas(auth.role, "skill:test")}
          />
        </Card>

        <Card title="Contract" description="Typed input/output and the rules applied to its own output.">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Input</div>
          <div className="mb-3 space-y-0.5">
            {Object.entries(inputContract).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-[11.5px]">
                <Mono className="!text-[var(--color-ink)]">{k}</Mono>
                <span className="text-[var(--color-ink-3)]">{v}</span>
              </div>
            ))}
          </div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Output</div>
          <div className="mb-3 space-y-0.5">
            {Object.entries(outputContract).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-[11.5px]">
                <Mono className="!text-[var(--color-ink)]">{k}</Mono>
                <span className="text-[var(--color-ink-3)]">{v}</span>
              </div>
            ))}
          </div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Validation rules</div>
          <ul className="list-inside list-disc space-y-0.5 text-[11.5px] text-[var(--color-ink-2)]">
            {validationRules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Run history" description="Input, output, tools, cost, confidence and errors for every run." padded={false} className="mb-5">
        {runs.length ? (
          <Table head={["Started", "Status", "Task", "Summary", "Skill versions", "Tools", "Conf.", "Time", "Cost"]}>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(r.startedAt)}</td>
                <td>
                  <StatusBadge status={r.status} />
                  {r.isMock ? (
                    <div className="mt-1">
                      <Badge tone="mock">MOCK</Badge>
                    </div>
                  ) : null}
                </td>
                <td className="max-w-[170px] truncate text-[12px]">{r.task?.title ?? "—"}</td>
                <td className="max-w-[380px] text-[12px]">
                  <div className="text-[var(--color-ink-2)]">{r.outputSummary || "—"}</div>
                  {r.error ? <div className="mt-0.5 text-[var(--color-danger)]">{r.error}</div> : null}
                  {r.nextAction ? <div className="mt-0.5 text-[11px] text-[var(--color-ink-4)]">next: {r.nextAction}</div> : null}
                </td>
                <td className="text-[11px]">
                  {(() => {
                    // Recorded at execution time. Editing a skill afterwards
                    // cannot change what this run reports. Runs from before
                    // versioning stored only skill keys, so their version is
                    // reported as unrecorded rather than guessed.
                    const used = parseSkillUsage(readJson<unknown>(r.skillsUsedJson, []));
                    if (!used.length) return <span className="text-[var(--color-ink-4)]">—</span>;
                    return (
                      <div className="flex flex-col gap-0.5">
                        {used.map((s, i) => (
                          <Mono
                            key={`${s.skillKey}-${s.versionId ?? i}`}
                            title={
                              !s.versionRecorded
                                ? "This run predates skill versioning, so no version was recorded."
                                : s.pinned
                                  ? "The assignment was pinned to this version."
                                  : "Followed the skill's active version."
                            }
                          >
                            {s.skillKey}{" "}
                            {s.versionRecorded ? (
                              <>
                                v{s.version}
                                {s.pinned ? " (pinned)" : ""}
                              </>
                            ) : (
                              <span className="text-[var(--color-ink-4)]">(version not recorded)</span>
                            )}
                          </Mono>
                        ))}
                      </div>
                    );
                  })()}
                </td>
                <td className="text-[11px]">
                  {r.toolCalls.length ? (
                    <div className="flex flex-col gap-0.5">
                      {[...new Set(r.toolCalls.map((t) => t.toolKey))].map((t) => (
                        <Mono key={t}>{t}</Mono>
                      ))}
                    </div>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="fm-mono">{r.confidence?.toFixed(2) ?? "—"}</td>
                <td className="fm-mono">{r.latencyMs}ms</td>
                <td className="fm-mono">{formatMoney(r.costUsd)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="This agent has not run yet" hint="Run it from here, or give the orchestrator a goal that needs it." />
        )}
      </Card>

      <Card title="Tool usage" padded={false}>
        {toolCalls.length ? (
          <Table head={["Tool", "Status", "Calls", "Avg latency"]}>
            {toolCalls.map((t) => (
              <tr key={`${t.toolKey}-${t.status}`}>
                <td>
                  <Mono className="!text-[var(--color-ink)]">{t.toolKey}</Mono>
                </td>
                <td>
                  <StatusBadge status={t.status === "SUCCESS" ? "SUCCEEDED" : t.status} />
                </td>
                <td className="fm-mono">{t._count._all}</td>
                <td className="fm-mono">{t._avg.latencyMs ? `${Math.round(t._avg.latencyMs)}ms` : "—"}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No tool calls recorded" />
        )}
      </Card>
    </>
  );
}
