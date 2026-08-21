/**
 * PATCH /api/skills/:id/versions/:versionId — edit a DRAFT.
 * POST  /api/skills/:id/versions/:versionId — lifecycle actions:
 *        transition | preflight | activate
 *
 * Activation is deliberately two calls: `preflight` returns the validation and
 * test results the operator confirms against, then `activate` applies them.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import {
  activateVersion,
  agentAllowlistsForSkill,
  configFromVersion,
  getVersionOrThrow,
  transitionVersion,
  updateDraftVersion,
} from "@/skills/service";
import { SkillVersionConfigSchema, SkillVersionStatusSchema, type SkillVersionStatus } from "@/skills/types";
import { validateSkillConfig } from "@/skills/validation";
import { runSkillTest } from "@/skills/testing";
import { hydrateVersion } from "@/skills/registry";
import { ConflictLikeError } from "@/skills/errors";
import { readJson } from "@/core/db/json";

const PatchBody = z.object({
  config: SkillVersionConfigSchema,
  changeSummary: z.string().max(500).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  try {
    const auth = await guard("skill:write", 120);
    const { id, versionId } = await params;
    const body = await parseBody(req, PatchBody);
    const project = await activeProject(auth).catch(() => null);

    const version = await updateDraftVersion(id, versionId, body, {
      organizationId: auth.organizationId,
      projectId: project?.id,
      actorId: auth.userId,
      actorName: auth.name,
    });

    const allowlists = await agentAllowlistsForSkill(id);
    const validation = validateSkillConfig(body.config, allowlists);

    return ok({ ok: true, versionId: version.id, version: version.version, validation });
  } catch (e) {
    return fail(e);
  }
}

const ActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("transition"), to: SkillVersionStatusSchema }),
  z.object({ action: z.literal("preflight") }),
  z.object({ action: z.literal("activate"), confirmed: z.boolean() }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  try {
    const { id, versionId } = await params;
    const raw = await req.json().catch(() => ({}));
    const body = ActionBody.parse(raw);

    const permission = body.action === "transition" ? "skill:write" : "skill:activate";
    const auth = await guard(permission, 60);
    const project = await activeProject(auth).catch(() => null);
    const ctx = { organizationId: auth.organizationId, projectId: project?.id, actorId: auth.userId, actorName: auth.name };

    if (body.action === "transition") {
      const version = await transitionVersion(id, versionId, body.to as SkillVersionStatus, ctx);
      return ok({ ok: true, status: version.status, version: version.version });
    }

    // --- preflight + activate share the same checks -------------------------
    const version = await getVersionOrThrow(id, versionId);
    const config = configFromVersion(version);
    const allowlists = await agentAllowlistsForSkill(id);
    const validation = validateSkillConfig(config, allowlists);

    // Run the skill's saved test cases, or a single schema-shaped smoke test.
    const testCases = await prisma.skillTestCase.findMany({ where: { skillId: id } });
    const resolved = hydrateVersion(version.skill, version, 100, false);
    const assignedAgent = (await prisma.agentSkill.findFirst({ where: { skillId: id }, include: { agent: true } }))?.agent.key;

    const testResults = [];
    if (testCases.length) {
      for (const testCase of testCases.slice(0, 5)) {
        testResults.push(
          await runSkillTest({
            skill: resolved,
            input: readJson<Record<string, unknown>>(testCase.inputJson, {}),
            expectations: readJson(testCase.expectationsJson, []),
            testCaseId: testCase.id,
            agentKey: assignedAgent,
            organizationId: auth.organizationId,
            projectId: project?.id,
            actorId: auth.userId,
          }),
        );
      }
    } else {
      // No saved cases: synthesise one from the declared inputs so activation
      // still exercises the version rather than rubber-stamping it.
      const sample: Record<string, unknown> = {};
      for (const field of config.inputs.filter((f) => f.required)) {
        sample[field.name] =
          field.type === "number" ? 1 : field.type === "array" ? [] : field.type === "object" ? {} : `sample ${field.name}`;
      }
      testResults.push(
        await runSkillTest({
          skill: resolved,
          input: sample,
          agentKey: assignedAgent,
          organizationId: auth.organizationId,
          projectId: project?.id,
          actorId: auth.userId,
        }),
      );
    }

    const testsPassed = testResults.every((r) => r.status === "PASSED");
    const canActivate = validation.valid && testsPassed;

    const preflight = {
      validation,
      tests: testResults.map((r) => ({
        id: r.id,
        status: r.status,
        confidence: r.confidence,
        model: r.model,
        isMock: r.isMock,
        durationMs: r.durationMs,
        failures: r.validation.filter((f) => !f.passed && f.severity === "ERROR").map((f) => f.message),
        warnings: r.validation.filter((f) => !f.passed && f.severity === "WARNING").map((f) => f.message),
        output: r.output.slice(0, 1200),
        effectiveTools: r.effectiveTools,
        deniedTools: r.deniedTools,
      })),
      canActivate,
      currentStatus: version.status,
    };

    if (body.action === "preflight") return ok({ ok: true, preflight });

    // --- activate -----------------------------------------------------------
    if (!body.confirmed) throw new ConflictLikeError("Activation requires explicit confirmation.");
    if (!canActivate) {
      throw new ConflictLikeError(
        validation.valid
          ? "Automated skill tests did not pass. Fix the failures or reopen the draft."
          : `Configuration has ${validation.errors} blocking error(s). Fix them before activating.`,
        preflight,
      );
    }

    // Walk the lifecycle rather than jumping: DRAFT -> TESTING -> READY -> ACTIVE.
    let current = version.status as SkillVersionStatus;
    if (current === "DRAFT") {
      await transitionVersion(id, versionId, "TESTING", ctx);
      current = "TESTING";
    }
    if (current === "TESTING") {
      await transitionVersion(id, versionId, "READY", ctx);
      current = "READY";
    }

    const result = await activateVersion(id, versionId, ctx);

    return ok({
      ok: true,
      preflight,
      activeVersion: result.activated.version,
      previousVersion: result.previous?.version ?? null,
      message: `v${result.activated.version} is now active.${result.previous ? ` v${result.previous.version} was archived, not deleted.` : ""} Agents use it on their next run; completed runs keep the version they used.`,
    });
  } catch (e) {
    return fail(e);
  }
}
