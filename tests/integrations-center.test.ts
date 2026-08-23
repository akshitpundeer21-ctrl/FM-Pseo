/**
 * Integrations Center tests.
 *
 * The security properties matter more than the features here, so they are
 * tested first and hardest: a secret must never leave the server, a connection
 * test must never lie about what it found, and an agent must not be able to
 * reach an integration it was not granted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/core/db/client";
import { INTEGRATION_CATALOG, findIntegration } from "@/integrations/catalog";
import {
  disconnectIntegration,
  listIntegrations,
  resolveCredentials,
  setCredential,
  setIntegrationSettings,
} from "@/integrations/service";
import { isTestable, safeMessage, testConnection } from "@/integrations/testers";
import { repoPathFor } from "@/integrations/clients/github";
import { columnLetter } from "@/integrations/clients/google-sheets";
import { parseAhrefsResponse, parseSemrushCsv } from "@/modules/keywords/seo-providers";
import { serviceAccountEmail } from "@/integrations/clients/google-auth";
import { executeTool, getTool } from "@/tools/registry";
import "@/tools/definitions";
import { ControlPlane } from "@/control-plane/control-plane";
import { AGENT_DEFINITIONS } from "@/agents/definitions";
import { ToolNotPermittedError } from "@/core/errors";

let organizationId: string;
let projectId: string;

beforeAll(async () => {
  const project = await prisma.project.findFirst({ where: { slug: "faresmatch-global" } });
  if (!project) throw new Error("Seed did not run - no project found");
  projectId = project.id;
  organizationId = project.organizationId;
});

describe("catalog", () => {
  it("carries every provider the Integrations Center must support", () => {
    const required = [
      "github",
      "google_sheets",
      "wordpress",
      "google_search_console",
      "ga4",
      "dataforseo",
      "semrush",
      "ahrefs",
      "amadeus",
      "duffel",
      "openai",
      "anthropic",
    ];
    const present = INTEGRATION_CATALOG.map((i) => i.provider);
    for (const provider of required) expect(present).toContain(provider);
  });

  it("did not drop or rename anything that already shipped", () => {
    // These strings are matched literally elsewhere in the app and in tests.
    for (const provider of ["webhook_cms", "perplexity", "internal_crawler", "wordpress", "amadeus"]) {
      expect(findIntegration(provider)).toBeTruthy();
    }
    expect(findIntegration("wordpress")!.credentials.map((c) => c.key)).toEqual(["username", "applicationPassword"]);
    expect(findIntegration("amadeus")!.credentials.map((c) => c.key)).toEqual(["clientId", "clientSecret"]);
  });

  it("keeps the three new secrets database-only, so no env var was added", () => {
    for (const provider of ["github", "semrush", "ahrefs"]) {
      for (const cred of findIntegration(provider)!.credentials) {
        expect(cred.envVar).toBeUndefined();
      }
    }
    // Sheets deliberately reuses the Google service account env var that exists.
    expect(findIntegration("google_sheets")!.credentials[0].envVar).toBe("GOOGLE_SERVICE_ACCOUNT_JSON");
  });
});

describe("secrets never reach the client", () => {
  it("returns a hint and never the stored value", async () => {
    await setCredential({
      organizationId,
      provider: "github",
      key: "token",
      value: "ghp_thisisatesttokenvalue000000000000",
      actorId: "test",
    });

    const listed = await listIntegrations(organizationId, projectId);
    const github = listed.find((i) => i.provider === "github")!;
    const serialised = JSON.stringify(github);

    expect(serialised).not.toContain("ghp_thisisatesttokenvalue000000000000");
    expect(github.credentials.find((c) => c.key === "token")!.present).toBe(true);
    expect(github.credentials.find((c) => c.key === "token")!.hint).not.toContain("thisisatest");
    expect(github.status).toBe("CONFIGURED");
  });

  it("stores the value encrypted, not in plaintext", async () => {
    const integration = await prisma.integration.findFirst({
      where: { organizationId, provider: "github" },
      include: { credentials: true },
    });
    const row = integration!.credentials.find((c) => c.key === "token")!;

    expect(row.ciphertext).not.toContain("ghp_");
    expect(row.iv).toBeTruthy();
    expect(row.authTag).toBeTruthy();
  });

  it("resolves the plaintext only on the server", async () => {
    const resolved = await resolveCredentials(organizationId, "github");
    expect(resolved.values.token).toBe("ghp_thisisatesttokenvalue000000000000");
    expect(resolved.source).toBe("database");
  });

  it("scrubs credential-shaped text out of anything shown to an operator", () => {
    expect(safeMessage("bad token ghp_abcdefghijklmnop rejected")).toContain("[redacted]");
    expect(safeMessage("bad token ghp_abcdefghijklmnop rejected")).not.toContain("abcdefghijklmnop");
    expect(safeMessage('{"private_key":"-----BEGIN PRIVATE KEY-----abc"}')).toContain("[redacted]");
    expect(safeMessage("Authorization: Bearer sk-abcdefghijklmnopqrst")).not.toContain("abcdefghijklmnop");
  });
});

describe("disconnect", () => {
  it("removes every stored secret and marks the integration disabled", async () => {
    await setCredential({ organizationId, provider: "semrush", key: "apiKey", value: "test-key-123", actorId: "test" });
    await setIntegrationSettings(organizationId, "semrush", { database: "uk" });

    const before = await resolveCredentials(organizationId, "semrush");
    expect(before.configured).toBe(true);

    const result = await disconnectIntegration(organizationId, "semrush");
    expect(result.removedCredentials).toBeGreaterThan(0);

    const after = await resolveCredentials(organizationId, "semrush");
    expect(after.configured).toBe(false);
    expect(after.values.apiKey).toBeUndefined();

    const row = await prisma.integration.findFirst({ where: { organizationId, provider: "semrush", projectId: null } });
    expect(row?.status).toBe("DISABLED");
    // Settings are cleared too, which the single-key DELETE could never do.
    expect(row?.configJson).toBe("{}");
  });

  it("is safe to call for a provider that was never configured", async () => {
    const result = await disconnectIntegration(organizationId, "ahrefs");
    expect(result.ok).toBe(true);
  });
});

describe("KNOWN DEFECT: credential scoping (pre-existing, not introduced here)", () => {
  // POST /api/integrations stores credentials with NO projectId, so they land
  // on the org-wide row. But executeTool resolves them with ctx.projectId, and
  // resolveCredentials matches `projectId: projectId ?? null` exactly - so the
  // org-wide row is invisible to it.
  //
  // Net effect: a provider connected through the dashboard is NOT visible to
  // the agents that need it. This predates the Integrations Center but it
  // defeats the point of it, so it is pinned here rather than left to be
  // rediscovered. Delete this test when resolveCredentials is fixed to fall
  // back to the org-wide row the way listIntegrations already does.
  it("does not surface a dashboard-stored credential to a project-scoped lookup", async () => {
    await setCredential({ organizationId, provider: "ahrefs", key: "apiKey", value: "scoping-probe", actorId: "test" });

    const orgWide = await resolveCredentials(organizationId, "ahrefs");
    const projectScoped = await resolveCredentials(organizationId, "ahrefs", projectId);

    expect(orgWide.configured).toBe(true);
    expect(orgWide.source).toBe("database");

    // This is the defect. When it is fixed, this expectation flips to true.
    expect(projectScoped.configured).toBe(false);
    expect(projectScoped.source).toBe("none");

    await disconnectIntegration(organizationId, "ahrefs");
  });

  it("still lists it in the dashboard, which is why the mismatch is easy to miss", async () => {
    await setCredential({ organizationId, provider: "ahrefs", key: "apiKey", value: "scoping-probe", actorId: "test" });

    // listIntegrations uses an OR over null + project, so the UI shows it as
    // connected even though a tool would not find it.
    const listed = await listIntegrations(organizationId, projectId);
    expect(listed.find((i) => i.provider === "ahrefs")!.status).toBe("CONFIGURED");

    await disconnectIntegration(organizationId, "ahrefs");
  });
});

describe("connection tests", () => {
  it("reports NOT_CONFIGURED rather than a failure when nothing is set up", async () => {
    const result = await testConnection(organizationId, "duffel");
    expect(result.outcome).toBe("NOT_CONFIGURED");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Not configured/i);
    // Naming what is missing is the useful part.
    expect(result.message).toContain("apiKey");
  });

  it("reports NOT_TESTABLE for a provider with nothing to reach", async () => {
    const result = await testConnection(organizationId, "internal_crawler");
    expect(result.outcome).toBe("NOT_TESTABLE");
  });

  it("refuses a provider that is not in the catalog", async () => {
    const result = await testConnection(organizationId, "not_a_provider");
    expect(result.outcome).toBe("NOT_TESTABLE");
    expect(result.message).toMatch(/not in the integration catalog/i);
  });

  it("knows which providers it can actually probe", () => {
    for (const provider of ["github", "google_sheets", "openai", "anthropic", "amadeus", "duffel", "wordpress"]) {
      expect(isTestable(provider)).toBe(true);
    }
    expect(isTestable("internal_crawler")).toBe(false);
  });
});

describe("the Control Plane still decides who may publish", () => {
  it("gave the Publishing Agent the GitHub tools and nobody else", () => {
    const withGithub = AGENT_DEFINITIONS.filter((a) => a.allowedTools.includes("github.publish")).map((a) => a.key);
    expect(withGithub).toEqual(["publishing"]);

    const keyword = AGENT_DEFINITIONS.find((a) => a.key === "keyword_research")!;
    expect(keyword.allowedTools).not.toContain("github.publish");
    expect(keyword.allowedTools).not.toContain("google_sheets.read");
  });

  it("kept github.publish behind the publish capability", () => {
    expect(getTool("github.publish").requiredCapability).toBe("publish");
    expect(getTool("github.unpublish").requiredCapability).toBe("unpublish");

    // Content agents were never given that capability and still are not.
    const contentGeneration = AGENT_DEFINITIONS.find((a) => a.key === "content_generation")!;
    expect(contentGeneration.capabilities).not.toContain("publish");
  });

  it("refuses github.publish for an agent that was not granted it", async () => {
    const controlPlane = await ControlPlane.forProject(projectId);
    const identity = await controlPlane.identify("keyword_research");

    await expect(
      executeTool("github.publish", { url: "/x", html: "<p>x</p>" }, { controlPlane, agent: identity }),
    ).rejects.toThrow(ToolNotPermittedError);
  });

  it("refuses the sheets tools for an agent that was not granted them", async () => {
    const controlPlane = await ControlPlane.forProject(projectId);
    const identity = await controlPlane.identify("content_generation");

    await expect(
      executeTool("google_sheets.read", {}, { controlPlane, agent: identity }),
    ).rejects.toThrow(ToolNotPermittedError);
  });

  it("refuses to publish to GitHub with no credentials rather than pretending", async () => {
    await disconnectIntegration(organizationId, "github");
    const controlPlane = await ControlPlane.forProject(projectId);
    const identity = await controlPlane.identify("publishing");

    await expect(
      executeTool(
        "github.publish",
        { url: "/flights/del/yyz", html: "<html></html>" },
        { controlPlane, agent: identity },
      ),
    ).rejects.toThrow(/not configured|github/i);
  });

  it("declares no mock fallback for publishing tools", () => {
    // A publish that did not happen must never look like one that did.
    expect(getTool("github.publish").allowMockFallback).toBe(false);
    expect(getTool("google_sheets.read").allowMockFallback).toBe(false);
    expect(getTool("google_sheets.update").allowMockFallback).toBe(false);
  });
});

describe("client helpers", () => {
  it("builds a repo path under the configured content directory", () => {
    expect(repoPathFor("/flights/del/yyz", "content/pages")).toBe("content/pages/flights/del/yyz.html");
    expect(repoPathFor("flights/del/yyz")).toBe("flights/del/yyz.html");
  });

  it("refuses a path that would escape the content directory", () => {
    expect(repoPathFor("/../../etc/passwd", "content")).toBe("content/etc/passwd.html");
    expect(() => repoPathFor("/", "content")).toThrow();
    expect(() => repoPathFor("../..", "content")).toThrow();
  });

  it("converts column indexes to A1 letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
  });

  it("reads the service account email without exposing the key", () => {
    const json = JSON.stringify({ client_email: "bot@project.iam.gserviceaccount.com", private_key: "SECRET" });
    expect(serviceAccountEmail(json)).toBe("bot@project.iam.gserviceaccount.com");
    expect(serviceAccountEmail("not json")).toBeNull();
    expect(serviceAccountEmail(JSON.stringify({ client_email: "x" }))).toBeNull();
  });
});

describe("SEO provider parsing", () => {
  const params = { seeds: ["delhi to toronto"], origin: "DEL", destination: "YYZ" };

  it("parses a Semrush CSV response", () => {
    const csv = "Keyword;Search Volume;Keyword Difficulty;CPC\ncheap flights to toronto;5400;62;1.85\ndelhi toronto flights;880;48;2.10";
    const rows = parseSemrushCsv(csv, params);

    expect(rows).toHaveLength(2);
    expect(rows[0].keyword).toBe("cheap flights to toronto");
    expect(rows[0].volume).toBe(5400);
    expect(rows[0].difficulty).toBe(62);
    expect(rows[0].source).toBe("semrush");
    expect(rows[0].isMock).toBe(false);
    expect(rows[0].origin).toBe("DEL");
  });

  it("throws on an unexpected Semrush shape rather than returning nothing", () => {
    expect(() => parseSemrushCsv("Something;Else\na;b", params)).toThrow(/Unexpected response columns/);
  });

  it("parses an Ahrefs JSON response and converts CPC from cents", () => {
    const rows = parseAhrefsResponse(
      { keywords: [{ keyword: "flights to toronto", volume_monthly: 3300, difficulty: 55, cpc: 190 }] },
      params,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].volume).toBe(3300);
    expect(rows[0].cpc).toBe(1.9);
    expect(rows[0].isMock).toBe(false);
  });

  it("throws on an unexpected Ahrefs shape rather than returning nothing", () => {
    expect(() => parseAhrefsResponse({ data: [] }, params)).toThrow(/keywords/);
  });

  it("never marks provider rows as mock", () => {
    const rows = parseSemrushCsv("Keyword;Search Volume;Keyword Difficulty;CPC\nx;10;1;0.1", params);
    expect(rows.every((r) => !r.isMock)).toBe(true);
  });
});
