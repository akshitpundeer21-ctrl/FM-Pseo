import { prisma } from "@/core/db/client";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Bars, Callout, Card, EmptyState, Grid, Mono, PageHeader, Table } from "@/ui/primitives";
import { pct } from "@/core/utils/text";

export const dynamic = "force-dynamic";

export default async function CompetitorsPage() {
  const { project } = await requireProject();

  const [competitors, mentions, citations, totalRuns] = await Promise.all([
    prisma.competitor.findMany({ where: { projectId: project.id }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }] }),
    prisma.aIMention.findMany({ where: { aiRun: { prompt: { projectId: project.id } } } }),
    prisma.aICitation.findMany({ where: { aiRun: { prompt: { projectId: project.id } } } }),
    prisma.aIRun.count({ where: { prompt: { projectId: project.id } } }),
  ]);

  const mentionByName = new Map<string, number>();
  for (const m of mentions) mentionByName.set(m.entityName, (mentionByName.get(m.entityName) ?? 0) + 1);

  const citationByDomain = new Map<string, number>();
  for (const c of citations) citationByDomain.set(c.domain, (citationByDomain.get(c.domain) ?? 0) + 1);

  const totalMentions = mentions.length || 1;

  return (
    <>
      <PageHeader
        title="Competitors"
        description="The competitive set used by AI visibility measurement and content-gap analysis. Only observable behaviour is recorded."
        meta={<Badge tone="neutral">{competitors.length} tracked</Badge>}
      />

      <div className="mb-5">
        <Callout tone="info" title="What is and is not claimed here">
          Mention and citation counts are measured from the answers recorded by the AI Visibility module. Nothing here implies
          knowledge of any competitor&rsquo;s content formula, ranking, or internal strategy. The seeded list is illustrative —
          replace it with your real competitive set.
        </Callout>
      </div>

      <Grid cols={2} className="mb-5">
        <Card title="Mention share in generated answers" description={`Across ${totalRuns} recorded probes.`}>
          {mentionByName.size ? (
            <Bars
              data={[...mentionByName.entries()]
                .map(([label, value]) => ({ label, value }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 10)}
            />
          ) : (
            <EmptyState title="No mentions recorded yet" hint="Run the AI visibility prompt library." />
          )}
        </Card>

        <Card title="Cited domains" description="Which domains answer engines actually pointed at.">
          {citationByDomain.size ? (
            <Bars
              data={[...citationByDomain.entries()]
                .map(([label, value]) => ({ label, value }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 10)}
            />
          ) : (
            <EmptyState title="No citations recorded yet" />
          )}
        </Card>
      </Grid>

      <Card title="Competitive set" padded={false}>
        {competitors.length ? (
          <Table head={["Competitor", "Domain", "Primary", "Mentions", "Mention share", "Citations", "Notes"]}>
            {competitors.map((c) => {
              const m = mentionByName.get(c.name) ?? 0;
              const cite = citationByDomain.get(c.domain) ?? 0;
              return (
                <tr key={c.id}>
                  <td className="font-medium">{c.name}</td>
                  <td>
                    <Mono>{c.domain}</Mono>
                  </td>
                  <td>{c.isPrimary ? <Badge tone="brand">primary</Badge> : <span className="text-[12px] text-[var(--color-ink-4)]">—</span>}</td>
                  <td className="fm-mono">{m}</td>
                  <td className="fm-mono">{mentions.length ? pct(m / totalMentions, 0) : "—"}</td>
                  <td className="fm-mono">{cite}</td>
                  <td className="max-w-[260px] text-[12px] text-[var(--color-ink-3)]">{c.notes ?? "—"}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title="No competitors configured" />
        )}
      </Card>
    </>
  );
}
