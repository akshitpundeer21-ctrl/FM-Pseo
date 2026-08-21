import { prisma } from "@/core/db/client";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Bars, Callout, Card, EmptyState, Grid, Meter, MockBadge, Mono, PageHeader, Table, timeAgo } from "@/ui/primitives";
import { RunAgentButton } from "@/ui/run-agent-button";
import { env } from "@/core/config/env";
import { pct } from "@/core/utils/text";

export const dynamic = "force-dynamic";

export default async function AiVisibilityPage() {
  const { project } = await requireProject();

  const [prompts, runs, mentions, citations, recommendations] = await Promise.all([
    prisma.aIPrompt.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } }),
    prisma.aIRun.findMany({
      where: { prompt: { projectId: project.id } },
      orderBy: { runAt: "desc" },
      take: 60,
      include: { prompt: { select: { prompt: true, category: true } }, mentions: true, citations: true },
    }),
    prisma.aIMention.findMany({ where: { aiRun: { prompt: { projectId: project.id } } } }),
    prisma.aICitation.findMany({ where: { aiRun: { prompt: { projectId: project.id } } } }),
    prisma.recommendation.findMany({ where: { projectId: project.id, type: "AI_VISIBILITY" }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

  const total = runs.length;
  const mentionRate = total ? runs.filter((r) => r.brandMentioned).length / total : 0;
  const citationRate = total ? runs.filter((r) => r.brandCited).length / total : 0;
  const promptsCovered = new Set(runs.filter((r) => r.brandMentioned).map((r) => r.promptId)).size;
  const queryCoverage = prompts.length ? promptsCovered / prompts.length : 0;
  const ownedCitations = citations.filter((c) => c.isOwned).length;
  const citationShare = citations.length ? ownedCitations / citations.length : 0;
  const isMock = total > 0 && runs.every((r) => r.isMock);

  const brandMentions = mentions.filter((m) => m.entityType === "BRAND").length;
  const competitorTally = new Map<string, number>();
  for (const m of mentions.filter((m) => m.entityType === "COMPETITOR")) {
    competitorTally.set(m.entityName, (competitorTally.get(m.entityName) ?? 0) + 1);
  }
  const competitorBars = [...competitorTally.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const visibilityScore = (mentionRate * 0.3 + citationRate * 0.35 + queryCoverage * 0.2 + citationShare * 0.15) * 100;

  const uncovered = prompts.filter((p) => !runs.some((r) => r.promptId === p.id && r.brandMentioned));

  return (
    <>
      <PageHeader
        title="AI visibility"
        description="How often the brand is mentioned and cited in generated answers, sampled across a prompt library."
        meta={
          <>
            <Badge tone="neutral">{prompts.length} prompts</Badge>
            <Badge tone="neutral">{total} recorded runs</Badge>
            <Badge tone="neutral">platforms: {env().AI_VISIBILITY_PLATFORMS}</Badge>
            {isMock ? <MockBadge /> : null}
          </>
        }
        actions={<RunAgentButton agentKey="ai_visibility" input={{ limit: 8 }} label="Run the prompt library" variant="primary" />}
      />

      <div className="mb-5">
        <Callout tone="info" title="These are not rankings">
          Answer engines synthesise from sources; they do not rank pages the way a search engine does. What is measured here
          is whether the brand is <strong>mentioned</strong> in an answer and whether one of our URLs is <strong>cited</strong>,
          sampled repeatedly over a prompt library. No technique guarantees a citation, and none is claimed here.
          {isMock ? " The current runs come from the deterministic mock assistant because no answer-engine API is connected." : ""}
        </Callout>
      </div>

      <Grid cols={4} className="mb-5">
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Visibility score</div>
          <div className="text-[26px] font-semibold">{total ? visibilityScore.toFixed(1) : "—"}</div>
          <div className="text-[11px] text-[var(--color-ink-4)]">weighted composite</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Mention rate</div>
          <div className="text-[26px] font-semibold">{total ? pct(mentionRate, 0) : "—"}</div>
          <div className="text-[11px] text-[var(--color-ink-4)]">{runs.filter((r) => r.brandMentioned).length} of {total} runs</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Citation rate</div>
          <div className="text-[26px] font-semibold">{total ? pct(citationRate, 0) : "—"}</div>
          <div className="text-[11px] text-[var(--color-ink-4)]">{ownedCitations} owned citations</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Query coverage</div>
          <div className="text-[26px] font-semibold">{prompts.length ? pct(queryCoverage, 0) : "—"}</div>
          <div className="text-[11px] text-[var(--color-ink-4)]">{promptsCovered} of {prompts.length} prompts</div>
        </div>
      </Grid>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Share of voice" description="Brand vs competitor mentions across all recorded answers.">
          {competitorBars.length || brandMentions ? (
            <Bars
              data={[
                { label: `${project.name} (brand)`, value: brandMentions, tone: "var(--color-brand)" },
                ...competitorBars.map((c) => ({ ...c, tone: "var(--color-ink-4)" })),
              ]}
            />
          ) : (
            <EmptyState title="No mentions recorded" />
          )}
          <div className="mt-3 text-[11.5px] text-[var(--color-ink-3)]">
            Citation share: <strong>{citations.length ? pct(citationShare, 0) : "—"}</strong> of {citations.length} cited URLs
            belong to us.
          </div>
        </Card>

        <Card title="Uncovered prompts" description="Prompts where the brand never appeared — these are content gaps." padded={false}>
          {uncovered.length ? (
            <div className="divide-y divide-[var(--color-border)]">
              {uncovered.slice(0, 10).map((p) => (
                <div key={p.id} className="px-4 py-2.5">
                  <div className="text-[12.5px]">{p.prompt}</div>
                  <div className="mt-0.5 flex gap-1.5">
                    <Badge tone="neutral">{p.category}</Badge>
                    <Badge tone="neutral">{p.intent}</Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title={total ? "Every prompt mentions the brand" : "No runs yet"} />
          )}
        </Card>
      </div>

      <Card title="Recorded runs" description="Full response, mentions and citations are stored for every probe." padded={false} className="mb-5">
        {runs.length ? (
          <Table head={["Prompt", "Platform", "Brand", "Cited", "Mentions", "Citations", "When"]}>
            {runs.slice(0, 30).map((r) => (
              <tr key={r.id}>
                <td className="max-w-[300px]">
                  <div className="truncate text-[12.5px]" title={r.prompt.prompt}>
                    {r.prompt.prompt}
                  </div>
                  {r.responseText ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-[var(--color-ink-3)]">show answer</summary>
                      <p className="mt-1 max-w-[520px] whitespace-pre-line text-[11.5px] text-[var(--color-ink-2)]">
                        {r.responseText.slice(0, 900)}
                      </p>
                    </details>
                  ) : null}
                  {r.error ? <div className="mt-1 text-[11px] text-[var(--color-danger)]">{r.error}</div> : null}
                </td>
                <td>
                  <Mono>{r.platform}</Mono>
                  <div className="text-[10.5px] text-[var(--color-ink-4)]">{r.model}</div>
                  {r.isMock ? (
                    <div className="mt-0.5">
                      <MockBadge />
                    </div>
                  ) : null}
                </td>
                <td>{r.brandMentioned ? <Badge tone="ok">mentioned</Badge> : <Badge tone="neutral">no</Badge>}</td>
                <td>{r.brandCited ? <Badge tone="ok">cited</Badge> : <Badge tone="neutral">no</Badge>}</td>
                <td className="text-[11.5px]">
                  {r.mentions.length ? r.mentions.map((m) => m.entityName).join(", ") : "—"}
                </td>
                <td className="max-w-[180px] text-[11px]">
                  {r.citations.length ? (
                    <div className="flex flex-col gap-0.5">
                      {r.citations.slice(0, 3).map((c) => (
                        <span key={c.id} className={c.isOwned ? "font-semibold text-[var(--color-ok)]" : "text-[var(--color-ink-3)]"}>
                          {c.domain}
                        </span>
                      ))}
                    </div>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(r.runAt)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No probes recorded" hint="Run the prompt library to start measuring." />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Prompt library" description="The sample set. Add prompts that reflect how your customers actually ask." padded={false}>
          <Table head={["Prompt", "Category", "Intent", "Runs"]}>
            {prompts.map((p) => (
              <tr key={p.id}>
                <td className="max-w-[320px] text-[12px]">{p.prompt}</td>
                <td>
                  <Badge tone="neutral">{p.category}</Badge>
                </td>
                <td className="text-[12px]">{p.intent}</td>
                <td className="fm-mono">{runs.filter((r) => r.promptId === p.id).length}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Recommendations" padded={false}>
          {recommendations.length ? (
            <div className="divide-y divide-[var(--color-border)]">
              {recommendations.map((r) => (
                <div key={r.id} className="px-4 py-3">
                  <div className="text-[13px] font-medium">{r.title}</div>
                  <p className="mt-1 whitespace-pre-line text-[12px] text-[var(--color-ink-2)]">{r.detail}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No AI visibility recommendations yet" />
          )}
        </Card>
      </div>
    </>
  );
}
