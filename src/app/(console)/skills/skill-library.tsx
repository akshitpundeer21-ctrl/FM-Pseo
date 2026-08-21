"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, FlaskConical, Loader2, Play, Plus, Search } from "lucide-react";
import { Badge, EmptyState, Mono, StatusBadge, Table, timeAgo } from "@/ui/primitives";

export interface SkillRow {
  id: string;
  key: string;
  name: string;
  category: string;
  description: string;
  status: string;
  activeVersion: number | null;
  activeVersionStatus: string | null;
  versionCount: number;
  draftVersion: number | null;
  allowedTools: string[];
  assignedAgents: { key: string; name: string; pinnedVersion: number | null; enabled: boolean }[];
  createdAt: string;
  updatedAt: string;
}

type SortKey = "name" | "updated" | "created" | "versions" | "agents";

export function SkillLibrary({
  skills,
  agents,
  categories,
  canWrite,
}: {
  skills: SkillRow[];
  agents: { key: string; name: string }[];
  categories: string[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [versionStatus, setVersionStatus] = useState("");
  const [category, setCategory] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [busy, setBusy] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = skills.filter((s) => {
      if (q && !(`${s.name} ${s.key} ${s.description} ${s.category}`.toLowerCase().includes(q))) return false;
      if (status && s.status !== status) return false;
      if (category && s.category !== category) return false;
      if (versionStatus === "HAS_DRAFT" && s.draftVersion === null) return false;
      if (versionStatus === "NO_ACTIVE" && s.activeVersion !== null) return false;
      if (agentKey && !s.assignedAgents.some((a) => a.key === agentKey)) return false;
      return true;
    });

    return rows.sort((a, b) => {
      switch (sort) {
        case "updated":
          return b.updatedAt.localeCompare(a.updatedAt);
        case "created":
          return b.createdAt.localeCompare(a.createdAt);
        case "versions":
          return b.versionCount - a.versionCount;
        case "agents":
          return b.assignedAgents.length - a.assignedAgents.length;
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [skills, query, status, category, versionStatus, agentKey, sort]);

  async function duplicate(skill: SkillRow) {
    setBusy(skill.id);
    try {
      const res = await fetch(`/api/skills/${skill.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "duplicate" }),
      });
      const data = await res.json();
      if (res.ok && data.skillId) router.push(`/skills/${data.skillId}`);
      else router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const activeFilters = [status, category, versionStatus, agentKey].filter(Boolean).length + (query ? 1 : 0);

  return (
    <>
      <div className="fm-card mb-4 p-3">
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="min-w-[240px] flex-1">
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]" htmlFor="q">
              Search
            </label>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-4)]" />
              <input
                id="q"
                className="fm-input !pl-8"
                placeholder="Name, key, description…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          <Select label="Status" value={status} onChange={setStatus} options={[["", "All"], ["ACTIVE", "Active"], ["INACTIVE", "Inactive"]]} />
          <Select
            label="Versions"
            value={versionStatus}
            onChange={setVersionStatus}
            options={[["", "All"], ["HAS_DRAFT", "Has a draft"], ["NO_ACTIVE", "No active version"]]}
          />
          <Select label="Category" value={category} onChange={setCategory} options={[["", "All"], ...categories.map((c) => [c, c] as [string, string])]} />
          <Select
            label="Assigned agent"
            value={agentKey}
            onChange={setAgentKey}
            options={[["", "Any"], ...agents.map((a) => [a.key, a.name] as [string, string])]}
          />
          <Select
            label="Sort"
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            options={[
              ["name", "Name"],
              ["updated", "Recently updated"],
              ["created", "Recently created"],
              ["versions", "Most versions"],
              ["agents", "Most assigned"],
            ]}
          />

          {activeFilters ? (
            <button
              className="fm-btn !py-1.5 !text-[12px]"
              onClick={() => {
                setQuery("");
                setStatus("");
                setCategory("");
                setVersionStatus("");
                setAgentKey("");
              }}
            >
              Clear ({activeFilters})
            </button>
          ) : null}
        </div>
      </div>

      <div className="fm-card overflow-hidden">
        {filtered.length ? (
          <Table
            head={["Skill", "Status", "Active version", "Assigned agents", "Requested tools", "Versions", "Updated", "Created", ""]}
          >
            {filtered.map((s) => (
              <tr key={s.id}>
                <td className="max-w-[300px]">
                  <Link href={`/skills/${s.id}`} className="font-medium hover:underline">
                    {s.name}
                  </Link>
                  <Mono className="mt-0.5 block">{s.key}</Mono>
                  <div className="mt-0.5 line-clamp-2 text-[11.5px] text-[var(--color-ink-3)]">{s.description}</div>
                  <div className="mt-1">
                    <Badge tone="neutral">{s.category}</Badge>
                  </div>
                </td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td>
                  {s.activeVersion !== null ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="fm-mono font-semibold text-[var(--color-ink)]">v{s.activeVersion}</span>
                      <StatusBadge status="ACTIVE" />
                    </span>
                  ) : (
                    <Badge tone="warn">no active version</Badge>
                  )}
                  {s.draftVersion !== null ? (
                    <div className="mt-1">
                      <Badge tone="info">v{s.draftVersion} draft</Badge>
                    </div>
                  ) : null}
                </td>
                <td className="max-w-[200px]">
                  {s.assignedAgents.length ? (
                    <div className="flex flex-wrap gap-1">
                      {s.assignedAgents.slice(0, 3).map((a) => (
                        <Link key={a.key} href={`/agents/${a.key}`}>
                          <Badge tone={a.enabled ? "brand" : "neutral"} title={a.pinnedVersion ? `Pinned to v${a.pinnedVersion}` : "Follows the active version"}>
                            {a.name}
                            {a.pinnedVersion ? ` · v${a.pinnedVersion}` : ""}
                          </Badge>
                        </Link>
                      ))}
                      {s.assignedAgents.length > 3 ? <Badge tone="neutral">+{s.assignedAgents.length - 3}</Badge> : null}
                    </div>
                  ) : (
                    <span className="text-[12px] text-[var(--color-ink-4)]">unassigned</span>
                  )}
                </td>
                <td className="max-w-[180px]">
                  {s.allowedTools.length ? (
                    <div className="flex flex-wrap gap-1">
                      {s.allowedTools.slice(0, 2).map((t) => (
                        <span key={t} className="rounded border border-[var(--color-border)] px-1.5 py-[1px] font-mono text-[10.5px] text-[var(--color-ink-3)]">
                          {t}
                        </span>
                      ))}
                      {s.allowedTools.length > 2 ? (
                        <span className="text-[10.5px] text-[var(--color-ink-4)]">+{s.allowedTools.length - 2}</span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-[11.5px] text-[var(--color-ink-4)]">agent allowlist</span>
                  )}
                </td>
                <td className="fm-mono">{s.versionCount}</td>
                <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{timeAgo(s.updatedAt)}</td>
                <td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">{s.createdAt.slice(0, 10)}</td>
                <td>
                  <div className="flex items-center gap-1.5">
                    <Link href={`/skills/${s.id}`} className="fm-btn !px-2 !py-1 !text-[11.5px]">
                      View
                    </Link>
                    <Link href={`/skills/playground?skill=${s.id}`} className="fm-btn !px-2 !py-1 !text-[11.5px]" title="Open in the playground">
                      <FlaskConical size={12} />
                    </Link>
                    {canWrite ? (
                      <button
                        className="fm-btn !px-2 !py-1 !text-[11.5px]"
                        onClick={() => duplicate(s)}
                        disabled={busy === s.id}
                        title="Duplicate into a new skill"
                      >
                        {busy === s.id ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            title={skills.length ? "No skills match these filters" : "No skills in the library"}
            hint={skills.length ? "Try clearing the filters." : "Create one to get started."}
          />
        )}
      </div>
    </>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="min-w-[130px]">
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">{label}</label>
      <select className="fm-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
