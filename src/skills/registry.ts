/**
 * Skill registry.
 *
 * Loads an agent's attached skills from the database and composes them into the
 * instruction block the agent injects into every LLM call. Because skills live
 * in the database, an operator can edit a methodology in the dashboard and the
 * next agent run picks it up - no redeploy, no code change.
 */
import { prisma } from "@/core/db/client";
import { readJson, readStringArray } from "@/core/db/json";
import type { SkillDefinition } from "@/skills/definitions";

export interface LoadedSkill extends SkillDefinition {
  id: string;
  version: number;
  priority: number;
}

export async function skillsForAgent(agentKey: string): Promise<LoadedSkill[]> {
  const rows = await prisma.agentSkill.findMany({
    where: { agent: { key: agentKey }, skill: { isActive: true } },
    include: { skill: true },
    orderBy: { priority: "asc" },
  });

  return rows.map((row) => ({
    id: row.skill.id,
    key: row.skill.key,
    name: row.skill.name,
    category: row.skill.category,
    description: row.skill.description,
    instructions: row.skill.instructions,
    methodology: readStringArray(row.skill.methodologyJson),
    constraints: readStringArray(row.skill.constraintsJson),
    outputContract: readJson<Record<string, string>>(row.skill.outputContractJson, {}),
    version: row.skill.version,
    priority: row.priority,
  }));
}

/** Render skills as a system-prompt section. */
export function renderSkills(skills: LoadedSkill[]): string {
  if (!skills.length) return "";
  const blocks = skills.map((s) => {
    const method = s.methodology.length ? `\nProcedure:\n${s.methodology.map((m, i) => `  ${i + 1}. ${m}`).join("\n")}` : "";
    const rules = s.constraints.length ? `\nHard rules (violating one fails validation):\n${s.constraints.map((c) => `  - ${c}`).join("\n")}` : "";
    const contract = Object.keys(s.outputContract).length
      ? `\nExpected output:\n${Object.entries(s.outputContract).map(([k, v]) => `  - ${k}: ${v}`).join("\n")}`
      : "";
    return `### Skill: ${s.name} (v${s.version})\n${s.instructions}${method}${rules}${contract}`;
  });
  return `## Applied skills\n\n${blocks.join("\n\n")}`;
}

/** All constraints across an agent's skills - used for post-generation checks. */
export function collectConstraints(skills: LoadedSkill[]): string[] {
  return skills.flatMap((s) => s.constraints);
}
