/**
 * Skill resolution + prompt rendering.
 *
 * The runtime never loads "a skill". It resolves the full chain:
 *
 *   agent -> assignment -> (pinned version | skill active version) -> config
 *
 * and hands back an immutable version. That is what lets a run from last week
 * still report exactly which instructions produced it, even after the skill has
 * been edited five times since.
 */
import { prisma } from "@/core/db/client";
import { readJson, readStringArray } from "@/core/db/json";
import { scopedLogger } from "@/core/logging/logger";
import {
  type ResolvedSkill,
  type SkillExample,
  type SkillIoField,
  type SkillModelGuidance,
  type SkillVersionStatus,
} from "@/skills/types";

const log = scopedLogger("skills.registry");

type VersionRow = {
  id: string;
  version: number;
  status: string;
  instructions: string;
  methodologyJson: string;
  constraintsJson: string;
  qualityCriteriaJson: string;
  safetyRulesJson: string;
  businessRulesJson: string;
  inputSchemaJson: string;
  outputSchemaJson: string;
  outputContractJson: string;
  examplesJson: string;
  allowedToolsJson: string;
  modelGuidanceJson: string;
};

type SkillRow = { id: string; key: string; name: string; category: string; description: string };

/** Turn a persisted version row into the runtime shape. */
export function hydrateVersion(skill: SkillRow, version: VersionRow, priority: number, pinned: boolean): ResolvedSkill {
  return {
    skillId: skill.id,
    skillKey: skill.key,
    name: skill.name,
    category: skill.category,
    description: skill.description,
    versionId: version.id,
    versionNumber: version.version,
    versionStatus: version.status as SkillVersionStatus,
    priority,
    pinned,
    instructions: version.instructions,
    methodology: readStringArray(version.methodologyJson),
    constraints: readStringArray(version.constraintsJson),
    qualityCriteria: readStringArray(version.qualityCriteriaJson),
    safetyRules: readStringArray(version.safetyRulesJson),
    businessRules: readStringArray(version.businessRulesJson),
    inputs: readJson<SkillIoField[]>(version.inputSchemaJson, []),
    outputs: readJson<SkillIoField[]>(version.outputSchemaJson, []),
    outputContract: readJson<Record<string, string>>(version.outputContractJson, {}),
    examples: readJson<SkillExample[]>(version.examplesJson, []),
    allowedTools: readStringArray(version.allowedToolsJson),
    modelGuidance: readJson<SkillModelGuidance>(version.modelGuidanceJson, {}),
  };
}

/**
 * Resolve every skill an agent should run with, in priority order.
 *
 * Skipped, with a warning rather than silently:
 *  - assignments that are disabled
 *  - skills whose identity is INACTIVE
 *  - skills with no active version and no pin (nothing safe to run)
 */
export async function resolveAgentSkills(agentKey: string): Promise<ResolvedSkill[]> {
  const rows = await prisma.agentSkill.findMany({
    where: { agent: { key: agentKey }, isEnabled: true },
    include: { skill: { include: { activeVersion: true } }, pinnedVersion: true },
    orderBy: { priority: "asc" },
  });

  const resolved: ResolvedSkill[] = [];

  for (const row of rows) {
    if (row.skill.status !== "ACTIVE") {
      log.warn("skill skipped - identity is not active", { agentKey, skill: row.skill.key, status: row.skill.status });
      continue;
    }

    const version = row.pinnedVersion ?? row.skill.activeVersion;
    if (!version) {
      log.warn("skill skipped - no active version and no pin", { agentKey, skill: row.skill.key });
      continue;
    }

    resolved.push(hydrateVersion(row.skill, version, row.priority, Boolean(row.pinnedVersionId)));
  }

  return resolved;
}

/** Back-compatible alias for the previous API. */
export const skillsForAgent = resolveAgentSkills;
export type LoadedSkill = ResolvedSkill;

/**
 * Render resolved skills as a system-prompt section.
 *
 * The version number is included deliberately: when an operator reads a run's
 * prompt they should see exactly which revision produced it.
 */
export function renderSkills(skills: ResolvedSkill[]): string {
  if (!skills.length) return "";

  const blocks = skills.map((s) => {
    const parts: string[] = [`### Skill: ${s.name} (v${s.versionNumber})`, s.instructions];

    if (s.inputs.length) {
      parts.push(
        `Inputs you will be given:\n${s.inputs
          .map((i) => `  - ${i.name} (${i.type}${i.required ? ", required" : ", optional"})${i.description ? `: ${i.description}` : ""}`)
          .join("\n")}`,
      );
    }
    if (s.methodology.length) {
      parts.push(`Procedure:\n${s.methodology.map((m, i) => `  ${i + 1}. ${m}`).join("\n")}`);
    }
    if (s.constraints.length) {
      parts.push(`Hard rules (violating one fails validation):\n${s.constraints.map((c) => `  - ${c}`).join("\n")}`);
    }
    if (s.safetyRules.length) {
      parts.push(`Safety requirements:\n${s.safetyRules.map((c) => `  - ${c}`).join("\n")}`);
    }
    if (s.businessRules.length) {
      parts.push(`Business rules:\n${s.businessRules.map((c) => `  - ${c}`).join("\n")}`);
    }
    if (s.qualityCriteria.length) {
      parts.push(`Quality bar:\n${s.qualityCriteria.map((c) => `  - ${c}`).join("\n")}`);
    }

    const outputLines = s.outputs.length
      ? s.outputs.map((o) => `  - ${o.name} (${o.type}${o.required ? ", required" : ", optional"})${o.description ? `: ${o.description}` : ""}`)
      : Object.entries(s.outputContract).map(([k, v]) => `  - ${k}: ${v}`);
    if (outputLines.length) parts.push(`Expected output:\n${outputLines.join("\n")}`);

    if (s.examples.length) {
      parts.push(
        `Worked example${s.examples.length === 1 ? "" : "s"}:\n${s.examples
          .slice(0, 3)
          .map((e) => `  - ${e.name}: given ${JSON.stringify(e.input)} produce ${e.expectedOutput.slice(0, 300)}`)
          .join("\n")}`,
      );
    }

    return parts.join("\n");
  });

  return `## Applied skills\n\n${blocks.join("\n\n")}`;
}

/** Render exactly one version, used by the sandbox and the playground. */
export function renderSingleSkill(skill: ResolvedSkill): string {
  return renderSkills([skill]);
}

/** All constraints across an agent's skills - used for post-generation checks. */
export function collectConstraints(skills: ResolvedSkill[]): string[] {
  return skills.flatMap((s) => [...s.constraints, ...s.safetyRules]);
}

/** Load one version in runtime shape, regardless of assignment. */
export async function loadSkillVersion(versionId: string): Promise<ResolvedSkill | null> {
  const version = await prisma.skillVersion.findUnique({ where: { id: versionId }, include: { skill: true } });
  if (!version) return null;
  return hydrateVersion(version.skill, version, 100, false);
}
