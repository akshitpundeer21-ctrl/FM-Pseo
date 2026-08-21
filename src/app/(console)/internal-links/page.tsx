import Link from "next/link";
import { prisma } from "@/core/db/client";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Callout, Card, EmptyState, Grid, Mono, PageHeader, StatusBadge, Table } from "@/ui/primitives";
import { RunAgentButton } from "@/ui/run-agent-button";

export const dynamic = "force-dynamic";

export default async function InternalLinksPage() {
  const { project } = await requireProject();

  const [links, pages, brand] = await Promise.all([
    prisma.internalLink.findMany({
      where: { projectId: project.id },
      orderBy: { relevance: "desc" },
      take: 200,
      include: { fromPage: { select: { url: true, title: true, id: true } }, toPage: { select: { url: true, status: true } } },
    }),
    prisma.page.findMany({
      where: { projectId: project.id },
      select: { id: true, url: true, title: true, status: true, _count: { select: { linksFrom: true, linksTo: true } } },
    }),
    prisma.brandProfile.findUnique({ where: { projectId: project.id }, select: { linkingRulesJson: true } }),
  ]);

  const rules = JSON.parse(brand?.linkingRulesJson ?? "{}") as { minInternalLinks?: number; relevanceFloor?: number };
  const orphans = pages.filter((p) => p.status === "PUBLISHED" && p._count.linksTo === 0);
  const underLinked = pages.filter((p) => p._count.linksFrom < (rules.minInternalLinks ?? 3) && p.status !== "REJECTED");

  return (
    <>
      <PageHeader
        title="Internal links"
        description="Links are proposed from the entity graph — shared airports, cities, carriers and sibling routes — and scored by relevance. There is no link quota."
        meta={
          <>
            <Badge tone="neutral">{links.length} proposed</Badge>
            <Badge tone={orphans.length ? "danger" : "ok"}>{orphans.length} orphan(s)</Badge>
            <Badge tone="neutral">relevance floor {rules.relevanceFloor ?? 0.35}</Badge>
          </>
        }
        actions={<RunAgentButton agentKey="internal_linking" input={{ projectWide: true }} label="Re-link all pages" variant="primary" />}
      />

      {orphans.length ? (
        <div className="mb-5">
          <Callout tone="danger" title={`${orphans.length} published page(s) have no inbound internal link`}>
            An orphan is a real defect: nothing on the site points at it. Publish more sibling pages or re-run the linking
            agent once the graph is denser.
            <ul className="mt-1.5 list-inside list-disc">
              {orphans.slice(0, 6).map((o) => (
                <li key={o.id}>{o.url}</li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}

      <Grid cols={2} className="mb-5">
        <Card title="Link graph coverage" padded={false}>
          <Table head={["Page", "Status", "Outbound", "Inbound"]}>
            {pages.map((p) => (
              <tr key={p.id}>
                <td className="max-w-[280px]">
                  <Link href={`/content/${p.id}`} className="hover:underline">
                    <Mono className="!text-[var(--color-ink)]">{p.url}</Mono>
                  </Link>
                </td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
                <td className="fm-mono" style={{ color: p._count.linksFrom < (rules.minInternalLinks ?? 3) ? "var(--color-warn)" : undefined }}>
                  {p._count.linksFrom}
                </td>
                <td className="fm-mono" style={{ color: p._count.linksTo === 0 && p.status === "PUBLISHED" ? "var(--color-danger)" : undefined }}>
                  {p._count.linksTo}
                </td>
              </tr>
            ))}
            {!pages.length ? (
              <tr>
                <td colSpan={4}>
                  <span className="text-[12px] text-[var(--color-ink-4)]">No pages yet.</span>
                </td>
              </tr>
            ) : null}
          </Table>
        </Card>

        <Card title="Why links were proposed" description="Relevance comes from shared entities, not from a target count." padded={false}>
          {links.length ? (
            <Table head={["From", "To", "Anchor", "Relevance", "Reason"]}>
              {links.slice(0, 40).map((l) => (
                <tr key={l.id}>
                  <td className="max-w-[150px] truncate">
                    <Mono>{l.fromPage?.url ?? "—"}</Mono>
                  </td>
                  <td className="max-w-[150px] truncate">
                    <Mono>{l.targetUrl}</Mono>
                  </td>
                  <td className="max-w-[160px] truncate text-[12px]">{l.anchorText}</td>
                  <td className="fm-mono font-semibold">{l.relevance.toFixed(2)}</td>
                  <td className="max-w-[220px] text-[11.5px] text-[var(--color-ink-3)]">{l.reason}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState
              title="No links proposed yet"
              hint="Links need at least two published or approved pages that share entities. Publish more of the route family, then re-run."
            />
          )}
        </Card>
      </Grid>
    </>
  );
}
