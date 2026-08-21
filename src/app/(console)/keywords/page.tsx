import { prisma } from "@/core/db/client";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Card, EmptyState, Grid, MockBadge, Mono, PageHeader, StatusBadge, Table } from "@/ui/primitives";
import { RunAgentButton } from "@/ui/run-agent-button";
import { formatNumber } from "@/core/utils/text";

export const dynamic = "force-dynamic";

const ACTION_TONE: Record<string, "ok" | "info" | "neutral" | "warn"> = {
  TARGET_NEW: "ok",
  TARGET_EXISTING: "info",
  SUPPORT: "neutral",
  IGNORE: "warn",
  REVIEW: "warn",
};

export default async function KeywordsPage({ searchParams }: { searchParams: Promise<{ intent?: string; cluster?: string }> }) {
  const { project } = await requireProject();
  const sp = await searchParams;

  const [clusters, keywords, totals] = await Promise.all([
    prisma.keywordCluster.findMany({
      where: { projectId: project.id },
      orderBy: { opportunityScore: "desc" },
      take: 30,
      include: { _count: { select: { keywords: true } } },
    }),
    prisma.keyword.findMany({
      where: {
        projectId: project.id,
        ...(sp.intent ? { intent: sp.intent } : {}),
        ...(sp.cluster ? { clusterId: sp.cluster } : {}),
      },
      orderBy: { opportunityScore: "desc" },
      take: 200,
      include: { cluster: { select: { name: true, id: true } } },
    }),
    prisma.keyword.aggregate({ where: { projectId: project.id }, _sum: { volume: true }, _count: { _all: true } }),
  ]);

  const intents = await prisma.keyword.groupBy({
    by: ["intent"],
    where: { projectId: project.id },
    _count: { _all: true },
    _sum: { volume: true },
  });

  const anyMock = keywords.some((k) => k.isMock);

  return (
    <>
      <PageHeader
        title="Keywords"
        description="Discovered, intent-classified, clustered and scored. Clusters map one page to a whole group of queries; cannibalisation is reported, never silently merged."
        meta={
          <>
            <Badge tone="neutral">{formatNumber(totals._count._all)} keywords</Badge>
            <Badge tone="neutral">{formatNumber(totals._sum.volume ?? 0)} combined volume</Badge>
            {anyMock ? <MockBadge label="SYNTHETIC CORPUS" /> : null}
          </>
        }
        actions={
          <RunAgentButton
            agentKey="keyword_research"
            input={{ origin: "DEL", destination: "YYZ", limit: 120, includeSiblingRoutes: true }}
            label="Run keyword research"
            variant="primary"
          />
        }
      />

      {anyMock ? (
        <div className="mb-4 rounded-lg border p-3 text-[12px]" style={{ background: "var(--color-mock-soft)", borderColor: "var(--color-mock)", color: "var(--color-mock)" }}>
          These volumes come from the bundled synthetic corpus, not a keyword API. They exist so scoring and clustering can be
          exercised offline. Connect DataForSEO in Integrations for measured data.
        </div>
      ) : null}

      <Grid cols={4} className="mb-5">
        {intents.map((i) => (
          <a key={i.intent} href={`/keywords?intent=${i.intent}`} className="fm-card block p-3.5 hover:border-[var(--color-border-strong)]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">{i.intent}</div>
            <div className="mt-1 text-[20px] font-semibold">{i._count._all}</div>
            <div className="text-[11.5px] text-[var(--color-ink-3)]">{formatNumber(i._sum.volume ?? 0)} volume</div>
          </a>
        ))}
      </Grid>

      <Card
        title="Clusters"
        description="One target page per cluster. Ordered by cluster opportunity score."
        padded={false}
        className="mb-5"
      >
        {clusters.length ? (
          <Table head={["Cluster", "Primary keyword", "Intent", "Page type", "Keywords", "Volume", "Difficulty", "Score"]}>
            {clusters.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`/keywords?cluster=${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </a>
                  {c.cannibalizationNotes ? (
                    <div className="mt-0.5 max-w-[280px] truncate text-[11px] text-[var(--color-warn)]" title={c.cannibalizationNotes}>
                      ⚠ {c.cannibalizationNotes}
                    </div>
                  ) : null}
                </td>
                <td className="max-w-[220px] truncate text-[12px]">{c.primaryKeyword}</td>
                <td>
                  <Badge tone="neutral">{c.intent}</Badge>
                </td>
                <td className="text-[12px]">{c.pageType ?? "—"}</td>
                <td className="fm-mono">{c._count.keywords}</td>
                <td className="fm-mono">{formatNumber(c.totalVolume)}</td>
                <td className="fm-mono">{c.avgDifficulty.toFixed(0)}</td>
                <td className="fm-mono font-semibold">{c.opportunityScore.toFixed(0)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            title="No clusters yet"
            hint="Run keyword research to discover, classify and cluster keywords for your target entities."
          />
        )}
      </Card>

      <Card
        title={sp.intent || sp.cluster ? "Filtered keywords" : "All keywords"}
        description={`${keywords.length} shown${sp.intent ? ` · intent = ${sp.intent}` : ""}${sp.cluster ? " · single cluster" : ""}`}
        actions={
          sp.intent || sp.cluster ? (
            <a href="/keywords" className="fm-btn !py-1 !text-[12px]">
              Clear filter
            </a>
          ) : null
        }
        padded={false}
      >
        {keywords.length ? (
          <Table head={["Keyword", "Intent", "Entity", "Route", "Volume", "KD", "Business value", "Score", "Action"]}>
            {keywords.map((k) => (
              <tr key={k.id}>
                <td className="max-w-[300px] truncate font-medium">{k.keyword}</td>
                <td>
                  <Badge tone="neutral">{k.intent}</Badge>
                </td>
                <td className="text-[12px] text-[var(--color-ink-3)]">{k.entityType ?? "—"}</td>
                <td>
                  <Mono>{k.origin && k.destination ? `${k.origin}→${k.destination}` : "—"}</Mono>
                </td>
                <td className="fm-mono">{formatNumber(k.volume)}</td>
                <td className="fm-mono">{k.difficulty.toFixed(0)}</td>
                <td className="fm-mono">{k.businessValue.toFixed(0)}</td>
                <td className="fm-mono font-semibold">{k.opportunityScore.toFixed(1)}</td>
                <td>
                  <Badge tone={ACTION_TONE[k.recommendedAction] ?? "neutral"}>{k.recommendedAction.replace(/_/g, " ")}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No keywords match" hint="Run keyword research, or clear the filter." />
        )}
      </Card>
    </>
  );
}
