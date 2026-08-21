import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import {
  Badge,
  Callout,
  Card,
  CompositionBar,
  EmptyState,
  Grid,
  KeyValue,
  Meter,
  MockBadge,
  Mono,
  PageHeader,
  StatusBadge,
  Table,
  timeAgo,
} from "@/ui/primitives";
import { RollbackButton } from "@/app/(console)/content/[id]/rollback-button";
import { formatNumber } from "@/core/utils/text";

export const dynamic = "force-dynamic";

interface BlockMeta {
  blockKey: string;
  componentKey: string;
  source: string;
  rendered: boolean;
  isRequired?: boolean;
  skippedReason?: string | null;
  usedPaths?: string[];
  wordCount?: number;
}

export default async function PageDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { project } = await requireProject();

  const page = await prisma.page.findFirst({
    where: { id, projectId: project.id },
    include: {
      pageFamily: true,
      template: { select: { key: true, name: true } },
      opportunity: { select: { id: true, totalScore: true, decision: true, candidateUrl: true } },
      versions: {
        orderBy: { version: "desc" },
        include: {
          qualityChecks: true,
          contentItems: { orderBy: { sequence: "asc" } },
          publishRecords: { orderBy: { publishedAt: "desc" } },
        },
      },
      schemas: true,
      linksFrom: { include: { toPage: { select: { url: true, title: true } } } },
      approvals: { orderBy: { createdAt: "desc" }, include: { decidedBy: { select: { name: true } } } },
    },
  });

  if (!page) notFound();

  const current = page.versions[0];
  const quality = current ? readJson<{ score?: number; decision?: string; blockingReasons?: string[]; warnings?: string[] }>(current.qualityJson, {}) : {};
  const composition = current
    ? readJson<{ templateShare: number; dynamicShare: number; aiShare: number; withinPolicy: boolean; policyNotes: string[] }>(current.compositionJson, {
        templateShare: 0,
        dynamicShare: 0,
        aiShare: 0,
        withinPolicy: true,
        policyNotes: [],
      })
    : null;
  const blocks = current ? readJson<BlockMeta[]>(current.blocksJson, []) : [];
  const aeo = current ? readJson<{ faqs?: { question: string; answer: string }[]; answerWords?: number }>(current.aeoJson, {}) : {};
  const geo = current
    ? readJson<{ evidence?: { claim: string; source: string; retrievedAt: string; isMock: boolean }[]; entities?: { name: string; type: string; identifier: string | null; disambiguated: boolean }[]; coverageGaps?: string[] }>(current.geoJson, {})
    : {};
  const facts = current ? readJson<{ verdicts?: { claim: string; kind: string; status: string; source: string | null; evidence: string | null }[] }>(current.factsJson, {}) : {};
  const published = current?.publishRecords.find((r) => r.status === "PUBLISHED");

  return (
    <>
      <PageHeader
        title={page.title}
        description={page.metaDescription ?? undefined}
        meta={
          <>
            <Mono>{page.url}</Mono>
            <StatusBadge status={page.status} />
            {page.qualityStatus !== "PENDING" ? <StatusBadge status={page.qualityStatus} /> : null}
            <Badge tone="neutral">v{page.currentVersion}</Badge>
            {page.pageFamily ? <Badge tone="neutral">{page.pageFamily.name}</Badge> : null}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {published ? (
              <a href={published.remoteUrl ?? `/site${page.url}`} target="_blank" rel="noreferrer" className="fm-btn">
                View live page
              </a>
            ) : null}
            {page.status === "PUBLISHED" ? <RollbackButton pageId={page.id} /> : null}
          </div>
        }
      />

      <Grid cols={4} className="mb-5">
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Quality score</div>
          <div className="text-[24px] font-semibold" style={{ color: (quality.score ?? 0) >= 70 ? "var(--color-ok)" : "var(--color-warn)" }}>
            {quality.score?.toFixed(1) ?? "—"}
          </div>
          <div className="text-[11.5px] text-[var(--color-ink-3)]">{quality.decision ?? "not gated yet"}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Words</div>
          <div className="text-[24px] font-semibold">{current ? formatNumber(current.wordCount) : "—"}</div>
          <div className="text-[11.5px] text-[var(--color-ink-3)]">{blocks.filter((b) => b.rendered).length} of {blocks.length} blocks rendered</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Opportunity score</div>
          <div className="text-[24px] font-semibold">{page.opportunity?.totalScore.toFixed(1) ?? "—"}</div>
          <div className="text-[11.5px] text-[var(--color-ink-3)]">{page.opportunity?.decision ?? "—"}</div>
        </div>
        <div className="fm-card p-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">Structured data</div>
          <div className="text-[24px] font-semibold">{page.schemas.length}</div>
          <div className="text-[11.5px] text-[var(--color-ink-3)]">
            {page.schemas.filter((s) => s.validationStatus === "VALID").length} valid
          </div>
        </div>
      </Grid>

      {quality.blockingReasons?.length ? (
        <div className="mb-4">
          <Callout tone="danger" title="Blocked by the quality gate">
            <ul className="list-inside list-disc space-y-0.5">
              {quality.blockingReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}

      {quality.warnings?.length ? (
        <div className="mb-4">
          <Callout tone="warn" title="Warnings">
            <ul className="list-inside list-disc space-y-0.5">
              {quality.warnings.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card title="Composition" description="Measured from what actually rendered, compared against the family policy.">
          {composition ? (
            <>
              <CompositionBar
                template={composition.templateShare}
                dynamic={composition.dynamicShare}
                ai={composition.aiShare}
                withinPolicy={composition.withinPolicy}
              />
              {composition.policyNotes?.length ? (
                <ul className="mt-3 list-inside list-disc space-y-0.5 text-[11.5px] text-[var(--color-warn)]">
                  {composition.policyNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <EmptyState title="No version yet" />
          )}
        </Card>

        <Card title="Provenance">
          <KeyValue
            rows={[
              { label: "Template", value: page.template ? <Mono>{page.template.key}</Mono> : "—" },
              { label: "Opportunity", value: page.opportunity ? <Mono>{page.opportunity.candidateUrl}</Mono> : "—" },
              { label: "Created", value: timeAgo(page.createdAt) },
              { label: "Published", value: page.publishedAt ? timeAgo(page.publishedAt) : "not published" },
              { label: "Adapter", value: published?.adapter ?? "—" },
            ]}
          />
        </Card>
      </div>

      <Card title="Quality gates" description="Each gate is scored and weighted; an ERROR-severity failure blocks publication." padded={false} className="mb-5">
        {current?.qualityChecks.length ? (
          <Table head={["Gate", "Result", "Severity", "Score", "Detail"]}>
            {current.qualityChecks.map((g) => (
              <tr key={g.id}>
                <td>
                  <Mono className="!text-[var(--color-ink)]">{g.gate}</Mono>
                </td>
                <td>{g.passed ? <Badge tone="ok">pass</Badge> : <Badge tone={g.severity === "ERROR" ? "danger" : "warn"}>fail</Badge>}</td>
                <td>
                  <StatusBadge status={g.severity} />
                </td>
                <td className="fm-mono">{g.score.toFixed(0)}</td>
                <td className="max-w-[520px] text-[12px] text-[var(--color-ink-2)]">{g.message}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="Quality gate has not run for this version" />
        )}
      </Card>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Fact verification" description="Every checkable claim matched to an attributed source." padded={false}>
          {facts.verdicts?.length ? (
            <Table head={["Claim", "Status", "Source"]}>
              {facts.verdicts.map((v, i) => (
                <tr key={i}>
                  <td className="max-w-[220px]">
                    <div className="font-medium">{v.claim}</div>
                    <Mono>{v.kind}</Mono>
                  </td>
                  <td>
                    <StatusBadge status={v.status} />
                  </td>
                  <td className="max-w-[280px] text-[11.5px] text-[var(--color-ink-3)]">{v.evidence ?? v.source ?? "—"}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No claims verified yet" />
          )}
        </Card>

        <Card title="Evidence block (GEO)" description="What the page tells readers about where its facts came from." padded={false}>
          {geo.evidence?.length ? (
            <Table head={["Claim", "Source", "Retrieved"]}>
              {geo.evidence.map((e, i) => (
                <tr key={i}>
                  <td className="max-w-[220px] text-[12px]">{e.claim}</td>
                  <td className="max-w-[240px] text-[11.5px] text-[var(--color-ink-3)]">
                    {e.source} {e.isMock ? <MockBadge label="reference" /> : null}
                  </td>
                  <td className="fm-mono">{e.retrievedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No evidence rows" />
          )}
        </Card>
      </div>

      <Card title="Block-by-block breakdown" description="What rendered, from which source, and why anything was skipped." padded={false} className="mb-5">
        {blocks.length ? (
          <Table head={["#", "Component", "Source", "Rendered", "Words", "Data used / reason"]}>
            {blocks.map((b, i) => {
              const item = current?.contentItems.find((c) => c.blockKey === b.blockKey);
              return (
                <tr key={b.blockKey}>
                  <td className="fm-mono">{i}</td>
                  <td>
                    <Mono className="!text-[var(--color-ink)]">{b.componentKey}</Mono>
                    {b.isRequired ? (
                      <div className="mt-0.5">
                        <Badge tone="danger">required</Badge>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <Badge tone={b.source === "AI" ? "mock" : b.source === "DYNAMIC" ? "info" : "neutral"}>{b.source}</Badge>
                  </td>
                  <td>{b.rendered ? <Badge tone="ok">yes</Badge> : <Badge tone="neutral">no</Badge>}</td>
                  <td className="fm-mono">{b.wordCount ?? item?.text.split(/\s+/).length ?? 0}</td>
                  <td className="max-w-[420px] text-[11.5px] text-[var(--color-ink-3)]">
                    {b.rendered ? (b.usedPaths?.length ? b.usedPaths.join(", ") : "—") : <span className="text-[var(--color-warn)]">{b.skippedReason}</span>}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title="No blocks recorded" />
        )}
      </Card>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="FAQ / answer targets (AEO)" padded={false}>
          {aeo.faqs?.length ? (
            <div className="divide-y divide-[var(--color-border)]">
              {aeo.faqs.map((f, i) => (
                <div key={i} className="px-4 py-3">
                  <div className="text-[12.5px] font-semibold">{f.question}</div>
                  <p className="mt-1 text-[12px] text-[var(--color-ink-2)]">{f.answer}</p>
                  <div className="mt-1 text-[10.5px] text-[var(--color-ink-4)]">{f.answer.split(/\s+/).length} words</div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No FAQ entries" />
          )}
        </Card>

        <Card title="Entities & structured data" padded={false}>
          {geo.entities?.length ? (
            <Table head={["Entity", "Type", "Identifier", "Disambiguated"]}>
              {geo.entities.map((e, i) => (
                <tr key={i}>
                  <td className="text-[12px] font-medium">{e.name}</td>
                  <td className="text-[12px]">{e.type}</td>
                  <td>
                    <Mono>{e.identifier ?? "—"}</Mono>
                  </td>
                  <td>{e.disambiguated ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">no</Badge>}</td>
                </tr>
              ))}
            </Table>
          ) : null}
          <div className="border-t border-[var(--color-border)] px-4 py-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">JSON-LD emitted</div>
            <div className="flex flex-wrap gap-1.5">
              {page.schemas.map((s) => (
                <Badge key={s.id} tone={s.validationStatus === "VALID" ? "ok" : "danger"}>
                  {s.type}
                </Badge>
              ))}
              {!page.schemas.length ? <span className="text-[12px] text-[var(--color-ink-4)]">none</span> : null}
            </div>
          </div>
          {geo.coverageGaps?.length ? (
            <div className="border-t border-[var(--color-border)] px-4 py-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-warn)]">Coverage gaps</div>
              <ul className="list-inside list-disc space-y-0.5 text-[11.5px] text-[var(--color-ink-2)]">
                {geo.coverageGaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Version history" description="Every version is retained so a rollback restores real content." padded={false}>
          <Table head={["Version", "Status", "Words", "Published", "Created"]}>
            {page.versions.map((v) => (
              <tr key={v.id}>
                <td className="fm-mono font-semibold">v{v.version}</td>
                <td>
                  <StatusBadge status={v.status} />
                </td>
                <td className="fm-mono">{formatNumber(v.wordCount)}</td>
                <td className="text-[12px]">
                  {v.publishRecords.length ? (
                    <span className="text-[var(--color-ink-2)]">
                      {v.publishRecords[0].adapter} · {timeAgo(v.publishRecords[0].publishedAt)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="text-[12px] text-[var(--color-ink-3)]">{timeAgo(v.createdAt)}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Internal links & approvals" padded={false}>
          <Table head={["Target", "Anchor", "Relevance", "Status"]}>
            {page.linksFrom.map((l) => (
              <tr key={l.id}>
                <td className="max-w-[200px] truncate">
                  <Mono>{l.targetUrl}</Mono>
                </td>
                <td className="text-[12px]">{l.anchorText}</td>
                <td className="fm-mono">{l.relevance.toFixed(2)}</td>
                <td>
                  <StatusBadge status={l.status} />
                </td>
              </tr>
            ))}
            {!page.linksFrom.length ? (
              <tr>
                <td colSpan={4} className="text-[12px] text-[var(--color-ink-4)]">
                  No internal links proposed for this page yet.
                </td>
              </tr>
            ) : null}
          </Table>
          {page.approvals.length ? (
            <div className="border-t border-[var(--color-border)] px-4 py-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Approvals</div>
              {page.approvals.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 py-1 text-[12px]">
                  <span className="truncate">{a.title}</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={a.status} />
                    <span className="text-[11px] text-[var(--color-ink-3)]">{a.decidedBy?.name ?? ""}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
