import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { ApprovalActions } from "@/app/(console)/approvals/approval-actions";
import { Badge, Callout, Card, EmptyState, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const { project } = await requireProject();

  const [pending, decided] = await Promise.all([
    prisma.approval.findMany({
      where: { projectId: project.id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { page: { select: { url: true, qualityScore: true, status: true } } },
    }),
    prisma.approval.findMany({
      where: { projectId: project.id, status: { not: "PENDING" } },
      orderBy: { decidedAt: "desc" },
      take: 25,
      include: { decidedBy: { select: { name: true } }, page: { select: { url: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Human decision points. The workflow parks here and resumes automatically once you approve."
        meta={
          <>
            <Badge tone={project.approvalMode === "MANUAL" ? "warn" : "brand"}>{project.approvalMode.replace("_", "-")} mode</Badge>
            <Badge tone="neutral">{pending.length} pending</Badge>
          </>
        }
      />

      <div className="mb-5">
        <Callout tone="info" title="How approval routing works">
          <strong>MANUAL</strong> — every action is reviewed. <strong>SEMI-AUTOMATIC</strong> — high-risk actions (publish,
          unpublish, rollback) and low-confidence runs are reviewed; low-risk research runs unattended.{" "}
          <strong>AUTOMATIC</strong> — only actions explicitly allowlisted in{" "}
          <Link href="/settings" className="underline">
            settings
          </Link>{" "}
          run unattended; everything else still comes here. Publishing is never allowlisted by default.
        </Callout>
      </div>

      <Card title="Waiting for a decision" padded={false} className="mb-5">
        {pending.length ? (
          <div className="divide-y divide-[var(--color-border)]">
            {pending.map((a) => {
              const payload = readJson<Record<string, unknown>>(a.payloadJson, {});
              return (
                <div key={a.id} className="grid gap-4 px-4 py-4 lg:grid-cols-[1.6fr_1fr]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14px] font-semibold">{a.title}</h3>
                      <StatusBadge status={a.riskLevel} />
                      <Badge tone="neutral">{a.entityType.replace(/_/g, " ").toLowerCase()}</Badge>
                    </div>
                    <p className="mt-1 text-[12.5px] text-[var(--color-ink-2)]">{a.summary}</p>

                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-3">
                      {payload.url ? (
                        <Field label="URL">
                          <span className="font-mono text-[11.5px]">{String(payload.url)}</span>
                        </Field>
                      ) : null}
                      {payload.score !== undefined ? <Field label="Quality score">{String(payload.score)}/100</Field> : null}
                      {payload.wordCount !== undefined ? <Field label="Words">{String(payload.wordCount)}</Field> : null}
                      {payload.decision ? <Field label="Gate decision">{String(payload.decision)}</Field> : null}
                      <Field label="Requested by">{a.requestedBy}</Field>
                      <Field label="Raised">{timeAgo(a.createdAt)}</Field>
                    </dl>

                    {Array.isArray(payload.warnings) && payload.warnings.length ? (
                      <div className="mt-3">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-warn)]">
                          Warnings from the quality gate
                        </div>
                        <ul className="list-inside list-disc space-y-0.5 text-[11.5px] text-[var(--color-ink-2)]">
                          {(payload.warnings as string[]).map((w) => (
                            <li key={w}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {a.pageId ? (
                      <div className="mt-3 flex gap-2">
                        <Link href={`/content/${a.pageId}`} className="fm-btn !py-1 !text-[12px]">
                          Inspect the page
                        </Link>
                      </div>
                    ) : null}
                  </div>

                  <div className="lg:border-l lg:border-[var(--color-border)] lg:pl-4">
                    <ApprovalActions approvalId={a.id} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="Nothing is waiting on you"
            hint="When an agent reaches a gated action it raises an approval here and the workflow pauses."
          />
        )}
      </Card>

      <Card title="Decision history" description="Every decision is recorded in the audit log with the deciding user." padded={false}>
        {decided.length ? (
          <Table head={["Item", "Decision", "Decided by", "Notes", "When"]}>
            {decided.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="text-[12.5px] font-medium">{a.title}</div>
                  {a.page ? <div className="font-mono text-[11px] text-[var(--color-ink-3)]">{a.page.url}</div> : null}
                </td>
                <td>
                  <StatusBadge status={a.status} />
                </td>
                <td className="text-[12px]">{a.decidedBy?.name ?? "—"}</td>
                <td className="max-w-[260px] text-[12px] text-[var(--color-ink-3)]">{a.notes ?? "—"}</td>
                <td className="text-[12px] text-[var(--color-ink-3)]">{timeAgo(a.decidedAt)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No decisions recorded yet" />
        )}
      </Card>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase tracking-wide text-[var(--color-ink-4)]">{label}</dt>
      <dd className="text-[var(--color-ink)]">{children}</dd>
    </div>
  );
}
