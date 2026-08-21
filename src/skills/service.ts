/**
 * Skill management service.
 *
 * Owns every state change a skill can undergo: create, edit-as-draft, lifecycle
 * transition, activation, rollback and assignment. Every one of them writes an
 * audit event with the previous and new state, because "who changed the
 * instructions and when" is the first question anyone asks when output shifts.
 *
 * Invariants enforced here, not in the UI:
 *  - only a DRAFT can be edited; anything else is frozen
 *  - activation demotes the previous ACTIVE to ARCHIVED, never deletes it
 *  - a version is never destroyed, including on rollback
 *  - transitions follow the state machine in types.ts
 */
import { prisma } from "@/core/db/client";
import { readJson, readStringArray, writeJson } from "@/core/db/json";
import { ConflictLikeError, NotFoundError, ValidationError } from "@/skills/errors";
import { audit } from "@/control-plane/audit";
import { scopedLogger } from "@/core/logging/logger";
import { slugify } from "@/core/utils/text";
import {
  canTransition,
  isEditable,
  transitionError,
  type SkillVersionConfig,
  type SkillVersionStatus,
} from "@/skills/types";
import { hydrateVersion } from "@/skills/registry";

const log = scopedLogger("skills.service");

export interface ActorContext {
  organizationId: string;
  projectId?: string;
  actorId: string;
  actorName?: string;
}

// --- reading ---------------------------------------------------------------

export function configFromVersion(v: {
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
}): SkillVersionConfig {
  return {
    instructions: v.instructions,
    methodology: readStringArray(v.methodologyJson),
    constraints: readStringArray(v.constraintsJson),
    qualityCriteria: readStringArray(v.qualityCriteriaJson),
    safetyRules: readStringArray(v.safetyRulesJson),
    businessRules: readStringArray(v.businessRulesJson),
    inputs: readJson(v.inputSchemaJson, []),
    outputs: readJson(v.outputSchemaJson, []),
    outputContract: readJson(v.outputContractJson, {}),
    examples: readJson(v.examplesJson, []),
    allowedTools: readStringArray(v.allowedToolsJson),
    modelGuidance: readJson(v.modelGuidanceJson, {}),
  };
}

function configToColumns(config: SkillVersionConfig) {
  return {
    instructions: config.instructions,
    methodologyJson: writeJson(config.methodology),
    constraintsJson: writeJson(config.constraints),
    qualityCriteriaJson: writeJson(config.qualityCriteria),
    safetyRulesJson: writeJson(config.safetyRules),
    businessRulesJson: writeJson(config.businessRules),
    inputSchemaJson: writeJson(config.inputs),
    outputSchemaJson: writeJson(config.outputs),
    outputContractJson: writeJson(config.outputContract),
    examplesJson: writeJson(config.examples),
    allowedToolsJson: writeJson(config.allowedTools),
    modelGuidanceJson: writeJson(config.modelGuidance),
  };
}

export async function getSkillOrThrow(skillId: string) {
  const skill = await prisma.skill.findUnique({
    where: { id: skillId },
    include: {
      activeVersion: true,
      versions: { orderBy: { version: "desc" } },
      agents: { include: { agent: true, pinnedVersion: true } },
    },
  });
  if (!skill) throw new NotFoundError("Skill", skillId);
  return skill;
}

export async function getVersionOrThrow(skillId: string, versionId: string) {
  const version = await prisma.skillVersion.findUnique({ where: { id: versionId }, include: { skill: true } });
  if (!version || version.skillId !== skillId) throw new NotFoundError("Skill version", versionId);
  return version;
}

// --- creation --------------------------------------------------------------

