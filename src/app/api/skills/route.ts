/**
 * POST /api/skills — create a skill and its v1 DRAFT.
 *
 * The new skill is not live until its draft is activated, which is the same
 * gate every subsequent version passes through.
 */
import { z } from "zod";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { createSkill } from "@/skills/service";
import { SkillVersionConfigSchema } from "@/skills/types";
import { validateSkillConfig } from "@/skills/validation";

const Body = z.object({
  key: z.string().max(60).optional(),
  name: z.string().min(2).max(120),
  category: z.string().max(60).default("GENERAL"),
  description: z.string().max(600).default(""),
  changeSummary: z.string().max(500).optional(),
  config: SkillVersionConfigSchema,
});

export async function POST(req: Request) {
  try {
    const auth = await guard("skill:write", 40);
    const body = await parseBody(req, Body);
    const project = await activeProject(auth).catch(() => null);

    const { skill, version } = await createSkill(
      {
        key: body.key,
        name: body.name,
        category: body.category,
        description: body.description,
        config: body.config,
        changeSummary: body.changeSummary,
      },
      { organizationId: auth.organizationId, projectId: project?.id, actorId: auth.userId, actorName: auth.name },
    );

    // Surfaced immediately so the operator sees what activation will demand.
    const validation = validateSkillConfig(body.config);

    return ok({ ok: true, skillId: skill.id, skillKey: skill.key, versionId: version.id, version: version.version, validation });
  } catch (e) {
    return fail(e);
  }
}
