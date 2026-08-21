/**
 * Skill management: lifecycle, immutability, activation, rollback, assignment,
 * tool-intersection safety and runtime version resolution.
 *
 * The acceptance path is exercised end to end at the bottom:
 *   create -> assign -> test -> activate -> run -> v1 recorded
 *   edit -> v2 draft -> activate -> run -> v2 recorded
 *   rollback -> v1 active -> run -> v1 recorded
 *   ... and the historical runs still report the version they actually used.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/core/db/client";
import { ControlPlane } from "@/control-plane/control-plane";
import { createAgent } from "@/agents/registry";
import { readJson } from "@/core/db/json";
import {
  activateVersion,
  assignSkill,
  createDraftVersion,
  createSkill,
  duplicateSkill,
  rollbackToVersion,
  setAssignmentVersion,
  transitionVersion,
  unassignSkill,
  updateDraftVersion,
  updateSkillIdentity,
  configFromVersion,
} from "@/skills/service";
import { resolveAgentSkills, renderSkills, loadSkillVersion } from "@/skills/registry";
import { canTransition, computeEffectiveTools, EMPTY_CONFIG, type SkillVersionConfig } from "@/skills/types";
import { validateSkillConfig, validateSkillInput } from "@/skills/validation";
import { runSkillTest } from "@/skills/testing";
import { describeAuditEvent } from "@/control-plane/audit-describe";
import { roleHas } from "@/core/security/rbac";
import { executeTool } from "@/tools/registry";
import "@/tools/definitions";

let organizationId: string;
let projectId: string;
let actorId: string;
let ctx: { organizationId: string; projectId: string; actorId: string; actorName: string };

const baseConfig = (overrides: Partial<SkillVersionConfig> = {}): SkillVersionConfig => ({
  ...EMPTY_CONFIG,
  instructions:
    "Summarise the supplied route for a traveller comparing options. Use only the data provided and omit anything you were not given.",
  methodology: ["Read the input.", "Write the summary."],
  constraints: ["Never state a price."],
  outputs: [{ name: "summary", type: "string", required: true, description: "The route summary." }],
  outputContract: { summary: "A short route summary." },
  ...overrides,
});

beforeAll(async () => {
  const project = await prisma.project.findFirst({ where: { slug: "faresmatch-global" } });
  projectId = project!.id;
  organizationId = project!.organizationId;
  const user = await prisma.user.findFirst({ where: { email: "admin@faresmatch.local" } });
  actorId = user!.id;
  ctx = { organizationId, projectId, actorId, actorName: "Demo Operator" };
});

describe("migration + seed", () => {
  it("gives every seeded skill exactly one active version with its content intact", async () => {
    const skills = await prisma.skill.findMany({ include: { activeVersion: true, versions: true } });
    expect(skills.length).toBeGreaterThanOrEqual(15);

    for (const s of skills.filter((x) => x.key !== "test_skill" && !x.key.startsWith("tmp_"))) {
      expect(s.versions.length).toBeGreaterThan(0);
      if (s.status === "ACTIVE") {
        expect(s.activeVersionId).toBeTruthy();
        expect(s.activeVersion?.status).toBe("ACTIVE");
        expect(s.activeVersion?.instructions.length).toBeGreaterThan(20);
      }
    }
  });

  it("carried the schema detail onto the seeded versions", async () => {
    const skill = await prisma.skill.findUnique({ where: { key: "seo_keyword_research" }, include: { activeVersion: true } });
    const config = configFromVersion(skill!.activeVersion!);
    expect(config.inputs.length).toBeGreaterThan(0);
    expect(config.outputs.length).toBeGreaterThan(0);
    expect(config.allowedTools).toContain("keyword.discover");
  });
});

describe("lifecycle state machine", () => {
  it("permits only the defined transitions", () => {
    expect(canTransition("DRAFT", "TESTING")).toBe(true);
    expect(canTransition("TESTING", "READY")).toBe(true);
    expect(canTransition("READY", "ACTIVE")).toBe(true);
    expect(canTransition("ACTIVE", "ARCHIVED")).toBe(true);
    expect(canTransition("ARCHIVED", "ACTIVE")).toBe(true); // rollback
    expect(canTransition("TESTING", "DRAFT")).toBe(true); // reopen

    expect(canTransition("DRAFT", "READY")).toBe(false); // must be tested first
    expect(canTransition("DRAFT", "ACTIVE")).toBe(false);
    expect(canTransition("ACTIVE", "DRAFT")).toBe(false); // active is immutable
    expect(canTransition("ARCHIVED", "DRAFT")).toBe(false);
  });

  it("refuses an invalid transition at the service layer", async () => {
    const { skill, version } = await createSkill(
      { name: "Lifecycle probe", category: "TEST", description: "d", config: baseConfig() },
      ctx,
    );
    await expect(transitionVersion(skill.id, version.id, "READY", ctx)).rejects.toThrow(/Cannot move a version from DRAFT/i);
    await prisma.skill.delete({ where: { id: skill.id } });
  });
});

describe("versions are immutable", () => {
  it("refuses to edit anything that has left DRAFT", async () => {
    const { skill, version } = await createSkill(
      { name: "Immutable probe", category: "TEST", description: "d", config: baseConfig() },
      ctx,
    );
    await transitionVersion(skill.id, version.id, "TESTING", ctx);

    await expect(
      updateDraftVersion(skill.id, version.id, { config: baseConfig({ instructions: "changed" }) }, ctx),
    ).rejects.toThrow(/immutable/i);

    await prisma.skill.delete({ where: { id: skill.id } });
  });

  it("editing an active skill creates a new draft and leaves the active version untouched", async () => {
    const { skill, version } = await createSkill(
      { name: "Draft-on-edit probe", category: "TEST", description: "d", config: baseConfig() },
      ctx,
    );
    await activateVersion(skill.id, version.id, ctx);

    const draft = await createDraftVersion(skill.id, { changeSummary: "Tighten the wording." }, ctx);
    expect(draft.version).toBe(2);
    expect(draft.status).toBe("DRAFT");

    const after = await prisma.skill.findUnique({ where: { id: skill.id }, include: { activeVersion: true } });
    expect(after!.activeVersion!.version).toBe(1);
    expect(after!.activeVersion!.status).toBe("ACTIVE");

    // The draft is editable; the active version still is not.
    await updateDraftVersion(skill.id, draft.id, { config: baseConfig({ instructions: "New wording entirely." }) }, ctx);
    const reloaded = await prisma.skillVersion.findUnique({ where: { id: draft.id } });
    expect(reloaded!.instructions).toBe("New wording entirely.");

    const v1 = await prisma.skillVersion.findUnique({ where: { id: version.id } });
    expect(v1!.instructions).toBe(baseConfig().instructions);

    await prisma.skill.delete({ where: { id: skill.id } });
  });
});

describe("activation and rollback", () => {
  it("archives the previous active version rather than deleting it", async () => {
    const { skill, version: v1 } = await createSkill(
      { name: "Activation probe", category: "TEST", description: "d", config: baseConfig() },
      ctx,
    );
    await activateVersion(skill.id, v1.id, ctx);
    const v2 = await createDraftVersion(skill.id, {}, ctx);
    const result = await activateVersion(skill.id, v2.id, ctx);

    expect(result.activated.version).toBe(2);
    expect(result.previous?.version).toBe(1);

    const versions = await prisma.skillVersion.findMany({ where: { skillId: skill.id }, orderBy: { version: "asc" } });
    expect(versions).toHaveLength(2);
    expect(versions[0].status).toBe("ARCHIVED"); // kept, not destroyed
    expect(versions[1].status).toBe("ACTIVE");

    await prisma.skill.delete({ where: { id: skill.id } });
  });

  it("rolls back to an archived version without losing the newer one", async () => {
    const { skill, version: v1 } = await createSkill(
      { name: "Rollback probe", category: "TEST", description: "d", config: baseConfig() },
      ctx,
    );
    await activateVersion(skill.id, v1.id, ctx);
    const v2 = await createDraftVersion(skill.id, {}, ctx);
    await activateVersion(skill.id, v2.id, ctx);

    await rollbackToVersion(skill.id, v1.id, ctx);

    const after = await prisma.skill.findUnique({ where: { id: skill.id }, include: { activeVersion: true, versions: true } });
    expect(after!.activeVersion!.version).toBe(1);
    expect(after!.versions).toHaveLength(2);
    expect(after!.versions.find((v) => v.version === 2)!.status).toBe("ARCHIVED");

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId, action: "skill.rolled_back", entityId: v1.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    expect(describeAuditEvent(audit!)).toMatch(/rolled back/i);

    await prisma.skill.delete({ where: { id: skill.id } });
  });

  it("refuses to activate a version that is already active", async () => {
    const { skill, version } = await createSkill(
      { name: "Double activation probe", category: "TEST", description: "d", config: baseConfig() },
      ctx,
    );
    await activateVersion(skill.id, version.id, ctx);
    await expect(activateVersion(skill.id, version.id, ctx)).rejects.toThrow(/already the active version/i);
    await prisma.skill.delete({ where: { id: skill.id } });
  });
});

describe("tool permissions are never widened by a skill", () => {
  it("intersects the agent allowlist with the skill request", () => {
    const scope = computeEffectiveTools(["keyword.discover", "travel.reference"], [
      { allowedTools: ["keyword.discover", "cms.publish"] },
    ]);
    expect(scope.effectiveTools).toEqual(["keyword.discover"]);
    expect(scope.deniedTools).toEqual(["cms.publish"]); // asked for, not granted
    expect(scope.narrowed).toBe(true);
  });

  it("does not brick an agent whose skills declare tools it does not hold", () => {
    // A skill attached for its methodology may declare tools that belong to a
    // different agent's context. Narrowing to an empty set would revoke every
    // tool the agent holds, which protects nothing and breaks the agent.
    const scope = computeEffectiveTools(["cms.publish", "cms.unpublish"], [{ allowedTools: ["web.crawl", "web.fetch"] }]);
    expect(scope.effectiveTools).toEqual(["cms.publish", "cms.unpublish"]);
    expect(scope.narrowed).toBe(false);
    expect(scope.narrowingSkippedReason).toBeTruthy();
    // The ceiling still holds: nothing was granted that the agent did not hold.
    expect(scope.effectiveTools).not.toContain("web.crawl");
    expect(scope.deniedTools).toEqual(["web.crawl", "web.fetch"]);
  });

  it("leaves the agent allowlist untouched when no skill requests tools", () => {
    const scope = computeEffectiveTools(["a", "b"], [{ allowedTools: [] }]);
    expect(scope.effectiveTools).toEqual(["a", "b"]);
    expect(scope.narrowed).toBe(false);
  });

  it("blocks a tool outside the resolved skill scope at execution time", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const agent = await cp.identify("keyword_research");

    // The agent holds research.competitors, but this scope does not include it.
    await expect(
      executeTool(
        "research.competitors",
        { limit: 2 },
        { controlPlane: cp, agent, skillScopedTools: ["keyword.discover"] },
      ),
    ).rejects.toThrow(/outside the tool scope/i);
  });

  it("still refuses a tool the agent never held, whatever the skill asks for", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const agent = await cp.identify("content_generation");
    await expect(
      executeTool(
        "cms.publish",
        { payload: { url: "/x", title: "t", metaDescription: "m", html: "<p></p>", jsonLd: [] } },
        { controlPlane: cp, agent, skillScopedTools: ["cms.publish"] },
      ),
    ).rejects.toThrow(/not permitted/i);
  });

  it("flags an ungrantable request during validation", async () => {
    const report = validateSkillConfig(baseConfig({ allowedTools: ["cms.publish"] }), {
      keyword_research: ["keyword.discover"],
    });
    const finding = report.findings.find((f) => f.check === "tools_grantable");
    expect(finding?.passed).toBe(false);
    expect(finding?.message).toMatch(/cms\.publish/);
  });
});

describe("configuration validation", () => {
  it("blocks an empty or undefined configuration", () => {
    const report = validateSkillConfig({ ...EMPTY_CONFIG, instructions: "" });
    expect(report.valid).toBe(false);
    expect(report.findings.find((f) => f.check === "instructions_present")?.passed).toBe(false);
    expect(report.findings.find((f) => f.check === "output_defined")?.passed).toBe(false);
  });

  it("rejects a tool that is not in the registry", () => {
    const report = validateSkillConfig(baseConfig({ allowedTools: ["not.a.real.tool"] }));
    expect(report.valid).toBe(false);
    expect(report.findings.find((f) => f.check === "tools_exist")?.message).toMatch(/not\.a\.real\.tool/);
  });

  it("refuses a credential embedded in the instructions", () => {
    const report = validateSkillConfig(
      baseConfig({ instructions: "Call the API with api_key: sk-ant-abcdefghijklmnop and summarise." }),
    );
    expect(report.valid).toBe(false);
    expect(report.findings.find((f) => f.check === "no_embedded_secrets")?.passed).toBe(false);
  });

  it("catches duplicate and unnamed schema fields", () => {
    const report = validateSkillConfig(
      baseConfig({
        inputs: [
          { name: "a", type: "string", required: true, description: "" },
          { name: "a", type: "string", required: false, description: "" },
          { name: "", type: "string", required: false, description: "" },
        ],
      }),
    );
    expect(report.findings.find((f) => f.check === "input_unique_names")?.passed).toBe(false);
    expect(report.findings.find((f) => f.check === "input_named")?.passed).toBe(false);
  });

  it("validates a sample input against the declared schema", () => {
    const inputs = [
      { name: "website", type: "url" as const, required: true, description: "" },
      { name: "limit", type: "number" as const, required: false, description: "" },
      { name: "market", type: "enum" as const, required: false, description: "", enumValues: ["US", "GB"] },
    ];
    expect(validateSkillInput(inputs, { website: "example.com", limit: 5, market: "US" }).every((f) => f.passed)).toBe(true);
    expect(validateSkillInput(inputs, {}).some((f) => !f.passed)).toBe(true);
    expect(validateSkillInput(inputs, { website: "example.com", market: "FR" }).some((f) => !f.passed)).toBe(true);
  });
});

describe("assignment and resolution", () => {
  it("resolves the active version by default and a pin when set", async () => {
    const { skill, version: v1 } = await createSkill(
      { name: "Resolution probe", category: "TEST", description: "d", config: baseConfig() },
      ctx,
    );
    await activateVersion(skill.id, v1.id, ctx);
    await assignSkill(skill.id, "internal_linking", ctx);

    let resolved = await resolveAgentSkills("internal_linking");
    let mine = resolved.find((s) => s.skillId === skill.id);
    expect(mine?.versionNumber).toBe(1);
    expect(mine?.pinned).toBe(false);

    const v2 = await createDraftVersion(skill.id, {}, ctx);
    await activateVersion(skill.id, v2.id, ctx);

    resolved = await resolveAgentSkills("internal_linking");
    mine = resolved.find((s) => s.skillId === skill.id);
    expect(mine?.versionNumber).toBe(2); // follows active

    await setAssignmentVersion(skill.id, "internal_linking", v1.id, ctx);
    resolved = await resolveAgentSkills("internal_linking");
    mine = resolved.find((s) => s.skillId === skill.id);
    expect(mine?.versionNumber).toBe(1); // pin wins
    expect(mine?.pinned).toBe(true);

    await unassignSkill(skill.id, "internal_linking", ctx);
    await prisma.skill.delete({ where: { id: skill.id } });
  });

  it("skips an INACTIVE skill even where it is assigned", async () => {
    const { skill, version } = await createSkill(
      { name: "Inactive probe", category: "TEST", description: "d", config: baseConfig() },
      ctx,
    );
    await activateVersion(skill.id, version.id, ctx);
    await assignSkill(skill.id, "internal_linking", ctx);

    expect((await resolveAgentSkills("internal_linking")).some((s) => s.skillId === skill.id)).toBe(true);

    await updateSkillIdentity(skill.id, { status: "INACTIVE" }, ctx);
    expect((await resolveAgentSkills("internal_linking")).some((s) => s.skillId === skill.id)).toBe(false);

    await prisma.skill.delete({ where: { id: skill.id } });
  });

  it("renders the resolved version number into the prompt", async () => {
    const resolved = await resolveAgentSkills("keyword_research");
    const prompt = renderSkills(resolved);
    expect(prompt).toContain("## Applied skills");
    expect(prompt).toMatch(/### Skill: .+ \(v\d+\)/);
  });

  it("duplicates a skill into an independent copy", async () => {
    const source = await prisma.skill.findUnique({ where: { key: "seo_keyword_research" } });
    const copy = await duplicateSkill(source!.id, undefined, ctx);
    expect(copy.skill.key).toMatch(/^seo_keyword_research_copy/);
    expect(copy.version.version).toBe(1);
    expect(copy.version.status).toBe("DRAFT");
    await prisma.skill.delete({ where: { id: copy.skill.id } });
  });
});

describe("sandbox", () => {
  it("runs a version and reports full telemetry without touching production", async () => {
    const skill = await prisma.skill.findUnique({ where: { key: "seo_keyword_research" }, include: { activeVersion: true } });
    const resolved = await loadSkillVersion(skill!.activeVersionId!);

    const pagesBefore = await prisma.page.count({ where: { projectId } });
    const publishesBefore = await prisma.publishRecord.count();

    const result = await runSkillTest({
      skill: resolved!,
      input: { origin: "DEL", destination: "YYZ", limit: 20 },
      agentKey: "keyword_research",
      organizationId,
      projectId,
      actorId,
    });

    expect(result.status).toBe("PASSED");
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.version).toBe(resolved!.versionNumber);
    expect(result.toolsUsed).toEqual(["llm.generate"]);
    expect(result.effectiveTools).toContain("keyword.discover");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Nothing in production moved.
    expect(await prisma.page.count({ where: { projectId } })).toBe(pagesBefore);
    expect(await prisma.publishRecord.count()).toBe(publishesBefore);

    const row = await prisma.skillTestRun.findUnique({ where: { id: result.id! } });
    expect(row?.skillVersionId).toBe(resolved!.versionId);
  });

  it("fails a test whose sample input misses a required field", async () => {
    const { skill, version } = await createSkill(
      {
        name: "Input guard probe",
        category: "TEST",
        description: "d",
        config: baseConfig({ inputs: [{ name: "website", type: "url", required: true, description: "site" }] }),
      },
      ctx,
    );
    const resolved = await loadSkillVersion(version.id);
    const result = await runSkillTest({ skill: resolved!, input: {}, organizationId, projectId, actorId });

    expect(result.status).toBe("FAILED");
    expect(result.validation.some((v) => !v.passed && v.message.includes("website"))).toBe(true);

    await prisma.skill.delete({ where: { id: skill.id } });
  });
});

describe("permissions", () => {
  it("restricts authoring to admins and owners, leaving view and test open", () => {
    for (const p of ["skill:write", "skill:activate", "skill:assign"] as const) {
      expect(roleHas("OWNER", p)).toBe(true);
      expect(roleHas("ADMIN", p)).toBe(true);
      expect(roleHas("EDITOR", p)).toBe(false);
      expect(roleHas("VIEWER", p)).toBe(false);
    }
    expect(roleHas("EDITOR", "skill:test")).toBe(true);
    expect(roleHas("VIEWER", "skill:read")).toBe(true);
    expect(roleHas("VIEWER", "skill:test")).toBe(false);
  });
});

describe("acceptance path: create -> activate -> run -> edit -> activate -> rollback", () => {
  it("records the exact version used on every run, forever", async () => {
    // --- create v1 and activate it ----------------------------------------
    const { skill, version: v1 } = await createSkill(
      {
        name: "Acceptance Link Rules",
        category: "TEST",
        description: "Governs how the linking agent proposes links.",
        config: baseConfig({ instructions: "Version one instructions: propose links conservatively." }),
        changeSummary: "First cut.",
      },
      ctx,
    );

    await assignSkill(skill.id, "internal_linking", ctx);
    await activateVersion(skill.id, v1.id, ctx);

    // --- run the agent and confirm v1 was used ------------------------------
    const cp = await ControlPlane.forProject(projectId, actorId);
    const run1 = await createAgent("internal_linking", cp).run({ projectWide: true });
    expect(run1.ok).toBe(true);

    const record1 = await prisma.agentRun.findUnique({ where: { id: run1.agentRunId } });
    const used1 = readJson<{ skillKey: string; version: number; versionId: string }[]>(record1!.skillsUsedJson, []);
    const mine1 = used1.find((s) => s.skillKey === skill.key);
    expect(mine1?.version).toBe(1);
    expect(mine1?.versionId).toBe(v1.id);

    // --- edit -> v2 draft -> activate ---------------------------------------
    const v2 = await createDraftVersion(skill.id, { changeSummary: "Loosen the relevance floor." }, ctx);
    await updateDraftVersion(
      skill.id,
      v2.id,
      { config: baseConfig({ instructions: "Version two instructions: propose links generously." }) },
      ctx,
    );
    await activateVersion(skill.id, v2.id, ctx);

    const run2 = await createAgent("internal_linking", cp).run({ projectWide: true });
    const record2 = await prisma.agentRun.findUnique({ where: { id: run2.agentRunId } });
    const used2 = readJson<{ skillKey: string; version: number }[]>(record2!.skillsUsedJson, []);
    expect(used2.find((s) => s.skillKey === skill.key)?.version).toBe(2);

    // --- rollback to v1 ------------------------------------------------------
    await rollbackToVersion(skill.id, v1.id, ctx);
    const run3 = await createAgent("internal_linking", cp).run({ projectWide: true });
    const record3 = await prisma.agentRun.findUnique({ where: { id: run3.agentRunId } });
    const used3 = readJson<{ skillKey: string; version: number }[]>(record3!.skillsUsedJson, []);
    expect(used3.find((s) => s.skillKey === skill.key)?.version).toBe(1);

    // --- the crux: history is not rewritten ---------------------------------
    const replay1 = readJson<{ skillKey: string; version: number }[]>(
      (await prisma.agentRun.findUnique({ where: { id: run1.agentRunId } }))!.skillsUsedJson,
      [],
    );
    const replay2 = readJson<{ skillKey: string; version: number }[]>(
      (await prisma.agentRun.findUnique({ where: { id: run2.agentRunId } }))!.skillsUsedJson,
      [],
    );
    expect(replay1.find((s) => s.skillKey === skill.key)?.version).toBe(1);
    expect(replay2.find((s) => s.skillKey === skill.key)?.version).toBe(2);

    // And v2's instructions are still exactly what run 2 executed with.
    const storedV2 = await prisma.skillVersion.findUnique({ where: { id: v2.id } });
    expect(storedV2!.instructions).toContain("Version two instructions");

    // --- the audit trail tells the story ------------------------------------
    const events = await prisma.auditLog.findMany({
      where: { organizationId, action: { startsWith: "skill." }, createdAt: { gte: skill.createdAt } },
      orderBy: { createdAt: "asc" },
    });
    const sentences = events.map((e) => describeAuditEvent(e, { [actorId]: "Demo Operator" }));
    expect(sentences.some((s) => /created Acceptance Link Rules v1/i.test(s))).toBe(true);
    expect(sentences.some((s) => /activated Acceptance Link Rules v2/i.test(s))).toBe(true);
    expect(sentences.some((s) => /rolled back Acceptance Link Rules/i.test(s))).toBe(true);

    await unassignSkill(skill.id, "internal_linking", ctx);
    await prisma.skill.delete({ where: { id: skill.id } });
  });
});