export async function createSkill(
  params: { key?: string; name: string; category: string; description: string; config: SkillVersionConfig; changeSummary?: string },
  ctx: ActorContext,
) {
  const key = (params.key?.trim() || slugify(params.name).replace(/-/g, "_")).slice(0, 60);
  if (!key) throw new ValidationError("A skill key could not be derived from the name");

  const existing = await prisma.skill.findUnique({ where: { key } });
  if (existing) throw new ConflictLikeError(`A skill with the key "${key}" already exists`);

  const skill = await prisma.skill.create({
    data: {
      key,
      name: params.name.trim(),
      category: params.category.trim() || "GENERAL",
      description: params.description.trim(),
      status: "ACTIVE",
      createdBy: ctx.actorId,
    },
  });

  const version = await prisma.skillVersion.create({
    data: {
      skillId: skill.id,
      version: 1,
      status: "DRAFT",
      changeSummary: params.changeSummary?.trim() || "Initial version.",
      createdBy: ctx.actorId,
      ...configToColumns(params.config),
    },
  });

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: "skill.created",
    entityType: "SKILL",
    entityId: skill.id,
    meta: {
      skillKey: skill.key,
      skillName: skill.name,
      version: 1,
      previousState: null,
      newState: "DRAFT",
      changeSummary: version.changeSummary,
      actorName: ctx.actorName,
    },
  });

  log.info("skill created", { skill: skill.key, actorId: ctx.actorId });
  return { skill, version };
}

/** Clone a skill (and one of its versions) into a brand-new skill at v1 DRAFT. */
export async function duplicateSkill(skillId: string, sourceVersionId: string | undefined, ctx: ActorContext) {
  const skill = await getSkillOrThrow(skillId);
  const source = sourceVersionId
    ? await getVersionOrThrow(skillId, sourceVersionId)
    : (skill.activeVersion ?? skill.versions[0]);
  if (!source) throw new ValidationError("This skill has no version to duplicate");

  let key = `${skill.key}_copy`;
  let n = 1;
  while (await prisma.skill.findUnique({ where: { key } })) {
    n += 1;
    key = `${skill.key}_copy_${n}`;
  }

  const created = await createSkill(
    {
      key,
      name: `${skill.name} (copy)`,
      category: skill.category,
      description: skill.description,
      config: configFromVersion(source),
      changeSummary: `Duplicated from ${skill.name} v${source.version}.`,
    },
    ctx,
  );

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: "skill.duplicated",
    entityType: "SKILL",
    entityId: created.skill.id,
    meta: { sourceSkill: skill.key, sourceVersion: source.version, newSkill: created.skill.key, actorName: ctx.actorName },
  });

  return created;
}

export async function updateSkillIdentity(
  skillId: string,
  patch: { name?: string; description?: string; category?: string; status?: "ACTIVE" | "INACTIVE" },
  ctx: ActorContext,
) {
  const skill = await getSkillOrThrow(skillId);
  const before = { name: skill.name, description: skill.description, category: skill.category, status: skill.status };

  const updated = await prisma.skill.update({
    where: { id: skillId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.category !== undefined ? { category: patch.category.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
  });

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: patch.status && patch.status !== skill.status ? "skill.status_changed" : "skill.updated",
    entityType: "SKILL",
    entityId: skillId,
    meta: {
      skillKey: skill.key,
      skillName: updated.name,
      previousState: before,
      newState: { name: updated.name, description: updated.description, category: updated.category, status: updated.status },
      actorName: ctx.actorName,
    },
  });

  return updated;
}

// --- versions --------------------------------------------------------------

/**
 * Create a new draft, copying its content from an existing version.
 *
 * This is what "edit an active skill" resolves to: the active version is left
 * untouched and production keeps running it until the new draft is activated.
 */
