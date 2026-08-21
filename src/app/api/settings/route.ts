/**
 * PATCH /api/settings — project-level operating policy: approval mode,
 * confidence threshold and the AUTOMATIC-mode allowlist.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readRecord, writeJson } from "@/core/db/json";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { audit } from "@/control-plane/audit";
import { ApprovalModeSchema } from "@/core/types/enums";

const Body = z.object({
  approvalMode: ApprovalModeSchema.optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  autoApprovedActions: z.array(z.string()).optional(),
  monthlyTokenBudget: z.number().int().min(0).optional(),
  monthlyCostBudget: z.number().min(0).optional(),
});

export async function PATCH(req: Request) {
  try {
    const auth = await guard("settings:write", 40);
    const body = await parseBody(req, Body);
    const project = await activeProject(auth);

    const settings = readRecord(project.settingsJson);
    if (body.autoApprovedActions) settings.autoApprovedActions = body.autoApprovedActions;

    await prisma.project.update({
      where: { id: project.id },
      data: {
        ...(body.approvalMode ? { approvalMode: body.approvalMode } : {}),
        ...(body.confidenceThreshold !== undefined ? { confidenceThreshold: body.confidenceThreshold } : {}),
        settingsJson: writeJson(settings),
      },
    });

    if (body.monthlyTokenBudget !== undefined || body.monthlyCostBudget !== undefined) {
      await prisma.organization.update({
        where: { id: auth.organizationId },
        data: {
          ...(body.monthlyTokenBudget !== undefined ? { monthlyTokenBudget: body.monthlyTokenBudget } : {}),
          ...(body.monthlyCostBudget !== undefined ? { monthlyCostBudget: body.monthlyCostBudget } : {}),
        },
      });
    }

    await audit({
      organizationId: auth.organizationId,
      projectId: project.id,
      actorType: "USER",
      actorId: auth.userId,
      action: "settings.updated",
      entityType: "PROJECT",
      entityId: project.id,
      meta: body as Record<string, unknown>,
    });

    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
