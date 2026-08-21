/**
 * POST /api/approvals/:id  — approve or reject, then resume any paused workflow.
 * Approving is a human decision: it is audited with the deciding user's id.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { audit } from "@/control-plane/audit";
import { resumeWorkflow } from "@/engine/workflow/engine";
import { readJson } from "@/core/db/json";
import { NotFoundError, ForbiddenError } from "@/core/errors";

const Body = z.object({ decision: z.enum(["APPROVED", "REJECTED"]), notes: z.string().max(1000).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await guard("approval:decide", 60);
    const { id } = await params;
    const body = await parseBody(req, Body);
    const project = await activeProject(auth);

    const approval = await prisma.approval.findUnique({ where: { id } });
    if (!approval) throw new NotFoundError("Approval", id);
    if (approval.projectId !== project.id) throw new ForbiddenError("Approval belongs to another project");
    if (approval.status !== "PENDING") {
      return ok({ ok: false, error: `Approval is already ${approval.status}` }, 409);
    }

    await prisma.approval.update({
      where: { id },
      data: { status: body.decision, decidedById: auth.userId, decidedAt: new Date(), notes: body.notes },
    });

    await audit({
      organizationId: auth.organizationId,
      projectId: project.id,
      actorType: "USER",
      actorId: auth.userId,
      action: `approval.${body.decision.toLowerCase()}`,
      entityType: approval.entityType,
      entityId: approval.entityId,
      meta: { approvalId: id, title: approval.title, notes: body.notes },
    });

    // Resume whichever workflow run is parked on this approval.
    const payload = readJson<{ workflowRunId?: string }>(approval.payloadJson, {});
    let resumed: Awaited<ReturnType<typeof resumeWorkflow>> | null = null;

    const waitingRun =
      (payload.workflowRunId
        ? await prisma.workflowRun.findUnique({ where: { id: payload.workflowRunId } })
        : null) ??
      (await prisma.workflowRun.findFirst({
        where: { projectId: project.id, status: "WAITING_APPROVAL" },
        orderBy: { createdAt: "desc" },
      }));

    if (waitingRun && waitingRun.status === "WAITING_APPROVAL") {
      if (body.decision === "APPROVED") {
        resumed = await resumeWorkflow(waitingRun.id, auth.userId);
      } else {
        await prisma.workflowRun.update({
          where: { id: waitingRun.id },
          data: { status: "CANCELLED", error: "Approval rejected by reviewer", completedAt: new Date() },
        });
      }
    }

    if (body.decision === "REJECTED" && approval.entityType === "PAGE_VERSION") {
      await prisma.pageVersion.update({ where: { id: approval.entityId }, data: { status: "REJECTED" } }).catch(() => undefined);
      if (approval.pageId) {
        await prisma.page.update({ where: { id: approval.pageId }, data: { status: "REJECTED" } }).catch(() => undefined);
      }
    }

    return ok({
      ok: true,
      decision: body.decision,
      resumed: resumed
        ? { workflowRunId: resumed.workflowRunId, status: resumed.status, completedSteps: resumed.completedSteps, error: resumed.error }
        : null,
    });
  } catch (e) {
    return fail(e);
  }
}
