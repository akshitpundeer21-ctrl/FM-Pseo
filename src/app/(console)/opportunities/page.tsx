import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Card, Callout, EmptyState, Grid, Meter, MockBadge, Mono, PageHeader, StatusBadge, Table } from "@/ui/primitives";
import { RunAgentButton } from "@/ui/run-agent-button";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ decision?: string }> }) {
  const { project } = await requireProject();
  const sp = await searchParams;

  const [opportunities, byDecision, families] = await Promise.all([
    prisma.opportunity.findMany({
      where: { projectId: project.id, ...(sp.decision ? { decision: sp.decision } : {}) },
      orderBy: { totalScore: "desc" },
      take: 100,
      include: { pageFamily: { select: { key: true, name: true, minOpportunityScore: true } }, pages: { select: { id: true, status: true } } },
    }),
    prisma.opportunity.groupBy({ by: ["decision"], where: { projectId: project.id }, _count: { _all: true } }),
    prisma.pageFamily.findMany({ where: { projectId: project.id }, select: { key: true, name: true, status: true } }),
  ]);

  const counts = Object.fromEntries(byDecision.map((d) => [d.decision, d._count._all]));

  return (
    <>
      <PageHeader
        title="Programmatic opportunities"
        description="Every candidate page is scored before it exists. A combination existing is never a reason to build it — demand, data availability, differentiation and utility are."
        meta={
          <>
            <Badge tone="ok">{counts.BUILD ?? 0} BUILD</Badge>
            <Badge tone="warn">{counts.REVIEW ?? 0} REVIEW</Badge>
            <Badge tone="danger">{counts.REJECT ?? 0} REJECT</Badge>
          </>
        }
        actions={
          <RunAgentButton
            agentKey="programmatic_opportunity"
            input={{ pageFamilyKey: "route", maxCandidates: 20 }}
            label="Score route candidates"
            variant="primary"
          />
        }
      />

      <div className="mb-5">
        <Callout tone="info" title="How the decision is made">
          A candidate is <strong>REJECTED</strong> outright when under 40% of its required data bindings resolve, when it
          overlaps an existing page by more than 70%, or when its total score falls below the viability floor of 35. It is
          approved to <strong>BUILD</strong> only when it clears the page family&rsquo;s threshold, resolves at least 60% of
          its data, and stays under 45% duplication risk. Everything else goes to a human.
        </Callout>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <a href="/opportunities" className={`fm-btn !py-1 !text-[12px] ${!sp.decision ? "fm-btn-primary" : ""}`}>
          All
        </a>
        {["BUILD", "REVIEW", "REJECT"].map((d) => (
          <a key={d} href={`/opportunities?decision=${d}`} className={`fm-btn !py-1 !text-[12px] ${sp.decision === d ? "fm-btn-primary" : ""}`}>
            {d} ({counts[d] ?? 0})
          </a>
        ))}
      </div>

      <Card padded={false} className="mb-5">
        {opportunities.length ? (
          <div className="divide-y divide-[var(--color-border)]">
            {opportunities.map((o) => {
              const reasons = readJson<string[]>(o.reasonsJson, []);
              const built = o.pages[0];
              return (
                <div key={o.id} className="grid gap-4 px-4 py-4 lg:grid-cols-[1.5fr_1fr]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={o.decision} />
                      <span className="text-[13.5px] font-semibold">{o.title}</span>
                      {o.isMock ? <MockBadge /> : null}
                      {built ? <Badge tone={built.status === "PUBLISHED" ? "ok" : "info"}>page {built.status.toLowerCase()}</Badge> : null}
                    </div>
                    <Mono>{o.candidateUrl}</Mono>

                    <div className="mt-2 text-[12px] text-[var(--color-ink-2)]">
                      <span className="text-[var(--color-ink-3)]">Primary keyword:</span> {o.primaryKeyword ?? "—"}
                      <span className="mx-2 text-[var(--color-ink-4)]">·</span>
                      <span className="text-[var(--color-ink-3)]">Family:</span> {o.pageFamily?.name ?? "—"} (threshold{" "}
                      {o.pageFamily?.minOpportunityScore ?? "—"})
                    </div>

                    <ul className="mt-2 space-y-0.5 text-[11.5px] text-[var(--color-ink-2)]">
                      {reasons.map((r, i) => (
                        <li key={i} className="flex gap-1.5">
                          <span className="text-[var(--color-ink-4)]">•</span>
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Total score</span>
                      <span className="text-[20px] font-semibold">{o.totalScore.toFixed(1)}</span>
                    </div>
                    <div className="space-y-1.5">
                      <Meter value={o.searchDemand} label="Search demand" tone="brand" />
                      <Meter value={o.intentMatch} label="Intent match" tone="brand" />
                      <Meter value={o.dataAvailability} label="Data availability" tone={o.dataAvailability >= 60 ? "ok" : "danger"} />
                      <Meter value={o.uniqueness} label="Uniqueness" tone="info" />
                      <Meter value={o.userUtility} label="User utility" tone="info" />
                      <Meter value={o.competition} label="Competition (inverted)" tone="neutral" />
                      <Meter value={o.duplicationRisk} label="Duplication risk" tone={o.duplicationRisk > 45 ? "danger" : "neutral"} />
                      <Meter value={o.indexationRisk} label="Indexation risk" tone={o.indexationRisk > 45 ? "warn" : "neutral"} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No opportunities scored yet"
            hint="Run the Programmatic Opportunity agent, or give the orchestrator a growth goal."
          />
        )}
      </Card>

      <Card title="Page families in scope" padded={false}>
        <Table head={["Family", "Key", "Status"]}>
          {families.map((f) => (
            <tr key={f.key}>
              <td className="font-medium">{f.name}</td>
              <td>
                <Mono>{f.key}</Mono>
              </td>
              <td>
                <StatusBadge status={f.status} />
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
