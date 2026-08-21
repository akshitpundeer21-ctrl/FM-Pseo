"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Badge, EmptyState, Mono } from "@/ui/primitives";

export interface AssignmentRow {
  agentKey: string;
  agentName: string;
  enabled: boolean;
  priority: number;
  pinnedVersionId: string | null;
  pinnedVersion: number | null;
  /** Tools this agent grants out of what the skill requested. */
  effectiveTools: string[];
  deniedTools: string[];
}

/**
 * Assign a skill to agents, pin versions, and show the effective tool
 * permission per agent so the intersection rule is visible rather than implied.
 */
export function AssignmentManager({
  skillId,
  assignments,
  allAgents,
  versions,
  activeVersionId,
  requestedTools,
  canAssign,
}: {
  skillId: string;
  assignments: AssignmentRow[];
  allAgents: { key: string; name: string }[];
  versions: { id: string; version: number; status: string }[];
  activeVersionId: string | null;
  requestedTools: string[];
  canAssign: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);

  const unassigned = allAgents.filter((a) => !assignments.some((x) => x.agentKey === a.key));

  async function post(body: Record<string, unknown>, key: string) {
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
      {assignments.length ? (
        <div className="divide-y divide-[var(--color-border)]">
          {assignments.map((a) => (
            <div key={a.agentKey} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/agents/${a.agentKey}`} className="text-[13px] font-semibold hover:underline">
                      {a.agentName}
                    </Link>
                    {a.pinnedVersion ? (
                      <Badge tone="warn" title="This assignment ignores the active version">
                        pinned to v{a.pinnedVersion}
                      </Badge>
                    ) : (
                      <Badge tone="ok">follows active version</Badge>
                    )}
                    {!a.enabled ? <Badge tone="neutral">disabled</Badge> : null}
                  </div>
                  <Mono className="mt-0.5 block">{a.agentKey}</Mono>

                  {requestedTools.length ? (
                    <div className="mt-1.5 text-[11.5px]">
                      <span className="text-[var(--color-ink-3)]">Effective tools: </span>
                      {a.effectiveTools.length ? (
                        <span className="text-[var(--color-ok)]">{a.effectiveTools.join(", ")}</span>
                      ) : (
                        <span className="text-[var(--color-ink-4)]">none granted</span>
                      )}
                      {a.deniedTools.length ? (
                        <span className="text-[var(--color-danger)]"> · denied: {a.deniedTools.join(", ")}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {canAssign ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <select
                      className="fm-input !w-auto !py-1 !text-[11.5px]"
                      value={a.pinnedVersionId ?? ""}
                      disabled={busy === a.agentKey}
                      onChange={(e) => post({ action: "pin", agentKey: a.agentKey, versionId: e.target.value || null }, a.agentKey)}
                    >
                      <option value="">Follow active{activeVersionId ? "" : " (none set)"}</option>
                      {versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          Pin to v{v.version} ({v.status.toLowerCase()})
                        </option>
                      ))}
                    </select>
                    <button
                      className="fm-btn !px-2 !py-1 !text-[11.5px]"
                      onClick={() => post({ action: "set_enabled", agentKey: a.agentKey, isEnabled: !a.enabled }, a.agentKey)}
                      disabled={busy === a.agentKey}
                    >
                      {a.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      className="fm-btn fm-btn-danger !px-2 !py-1 !text-[11.5px]"
                      onClick={() => post({ action: "unassign", agentKey: a.agentKey }, a.agentKey)}
                      disabled={busy === a.agentKey}
                      title="Remove this skill from the agent"
                    >
                      {busy === a.agentKey ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="Not assigned to any agent" hint="A skill only affects behaviour once an agent is assigned to it." />
      )}

      {canAssign && unassigned.length ? (
        <div className="mt-3 flex items-center gap-2 border-t border-[var(--color-border)] pt-3">
          <select className="fm-input !py-1.5 !text-[12px]" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Select an agent…</option>
            {unassigned.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            className="fm-btn !py-1.5 !text-[12px]"
            disabled={!adding || busy === "add"}
            onClick={async () => {
              await post({ action: "assign", agentKey: adding }, "add");
              setAdding("");
            }}
          >
            {busy === "add" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Assign to agent
          </button>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}
