import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Callout, Card, EmptyState, Grid, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";
import { RunAgentButton } from "@/ui/run-agent-button";

export const dynamic = "force-dynamic";

interface Issue {
  url: string;
  check: string;
  severity: "ERROR" | "WARNING" | "INFO";
  message: string;
}

export default async function TechnicalSeoPage() {
  const { project } = await requireProject();

  const website = await prisma.website.findFirst({ where: { projectId: project.id } });
  const [runs, results] = await Promise.all([
    prisma.crawlRun.findMany({
      where: { website: { projectId: project.id } },
      orderBy: { startedAt: "desc" },
      take: 8,
    }),
    website
      ? prisma.crawlResult.findMany({
          where: { websiteId: website.id },
          orderBy: { fetchedAt: "desc" },
          take: 60,
        })
      : [],
  ]);

  const latestByUrl = new Map<string, (typeof results)[number]>();
  for (const r of results) if (!latestByUrl.has(r.url)) latestByUrl.set(r.url, r);
  const pages = [...latestByUrl.values()];

  const allIssues = pages.flatMap((p) => readJson<Issue[]>(p.issuesJson, []));
  const errors = allIssues.filter((i) => i.severity === "ERROR");
  const warnings = allIssues.filter((i) => i.severity === "WARNING");

  const byCheck = allIssues.reduce<Record<string, { count: number; severity: string }>>((acc, i) => {
    acc[i.check] = { count: (acc[i.check]?.count ?? 0) + 1, severity: i.severity };
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title="Technical SEO"
        description="The built-in crawler fetches what was actually published over real HTTP and validates status, canonicals, indexability, headings, structured data, orphans and broken links."
        meta={
          website ? (
            <>
              <Mono>{website.baseUrl}</Mono>
              <Badge tone="neutral">{website.cms}</Badge>
              <Badge tone="neutral">last crawled {website.lastCrawledAt ? timeAgo(website.lastCrawledAt) : "never"}</Badge>
            </>
          ) : null
        }
        actions={
          website ? (
            <RunAgentButton agentKey="technical_seo" input={{ websiteId: website.id, maxPages: 50 }} label="Crawl now" variant="primary" />
          ) : undefined
        }
      />

      {!website ? (
        <Callout tone="warn" title="No website connected">
          Add a website to the project before running a crawl.
        </Callout>
      ) : null}

      <Grid cols={4} className="mb-5">
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Pages crawled</div>
          <div className="text-[24px] font-semibold">{pages.length}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Errors</div>
          <div className="text-[24px] font-semibold" style={{ color: errors.length ? "var(--color-danger)" : "var(--color-ok)" }}>
            {errors.length}
          </div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Warnings</div>
          <div className="text-[24px] font-semibold" style={{ color: warnings.length ? "var(--color-warn)" : "var(--color-ink)" }}>
            {warnings.length}
          </div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Indexable</div>
          <div className="text-[24px] font-semibold">
            {pages.filter((p) => p.indexable && p.httpStatus === 200).length}/{pages.length}
          </div>
        </div>
      </Grid>

      {Object.keys(byCheck).length ? (
        <Card title="Issues by check" className="mb-5">
          <div className="flex flex-wrap gap-2">
            {Object.entries(byCheck)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([check, v]) => (
                <Badge key={check} tone={v.severity === "ERROR" ? "danger" : v.severity === "WARNING" ? "warn" : "info"}>
                  {check.replace(/_/g, " ")} · {v.count}
                </Badge>
              ))}
          </div>
        </Card>
      ) : null}

      <Card title="Crawled pages" description="Latest result per URL." padded={false} className="mb-5">
        {pages.length ? (
          <Table head={["URL", "Status", "Title", "H1", "Canonical", "Indexable", "Words", "Links", "Schema", "Issues"]}>
            {pages.map((p) => {
              const issues = readJson<Issue[]>(p.issuesJson, []);
              const schemaTypes = readJson<string[]>(p.schemaTypesJson, []);
              return (
                <tr key={p.id}>
                  <td className="max-w-[240px]">
                    <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">
                      <Mono className="!text-[var(--color-ink)]">{p.url.replace(/^https?:\/\/[^/]+/, "")}</Mono>
                    </a>
                  </td>
                  <td>
                    <Badge tone={p.httpStatus === 200 ? "ok" : p.httpStatus === 0 || p.httpStatus >= 400 ? "danger" : "warn"}>
                      {p.httpStatus || "ERR"}
                    </Badge>
                  </td>
                  <td className="max-w-[200px] truncate text-[12px]" title={p.title ?? ""}>
                    {p.title ?? <span className="text-[var(--color-danger)]">missing</span>}
                  </td>
                  <td className="max-w-[160px] truncate text-[12px]">{p.h1 ?? <span className="text-[var(--color-danger)]">missing</span>}</td>
                  <td>{p.canonical ? <Badge tone="ok">set</Badge> : <Badge tone="warn">none</Badge>}</td>
                  <td>{p.indexable ? <Badge tone="ok">yes</Badge> : <Badge tone="danger">no</Badge>}</td>
                  <td className="fm-mono">{p.wordCount}</td>
                  <td className="fm-mono">{p.internalLinkCount}</td>
                  <td className="text-[11px]">{schemaTypes.length ? schemaTypes.join(", ") : "—"}</td>
                  <td>
                    {issues.length ? (
                      <div className="flex flex-col gap-0.5">
                        {issues.slice(0, 3).map((i, idx) => (
                          <span
                            key={idx}
                            className="text-[11px]"
                            style={{ color: i.severity === "ERROR" ? "var(--color-danger)" : "var(--color-warn)" }}
                            title={i.message}
                          >
                            {i.check}: {i.message.slice(0, 60)}
                          </span>
                        ))}
                        {issues.length > 3 ? <span className="text-[11px] text-[var(--color-ink-4)]">+{issues.length - 3} more</span> : null}
                      </div>
                    ) : (
                      <Badge tone="ok">clean</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState
            title="Nothing crawled yet"
            hint="Publish a page and run a crawl. The crawler fetches the real URL — start the dev server first so /site/* responds."
          />
        )}
      </Card>

      <Card title="Crawl runs" padded={false}>
        {runs.length ? (
          <Table head={["Started", "Status", "Adapter", "Pages", "Issues", "Error"]}>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="text-[12px] text-[var(--color-ink-3)]">{timeAgo(r.startedAt)}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td>
                  <Mono>{r.adapter}</Mono>
                </td>
                <td className="fm-mono">{r.pagesCrawled}</td>
                <td className="fm-mono">{r.issuesFound}</td>
                <td className="max-w-[300px] text-[12px] text-[var(--color-danger)]">{r.error ?? "—"}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No crawl runs" />
        )}
      </Card>
    </>
  );
}
