/**
 * POST /api/skills/:id/test — run a skill version in the sandbox.
 *
 * The sandbox executes generation only. It cannot publish, cannot create pages
 * and cannot mutate project data; it writes a SkillTestRun and nothing else.
 * `compareVersionId` runs a second version against the same input so a draft can
 * be judged against what is live before anything is activated.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { getSkillOrThrow, getVersionOrThrow } from "@/skills/service";
import { hydrateVersion } from "@/skills/registry";
import { runSkillTest, type TestExpectation } from "@/skills/testing";
import { readJson } from "@/core/db/json";
import { ValidationError } from "@/skills/errors";
import { audit } from "@/control-plane/audit";

const Body = z.object({
  versionId: z.string().optional(),
  compareVersionId: z.string().optional(),
  agentKey: z.string().optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  testCaseId: z.string().optional(),
  saveAs: z.string().max(120).optional(),
  expectations: z
    .array(
      z.object({
        type: z.enum(["contains", "not_contains", "matches", "min_words", "max_words", "json_field"]),
        value: z.string().max(400),
      }),
    )
    .optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await guard("skill:test", 40);
    const { id } = await params;
    const body = await parseBody(req, Body);
    const project = await activeProject(auth).catch(() => null);

    const skill = await getSkillOrThrow(id);
    const targetVersionId = body.versionId ?? skill.activeVersionId ?? skill.versions[0]?.id;
    if (!targetVersionId) throw new ValidationError("This skill has no version to test.");

    let input = body.input;
    let expectations: TestExpectation[] | undefined = body.expectations;

    if (body.testCaseId) {
      const testCase = await prisma.skillTestCase.findUnique({ where: { id: body.testCaseId } });
      if (testCase && testCase.skillId === id) {
        input = readJson<Record<string, unknown>>(testCase.inputJson, {});
        expectations = readJson<TestExpectation[]>(testCase.expectationsJson, []);
      }
    }

    const version = await getVersionOrThrow(id, targetVersionId);
    const primary = await runSkillTest({
      skill: hydrateVersion(version.skill, version, 100, false),
      input,
      expectations,
      agentKey: body.agentKey,
      testCaseId: body.testCaseId,
      organizationId: auth.organizationId,
      projectId: project?.id,
      actorId: auth.userId,
    });

    let comparison = null;
    if (body.compareVersionId && body.compareVersionId !== targetVersionId) {
      const other = await getVersionOrThrow(id, body.compareVersionId);
      comparison = await runSkillTest({
        skill: hydrateVersion(other.skill, other, 100, false),
        input,
        expectations,
        agentKey: body.agentKey,
        organizationId: auth.organizationId,
        projectId: project?.id,
        actorId: auth.userId,
      });
    }

    // Optionally keep the input as a reusable case for future activations.
    if (body.saveAs) {
      await prisma.skillTestCase.create({
        data: {
          skillId: id,
          name: body.saveAs,
          inputJson: JSON.stringify(input),
          expectationsJson: JSON.stringify(expectations ?? []),
          createdBy: auth.userId,
        },
      });
    }

    await audit({
      organizationId: auth.organizationId,
      projectId: project?.id,
      actorType: "USER",
      actorId: auth.userId,
      action: "skill.tested",
      entityType: "SKILL_VERSION",
      entityId: targetVersionId,
      meta: {
        skillId: id,
        skillKey: skill.key,
        skillName: skill.name,
        version: primary.version,
        newState: primary.status,
        comparedWith: comparison?.version ?? null,
        actorName: auth.name,
      },
    });

    return ok({ ok: true, result: primary, comparison });
  } catch (e) {
    return fail(e);
  }
}
