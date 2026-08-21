/**
 * POST /api/pages/:id/rollback — restore the previous published version, or
 * unpublish when there is none. Audited with the acting user.
 */
import { z } from "zod";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { rollbackPage } from "@/agents/publishing.agent";
import { prisma } from "@/core/db/client";
import { ForbiddenError, NotFoundError } from "@/core/errors";

const Body = z.object({ toVersion: z.number().int().positive().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await guard("publish:execute", 20);
    const { id } = await params;
    const body = await parseBody(req, Body);
    const project = await activeProject(auth);

    const page = await prisma.page.findUnique({ where: { id } });
    if (!page) throw new NotFoundError("Page", id);
    if (page.projectId !== project.id) throw new ForbiddenError("Page belongs to another project");

    const result = await rollbackPage({
      projectId: project.id,
      organizationId: auth.organizationId,
      pageId: id,
      actorId: auth.userId,
      toVersion: body.toVersion,
    });
    return ok({ ok: true, ...result });
  } catch (e) {
    return fail(e);
  }
}
