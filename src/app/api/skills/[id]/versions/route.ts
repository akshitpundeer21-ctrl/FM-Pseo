/**
 * POST /api/skills/:id/versions — create a new DRAFT version.
 *
 * This is what "edit an active skill" resolves to. The active version is never
 * touched: production keeps running it until the draft is explicitly activated.
 */
import { z } from "zod";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { createDraftVersion } from "@/skills/service";
import { SkillVersionConfigSchema } from "@/skills/types";

const Body = z.object({
  fromVersionId: z.string().optional(),
  changeSummary: z.string().max(500).optional(),
  config: SkillVersionConfigSchema.optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await guard("skill:write", 60);
    const { id } = await params;
    const body = await parseBody(req, Body);
    const project = await activeProject(auth).catch(() => null);

    const version = await createDraftVersion(id, body, {
      organizationId: auth.organizationId,
      projectId: project?.id,
      actorId: auth.userId,
      actorName: auth.name,
    });

    return ok({
      ok: true,
      versionId: version.id,
      version: version.version,
      status: version.status,
      message: `v${version.version} created as a draft. The active version is unchanged until you activate it.`,
    });
  } catch (e) {
    return fail(e);
  }
}
