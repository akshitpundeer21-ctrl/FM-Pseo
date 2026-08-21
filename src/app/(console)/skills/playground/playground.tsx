"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SkillTestPanel } from "@/ui/skill-test-panel";
import { Badge, Callout, Mono } from "@/ui/primitives";

export interface PlaygroundSkill {
  id: string;
  key: string;
  name: string;
  category: string;
  activeVersionId: string | null;
  draftVersionId: string | null;
  versions: { id: string; version: number; status: string }[];
  inputs: { name: string; type: string; required: boolean; description: string }[];
  assignedAgentKeys: string[];
}

/**
 * Pick an agent, a skill and a version, supply an input, run it, and compare a
 * draft against what is live before activating anything.
 */
export function Playground({
  skills,
  agents,
  initialSkillId,
}: {
  skills: PlaygroundSkill[];
  agents: { key: string; name: string }[];
  initialSkillId?: string;
}) {
  const [agentKey, setAgentKey] = useState("");
  const [skillId, setSkillId] = useState(initialSkillId ?? skills[0]?.id ?? "");

  // Choosing an agent narrows the skill list to what that agent actually runs.
  const visibleSkills = useMemo(
    () => (agentKey ? skills.filter((s) => s.assignedAgentKeys.includes(agentKey)) : skills),
    [skills, agentKey],
  );

  const skill = skills.find((s) => s.id === skillId) ?? visibleSkills[0] ?? null;
  const activeVersion = skill?.versions.find((v) => v.id === skill.activeVersionId);
  const draftVersion = skill?.versions.find((v) => v.id === skill.draftVersionId);

  return (
    <div className="space-y-4">
      <div className="fm-card p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
              1. Agent
            </label>
            <select
              className="fm-input"
              value={agentKey}
              onChange={(e) => {
                const next = e.target.value;
                setAgentKey(next);
                const allowed = next ? skills.filter((s) => s.assignedAgentKeys.includes(next)) : skills;
                if (!allowed.some((s) => s.id === skillId)) setSkillId(allowed[0]?.id ?? "");
              }}
            >
              <option value="">Any agent (tool scope unresolved)</option>
              {agents.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-[var(--color-ink-4)]">
              Selecting an agent resolves the effective tool permissions for the run.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
              2. Skill
            </label>
            <select className="fm-input" value={skill?.id ?? ""} onChange={(e) => setSkillId(e.target.value)}>
              {visibleSkills.length ? (
                visibleSkills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))
              ) : (
                <option value="">No skills assigned to this agent</option>
              )}
            </select>
            {skill ? (
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                <Mono>{skill.key}</Mono>
                {activeVersion ? <Badge tone="ok">active v{activeVersion.version}</Badge> : <Badge tone="warn">no active version</Badge>}
                {draftVersion ? <Badge tone="info">draft v{draftVersion.version}</Badge> : null}
                <Link href={`/skills/${skill.id}`} className="text-[var(--color-brand)] hover:underline">
                  open skill
                </Link>
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {skill && draftVersion && activeVersion ? (
        <Callout tone="info" title={`Compare v${activeVersion.version} (live) against v${draftVersion.version} (draft)`}>
          Set <strong>Version</strong> to the draft and <strong>Compare against</strong> to the active version. Both run on the
          same input, side by side, so you can judge the change before activating it.
        </Callout>
      ) : null}

      {skill ? (
        <div className="fm-card p-4">
          <SkillTestPanel
            key={`${skill.id}-${agentKey}`}
            skillId={skill.id}
            versions={skill.versions}
            defaultVersionId={skill.draftVersionId ?? skill.activeVersionId}
            agents={agents}
            defaultAgentKey={agentKey || skill.assignedAgentKeys[0] || null}
            inputFields={skill.inputs}
          />
        </div>
      ) : (
        <div className="fm-card p-8 text-center text-[13px] text-[var(--color-ink-3)]">
          No skill selected. Assign a skill to this agent, or choose &ldquo;Any agent&rdquo;.
        </div>
      )}
    </div>
  );
}
