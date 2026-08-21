import { prisma } from "@/core/db/client";
import { readJson, readStringArray } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { Badge, Callout, Card, EmptyState, Mono, PageHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  await requireProject();

  const skills = await prisma.skill.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
    include: { agents: { include: { agent: { select: { key: true, name: true } } } } },
  });

  const byCategory = skills.reduce<Record<string, typeof skills>>((acc, s) => {
    (acc[s.category] ??= []).push(s);
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title="Skill library"
        description="Skills describe HOW work is done: methodology, hard rules and an output contract. They live in the database, are versioned, and can be attached to any number of agents."
        meta={<Badge tone="neutral">{skills.length} skills</Badge>}
      />

      <div className="mb-5">
        <Callout tone="info" title="Skills vs brand knowledge">
          A skill answers <strong>how to perform a task</strong>. The brand profile answers <strong>what the output must be
          like</strong>. Agents compose both at prompt-build time, which is why no instruction is hard-coded inside agent
          logic and why the same skill can serve several agents.
        </Callout>
      </div>

      {Object.entries(byCategory).map(([category, items]) => (
        <section key={category} className="mb-6">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-3)]">{category}</h2>
          <div className="space-y-3">
            {items.map((s) => {
              const methodology = readStringArray(s.methodologyJson);
              const constraints = readStringArray(s.constraintsJson);
              const contract = readJson<Record<string, string>>(s.outputContractJson, {});
              return (
                <Card key={s.id} padded={false}>
                  <div className="border-b border-[var(--color-border)] px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[13.5px] font-semibold">{s.name}</h3>
                      <Mono>{s.key}</Mono>
                      <Badge tone="neutral">v{s.version}</Badge>
                      {s.agents.map((a) => (
                        <Badge key={a.id} tone="brand">
                          {a.agent.name}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-1 text-[12.5px] text-[var(--color-ink-2)]">{s.description}</p>
                  </div>

                  <div className="grid gap-4 p-4 lg:grid-cols-3">
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                        Instructions
                      </div>
                      <p className="text-[12px] leading-relaxed text-[var(--color-ink-2)]">{s.instructions}</p>
                    </div>
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                        Procedure
                      </div>
                      <ol className="list-inside list-decimal space-y-0.5 text-[11.5px] text-[var(--color-ink-2)]">
                        {methodology.map((m, i) => (
                          <li key={i}>{m}</li>
                        ))}
                      </ol>
                    </div>
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-danger)]">
                        Hard rules
                      </div>
                      <ul className="mb-3 list-inside list-disc space-y-0.5 text-[11.5px] text-[var(--color-ink-2)]">
                        {constraints.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                      {Object.keys(contract).length ? (
                        <>
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                            Output contract
                          </div>
                          <div className="space-y-0.5">
                            {Object.entries(contract).map(([k, v]) => (
                              <div key={k} className="text-[11px]">
                                <Mono className="!text-[var(--color-ink)]">{k}</Mono>{" "}
                                <span className="text-[var(--color-ink-3)]">{v}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      ))}

      {!skills.length ? <EmptyState title="No skills seeded" /> : null}
    </>
  );
}
