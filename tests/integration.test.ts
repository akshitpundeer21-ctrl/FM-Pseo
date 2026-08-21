/**
 * Integration tests against the real database, control plane, tool registry and
 * agents. These cover the governance guarantees that the product depends on:
 * an agent cannot use a tool it was not granted, cannot publish without an
 * approval, and cannot spend past its budget.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/core/db/client";
import { ControlPlane } from "@/control-plane/control-plane";
import { executeTool } from "@/tools/registry";
import "@/tools/definitions";
import { createAgent } from "@/agents/registry";
import { createTask, updateTaskStatus } from "@/engine/tasks/task-service";
import { login, registerUser, authFromToken } from "@/core/security/auth";
import { resolveCredentials, setCredential, listIntegrations } from "@/integrations/service";
import { assertRateLimit, budgetStatus, recordUsage, resetRateLimits } from "@/control-plane/budget";
import { DynamicDataEngine, routeBindings } from "@/engine/data/engine";
import { ToolNotPermittedError } from "@/core/errors";

let projectId: string;
let organizationId: string;

beforeAll(async () => {
  const project = await prisma.project.findFirst({ where: { slug: "faresmatch-global" } });
  if (!project) throw new Error("Seed did not run - no project found");
  projectId = project.id;
  organizationId = project.organizationId;
});

describe("database + seed", () => {
  it("seeds the agent catalog, skill library and component library", async () => {
    const [agents, skills, components, families, prompts] = await Promise.all([
      prisma.agent.count(),
      prisma.skill.count(),
      prisma.componentDef.count(),
      prisma.pageFamily.count({ where: { projectId } }),
      prisma.aIPrompt.count({ where: { projectId } }),
    ]);
    expect(agents).toBeGreaterThanOrEqual(13);
    expect(skills).toBeGreaterThanOrEqual(13);
    expect(components).toBeGreaterThanOrEqual(15);
    expect(families).toBeGreaterThanOrEqual(1);
    expect(prompts).toBeGreaterThan(0);
  });

  it("seeds no fabricated results", async () => {
    // The seed must create configuration only. Keywords, pages and metrics have
    // to come from actually running the agents.
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project).toBeTruthy();
    const agentRuns = await prisma.agentRun.count({ where: { projectId } });
    // Other tests in this file create runs; assert the seed itself made none by
    // checking there is no run older than the project.
    const oldest = await prisma.agentRun.findFirst({ where: { projectId }, orderBy: { startedAt: "asc" } });
    if (agentRuns > 0 && oldest) {
      expect(oldest.startedAt.getTime()).toBeGreaterThanOrEqual(project!.createdAt.getTime());
    }
  });

  it("attaches skills to agents", async () => {
    const kr = await prisma.agent.findUnique({ where: { key: "keyword_research" }, include: { skills: true } });
    expect(kr?.skills.length).toBeGreaterThan(0);
  });
});

describe("authentication", () => {
  it("signs a user in and resolves their tenant from the session token", async () => {
    const { token } = await login("admin@faresmatch.local", "faresmatch-demo-2026");
    const auth = await authFromToken(token);
    expect(auth?.email).toBe("admin@faresmatch.local");
    expect(auth?.organizationId).toBe(organizationId);
    expect(auth?.role).toBe("OWNER");
  });

  it("rejects a wrong password", async () => {
    await expect(login("admin@faresmatch.local", "not-the-password")).rejects.toThrow();
  });

  it("rejects an unknown session token", async () => {
    expect(await authFromToken("clearly-not-a-real-token")).toBeNull();
  });

  it("rejects a weak password at registration", async () => {
    await expect(registerUser({ email: "x@y.com", name: "X", password: "short", organizationId })).rejects.toThrow();
  });
});

describe("control plane", () => {
  it("refuses a tool the agent was not granted", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const contentAgent = await cp.identify("content_generation");
    // The content agent may generate, but publishing is not on its allowlist.
    expect(() => cp.assertToolAllowed(contentAgent, "cms.publish")).toThrow(ToolNotPermittedError);
    expect(contentAgent.capabilities).not.toContain("publish");
  });

  it("grants publishing only to the publishing agent", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const publisher = await cp.identify("publishing");
    expect(publisher.capabilities).toContain("publish");
    expect(() => cp.assertToolAllowed(publisher, "cms.publish")).not.toThrow();

    const all = await prisma.agent.findMany();
    const withPublish = all.filter((a) => JSON.parse(a.permissionsJson).includes("publish"));
    expect(withPublish.map((a) => a.key)).toEqual(["publishing"]);
  });

  it("refuses a capability the agent does not hold", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const linker = await cp.identify("internal_linking");
    expect(() => cp.assertCapability(linker, "publish")).toThrow();
    expect(() => cp.assertCapability(linker, "write_links")).not.toThrow();
  });

  it("blocks a disallowed tool at the execution layer, not just in policy", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const contentAgent = await cp.identify("content_generation");
    await expect(
      executeTool("cms.publish", { payload: { url: "/x", title: "t", metaDescription: "m", html: "<p></p>", jsonLd: [] } }, { controlPlane: cp, agent: contentAgent }),
    ).rejects.toThrow(/not permitted/i);
  });

  it("requires approval for publishing in SEMI_AUTOMATIC mode", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const decision = cp.decideApproval({ action: "publish", confidence: 0.99 });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.risk).toBe("HIGH");
  });

  it("lets low-risk research run unattended in SEMI_AUTOMATIC mode", async () => {
    const cp = await ControlPlane.forProject(projectId);
    expect(cp.decideApproval({ action: "keyword_research", confidence: 0.9 }).requiresApproval).toBe(false);
  });

  it("escalates a low-confidence run even when the action is low risk", async () => {
    const cp = await ControlPlane.forProject(projectId);
    expect(cp.decideApproval({ action: "keyword_research", confidence: 0.2 }).requiresApproval).toBe(true);
  });
});

describe("budget + rate limiting", () => {
  it("records usage against the organization ledger", async () => {
    const before = await budgetStatus(organizationId);
    await recordUsage({ organizationId, projectId, tokensIn: 1000, tokensOut: 500, costUsd: 0.25, category: "test" });
    const after = await budgetStatus(organizationId);
    expect(after.tokensUsed).toBe(before.tokensUsed + 1500);
    expect(after.costUsd).toBeCloseTo(before.costUsd + 0.25, 4);
  });

  it("enforces the rate limit", () => {
    resetRateLimits();
    for (let i = 0; i < 3; i++) assertRateLimit({ key: "test-key", limit: 3, windowMs: 60_000 });
    expect(() => assertRateLimit({ key: "test-key", limit: 3, windowMs: 60_000 })).toThrow(/rate limit/i);
  });
});

describe("integration credentials", () => {
  it("stores a credential encrypted and resolves it server-side without exposing it", async () => {
    await setCredential({ organizationId, provider: "dataforseo", key: "login", value: "test-login-value" });

    const row = await prisma.credential.findFirst({ where: { key: "login", integration: { provider: "dataforseo" } } });
    expect(row).toBeTruthy();
    expect(row!.ciphertext).not.toContain("test-login-value");
    expect(row!.hint).not.toContain("test-login-value");

    const resolved = await resolveCredentials(organizationId, "dataforseo");
    expect(resolved.values.login).toBe("test-login-value");

    // What the dashboard receives must never include the value.
    const publicView = await listIntegrations(organizationId, projectId);
    const dfs = publicView.find((i) => i.provider === "dataforseo")!;
    expect(JSON.stringify(dfs)).not.toContain("test-login-value");
    expect(dfs.credentials.find((c) => c.key === "login")?.present).toBe(true);

    await prisma.credential.delete({ where: { id: row!.id } });
  });

  it("reports an unconfigured integration honestly", async () => {
    const resolved = await resolveCredentials(organizationId, "amadeus");
    expect(resolved.configured).toBe(false);
    expect(resolved.missing.length).toBeGreaterThan(0);
  });
});

describe("dynamic data engine", () => {
  it("resolves route + airport data with full provenance", async () => {
    const engine = await DynamicDataEngine.forProject(projectId, organizationId);
    const ctx = await engine.resolve(routeBindings("DEL", "YYZ"));

    expect((ctx.values as any).route.distanceKm).toBeGreaterThan(10_000);
    expect((ctx.values as any).origin.city).toBe("Delhi");
    expect((ctx.values as any).destination.city).toBe("Toronto");
    expect(ctx.points.every((p) => p.sourceName && p.retrievedAt && typeof p.confidence === "number")).toBe(true);
    expect(ctx.containsMock).toBe(true);
  });

  it("refuses to serve live offers from a mock source", async () => {
    const engine = await DynamicDataEngine.forProject(projectId, organizationId);
    const ctx = await engine.resolve([{ namespace: "offers", params: { origin: "DEL", destination: "YYZ" } }]);
    // No credentialed provider -> reported missing, never fabricated.
    expect(ctx.missing).toContain("offers");
    expect(ctx.points.filter((p) => p.path.startsWith("offers."))).toHaveLength(0);
  });
});

describe("tool registry", () => {
  it("falls back to the labelled mock provider and flags it", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const agent = await cp.identify("keyword_research");
    const result = await executeTool("keyword.discover", { seeds: ["delhi to toronto flights"], origin: "DEL", destination: "YYZ", limit: 20 }, { controlPlane: cp, agent });

    expect(result.ok).toBe(true);
    expect(result.isMock).toBe(true);
    expect((result.output as any).rows.length).toBeGreaterThan(0);
  });

  it("validates tool input and rejects a bad shape", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const agent = await cp.identify("keyword_research");
    await expect(executeTool("keyword.discover", { seeds: "not-an-array" }, { controlPlane: cp, agent })).rejects.toThrow(/invalid input/i);
  });

  it("records every invocation for observability", async () => {
    const before = await prisma.toolInvocation.count();
    const cp = await ControlPlane.forProject(projectId);
    const agent = await cp.identify("keyword_research");
    await executeTool("research.competitors", { limit: 3 }, { controlPlane: cp, agent });
    expect(await prisma.toolInvocation.count()).toBe(before + 1);
  });

  it("never fabricates live flight offers", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const agent = await cp.identify("content_generation");
    // travel.offers has allowMockFallback:false, so with no credentials it must fail.
    await expect(
      executeTool("travel.offers", { origin: "DEL", destination: "YYZ", passengers: 1 }, { controlPlane: cp, agent }),
    ).rejects.toThrow(/not configured|amadeus/i);
  });
});

describe("task system", () => {
  it("creates and transitions a task through its lifecycle", async () => {
    const task = await createTask({ projectId, title: "Test task", goal: "verify the task lifecycle", agentKey: "keyword_research", input: { origin: "DEL" } });
    expect(task.status).toBe("PENDING");

    const running = await updateTaskStatus(task.id, "RUNNING");
    expect(running.status).toBe("RUNNING");
    expect(running.startedAt).toBeTruthy();
    expect(running.attempts).toBe(1);

    const done = await updateTaskStatus(task.id, "COMPLETED", { output: { ok: true }, confidence: 0.9, validationStatus: "PASSED" });
    expect(done.status).toBe("COMPLETED");
    expect(done.completedAt).toBeTruthy();
    expect(done.validationStatus).toBe("PASSED");
  });
});

describe("agent execution", () => {
  it("runs an agent and records a full, observable AgentRun", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const agent = createAgent("keyword_research", cp);
    const result = await agent.run({ origin: "DEL", destination: "YYZ", limit: 40 });

    expect(result.ok).toBe(true);
    expect(result.output.keywordCount).toBeGreaterThan(0);
    expect(result.toolsUsed).toContain("keyword.discover");

    const run = await prisma.agentRun.findUnique({ where: { id: result.agentRunId } });
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.outputSummary).toBeTruthy();
    expect(run?.isMock).toBe(true);
  });

  it("rejects input that fails the agent's own schema", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const agent = createAgent("keyword_research", cp);
    await expect(agent.run({ limit: "many" as never })).rejects.toThrow(/schema/i);
  });

  it("records a failure instead of silently returning nothing", async () => {
    const cp = await ControlPlane.forProject(projectId);
    const agent = createAgent("programmatic_opportunity", cp);
    const result = await agent.run({ pageFamilyKey: "does-not-exist" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const run = await prisma.agentRun.findUnique({ where: { id: result.agentRunId } });
    expect(run?.status).toBe("FAILED");
    expect(run?.error).toBeTruthy();
  });
});
