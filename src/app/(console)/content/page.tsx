import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Card, CompositionBar, EmptyState, MockBadge, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";
import { formatNumber } from "@/core/utils/text";

export const dynamic = "force-dynamic";

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { project } = await requireProject();
  const sp = await searchParams;

  const [pages, statusCounts] = await Promise.all([
    prisma.page.findMany({
      where: { projectId: project.id, ...(sp.status ? { status: sp.status } : {}) },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        pageFamily: { select: { name: true } },
        versions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, wordCount: true, compositionJson: true, status: true } },
        _count: { select: { versions: true, linksFrom: true, schemas: true } },
      },
    }),
    prisma.page.groupBy({ by: ["status"], where: { projectId: project.id }, _count: { _all: true } }),
  ]);

  return (
    <>
      <PageHeader
        title="Content"
        description="Generated pages, their version history, composition mix and quality score. Nothing here is live until it has been approved and published."
        meta={
          <>
            {statusCounts.map((s) => (
              <Link key={s.status} href={`/content?status=${s.status}`}>
                <Badge tone="neutral">
                  {s.status.toLowerCase()} {s._count._all}
                </Badge>
              </Link>
            ))}
          </>
        }
        actions={
          sp.status ? (
            <Link href="/content" className="fm-btn">
              Clear filter
            </Link>
          ) : undefined
        }
      />

      <Card padded={false}>
        {pages.length ? (
          <Table head={["Page", "Family", "Status", "Quality", "Composition", "Words", "Versions", "Links", "Updated"]}>
            {pages.map((p) => {
              const v = p.versions[0];
              const comp = v ? readJson<{ templateShare: number; dynamicShare: number; aiShare: number; withinPolicy: boolean }>(v.compositionJson, { templateShare: 0, dynamicShare: 0, aiShare: 0, withinPolicy: true }) : null;
              return (
                <tr key={p.id}>
                  <td className="max-w-[280px]">
                    <Link href={`/content/${p.id}`} className="font-medium hover:underline">
                      {p.title}
                    </Link>
                    <Mono className="mt-0.5 block">{p.url}</Mono>
                  </td>
                  <td className="text-[12px]">{p.pageFamily?.name ?? "—"}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>
                    <span className="fm-mono font-semibold">{p.qualityScore ? p.qualityScore.toFixed(1) : "—"}</span>
                    {p.qualityStatus !== "PENDING" ? (
                      <div className="mt-0.5">
                        <StatusBadge status={p.qualityStatus} />
                      </div>
                    ) : null}
                  </td>
                  <td className="min-w-[170px]">
                    {comp ? <CompositionBar template={comp.templateShare} dynamic={comp.dynamicShare} ai={comp.aiShare} withinPolicy={comp.withinPolicy} /> : "—"}
                  </td>
                  <td className="fm-mono">{v ? formatNumber(v.wordCount) : "—"}</td>
                  <td className="fm-mono">{p._count.versions}</td>
                  <td className="fm-mono">{p._count.linksFrom}</td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(p.updatedAt)}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState
            title="No content generated yet"
            hint="Run a growth goal: the orchestrator scores opportunities first, then generates only the pages that clear the gate."
            action={
              <Link href="/goals" className="fm-btn fm-btn-primary">
                Give the orchestrator a goal
              </Link>
            }
          />
        )}
      </Card>
    </>
  );
}
