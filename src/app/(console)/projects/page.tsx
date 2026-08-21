import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { BrandForm } from "@/app/(console)/projects/brand-form";
import { loadBrand } from "@/modules/brand/brand";
import { Badge, Callout, Card, EmptyState, Grid, KeyValue, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const { auth, project } = await requireProject();

  const [projects, websites, brand, dataSources] = await Promise.all([
    prisma.project.findMany({
      where: { organizationId: auth.organizationId },
      include: { _count: { select: { pages: true, keywords: true, websites: true } } },
    }),
    prisma.website.findMany({ where: { projectId: project.id } }),
    loadBrand(project.id).catch(() => null),
    prisma.dataSource.findMany({ where: { projectId: project.id } }),
  ]);

  return (
    <>
      <PageHeader
        title="Projects, websites & brand"
        description="The configuration layer: which site the system works on, and what its output must sound like."
        meta={
          <>
            <Badge tone="neutral">{projects.length} project(s)</Badge>
            <Badge tone="neutral">{auth.organizationName}</Badge>
            <Badge tone="brand">your role: {auth.role}</Badge>
          </>
        }
      />

      <Grid cols={2} className="mb-5">
        <Card title="Projects" padded={false}>
          <Table head={["Project", "Approval mode", "Pages", "Keywords", "Created"]}>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="font-medium">{p.name}</div>
                  <Mono>{p.slug}</Mono>
                  {p.description ? <div className="mt-0.5 max-w-[280px] text-[11.5px] text-[var(--color-ink-3)]">{p.description}</div> : null}
                </td>
                <td>
                  <Badge tone="brand">{p.approvalMode.replace("_", "-")}</Badge>
                </td>
                <td className="fm-mono">{p._count.pages}</td>
                <td className="fm-mono">{p._count.keywords}</td>
                <td className="text-[12px] text-[var(--color-ink-3)]">{timeAgo(p.createdAt)}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Websites" description="Where pages are published and what the crawler audits." padded={false}>
          {websites.length ? (
            <Table head={["Site", "Base URL", "CMS", "Verified", "Last crawl"]}>
              {websites.map((w) => (
                <tr key={w.id}>
                  <td>
                    <div className="font-medium">{w.name}</div>
                    <Mono>{w.domain}</Mono>
                  </td>
                  <td>
                    <a href={w.baseUrl} target="_blank" rel="noreferrer" className="text-[12px] text-[var(--color-brand)] hover:underline">
                      {w.baseUrl}
                    </a>
                  </td>
                  <td>
                    <Badge tone="neutral">{w.cms}</Badge>
                  </td>
                  <td>{w.verified ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">no</Badge>}</td>
                  <td className="text-[12px] text-[var(--color-ink-3)]">{w.lastCrawledAt ? timeAgo(w.lastCrawledAt) : "never"}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No website connected" />
          )}
        </Card>
      </Grid>

      <Card title="Data sources" description="Where the Dynamic Data Engine gets values, and how much each is trusted." padded={false} className="mb-5">
        <Table head={["Source", "Type", "Adapter", "Status", "Trust", "Mock"]}>
          {dataSources.map((d) => (
            <tr key={d.id}>
              <td>
                <div className="font-medium">{d.name}</div>
                <Mono>{d.key}</Mono>
              </td>
              <td className="text-[12px]">{d.type}</td>
              <td>
                <Mono>{d.adapter}</Mono>
              </td>
              <td>
                <StatusBadge status={d.status} />
              </td>
              <td className="fm-mono">{d.trustLevel.toFixed(2)}</td>
              <td>{d.isMock ? <Badge tone="mock">reference data</Badge> : <Badge tone="ok">live</Badge>}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card
        title="Brand & content knowledge"
        description="Read by every agent on every run. Skills say how to work; this says what the output must be like."
      >
        <div className="mb-4">
          <Callout tone="info" title="These rules are enforced, not just suggested">
            The words-to-avoid list and the price/superlative rules run as a deterministic compliance check after every
            generation. A violation fails the brand_compliance quality gate and the page cannot be published.
          </Callout>
        </div>
        {brand ? (
          <BrandForm
            initial={{
              brandName: brand.brandName,
              voice: brand.voice,
              tone: brand.tone,
              targetAudience: brand.targetAudience,
              writingStyle: brand.writingStyle,
              readingLevel: brand.readingLevel,
              ctaStyle: brand.ctaStyle,
              preferredTerms: brand.preferredTerms,
              avoidWords: brand.avoidWords,
              avoidClaims: brand.avoidClaims,
              editorialRules: brand.editorialRules,
            }}
          />
        ) : (
          <EmptyState title="No brand profile" hint="Run the seed to create one." />
        )}
      </Card>
    </>
  );
}
