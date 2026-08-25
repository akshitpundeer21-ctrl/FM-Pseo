import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Callout, Card, EmptyState, Grid, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";
import { env } from "@/core/config/env";
import { listIntegrations } from "@/integrations/service";

export const dynamic = "force-dynamic";

export default async function PublishingPage() {
  const { auth, project } = await requireProject();

  const [records, website, integrations, statusCounts] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { pageVersion: { page: { projectId: project.id } } },
      orderBy: { publishedAt: "desc" },
      take: 60,
      include: { pageVersion: { include: { page: { select: { id: true, url: true, title: true, status: true } } } } },
    }),
    prisma.website.findFirst({ where: { projectId: project.id } }),
    listIntegrations(auth.organizationId, project.id),
    prisma.page.groupBy({ by: ["status"], where: { projectId: project.id }, _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));
  const cmsIntegrations = integrations.filter((i) => i.category === "CMS");
  const fallbacks = records.filter((r) => readJson<{ fellBack?: boolean }>(r.responseJson, {}).fellBack);

  return (
    <>
      <PageHeader
        title="Publishing"
        description="The publishing lifecycle: draft → validated → approved → published, with update, unpublish and rollback. Only the Publishing Agent holds the publish capability."
        meta={
          <>
            <Badge tone="neutral">adapter: {website?.cms ?? env().PUBLISH_ADAPTER}</Badge>
            <Badge tone="ok">{counts.PUBLISHED ?? 0} published</Badge>
            <Badge tone="warn">{(counts.VALIDATED ?? 0) + (counts.REVIEW ?? 0)} awaiting publication</Badge>
            <Badge tone="danger">{counts.REJECTED ?? 0} rejected</Badge>
          </>
        }
        actions={
          <a href="/site" target="_blank" rel="noreferrer" className="fm-btn">
            Open published site
          </a>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Active adapter" className="lg:col-span-1">
          <div className="text-[13px] font-semibold">{website?.cms ?? env().PUBLISH_ADAPTER}</div>
          <p className="mt-1 text-[12px] text-[var(--color-ink-2)]">
            {(website?.cms ?? env().PUBLISH_ADAPTER) === "local_static"
              ? "Writes a complete HTML document to the published directory. The app serves it at /site/*, so the crawler can fetch the real page back over HTTP."
              : (website?.cms ?? env().PUBLISH_ADAPTER) === "database"
                ? "Stores the rendered HTML in the database. Used on serverless platforms (Vercel) where the filesystem is ephemeral."
                : "Publishes through the configured CMS integration."}
          </p>
          <div className="mt-3">
            <Mono>{env().PUBLISH_LOCAL_DIR}</Mono>
          </div>
        </Card>

        <Card title="CMS integrations" className="lg:col-span-2" padded={false}>
          <Table head={["Provider", "Status", "Falls back to", ""]}>
            {cmsIntegrations.map((i) => (
              <tr key={i.provider}>
                <td>
                  <div className="font-medium">{i.name}</div>
                  <div className="text-[11.5px] text-[var(--color-ink-3)]">{i.description}</div>
                </td>
                <td>
                  <StatusBadge status={i.status} />
                </td>
                <td className="max-w-[300px] text-[11.5px] text-[var(--color-ink-3)]">{i.degradesTo}</td>
                <td>
                  <Link href="/integrations" className="fm-btn !py-1 !text-[12px]">
                    Configure
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      {fallbacks.length ? (
        <div className="mb-5">
          <Callout tone="warn" title={`${fallbacks.length} publish(es) used a fallback adapter`}>
            The requested CMS was not configured, so the page was written to the local static site instead. The publish record
            below records exactly which adapter ran — nothing is reported as having reached a CMS that it did not.
          </Callout>
        </div>
      ) : null}

      <Card title="Publish records" description="Every publish, update, unpublish and rollback." padded={false}>
        {records.length ? (
          <Table head={["Page", "Version", "Adapter", "Status", "Destination", "Actor", "When"]}>
            {records.map((r) => {
              const meta = readJson<{ fellBack?: boolean; reason?: string }>(r.responseJson, {});
              return (
                <tr key={r.id}>
                  <td className="max-w-[240px]">
                    <Link href={`/content/${r.pageVersion.page.id}`} className="font-medium hover:underline">
                      {r.pageVersion.page.title}
                    </Link>
                    <Mono className="mt-0.5 block">{r.pageVersion.page.url}</Mono>
                  </td>
                  <td className="fm-mono">v{r.pageVersion.version}</td>
                  <td>
                    <Mono className="!text-[var(--color-ink)]">{r.adapter}</Mono>
                    {meta.fellBack ? (
                      <div className="mt-0.5">
                        <Badge tone="warn" title={meta.reason}>
                          fallback
                        </Badge>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="max-w-[240px] truncate text-[12px]">
                    {r.remoteUrl ? (
                      <a href={r.remoteUrl} target="_blank" rel="noreferrer" className="text-[var(--color-brand)] hover:underline">
                        {r.remoteUrl}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="text-[12px]">{r.actor}</td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(r.publishedAt)}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState
            title="Nothing published yet"
            hint="Pages publish only after the quality gate passes and a human approves."
            action={
              <Link href="/approvals" className="fm-btn">
                Check approvals
              </Link>
            }
          />
        )}
      </Card>
    </>
  );
}