export async function createDraftVersion(
  skillId: string,
  params: { fromVersionId?: string; config?: SkillVersionConfig; changeSummary?: string },
  ctx: ActorContext,
) {
  const skill = await getSkillOrThrow(skillId);

  const existingDraft = skill.versions.find((v) => v.status === "DRAFT");
  if (existingDraft && !params.config) {
    throw new ConflictLikeError(
      `This skill already has a draft (v${existingDraft.version}). Edit or discard it before creating another.`,
    );
  }

  const source = params.fromVersionId
    ? await getVersionOrThrow(skillId, params.fromVersionId)
    : (skill.activeVersion ?? skill.versions[0]);

  const config = params.config ?? (source ? configFromVersion(source) : undefined);
  if (!config) throw new ValidationError("No configuration supplied and no version to copy from");

  const nextVersion = (skill.versions[0]?.version ?? 0) + 1;

  const version = await prisma.skillVersion.create({
    data: {
      skillId,
      version: nextVersion,
      status: "DRAFT",
      changeSummary: params.changeSummary?.trim() || (source ? `Draft based on v${source.version}.` : "New draft."),
      createdBy: ctx.actorId,
      ...configToColumns(config),
    },
  });

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: "skill.version_created",
    entityType: "SKILL_VERSION",
    entityId: version.id,
    meta: {
      skillId,
      skillKey: skill.key,
      skillName: skill.name,
      version: nextVersion,
      basedOn: source?.version ?? null,
      previousState: null,
      newState: "DRAFT",
      changeSummary: version.changeSummary,
      actorName: ctx.actorName,
    },
  });

  log.info("draft version created", { skill: skill.key, version: nextVersion, actorId: ctx.actorId });
  return version;
}

/** Edit a draft in place. Refused for any other status - versions are immutable. */
export async function updateDraftVersion(
  skillId: string,
  versionId: string,
  params: { config: SkillVersionConfig; changeSummary?: string },
  ctx: ActorContext,
) {
  const version = await getVersionOrThrow(skillId, versionId);
  if (!isEditable(version.status)) {
    throw new ConflictLikeError(
      `v${version.version} is ${version.status} and immutable. Create a new draft to make changes.`,
    );
  }

  const before = configFromVersion(version);
  const updated = await prisma.skillVersion.update({
    where: { id: versionId },
    data: {
      ...configToColumns(params.config),
      ...(params.changeSummary !== undefined ? { changeSummary: params.changeSummary.trim() } : {}),
    },
  });

  const changedFields = (Object.keys(params.config) as (keyof SkillVersionConfig)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(params.config[k]),
  );

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: "skill.version_updated",
    entityType: "SKILL_VERSION",
    entityId: versionId,
    meta: {
      skillId,
      skillKey: version.skill.key,
      skillName: version.skill.name,
      version: version.version,
      previousState: "DRAFT",
      newState: "DRAFT",
      changedFields,
      changeSummary: updated.changeSummary,
      actorName: ctx.actorName,
    },
  });

  return updated;
}

/** Move a version through the lifecycle. Invalid transitions are refused. */
export async function transitionVersion(
  skillId: string,
  versionId: string,
  to: SkillVersionStatus,
  ctx: ActorContext,
) {
  const version = await getVersionOrThrow(skillId, versionId);
  const from = version.status as SkillVersionStatus;

  if (from === to) return version;
  if (to === "ACTIVE") {
    throw new ValidationError("Use the activation endpoint to make a version active - it runs preflight checks first.");
  }
  if (!canTransition(from, to)) throw new ConflictLikeError(transitionError(from, to));

  if (from === "ACTIVE" && to === "ARCHIVED") {
    const assigned = await prisma.agentSkill.count({ where: { skillId, isEnabled: true } });
    if (assigned > 0) {
      throw new ConflictLikeError(
        `v${version.version} is the active version for ${assigned} agent assignment(s). Activate a different version first, or unassign the skill.`,
      );
    }
  }

  const updated = await prisma.skillVersion.update({
    where: { id: versionId },
    data: {
      status: to,
      ...(to === "ARCHIVED" ? { archivedAt: new Date() } : {}),
    },
  });

  if (from === "ACTIVE" && to === "ARCHIVED") {
    await prisma.skill.update({ where: { id: skillId }, data: { activeVersionId: null } });
  }

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: "skill.version_transitioned",
    entityType: "SKILL_VERSION",
    entityId: versionId,
    meta: {
      skillId,
      skillKey: version.skill.key,
      skillName: version.skill.name,
      version: version.version,
      previousState: from,
      newState: to,
      actorName: ctx.actorName,
    },
  });

  log.info("version transitioned", { skill: version.skill.key, version: version.version, from, to });
  return updated;
}

