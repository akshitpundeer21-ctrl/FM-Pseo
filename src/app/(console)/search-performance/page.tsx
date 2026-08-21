import { prisma } from "@/core/db/client";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Bars, Callout, Card, EmptyState, Grid, MockBadge, Mono, PageHeader, Sparkline, Table } from "@/ui/primitives";
import { RunAgentButton } from "@/ui/run-agent-button";
import { listIntegrations } from "@/integrations/service";
import { formatNumber, pct } from "@/core/utils/text";

export const dynamic = "force-dynamic";

export default async function SearchPerformancePage() {
  const { auth, project } = await requireProject();

  const [snapshots, recommendations, integrations] = await Promise.all([
    prisma.analyticsSnapshot.findMany({ where: { projectId: project.id }, orderBy: { date: "asc" }, take: 2000 }),
    prisma.recommendation.findMany({
      where: { projectId: project.id, type: "SEARCH_PERFORMANCE" },
      orderBy: { priority: "desc" },
      take: 10,
    }),
    listIntegrations(auth.organizationId, project.id),
  ]);

  const gsc = integrations.find((i) => i.provider === "google_search_console");
  const isMockSeries = snapshots.length > 0 && snapshots.every((s) => s.isMock);

  const queries = snapshots.filter((s) => s.dimension === "query");
  const pages = snapshots.filter((s) => s.dimension === "page");

  const byDay = new Map<string, { clicks: number; impressions: number }>();
  for (const s of queries.length ? queries : pages) {
    const key = s.date.toISOString().slice(0, 10);
    const cur = byDay.get(key) ?? { clicks: 0, impressions: 0 };
    cur.clicks += s.clicks;
    cur.impressions += s.impressions;
    byDay.set(key, cur);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));

  const agg = (rows: typeof snapshots) => {
    const byValue = new Map<string, { clicks: number; impressions: number; posSum: number; n: number }>();
    for (const r of rows) {
      const cur = byValue.get(r.dimensionValue) ?? { clicks: 0, impressions: 0, posSum: 0, n: 0 };
      cur.clicks += r.clicks;
      cur.impressions += r.impressions;
      cur.posSum += r.position;
      cur.n++;
      byValue.set(r.dimensionValue, cur);
    }
    return [...byValue.entries()]
      .map(([value, v]) => ({
        value,
        clicks: v.clicks,
        impressions: v.impressions,
        ctr: v.impressions ? v.clicks / v.impressions : 0,
        position: v.n ? v.posSum / v.n : 0,
      }))
      .sort((a, b) => b.impressions - a.impressions);
  };

  const topQueries = agg(queries).slice(0, 25);
  const topPages = agg(pages).slice(0, 25);

  const totalClicks = snapshots.reduce((s, r) => s + r.clicks, 0);
  const totalImpressions = snapshots.reduce((s, r) => s + r.impressions, 0);
  const avgPosition = snapshots.length ? snapshots.reduce((s, r) => s + r.position, 0) / snapshots.length : 0;

  return (
    <>
      <PageHeader
        title="Search performance"
        description="Clicks, impressions, CTR and position for the published inventory, fed back into the content plan as recommendations."
        meta={
          <>
            {gsc?.status === "CONFIGURED" ? (
              <Badge tone="ok">Google Search Console connected</Badge>
            ) : (
              <Badge tone="neutral">Search Console not connected</Badge>
            )}
            {isMockSeries ? <MockBadge label="SYNTHETIC SERIES" /> : null}
          </>
        }
        actions={
          <div className="flex flex-wrap items-start gap-2">
            <RunAgentButton agentKey="search_performance" input={{ days: 28, dimension: "query" }} label="Refresh (queries)" />
            <RunAgentButton agentKey="search_performance" input={{ days: 28, dimension: "page" }} label="Refresh (pages)" />
          </div>
        }
      />

      {gsc?.status !== "CONFIGURED" ? (
        <div className="mb-5">
          <Callout tone="mock" title="This is a synthetic series, not measured traffic">
            No Search Console property is connected, so the Search Performance agent generates a deterministic series derived
            from each page&rsquo;s publish date and its cluster volume. It exists to exercise the feedback loop. Every row is
            flagged as mock and is never blended with real data. A page published today has no history at all — use the
            simulate button below if you want a series to inspect.
            <div className="mt-2">
              <RunAgentButton
                agentKey="search_performance"
                input={{ days: 28, dimension: "query", simulateHistoryDays: 45 }}
                label="Generate 45 days of simulated history"
                hint="Backdates the synthetic series so the dashboard has something to show. Clearly labelled as mock."
              />
            </div>
          </Callout>
        </div>
      ) : null}

      <Grid cols={4} className="mb-5">
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Clicks</div>
          <div className="text-[24px] font-semibold">{formatNumber(totalClicks)}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Impressions</div>
          <div className="text-[24px] font-semibold">{formatNumber(totalImpressions)}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">CTR</div>
          <div className="text-[24px] font-semibold">{totalImpressions ? pct(totalClicks / totalImpressions) : "—"}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Avg position</div>
          <div className="text-[24px] font-semibold">{avgPosition ? avgPosition.toFixed(1) : "—"}</div>
        </div>
      </Grid>

      <Card title="Clicks over time" description={days.length ? `${days.length} days` : "no data"} className="mb-5">
        {days.length > 1 ? (
          <>
            <Sparkline points={days.map(([, v]) => v.clicks)} height={64} />
            <div className="mt-2 flex justify-between text-[11px] text-[var(--color-ink-4)]">
              <span>{days[0][0]}</span>
              <span>{days[days.length - 1][0]}</span>
            </div>
          </>
        ) : (
          <EmptyState title="No time series yet" hint="Run the Search Performance agent to collect data." />
        )}
      </Card>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Top queries" padded={false}>
          {topQueries.length ? (
            <Table head={["Query", "Clicks", "Impr.", "CTR", "Pos."]}>
              {topQueries.map((q) => (
                <tr key={q.value}>
                  <td className="max-w-[260px] truncate text-[12px]">{q.value}</td>
                  <td className="fm-mono">{formatNumber(q.clicks)}</td>
                  <td className="fm-mono">{formatNumber(q.impressions)}</td>
                  <td className="fm-mono">{pct(q.ctr)}</td>
                  <td className="fm-mono">{q.position.toFixed(1)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No query data" />
          )}
        </Card>

        <Card title="Top pages" padded={false}>
          {topPages.length ? (
            <Table head={["Page", "Clicks", "Impr.", "CTR", "Pos."]}>
              {topPages.map((p) => (
                <tr key={p.value}>
                  <td className="max-w-[260px] truncate">
                    <Mono>{p.value}</Mono>
                  </td>
                  <td className="fm-mono">{formatNumber(p.clicks)}</td>
                  <td className="fm-mono">{formatNumber(p.impressions)}</td>
                  <td className="fm-mono">{pct(p.ctr)}</td>
                  <td className="fm-mono">{p.position.toFixed(1)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No page data" hint="Run the agent with the page dimension." />
          )}
        </Card>
      </div>

      <Card title="Recommendations from search data" description="Movement turned into concrete next actions." padded={false}>
        {recommendations.length ? (
          <div className="divide-y divide-[var(--color-border)]">
            {recommendations.map((r) => (
              <div key={r.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-[13px] font-medium">{r.title}</span>
                  <div className="flex shrink-0 gap-1.5">
                    <Badge tone={r.impact === "HIGH" ? "danger" : "warn"}>{r.impact} impact</Badge>
                    <Badge tone="neutral">{r.effort} effort</Badge>
                  </div>
                </div>
                <p className="mt-1 whitespace-pre-line text-[12px] text-[var(--color-ink-2)]">{r.detail}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No recommendations yet" hint="They appear once there is enough data to spot striking-distance queries." />
        )}
      </Card>
    </>
  );
}
