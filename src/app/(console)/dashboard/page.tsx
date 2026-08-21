import Link from "next/link";
import { prisma } from "@/core/db/client";
import { env } from "@/core/config/env";
import { readJson } from "@/core/db/json";
import { budgetStatus } from "@/control-plane/budget";
import { listIntegrations } from "@/integrations/service";
import { requireProject, overviewCounts } from "@/app/(console)/_lib/data";
import {
  Badge,
  Bars,
  Callout,
  Card,
  Grid,
  MockBadge,
  PageHeader,
  Sparkline,
  Stat,
  StatusBadge,
  Table,
  EmptyState,
  timeAgo,
  Meter,
} from "@/ui/primitives";
import { formatMoney, formatNumber } from "@/core/utils/text";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const { auth, project } = await requireProject();
  const counts = await overviewCounts(project.id);

  const [recentRuns, recentTasks, approvals, recommendations, analytics, aiMetrics, budget, integrations, errorLogs] =
    await Promise.all([
      prisma.agentRun.findMany({
        where: { projectId: project.id },
        orderBy: { startedAt: "desc" },
        take: 8,
        include: { agent: { select: { name: true, key: true } } },
      }),
      prisma.task.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: "desc" },
        take: 6,
        include: { agent: { select: { name: true } } },
      }),
      prisma.approval.findMany({ where: { projectId: project.id, status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 5 }),
      prisma.recommendation.findMany({ where: { projectId: project.id, status: "OPEN" }, orderBy: { priority: "desc" }, take: 5 }),
      prisma.analyticsSnapshot.findMany({
        where: { projectId: project.id, dimension: "query" },
        orderBy: { date: "asc" },
        take: 400,
      }),
      prisma.aIRun.findMany({ where: { prompt: { projectId: project.id } }, orderBy: { runAt: "desc" }, take: 60 }),
      budgetStatus(auth.organizationId),
      listIntegrations(auth.organizationId, project.id),
      prisma.logEntry.findMany({
        where: { projectId: project.id, level: "ERROR" },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

  // Clicks by day for the sparkline.
  const byDay = new Map<string, number>();
  for (const row of analytics) {
    const key = row.date.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + row.clicks);
  }
  const series = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  const totalClicks = analytics.reduce((s, r) => s + r.clicks, 0);
  const totalImpressions = analytics.reduce((s, r) => s + r.impressions, 0);
  const analyticsAreMock = analytics.length > 0 && analytics.every((r) => r.isMock);

  const aiMentionRate = aiMetrics.length ? aiMetrics.filter((r) => r.brandMentioned).length / aiMetrics.length : 0;
  const aiCitationRate = aiMetrics.length ? aiMetrics.filter((r) => r.brandCited).length / aiMetrics.length : 0;
  const aiIsMock = aiMetrics.length > 0 && aiMetrics.every((r) => r.isMock);

  const configuredIntegrations = integrations.filter((i) => i.status === "CONFIGURED");
  const mockingIntegrations = integrations.filter((i) => i.status === "NOT_CONFIGURED" && i.hasMock);

  const nothingRunYet = counts.agentRuns === 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description={`${project.name} — what the operating system is doing right now.`}
        meta={
          <>
            <Badge tone="brand">{project.approvalMode.replace("_", "-")} approvals</Badge>
            <Badge tone="neutral">confidence floor {project.confidenceThreshold}</Badge>
            {env().DEMO_MODE ? <MockBadge label="DEMO MODE" /> : null}
          </>
        }
        actions={
          <Link href="/goals" className="fm-btn fm-btn-primary">
            Give the orchestrator a goal
          </Link>
        }
      />

      {nothingRunYet ? (
        <div className="mb-5">
          <Callout tone="brand" title="Nothing has run yet">
            The seed creates configuration only — agents, skills, components, page families and the brand profile. No
            keywords, pages or metrics are fabricated. Open{" "}
            <Link href="/goals" className="underline">
              Goals &amp; workflows
            </Link>{" "}
            and give the Master Orchestrator an objective such as{" "}
            <em>&ldquo;Create an SEO growth strategy around Delhi to Toronto flights&rdquo;</em> to make the system produce
            something real.
          </Callout>
        </div>
      ) : null}

      <Grid cols={4} className="mb-4">
        <Stat label="Published pages" value={counts.publishedPages} sub={`${counts.pages} total pages`} href="/content" tone="ok" />
        <Stat
          label="Awaiting approval"
          value={counts.pendingApprovals}
          sub={counts.reviewPages ? `${counts.reviewPages} page(s) in review` : "nothing blocked"}
          href="/approvals"
          tone={counts.pendingApprovals ? "warn" : "default"}
        />
        <Stat
          label="Programmatic opportunities"
          value={counts.opportunities}
          sub={`${counts.buildOpportunities} cleared the build gate`}
          href="/opportunities"
        />
        <Stat label="Keywords" value={formatNumber(counts.keywords)} sub={`${counts.clusters} clusters`} href="/keywords" />
      </Grid>

      <Grid cols={4} className="mb-6">
        <Stat
          label="Agent runs"
          value={counts.agentRuns}
          sub={counts.runningTasks ? `${counts.runningTasks} task(s) queued/running` : "idle"}
          href="/tasks"
        />
        <Stat
          label="Errors (logged)"
          value={counts.errors}
          sub={counts.failedTasks ? `${counts.failedTasks} failed task(s)` : "no failed tasks"}
          href="/logs?level=ERROR"
          tone={counts.errors ? "danger" : "default"}
        />
        <Stat label="Open recommendations" value={counts.recommendations} sub="from performance + visibility" href="/search-performance" />
        <Stat
          label="Spend this period"
          value={formatMoney(budget.costUsd)}
          sub={`${formatNumber(budget.tokensUsed)} tokens of ${formatNumber(budget.tokenBudget)}`}
          href="/settings"
          tone={budget.exhausted ? "danger" : "default"}
        />
      </Grid>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title="Search performance"
          description={analytics.length ? `${byDay.size} days of query data` : "No data yet"}
          actions={analyticsAreMock ? <MockBadge label="SYNTHETIC SERIES" /> : null}
        >
          {series.length > 1 ? (
            <>
              <Sparkline points={series} />
              <div className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Clicks</div>
                  <div className="text-[18px] font-semibold">{formatNumber(totalClicks)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Impressions</div>
                  <div className="text-[18px] font-semibold">{formatNumber(totalImpressions)}</div>
                </div>
              </div>
            </>
          ) : (
            <EmptyState
              title="No search performance data"
              hint="Connect Google Search Console, or run the Search Performance agent to generate a labelled synthetic series."
              action={
                <Link href="/search-performance" className="fm-btn">
                  Open search performance
                </Link>
              }
            />
          )}
        </Card>

        <Card
          title="AI visibility"
          description="Mentions and citations in generated answers — not rankings."
          actions={aiIsMock ? <MockBadge /> : null}
        >
          {aiMetrics.length ? (
            <div className="space-y-3">
              <Meter value={aiMentionRate * 100} label="Mention rate" tone="brand" />
              <Meter value={aiCitationRate * 100} label="Citation rate" tone="info" />
              <div className="text-[12px] text-[var(--color-ink-3)]">
                Across {aiMetrics.length} recorded probe{aiMetrics.length === 1 ? "" : "s"}.
              </div>
              <Link href="/ai-visibility" className="fm-btn !py-1 !text-[12px]">
                Open AI visibility
              </Link>
            </div>
          ) : (
            <EmptyState
              title="No probes recorded"
              hint="Run the AI Visibility agent against the prompt library."
              action={
                <Link href="/ai-visibility" className="fm-btn">
                  Open AI visibility
                </Link>
              }
            />
          )}
        </Card>

        <Card title="Integrations" description={`${configuredIntegrations.length} of ${integrations.length} connected`}>
          <div className="space-y-2">
            {integrations.slice(0, 6).map((i) => (
              <div key={i.provider} className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] text-[var(--color-ink-2)]">{i.name}</span>
                {i.status === "CONFIGURED" ? <StatusBadge status="CONFIGURED" /> : i.hasMock ? <MockBadge label="MOCK" /> : <StatusBadge status="NOT_CONFIGURED" />}
              </div>
            ))}
          </div>
          {mockingIntegrations.length ? (
            <p className="mt-3 text-[11.5px] text-[var(--color-ink-3)]">
              {mockingIntegrations.length} integration{mockingIntegrations.length === 1 ? " is" : "s are"} running on labelled
              mock adapters.{" "}
              <Link href="/integrations" className="underline">
                Connect them
              </Link>
              .
            </p>
          ) : null}
        </Card>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Recent agent activity" description="Every run is recorded with its tools, cost and confidence." padded={false}>
          {recentRuns.length ? (
            <Table head={["Agent", "Status", "Confidence", "Duration", "When"]}>
              {recentRuns.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/agents/${r.agent.key}`} className="font-medium text-[var(--color-ink)] hover:underline">
                      {r.agent.name}
                    </Link>
                    {r.isMock ? (
                      <span className="ml-1.5">
                        <MockBadge />
                      </span>
                    ) : null}
                    <div className="mt-0.5 max-w-[380px] truncate text-[11.5px] text-[var(--color-ink-3)]" title={r.outputSummary || r.error || ""}>
                      {r.outputSummary || r.error || "—"}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="fm-mono">{r.confidence?.toFixed(2) ?? "—"}</td>
                  <td className="fm-mono">{r.latencyMs}ms</td>
                  <td className="text-[12px] text-[var(--color-ink-3)]">{timeAgo(r.startedAt)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No agent runs yet" hint="Give the orchestrator a goal to start the pipeline." />
          )}
        </Card>

        <Card title="Pending approvals" description="Nothing publishes without a human decision in MANUAL/SEMI-AUTOMATIC mode." padded={false}>
          {approvals.length ? (
            <Table head={["Item", "Risk", "Requested", ""]}>
              {approvals.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="font-medium">{a.title}</div>
                    <div className="mt-0.5 max-w-[320px] truncate text-[11.5px] text-[var(--color-ink-3)]">{a.summary}</div>
                  </td>
                  <td>
                    <StatusBadge status={a.riskLevel} />
                  </td>
                  <td className="text-[12px] text-[var(--color-ink-3)]">{timeAgo(a.createdAt)}</td>
                  <td>
                    <Link href="/approvals" className="fm-btn !py-1 !text-[12px]">
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="Nothing waiting on you" hint="Approvals appear here when an agent needs a human decision." />
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Latest tasks" padded={false}>
          {recentTasks.length ? (
            <Table head={["Task", "Agent", "Status", "When"]}>
              {recentTasks.map((t) => (
                <tr key={t.id}>
                  <td className="max-w-[280px] truncate font-medium">{t.title}</td>
                  <td className="text-[12px] text-[var(--color-ink-2)]">{t.agent?.name ?? "—"}</td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="text-[12px] text-[var(--color-ink-3)]">{timeAgo(t.createdAt)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No tasks yet" />
          )}
        </Card>

        <Card title="Recommendations & errors" padded={false}>
          {recommendations.length || errorLogs.length ? (
            <div className="divide-y divide-[var(--color-border)]">
              {recommendations.map((r) => (
                <div key={r.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium">{r.title}</span>
                    <Badge tone={r.impact === "HIGH" ? "danger" : "warn"}>{r.impact}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] text-[var(--color-ink-3)]">{r.detail}</p>
                </div>
              ))}
              {errorLogs.map((l) => (
                <div key={l.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium text-[var(--color-danger)]">{l.scope}</span>
                    <span className="text-[11px] text-[var(--color-ink-3)]">{timeAgo(l.createdAt)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] text-[var(--color-ink-3)]">{l.message}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No open recommendations or errors" />
          )}
        </Card>
      </div>
    </>
  );
}