/**
 * Make a version active.
 *
 * The previous active version is ARCHIVED, never deleted, so a rollback always
 * has something real to return to. Assignments that pin a specific version are
 * left alone - a pin is an explicit operator decision.
 */
export async function activateVersion(
  skillId: string,
  versionId: string,
  ctx: ActorContext,
  opts: { isRollback?: boolean } = {},
) {
  const skill = await getSkillOrThrow(skillId);
  const version = await getVersionOrThrow(skillId, versionId);

  if (version.status === "ACTIVE" && skill.activeVersionId === versionId) {
    throw new ConflictLikeError(`v${version.version} is already the active version.`);
  }

  const previous = skill.activeVersion;

  const result = await prisma.$transaction(async (tx) => {
    // Release the pointer first so the unique constraint never trips.
    await tx.skill.update({ where: { id: skillId }, data: { activeVersionId: null } });

    if (previous && previous.id !== versionId) {
      await tx.skillVersion.update({
        where: { id: previous.id },
        data: { status: "ARCHIVED", archivedAt: new Date() },
      });
    }

    const activated = await tx.skillVersion.update({
      where: { id: versionId },
      data: { status: "ACTIVE", activatedAt: new Date(), archivedAt: null },
    });

    await tx.skill.update({ where: { id: skillId }, data: { activeVersionId: versionId } });
    return activated;
  });

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: opts.isRollback ? "skill.rolled_back" : "skill.activated",
    entityType: "SKILL_VERSION",
    entityId: versionId,
    meta: {
      skillId,
      skillKey: skill.key,
      skillName: skill.name,
      version: version.version,
      previousVersion: previous?.version ?? null,
      previousState: previous ? `v${previous.version} ACTIVE` : "none",
      newState: `v${version.version} ACTIVE`,
      changeSummary: version.changeSummary,
      actorName: ctx.actorName,
    },
  });

  log.info(opts.isRollback ? "version rolled back" : "version activated", {
    skill: skill.key,
    to: version.version,
    from: previous?.version ?? null,
  });

  return { activated: result, previous };
}

export async function rollbackToVersion(skillId: string, targetVersionId: string, ctx: ActorContext) {
  const target = await getVersionOrThrow(skillId, targetVersionId);
  if (target.status === "DRAFT") {
    throw new ValidationError("A draft has never been active, so there is nothing to roll back to. Activate it instead.");
  }
  return activateVersion(skillId, targetVersionId, ctx, { isRollback: true });
}

// --- assignments -----------------------------------------------------------

export async function assignSkill(
  skillId: string,
  agentKey: string,
  ctx: ActorContext,
  opts: { priority?: number; pinnedVersionId?: string | null } = {},
) {
  const skill = await getSkillOrThrow(skillId);
  const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
  if (!agent) throw new NotFoundError("Agent", agentKey);

  if (opts.pinnedVersionId) await getVersionOrThrow(skillId, opts.pinnedVersionId);

  const existing = await prisma.agentSkill.findUnique({
    where: { agentId_skillId: { agentId: agent.id, skillId } },
  });

  const assignment = existing
    ? await prisma.agentSkill.update({
        where: { id: existing.id },
        data: {
          isEnabled: true,
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          ...(opts.pinnedVersionId !== undefined ? { pinnedVersionId: opts.pinnedVersionId } : {}),
        },
      })
    : await prisma.agentSkill.create({
        data: {
          agentId: agent.id,
          skillId,
          priority: opts.priority ?? 100,
          pinnedVersionId: opts.pinnedVersionId ?? null,
          assignedBy: ctx.actorId,
        },
      });

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: existing ? "skill.assignment_updated" : "skill.assigned",
    entityType: "SKILL",
    entityId: skillId,
    meta: {
      skillKey: skill.key,
      skillName: skill.name,
      agentKey,
      agentName: agent.name,
      previousState: existing ? { enabled: existing.isEnabled, pinnedVersionId: existing.pinnedVersionId } : null,
      newState: { enabled: true, pinnedVersionId: assignment.pinnedVersionId },
      actorName: ctx.actorName,
    },
  });

  return assignment;
}

