import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Callout, Card, EmptyState, Grid, Mono, PageHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

const SOURCE_TONE: Record<string, "neutral" | "info" | "mock" | "brand"> = {
  TEMPLATE: "neutral",
  DYNAMIC: "info",
  AI: "mock",
  HYBRID: "brand",
};

interface AiSlot {
  name: string;
  task: string;
  instruction: string;
  optional?: boolean;
}

export default async function ComponentsPage() {
  const { project } = await requireProject();

  const [components, usage] = await Promise.all([
    prisma.componentDef.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] }),
    prisma.templateBlock.groupBy({
      by: ["componentId"],
      where: { template: { projectId: project.id } },
      _count: { _all: true },
    }),
  ]);

  const usageByComponent = new Map(usage.map((u) => [u.componentId, u._count._all]));
  const byCategory = components.reduce<Record<string, typeof components>>((acc, c) => {
    (acc[c.category] ??= []).push(c);
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title="Component library"
        description="Independently configurable, versioned building blocks. Each declares the data it requires, the data it can use, and the named slots it asks the generator to fill."
        meta={<Badge tone="neutral">{components.length} components</Badge>}
      />

      <div className="mb-5">
        <Callout tone="info" title="How a component behaves when its data is missing">
          A component whose <em>required</em> bindings do not resolve does not render, and the reason is recorded on the page
          version. If that block was marked required in the template, the page cannot pass the quality gate. This is what
          prevents a page from being published around an empty section.
        </Callout>
      </div>

      {Object.entries(byCategory).map(([category, items]) => (
        <section key={category} className="mb-6">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-3)]">{category}</h2>
          <Grid cols={3}>
            {items.map((c) => {
              const bindings = readJson<{ required?: string[]; optional?: string[] }>(c.dataBindingsJson, {});
              const slots = readJson<AiSlot[]>(c.aiSlotsJson, []);
              const used = usageByComponent.get(c.id) ?? 0;

              return (
                <div key={c.id} className="fm-card flex h-full flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold">{c.name}</h3>
                      <Mono>{c.key}</Mono>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone="neutral">v{c.version}</Badge>
                      {used ? <Badge tone="ok">used {used}×</Badge> : <Badge tone="neutral">unused</Badge>}
                    </div>
                  </div>

                  <p className="mt-2 flex-1 text-[12px] text-[var(--color-ink-2)]">{c.description}</p>

                  {bindings.required?.length ? (
                    <div className="mt-3">
                      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-danger)]">
                        Required data
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {bindings.required.map((b) => (
                          <span
                            key={b}
                            className="rounded border px-1.5 py-[1px] font-mono text-[10.5px]"
                            style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
                          >
                            {b}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-[11px] text-[var(--color-ink-4)]">No required data bindings.</div>
                  )}

                  {bindings.optional?.length ? (
                    <div className="mt-2">
                      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-ink-4)]">
                        Enriched by
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {bindings.optional.map((b) => (
                          <span key={b} className="rounded border border-[var(--color-border)] px-1.5 py-[1px] font-mono text-[10.5px] text-[var(--color-ink-3)]">
                            {b}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {slots.length ? (
                    <div className="mt-3 border-t border-[var(--color-border)] pt-2.5">
                      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-mock)]">
                        Generation slots
                      </div>
                      {slots.map((s) => (
                        <div key={s.name} className="mb-1.5">
                          <div className="flex items-center gap-1.5">
                            <Mono className="!text-[var(--color-ink)]">{s.name}</Mono>
                            <span className="text-[10.5px] text-[var(--color-ink-4)]">task: {s.task}</span>
                            {s.optional ? <Badge tone="neutral">optional</Badge> : null}
                          </div>
                          <p className="text-[11px] text-[var(--color-ink-3)]">{s.instruction}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Grid>
        </section>
      ))}

      {!components.length ? <EmptyState title="No components registered" /> : null}
    </>
  );
}
