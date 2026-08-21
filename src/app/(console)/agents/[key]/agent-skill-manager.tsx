"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FlaskConical, Loader2, Plus, Settings2, X } from "lucide-react";
import { Badge, EmptyState, Mono, StatusBadge, timeAgo } from "@/ui/primitives";

export interface AgentSkillRow {
  skillId: string;
  skillKey: string;
  name: string;
  description: string;
  skillStatus: string;
  /** The version this agent will actually run. */
  resolvedVersion: number | null;
  resolvedStatus: string | null;
  pinnedVersionId: string | null;
  enabled: boolean;
  updatedAt: string;
  versions: { id: string; version: number; status: string }[];
  /** Tools this skill requests that this agent does NOT hold. */
  deniedTools: string[];
}

/**
 * Interactive skills section on the agent page: add, remove, pin a version,
 * open or test — without leaving the agent's context.
 */
export function AgentSkillManager({
  agentKey,
  skills,
  availableSkills,
  canAssign,
  canTest,
}: {
  agentKey: string;
  skills: AgentSkillRow[];
  availableSkills: { id: string; name: string }[];
  canAssign: boolean;
  canTest: boolean;
}) {
  const router = useRouter();
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function post(skillId: string, body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${skillId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) setError(data?.error?.message ?? "Request failed");
      else router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {skills.length ? (
        <div className="space-y-2.5">
          {skills.map((s) => (
            <div key={s.skillId} className="rounded-lg border border-[var(--color-border)] p-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/skills/${s.skillId}`} className="text-[12.5px] font-semibold hover:underline">
                      {s.name}
                    </Link>
                    {s.resolvedVersion !== null ? (
                      <>
                        <Mono className="!text-[var(--color-ink)]">v{s.resolvedVersion}</Mono>
                        <StatusBadge status={s.resolvedStatus ?? "ACTIVE"} />
                      </>
                    ) : (
                      <Badge tone="danger">will not run — no version resolves</Badge>
                    )}
                    {s.pinnedVersionId ? <Badge tone="warn">pinned</Badge> : null}
                    {!s.enabled ? <Badge tone="neutral">disabled</Badge> : null}
                    {s.skillStatus !== "ACTIVE" ? <Badge tone="danger">skill {s.skillStatus.toLowerCase()}</Badge> : null}
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[11.5px] text-[var(--color-ink-3)]">{s.description}</p>
                  {s.deniedTools.length ? (
                    <p className="mt-0.5 text-[11px] text-[var(--color-danger)]">
                      requests tools this agent does not hold: {s.deniedTools.join(", ")} — not granted
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[10.5px] text-[var(--color-ink-4)]">updated {timeAgo(s.updatedAt)}</p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Link href={`/skills/${s.skillId}`} className="fm-btn !px-2 !py-1 !text-[11.5px]">
                    Open
                  </Link>
                  {canTest ? (
                    <Link
                      href={`/skills/playground?skill=${s.skillId}`}
                      className="fm-btn !px-2 !py-1 !text-[11.5px]"
                      title="Test this skill"
                    >
                      <FlaskConical size={12} />
                    </Link>
                  ) : null}
                  {manage && canAssign ? (
                    <>
                      <select
                        className="fm-input !w-auto !py-1 !text-[11.5px]"
                        value={s.pinnedVersionId ?? ""}
                        disabled={busy === s.skillId}
                        onChange={(e) => post(s.skillId, { action: "pin", agentKey, versionId: e.target.value || null }, s.skillId)}
                      >
                        <option value="">Follow active</option>
                        {s.versions.map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.version} ({v.status.toLowerCase()})
                          </option>
                        ))}
                      </select>
                      <button
                        className="fm-btn fm-btn-danger !px-2 !py-1 !text-[11.5px]"
                        onClick={() => post(s.skillId, { action: "unassign", agentKey }, s.skillId)}
                        disabled={busy === s.skillId}
                        title="Remove this skill from the agent"
                      >
                        {busy === s.skillId ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No skills attached" hint="Assign one so this agent has a methodology to follow." />
      )}

      {canAssign ? (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          {manage ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <select className="fm-input !py-1.5 !text-[12px]" value={adding} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">Add a skill…</option>
                  {availableSkills.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  className="fm-btn !py-1.5 !text-[12px]"
                  disabled={!adding || busy === "add"}
                  onClick={async () => {
                    await post(adding, { action: "assign", agentKey }, "add");
                    setAdding("");
                  }}
                >
                  {busy === "add" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
                </button>
              </div>
              <button className="text-[11.5px] text-[var(--color-ink-3)] hover:underline" onClick={() => setManage(false)}>
                Done managing
              </button>
            </div>
          ) : (
            <button className="fm-btn !py-1.5 !text-[12px]" onClick={() => setManage(true)}>
              <Settings2 size={13} /> Manage skills
            </button>
          )}
        </div>
      ) : null}

      {error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}
