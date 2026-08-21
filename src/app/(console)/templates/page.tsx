import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Card, EmptyState, Mono, PageHeader, StatusBadge, Table } from "@/ui/primitives";

export const dynamic = "force-dynamic";

const SOURCE_TONE: Record<string, "neutral" | "info" | "mock" | "brand"> = {
  TEMPLATE: "neutral",
  DYNAMIC: "info",
  AI: "mock",
  HYBRID: "brand",
};

export default async function TemplatesPage() {
  const { project } = await requireProject();

  const templates = await prisma.template.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    include: {
      pageFamily: { select: { name: true, key: true } },
      blocks: { include: { component: true }, orderBy: { sequence: "asc" } },
      _count: { select: { pages: true } },
    },
  });

  return (
    <>
      <PageHeader
        title="Templates"
        description="A template is an ordered list of component blocks with per-block conditions, overrides and a content-source classification. The structure is reused across every page in the family; the substance is resolved per page."
      />

      {templates.length ? (
        <div className="space-y-5">
          {templates.map((t) => {
            const seo = readJson<{ titlePattern?: string; metaPattern?: string }>(t.seoConfigJson, {});
            const counts = t.blocks.reduce<Record<string, number>>((acc, b) => {
              acc[b.contentSource] = (acc[b.contentSource] ?? 0) + 1;
              return acc;
            }, {});
            return (
              <Card
                key={t.id}
                title={t.name}
                description={t.description ?? undefined}
                actions={
                  <div className="flex items-center gap-1.5">
                    <Mono>{t.key}</Mono>
                    <Badge tone="neutral">v{t.version}</Badge>
                    <StatusBadge status={t.status} />
                  </div>
                }
                padded={false}
              >
                <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-[12px]">
                  <span className="text-[var(--color-ink-3)]">
                    Family: <strong className="text-[var(--color-ink)]">{t.pageFamily?.name ?? "—"}</strong>
                  </span>
                  <span className="text-[var(--color-ink-3)]">
                    Pages using it: <strong className="text-[var(--color-ink)]">{t._count.pages}</strong>
                  </span>
                  <span className="text-[var(--color-ink-3)]">
                    Blocks: <strong className="text-[var(--color-ink)]">{t.blocks.length}</strong>
                  </span>
                  {Object.entries(counts).map(([k, v]) => (
                    <Badge key={k} tone={SOURCE_TONE[k] ?? "neutral"}>
                      {v} {k.toLowerCase()}
                    </Badge>
                  ))}
                  {t.propagateUpdates ? <Badge tone="info">component updates propagate</Badge> : null}
                </div>

                {seo.titlePattern ? (
                  <div className="border-b border-[var(--color-border)] px-4 py-2.5 text-[12px]">
                    <div className="text-[var(--color-ink-3)]">Title pattern</div>
                    <Mono className="!text-[var(--color-ink)]">{seo.titlePattern}</Mono>
                    {seo.metaPattern ? (
                      <>
                        <div className="mt-1.5 text-[var(--color-ink-3)]">Meta pattern</div>
                        <Mono className="!text-[var(--color-ink)]">{seo.metaPattern}</Mono>
                      </>
                    ) : null}
                  </div>
                ) : null}

                <Table head={["#", "Component", "Content source", "Required", "Condition", "Data bindings"]}>
                  {t.blocks.map((b) => {
                    const bindings = readJson<{ required?: string[]; optional?: string[] }>(b.component.dataBindingsJson, {});
                    return (
                      <tr key={b.id}>
                        <td className="fm-mono">{b.sequence}</td>
                        <td>
                          <div className="font-medium">{b.component.name}</div>
                          <Mono>{b.component.key}</Mono>
                        </td>
                        <td>
                          <Badge tone={SOURCE_TONE[b.contentSource] ?? "neutral"}>{b.contentSource}</Badge>
                        </td>
                        <td>{b.isRequired ? <Badge tone="danger">required</Badge> : <span className="text-[12px] text-[var(--color-ink-4)]">optional</span>}</td>
                        <td>
                          {b.condition ? (
                            <Mono className="!text-[var(--color-ink)]">{b.condition}</Mono>
                          ) : (
                            <span className="text-[12px] text-[var(--color-ink-4)]">—</span>
                          )}
                        </td>
                        <td className="max-w-[300px]">
                          <div className="flex flex-wrap gap-1">
                            {(bindings.required ?? []).map((r) => (
                              <span key={r} className="rounded border px-1.5 py-[1px] font-mono text-[10.5px]" style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }} title="required binding">
                                {r}
                              </span>
                            ))}
                            {(bindings.optional ?? []).slice(0, 3).map((r) => (
                              <span key={r} className="rounded border border-[var(--color-border)] px-1.5 py-[1px] font-mono text-[10.5px] text-[var(--color-ink-3)]">
                                {r}
                              </span>
                            ))}
                            {!bindings.required?.length && !bindings.optional?.length ? (
                              <span className="text-[11.5px] text-[var(--color-ink-4)]">none</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </Table>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            title="No templates yet"
            hint="The Content Strategy Agent creates a template from the component library the first time a page family needs one."
          />
        </Card>
      )}
    </>
  );
}