export async function unassignSkill(skillId: string, agentKey: string, ctx: ActorContext) {
  const skill = await getSkillOrThrow(skillId);
  const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
  if (!agent) throw new NotFoundError("Agent", agentKey);

  const existing = await prisma.agentSkill.findUnique({
    where: { agentId_skillId: { agentId: agent.id, skillId } },
  });
  if (!existing) return { ok: true };

  await prisma.agentSkill.delete({ where: { id: existing.id } });

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: "skill.unassigned",
    entityType: "SKILL",
    entityId: skillId,
    meta: {
      skillKey: skill.key,
      skillName: skill.name,
      agentKey,
      agentName: agent.name,
      previousState: { enabled: existing.isEnabled, pinnedVersionId: existing.pinnedVersionId },
      newState: null,
      actorName: ctx.actorName,
    },
  });

  return { ok: true };
}

/** Pin an assignment to a specific version, or clear the pin to follow active. */
export async function setAssignmentVersion(
  skillId: string,
  agentKey: string,
  pinnedVersionId: string | null,
  ctx: ActorContext,
) {
  const skill = await getSkillOrThrow(skillId);
  const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
  if (!agent) throw new NotFoundError("Agent", agentKey);

  const existing = await prisma.agentSkill.findUnique({
    where: { agentId_skillId: { agentId: agent.id, skillId } },
  });
  if (!existing) throw new NotFoundError("Skill assignment", `${agentKey}/${skill.key}`);

  if (pinnedVersionId) await getVersionOrThrow(skillId, pinnedVersionId);

  const updated = await prisma.agentSkill.update({ where: { id: existing.id }, data: { pinnedVersionId } });
  const pinnedVersion = pinnedVersionId ? await prisma.skillVersion.findUnique({ where: { id: pinnedVersionId } }) : null;

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: pinnedVersionId ? "skill.version_pinned" : "skill.version_unpinned",
    entityType: "SKILL",
    entityId: skillId,
    meta: {
      skillKey: skill.key,
      skillName: skill.name,
      agentKey,
      agentName: agent.name,
      previousState: existing.pinnedVersionId,
      newState: pinnedVersionId ? `v${pinnedVersion?.version}` : "follows active version",
      actorName: ctx.actorName,
    },
  });

  return updated;
}

export async function setAssignmentEnabled(skillId: string, agentKey: string, isEnabled: boolean, ctx: ActorContext) {
  const skill = await getSkillOrThrow(skillId);
  const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
  if (!agent) throw new NotFoundError("Agent", agentKey);

  const existing = await prisma.agentSkill.findUnique({ where: { agentId_skillId: { agentId: agent.id, skillId } } });
  if (!existing) throw new NotFoundError("Skill assignment", `${agentKey}/${skill.key}`);

  const updated = await prisma.agentSkill.update({ where: { id: existing.id }, data: { isEnabled } });

  await audit({
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    actorType: "USER",
    actorId: ctx.actorId,
    action: "skill.assignment_updated",
    entityType: "SKILL",
    entityId: skillId,
    meta: {
      skillKey: skill.key,
      agentKey,
      agentName: agent.name,
      previousState: { enabled: existing.isEnabled },
      newState: { enabled: isEnabled },
      actorName: ctx.actorName,
    },
  });

  return updated;
}

/** Agent allowlists keyed by agent key, for tool-intersection reporting. */
export async function agentAllowlistsForSkill(skillId: string): Promise<Record<string, string[]>> {
  const rows = await prisma.agentSkill.findMany({ where: { skillId }, include: { agent: true } });
  return Object.fromEntries(rows.map((r) => [r.agent.key, readStringArray(r.agent.allowedToolsJson)]));
}

export { hydrateVersion };
