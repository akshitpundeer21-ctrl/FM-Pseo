/**
 * PATCH  /api/skills/:id — edit skill identity (name, description, category, status)
 * POST   /api/skills/:id — actions that operate on the skill as a whole:
 *                          duplicate, rollback, assignment changes
 */
import { z } from "zod";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import {
  assignSkill,
  duplicateSkill,
  rollbackToVersion,
  setAssignmentEnabled,
  setAssignmentVersion,
  unassignSkill,
  updateSkillIdentity,
} from "@/skills/service";
import { SkillStatusSchema } from "@/skills/types";
import { ValidationError } from "@/skills/errors";

const PatchBody = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(600).optional(),
  category: z.string().max(60).optional(),
  status: SkillStatusSchema.optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await guard("skill:write", 60);
    const { id } = await params;
    const body = await parseBody(req, PatchBody);
    const project = await activeProject(auth).catch(() => null);

    const skill = await updateSkillIdentity(id, body, {
      organizationId: auth.organizationId,
      projectId: project?.id,
      actorId: auth.userId,
      actorName: auth.name,
    });

    return ok({ ok: true, skill: { id: skill.id, name: skill.name, status: skill.status } });
  } catch (e) {
    return fail(e);
  }
}

const ActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("duplicate"), sourceVersionId: z.string().optional() }),
  z.object({ action: z.literal("rollback"), targetVersionId: z.string() }),
  z.object({
    action: z.literal("assign"),
    agentKey: z.string(),
    priority: z.number().int().min(0).max(1000).optional(),
    pinnedVersionId: z.string().nullable().optional(),
  }),
  z.object({ action: z.literal("unassign"), agentKey: z.string() }),
  z.object({ action: z.literal("pin"), agentKey: z.string(), versionId: z.string().nullable() }),
  z.object({ action: z.literal("set_enabled"), agentKey: z.string(), isEnabled: z.boolean() }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const raw = await req.json().catch(() => ({}));
    const body = ActionBody.parse(raw);

    // Each action carries its own permission - rollback is an activation-class
    // change, assignment is its own grant, duplication is authoring.
    const permission =
      body.action === "rollback"
        ? "skill:activate"
        : body.action === "duplicate"
          ? "skill:write"
          : "skill:assign";

    const auth = await guard(permission, 60);
    const project = await activeProject(auth).catch(() => null);
    const ctx = {
      organizationId: auth.organizationId,
      projectId: project?.id,
      actorId: auth.userId,
      actorName: auth.name,
    };

    switch (body.action) {
      case "duplicate": {
        const created = await duplicateSkill(id, body.sourceVersionId, ctx);
        return ok({ ok: true, skillId: created.skill.id, skillKey: created.skill.key, versionId: created.version.id });
      }
      case "rollback": {
        const result = await rollbackToVersion(id, body.targetVersionId, ctx);
        return ok({
          ok: true,
          activeVersion: result.activated.version,
          previousVersion: result.previous?.version ?? null,
          message: `Rolled back to v${result.activated.version}${result.previous ? ` from v${result.previous.version}` : ""}. v${result.previous?.version ?? "?"} is archived, not deleted.`,
        });
      }
      case "assign": {
        await assignSkill(id, body.agentKey, ctx, {
          priority: body.priority,
          pinnedVersionId: body.pinnedVersionId ?? undefined,
        });
        return ok({ ok: true });
      }
      case "unassign": {
        await unassignSkill(id, body.agentKey, ctx);
        return ok({ ok: true });
      }
      case "pin": {
        await setAssignmentVersion(id, body.agentKey, body.versionId, ctx);
        return ok({ ok: true });
      }
      case "set_enabled": {
        await setAssignmentEnabled(id, body.agentKey, body.isEnabled, ctx);
        return ok({ ok: true });
      }
      default:
        throw new ValidationError("Unknown action");
    }
  } catch (e) {
    return fail(e);
  }
}
