/**
 * Seeds the skill library as identity + immutable v1 version.
 *
 * Idempotent and non-destructive: a skill that already has versions is left
 * alone apart from its identity fields, so re-running the seed never overwrites
 * an operator's edits or resets an activated version.
 */
import { prisma } from "../src/core/db/client";
import { writeJson } from "../src/core/db/json";
import { SKILLS } from "../src/skills/definitions";
import { SKILL_EXTRAS, deriveOutputs } from "../src/skills/seed-config";

export async function seedSkills(): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;

  for (const definition of SKILLS) {
    const extras = SKILL_EXTRAS[definition.key] ?? {};

    const skill = await prisma.skill.upsert({
      where: { key: definition.key },
      update: {
        name: definition.name,
        category: definition.category,
        description: definition.description,
      },
      create: {
        key: definition.key,
        name: definition.name,
        category: definition.category,
        description: definition.description,
        status: "ACTIVE",
        createdBy: "system",
      },
    });

    const versionCount = await prisma.skillVersion.count({ where: { skillId: skill.id } });
    if (versionCount > 0) {
      existing++;
      continue;
    }

    const version = await prisma.skillVersion.create({
      data: {
        skillId: skill.id,
        version: 1,
        status: "ACTIVE",
        changeSummary: "Initial version seeded with the built-in skill library.",
        createdBy: "system",
        activatedAt: new Date(),
        instructions: definition.instructions,
        methodologyJson: writeJson(definition.methodology),
        constraintsJson: writeJson(definition.constraints),
        qualityCriteriaJson: writeJson(extras.qualityCriteria ?? []),
        safetyRulesJson: writeJson(extras.safetyRules ?? []),
        businessRulesJson: writeJson(extras.businessRules ?? []),
        inputSchemaJson: writeJson(extras.inputs ?? []),
        outputSchemaJson: writeJson(deriveOutputs(definition.outputContract)),
        outputContractJson: writeJson(definition.outputContract),
        examplesJson: writeJson(extras.examples ?? []),
        allowedToolsJson: writeJson(extras.allowedTools ?? []),
        modelGuidanceJson: writeJson(extras.modelGuidance ?? {}),
      },
    });

    await prisma.skill.update({ where: { id: skill.id }, data: { activeVersionId: version.id } });
    created++;
  }

  return { created, existing };
}

/**
 * Backfill schema detail onto skills whose only version came from the pre-
 * versioning migration (which had no inputs, tools or rule categories to carry
 * over). Only touches a v1 that is still exactly as migrated.
 */
export async function enrichMigratedVersions(): Promise<number> {
  let enriched = 0;

  for (const definition of SKILLS) {
    const extras = SKILL_EXTRAS[definition.key];
    if (!extras) continue;

    const skill = await prisma.skill.findUnique({ where: { key: definition.key }, include: { versions: true } });
    if (!skill || skill.versions.length !== 1) continue;

    const v = skill.versions[0];
    const untouched = v.inputSchemaJson === "[]" && v.allowedToolsJson === "[]" && v.outputSchemaJson === "[]";
    if (!untouched) continue;

    await prisma.skillVersion.update({
      where: { id: v.id },
      data: {
        qualityCriteriaJson: writeJson(extras.qualityCriteria ?? []),
        safetyRulesJson: writeJson(extras.safetyRules ?? []),
        businessRulesJson: writeJson(extras.businessRules ?? []),
        inputSchemaJson: writeJson(extras.inputs ?? []),
        outputSchemaJson: writeJson(deriveOutputs(definition.outputContract)),
        examplesJson: writeJson(extras.examples ?? []),
        allowedToolsJson: writeJson(extras.allowedTools ?? []),
        modelGuidanceJson: writeJson(extras.modelGuidance ?? {}),
      },
    });
    enriched++;
  }

  return enriched;
}
