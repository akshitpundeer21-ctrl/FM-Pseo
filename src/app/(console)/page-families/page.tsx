import { prisma } from "@/core/db/client";
import { readJson, readStringArray } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Callout, Card, EmptyState, Grid, KeyValue, Mono, PageHeader, StatusBadge, Table } from "@/ui/primitives";
import type { CompositionPolicy } from "@/engine/templates/renderer";

export const dynamic = "force-dynamic";

export default async function PageFamiliesPage() {
  const { project } = await requireProject();

  const families = await prisma.pageFamily.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    include: {
      templates: { include: { _count: { select: { blocks: true } } } },
      _count: { select: { pages: true, opportunities: true } },
    },
  });

  return (
    <>
      <PageHeader
        title="Page families"
        description="A page family is a URL pattern + a template + a data contract + a composition policy. Nothing is generated for a family until a candidate clears its opportunity threshold."
      />

      <div className="mb-5">
        <Callout tone="info" title="Composition policy, not a fixed ratio">
          Each family configures how much of a page may come from the reusable template layer, how much must be page-specific
          dynamic data, and how much may be model-generated. The renderer measures the actual mix of every page against this
          policy. There is no hard-coded 70/30 rule anywhere in the system.
        </Callout>
      </div>

      <div className="space-y-4">
        {families.map((f) => {
          const composition = readJson<{ policy?: CompositionPolicy; requiredBindings?: string[] }>(f.compositionJson, {});
          const policy = composition.policy ?? {};
          const thresholds = readJson<Record<string, number>>(f.qualityThresholdsJson, {});
          const entityTypes = readStringArray(f.entityTypesJson);

          return (
            <Card key={f.id} padded={false}>
              <div className="grid gap-4 p-4 lg:grid-cols-[1.3fr_1fr_1fr]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[14px] font-semibold">{f.name}</h3>
                    <StatusBadge status={f.status} />
                    <Mono>{f.key}</Mono>
                  </div>
                  <p className="mt-1 text-[12.5px] text-[var(--color-ink-2)]">{f.description}</p>
                  <div className="mt-2">
                    <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-[3px] font-mono text-[12px]">
                      {f.urlPattern}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {entityTypes.map((e) => (
                      <Badge key={e} tone="neutral">
                        {e}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-4 text-[12px] text-[var(--color-ink-3)]">
                    <span>
                      <strong className="text-[var(--color-ink)]">{f._count.opportunities}</strong> opportunities scored
                    </span>
                    <span>
                      <strong className="text-[var(--color-ink)]">{f._count.pages}</strong> pages
                    </span>
                    <span>
                      <strong className="text-[var(--color-ink)]">{f.templates.length}</strong> template(s)
                    </span>
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                    Composition policy
                  </div>
                  {Object.keys(policy).length ? (
                    <KeyValue
                      rows={[
                        {
                          label: "Min page-specific share",
                          value: policy.minUniqueShare !== undefined ? `${(policy.minUniqueShare * 100).toFixed(0)}%` : "—",
                        },
                        {
                          label: "Max template share",
                          value: policy.maxTemplateShare !== undefined ? `${(policy.maxTemplateShare * 100).toFixed(0)}%` : "—",
                        },
                        {
                          label: "Max generated share",
                          value: policy.maxAiShare !== undefined ? `${(policy.maxAiShare * 100).toFixed(0)}%` : "—",
                        },
                        { label: "Min distinct data points", value: policy.minDistinctDataPoints ?? "—" },
                      ]}
                    />
                  ) : (
                    <p className="text-[12px] text-[var(--color-ink-4)]">No policy set — this family is an extension point.</p>
                  )}
                </div>

                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                    Gates & data contract
                  </div>
                  <KeyValue
                    rows={[
                      { label: "Min opportunity score", value: f.minOpportunityScore },
                      { label: "Min quality score", value: thresholds.minScore ?? "—" },
                      { label: "Min differentiation", value: thresholds.minDifferentiation ?? "—" },
                      { label: "Min word count", value: thresholds.minWordCount ?? "—" },
                    ]}
                  />
                  {composition.requiredBindings?.length ? (
                    <div className="mt-2">
                      <div className="mb-1 text-[10.5px] uppercase tracking-wide text-[var(--color-ink-4)]">
                        Required data bindings ({composition.requiredBindings.length})
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {composition.requiredBindings.map((b) => (
                          <span key={b} className="rounded border border-[var(--color-border)] px-1.5 py-[1px] font-mono text-[10.5px] text-[var(--color-ink-3)]">
                            {b}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {f.templates.length ? (
                <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-3 text-[12px]">
                    <span className="text-[var(--color-ink-3)]">Templates:</span>
                    {f.templates.map((t) => (
                      <span key={t.id} className="inline-flex items-center gap-1.5">
                        <Mono className="!text-[var(--color-ink)]">{t.key}</Mono>
                        <span className="text-[var(--color-ink-3)]">
                          v{t.version} · {t._count.blocks} blocks
                        </span>
                        {t.propagateUpdates ? <Badge tone="info">propagates updates</Badge> : null}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-[12px] text-[var(--color-ink-3)]">
                  No template yet. The Content Strategy Agent creates one on first use from the component library.
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {!families.length ? <EmptyState title="No page families configured" /> : null}
    </>
  );
}
