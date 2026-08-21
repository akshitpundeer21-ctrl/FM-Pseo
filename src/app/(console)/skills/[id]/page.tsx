import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/core/db/client";
import { readStringArray } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { roleHas } from "@/core/security/rbac";
import { configFromVersion } from "@/skills/service";
import { computeEffectiveTools } from "@/skills/types";
import { validateSkillConfig } from "@/skills/validation";
import { describeAuditEvent } from "@/control-plane/audit-describe";
import { describeTools } from "@/tools/definitions";
import { SkillEditor } from "@/app/(console)/skills/[id]/skill-editor";
import { VersionActions } from "@/app/(console)/skills/[id]/version-actions";
import { AssignmentManager, type AssignmentRow } from "@/app/(console)/skills/[id]/assignment-manager";
import { SkillTestPanel } from "@/ui/skill-test-panel";
import { Badge, Callout, Card, EmptyState, KeyValue, Mono, PageHeader, StatusBadge, Table, timeAgo } from "@/ui/primitives";
import { formatMoney } from "@/core/utils/text";

export const dynamic = "force-dynamic";

const TABS = [
  ["overview", "Overview"],
  ["edit", "Edit"],
  ["versions", "Versions"],
  ["test", "Test"],
  ["history", "History"],
] as const;

export default async function SkillDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; version?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { auth, project } = await requireProject();

  const canWrite = roleHas(auth.role, "skill:write");
  const canActivate = roleHas(auth.role, "skill:activate");
  const canAssign = roleHas(auth.role, "skill:assign");
  const canTest = roleHas(auth.role, "skill:test");

  const skill = await prisma.skill.findUnique({
    where: { id },
    include: {
      activeVersion: true,
      versions: { orderBy: { version: "desc" } },
      agents: { include: { agent: true, pinnedVersion: true } },
      testRuns: { orderBy: { createdAt: "desc" }, take: 15, include: { skillVersion: { select: { version: true } } } },
    },
  });
  if (!skill) notFound();

  const tab = (TABS.find(([t]) => t === sp.tab)?.[0] ?? "overview") as (typeof TABS)[number][0];
  const draft = skill.versions.find((v) => v.status === "DRAFT");
  const selected =
    skill.versions.find((v) => v.id === sp.version) ?? skill.activeVersion ?? draft ?? skill.versions[0] ?? null;

  const config = selected ? configFromVersion(selected) : null;
  const requestedTools = config?.allowedTools ?? [];

  // Effective permission per assigned agent, so the intersection rule is visible.
  const assignments: AssignmentRow[] = skill.agents.map((a) => {
    const agentTools = readStringArray(a.agent.allowedToolsJson);
    const scope = computeEffectiveTools(agentTools, [{ allowedTools: requestedTools }]);
    return {
      agentKey: a.agent.key,
      agentName: a.agent.name,
      enabled: a.isEnabled,
      priority: a.priority,
      pinnedVersionId: a.pinnedVersionId,
      pinnedVersion: a.pinnedVersion?.version ?? null,
      effectiveTools: scope.narrowed ? scope.effectiveTools : agentTools,
      deniedTools: scope.deniedTools,
    };
  });

  const [allAgents, auditRows, users] = await Promise.all([
    prisma.agent.findMany({ orderBy: { name: "asc" }, select: { key: true, name: true } }),
    prisma.auditLog.findMany({
      where: {
        organizationId: auth.organizationId,
        action: { startsWith: "skill." },
        OR: [{ entityId: id }, { entityId: { in: skill.versions.map((v) => v.id) } }],
      },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));

  const allowlists = Object.fromEntries(skill.agents.map((a) => [a.agent.key, readStringArray(a.agent.allowedToolsJson)]));
  const validation = config ? validateSkillConfig(config, allowlists) : null;
  const tools = describeTools().map((t) => ({ key: t.key, name: t.name, category: t.category }));

  const tabHref = (t: string) => `/skills/${id}?tab=${t}${selected ? `&version=${selected.id}` : ""}`;

  return (
    <>
      <PageHeader
        title={skill.name}
        description={skill.description}
        meta={
          <>
            <Mono>{skill.key}</Mono>
            <Badge tone="neutral">{skill.category}</Badge>
            <StatusBadge status={skill.status} />
            {skill.activeVersion ? (
              <Badge tone="ok">active v{skill.activeVersion.version}</Badge>
            ) : (
              <Badge tone="warn">no active version</Badge>
            )}
            {draft ? <Badge tone="info">v{draft.version} draft</Badge> : null}
            <Badge tone="neutral">{skill.versions.length} versions</Badge>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link href="/skills" className="fm-btn">
              Back to library
            </Link>
            <Link href={`/skills/playground?skill=${id}`} className="fm-btn">
              Playground
            </Link>
          </div>
        }
      />

      <nav className="mb-5 flex flex-wrap gap-1.5 border-b border-[var(--color-border)] pb-2">
        {TABS.map(([t, label]) => (
          <Link
            key={t}
            href={tabHref(t)}
            className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              tab === t ? "bg-[var(--color-brand-soft)] text-[var(--color-brand-ink)]" : "text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {label}
            {t === "versions" ? ` (${skill.versions.length})` : ""}
            {t === "history" ? ` (${auditRows.length})` : ""}
          </Link>
        ))}
      </nav>

      {selected ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Viewing</span>
          <div className="flex flex-wrap gap-1">
            {skill.versions.map((v) => (
              <Link
                key={v.id}
                href={`/skills/${id}?tab=${tab}&version=${v.id}`}
                className={`rounded border px-2 py-[2px] text-[11.5px] ${
                  v.id === selected.id
                    ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] font-semibold text-[var(--color-brand-ink)]"
                    : "border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
                }`}
              >
                v{v.version}
                <span className="ml-1 text-[10px] opacity-70">{v.status.toLowerCase()}</span>
              </Link>
            ))}
          </div>
          {validation && !validation.valid ? (
            <Badge tone="danger">{validation.errors} blocking issue(s)</Badge>
          ) : validation && validation.warnings ? (
            <Badge tone="warn">{validation.warnings} warning(s)</Badge>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {tab === "overview" && selected && config ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Identity">
              <KeyValue
                rows={[
                  { label: "Skill ID", value: <Mono>{skill.id}</Mono> },
                  { label: "Key", value: <Mono>{skill.key}</Mono> },
                  { label: "Category", value: skill.category },
                  { label: "Status", value: <StatusBadge status={skill.status} /> },
                  { label: "Created", value: skill.createdAt.toISOString().slice(0, 10) },
                  { label: "Last updated", value: timeAgo(skill.updatedAt) },
                ]}
              />
            </Card>

            <Card title={`Version v${selected.version}`}>
              <KeyValue
                rows={[
                  { label: "Status", value: <StatusBadge status={selected.status} /> },
                  { label: "Created by", value: selected.createdBy ? (userNames[selected.createdBy] ?? selected.createdBy) : "—" },
                  { label: "Created", value: selected.createdAt.toISOString().slice(0, 16).replace("T", " ") },
                  { label: "Updated", value: timeAgo(selected.updatedAt) },
                  { label: "Activated", value: selected.activatedAt ? timeAgo(selected.activatedAt) : "never" },
                ]}
              />
              <p className="mt-2 text-[12px] text-[var(--color-ink-2)]">
                <span className="text-[var(--color-ink-3)]">Change summary: </span>
                {selected.changeSummary || "—"}
              </p>
            </Card>

            <Card title="Lifecycle">
              <div className="mb-3 flex flex-wrap items-center gap-1 text-[11px]">
                {["DRAFT", "TESTING", "READY", "ACTIVE", "ARCHIVED"].map((s, i) => (
                  <span key={s} className="flex items-center gap-1">
                    {i > 0 ? <span className="text-[var(--color-ink-4)]">→</span> : null}
                    <span
                      className="rounded px-1.5 py-[1px] font-semibold"
                      style={
                        selected.status === s
                          ? { background: "var(--color-brand-soft)", color: "var(--color-brand-ink)" }
                          : { color: "var(--color-ink-4)" }
                      }
                    >
                      {s}
                    </span>
                  </span>
                ))}
              </div>
              <VersionActions
                skillId={skill.id}
                versionId={selected.id}
                version={selected.version}
                status={selected.status}
                isActive={skill.activeVersionId === selected.id}
                canWrite={canWrite}
                canActivate={canActivate}
              />
            </Card>
          </div>

          <Card title="Instructions" description="Exactly what this version injects into the agent's prompt.">
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-2)] p-3 text-[12.5px] leading-relaxed">
              {config.instructions || "(empty)"}
            </pre>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Inputs" padded={false}>
              {config.inputs.length ? (
                <Table head={["Field", "Type", "Required", "Description", "Validation"]}>
                  {config.inputs.map((f) => (
                    <tr key={f.name}>
                      <td>
                        <Mono className="!text-[var(--color-ink)]">{f.name}</Mono>
                      </td>
                      <td className="text-[12px]">{f.type}</td>
                      <td>{f.required ? <Badge tone="danger">required</Badge> : <span className="text-[12px] text-[var(--color-ink-4)]">optional</span>}</td>
                      <td className="max-w-[240px] text-[11.5px] text-[var(--color-ink-2)]">{f.description}</td>
                      <td className="max-w-[160px] text-[11.5px] text-[var(--color-ink-3)]">
                        {f.type === "enum" ? (f.enumValues ?? []).join(", ") : (f.validation ?? "—")}
                      </td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <EmptyState title="No inputs declared" />
              )}
            </Card>

            <Card title="Outputs" padded={false}>
              {config.outputs.length ? (
                <Table head={["Field", "Type", "Required", "Description"]}>
                  {config.outputs.map((f) => (
                    <tr key={f.name}>
                      <td>
                        <Mono className="!text-[var(--color-ink)]">{f.name}</Mono>
                      </td>
                      <td className="text-[12px]">{f.type}</td>
                      <td>{f.required ? <Badge tone="danger">required</Badge> : <span className="text-[12px] text-[var(--color-ink-4)]">optional</span>}</td>
                      <td className="max-w-[300px] text-[11.5px] text-[var(--color-ink-2)]">{f.description}</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <EmptyState title="No output fields declared" />
              )}
            </Card>
          </div>

          <Card
            title="Tools"
            description="A skill requests tools; the Control Plane decides. Effective permission is always agent ∩ skill."
          >
            {requestedTools.length ? (
              <>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {requestedTools.map((t) => (
                    <Badge key={t} tone="info">
                      {t}
                    </Badge>
                  ))}
                </div>
                <Callout tone="warn" title="A skill can never widen an agent's permissions">
                  Anything requested here is intersected with the agent&rsquo;s own allowlist at runtime. A tool the agent does
                  not hold is denied and logged — it is never granted because a skill asked for it.
                </Callout>
              </>
            ) : (
              <p className="text-[12px] text-[var(--color-ink-3)]">
                No tools requested — each agent&rsquo;s own allowlist applies unchanged.
              </p>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Rules">
              <RuleList label="Hard rules (constraints)" tone="danger" items={config.constraints} />
              <RuleList label="Safety requirements" tone="danger" items={config.safetyRules} />
              <RuleList label="Business rules" tone="warn" items={config.businessRules} />
              <RuleList label="Quality requirements" tone="info" items={config.qualityCriteria} />
              <RuleList label="Procedure" tone="neutral" items={config.methodology} ordered />
            </Card>

            <Card title="Examples" padded={false}>
              {config.examples.length ? (
                <div className="divide-y divide-[var(--color-border)]">
                  {config.examples.map((ex, i) => (
                    <div key={i} className="px-4 py-3">
                      <div className="text-[12.5px] font-semibold">{ex.name || `Example ${i + 1}`}</div>
                      <div className="mt-1.5 text-[11px] uppercase tracking-wide text-[var(--color-ink-4)]">Input</div>
                      <pre className="mt-0.5 overflow-auto rounded bg-[var(--color-surface-2)] p-2 text-[11px]">
                        {JSON.stringify(ex.input, null, 2)}
                      </pre>
                      <div className="mt-1.5 text-[11px] uppercase tracking-wide text-[var(--color-ink-4)]">Expected output</div>
                      <p className="mt-0.5 text-[11.5px] text-[var(--color-ink-2)]">{ex.expectedOutput}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="No examples" />
              )}
            </Card>
          </div>

          <Card
            title="Assigned agents"
            description="Effective tool permission is resolved per agent and shown below."
          >
            <AssignmentManager
              skillId={skill.id}
              assignments={assignments}
              allAgents={allAgents}
              versions={skill.versions.map((v) => ({ id: v.id, version: v.version, status: v.status }))}
              activeVersionId={skill.activeVersionId}
              requestedTools={requestedTools}
              canAssign={canAssign}
            />
          </Card>
        </div>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {tab === "edit" ? (
        !canWrite ? (
          <Callout tone="warn" title="Your role cannot edit skills">
            Editing requires the <Mono>skill:write</Mono> permission. You can still view and test.
          </Callout>
        ) : draft ? (
          <>
            <div className="mb-4">
              <Callout tone="info" title={`Editing v${draft.version} (draft)`}>
                {skill.activeVersion
                  ? `The active version is v${skill.activeVersion.version} and it keeps running until you activate this draft.`
                  : "This skill has no active version yet."}{" "}
                Versions are immutable once they leave DRAFT.
              </Callout>
            </div>
            <SkillEditor
              skillId={skill.id}
              versionId={draft.id}
              version={draft.version}
              initial={configFromVersion(draft)}
              initialChangeSummary={draft.changeSummary}
              availableTools={tools}
            />
          </>
        ) : (
          <Card>
            <EmptyState
              title="No draft to edit"
              hint={`v${selected?.version ?? "?"} is ${selected?.status.toLowerCase() ?? "frozen"} and immutable. Create a new draft from it to make changes — the active version keeps running until you activate the draft.`}
              action={
                selected ? (
                  <VersionActions
                    skillId={skill.id}
                    versionId={selected.id}
                    version={selected.version}
                    status={selected.status}
                    isActive={skill.activeVersionId === selected.id}
                    canWrite={canWrite}
                    canActivate={canActivate}
                  />
                ) : null
              }
            />
          </Card>
        )
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {tab === "versions" ? (
        <Card padded={false}>
          <Table head={["Version", "Status", "Change summary", "Created by", "Created", "Activated", "Tools", ""]}>
            {skill.versions.map((v) => (
              <tr key={v.id}>
                <td>
                  <Link href={`/skills/${id}?tab=overview&version=${v.id}`} className="fm-mono font-semibold hover:underline">
                    v{v.version}
                  </Link>
                </td>
                <td>
                  <StatusBadge status={v.status} />
                  {skill.activeVersionId === v.id ? (
                    <div className="mt-1">
                      <Badge tone="ok">live</Badge>
                    </div>
                  ) : null}
                </td>
                <td className="max-w-[300px] text-[12px]">{v.changeSummary || "—"}</td>
                <td className="text-[12px]">{v.createdBy ? (userNames[v.createdBy] ?? v.createdBy) : "—"}</td>
                <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(v.createdAt)}</td>
                <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">
                  {v.activatedAt ? timeAgo(v.activatedAt) : "—"}
                </td>
                <td className="max-w-[160px] text-[11px] text-[var(--color-ink-3)]">
                  {readStringArray(v.allowedToolsJson).join(", ") || "—"}
                </td>
                <td>
                  <VersionActions
                    skillId={skill.id}
                    versionId={v.id}
                    version={v.version}
                    status={v.status}
                    isActive={skill.activeVersionId === v.id}
                    canWrite={canWrite}
                    canActivate={canActivate}
                  />
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {tab === "test" ? (
        <div className="space-y-4">
          {!canTest ? (
            <Callout tone="warn" title="Your role cannot run tests">
              Testing requires the <Mono>skill:test</Mono> permission.
            </Callout>
          ) : (
            <Card title="Sandbox" description="Run this skill against a sample input and inspect everything it produced.">
              <SkillTestPanel
                skillId={skill.id}
                versions={skill.versions.map((v) => ({ id: v.id, version: v.version, status: v.status }))}
                defaultVersionId={selected?.id ?? null}
                agents={allAgents}
                defaultAgentKey={assignments[0]?.agentKey}
                inputFields={config?.inputs ?? []}
              />
            </Card>
          )}

          <Card title="Recent test runs" padded={false}>
            {skill.testRuns.length ? (
              <Table head={["When", "Version", "Status", "Agent", "Confidence", "Model", "Tokens", "Cost", "Duration"]}>
                {skill.testRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(r.createdAt)}</td>
                    <td className="fm-mono">v{r.skillVersion.version}</td>
                    <td>
                      <StatusBadge status={r.status === "PASSED" ? "COMPLETED" : r.status} />
                      {r.isMock ? (
                        <span className="ml-1.5">
                          <Badge tone="mock">MOCK</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="text-[12px]">{r.agentKey ?? "—"}</td>
                    <td className="fm-mono">{r.confidence.toFixed(2)}</td>
                    <td className="text-[11.5px]">{r.model || "—"}</td>
                    <td className="fm-mono">{r.tokensIn + r.tokensOut}</td>
                    <td className="fm-mono">{formatMoney(r.costUsd)}</td>
                    <td className="fm-mono">{r.durationMs}ms</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyState title="No test runs yet" />
            )}
          </Card>
        </div>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {tab === "history" ? (
        <Card title="Change history" description="Every skill change, with who made it and what it replaced." padded={false}>
          {auditRows.length ? (
            <div className="divide-y divide-[var(--color-border)]">
              {auditRows.map((row) => (
                <div key={row.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[12.5px] text-[var(--color-ink)]">{describeAuditEvent(row, userNames)}</span>
                    <span className="text-[11px] text-[var(--color-ink-3)]">{timeAgo(row.createdAt)}</span>
                  </div>
                  <Mono className="mt-0.5 block !text-[10.5px]">{row.action}</Mono>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No changes recorded yet" />
          )}
        </Card>
      ) : null}
    </>
  );
}

function RuleList({
  label,
  items,
  tone,
  ordered,
}: {
  label: string;
  items: string[];
  tone: "danger" | "warn" | "info" | "neutral";
  ordered?: boolean;
}) {
  if (!items.length) return null;
  const color = {
    danger: "var(--color-danger)",
    warn: "var(--color-warn)",
    info: "var(--color-info)",
    neutral: "var(--color-ink-3)",
  }[tone];

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color }}>
        {label}
      </div>
      {ordered ? (
        <ol className="list-inside list-decimal space-y-0.5 text-[11.5px] text-[var(--color-ink-2)]">
          {items.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ol>
      ) : (
        <ul className="list-inside list-disc space-y-0.5 text-[11.5px] text-[var(--color-ink-2)]">
          {items.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
