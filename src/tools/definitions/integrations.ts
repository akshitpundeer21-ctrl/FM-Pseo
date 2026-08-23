/**
 * Tools added by the Integrations Center.
 *
 * The shape is the same as every other tool in this system, which is the whole
 * point:
 *
 *     Agent  ->  Tool  ->  Integration  ->  Secret
 *
 * An agent names a tool key and passes structured input. `executeTool` checks
 * the agent's allowlist, its capability, its budget and its skill scope, then
 * resolves the credential server-side and hands it to `execute`. The agent
 * never sees a token, and an agent without the capability cannot reach these at
 * all no matter what it knows.
 *
 * `github.publish` requires the `publish` capability, which only the Publishing
 * Agent holds. The Keyword Research Agent cannot commit to a repository.
 */
import { z } from "zod";
import { registerTool } from "@/tools/registry";
import { resolveCredentials } from "@/integrations/service";
import { deleteFile, putFile, repoPathFor } from "@/integrations/clients/github";
import { readRows, updateRows } from "@/integrations/clients/google-sheets";
import { IntegrationNotConfiguredError } from "@/core/errors";

// ---------------------------------------------------------------------------
// GitHub publishing
// ---------------------------------------------------------------------------

export const githubPublishTool = registerTool({
  key: "github.publish",
  name: "Publish to GitHub",
  description:
    "Commits a rendered page to the configured repository and branch. A connected host deploys it. Requires the publish capability.",
  category: "publishing",
  requiredCapability: "publish",
  integrationProvider: "github",
  // No mock. A publish that did not happen must never look like one that did.
  allowMockFallback: false,
  timeoutMs: 60_000,
  inputSchema: z.object({
    url: z.string().min(1),
    html: z.string().min(1),
    title: z.string().optional(),
    /** Overrides the commit message the tool would compose. */
    message: z.string().optional(),
  }),
  outputSchema: z.object({
    committed: z.boolean(),
    repoPath: z.string(),
    commitSha: z.string(),
    htmlUrl: z.string(),
    updated: z.boolean(),
    repository: z.string(),
    branch: z.string(),
  }),
  async execute(input, ctx) {
    const creds = await resolveCredentials(ctx.organizationId, "github", ctx.projectId);
    if (!creds.configured) throw new IntegrationNotConfiguredError("github", creds.missing);

    const config = {
      token: creds.values.token,
      owner: creds.settings.owner,
      repo: creds.settings.repo,
      branch: creds.settings.branch || "main",
      contentPath: creds.settings.contentPath,
    };

    const repoPath = repoPathFor(input.url, config.contentPath);
    const result = await putFile(config, {
      repoPath,
      content: input.html,
      message: input.message ?? `Publish ${input.title ?? input.url}`,
    });

    ctx.logger.info("published to github", { repoPath, updated: result.updated });
    return {
      committed: true,
      repoPath: result.path,
      commitSha: result.commitSha,
      htmlUrl: result.htmlUrl,
      updated: result.updated,
      repository: `${config.owner}/${config.repo}`,
      branch: config.branch,
    };
  },
});

export const githubUnpublishTool = registerTool({
  key: "github.unpublish",
  name: "Remove from GitHub",
  description: "Deletes a previously committed page from the repository. Requires the unpublish capability.",
  category: "publishing",
  requiredCapability: "unpublish",
  integrationProvider: "github",
  allowMockFallback: false,
  timeoutMs: 60_000,
  inputSchema: z.object({ url: z.string().min(1), message: z.string().optional() }),
  outputSchema: z.object({ deleted: z.boolean(), repoPath: z.string() }),
  async execute(input, ctx) {
    const creds = await resolveCredentials(ctx.organizationId, "github", ctx.projectId);
    if (!creds.configured) throw new IntegrationNotConfiguredError("github", creds.missing);

    const config = {
      token: creds.values.token,
      owner: creds.settings.owner,
      repo: creds.settings.repo,
      branch: creds.settings.branch || "main",
      contentPath: creds.settings.contentPath,
    };
    const repoPath = repoPathFor(input.url, config.contentPath);
    const { deleted } = await deleteFile(config, { repoPath, message: input.message ?? `Unpublish ${input.url}` });
    ctx.logger.warn("removed from github", { repoPath, deleted });
    return { deleted, repoPath };
  },
});

// ---------------------------------------------------------------------------
// Google Sheets as a job queue
// ---------------------------------------------------------------------------

export const sheetsReadTool = registerTool({
  key: "google_sheets.read",
  name: "Read Google Sheet rows",
  description:
    "Reads rows from the configured spreadsheet, keyed by its header row. The column layout is whatever the sheet uses; nothing is assumed.",
  category: "data",
  requiredCapability: "call_external_api",
  integrationProvider: "google_sheets",
  allowMockFallback: false,
  timeoutMs: 30_000,
  inputSchema: z.object({
    limit: z.number().int().min(1).max(500).optional(),
    /** Header-keyed equality filter, e.g. { status: "pending" }. */
    filter: z.record(z.string(), z.string()).optional(),
  }),
  outputSchema: z.object({
    spreadsheetTitle: z.string(),
    sheetName: z.string(),
    header: z.array(z.string()),
    rows: z.array(z.object({ rowNumber: z.number(), values: z.record(z.string(), z.string()) })),
    rowCount: z.number(),
  }),
  async execute(input, ctx) {
    const creds = await resolveCredentials(ctx.organizationId, "google_sheets", ctx.projectId);
    if (!creds.configured) throw new IntegrationNotConfiguredError("google_sheets", creds.missing);

    const page = await readRows(
      {
        serviceAccountJson: creds.values.serviceAccountJson,
        spreadsheetId: creds.settings.spreadsheetId,
        sheetName: creds.settings.sheetName,
      },
      { limit: input.limit, filter: input.filter },
    );

    ctx.logger.info("read job queue", { sheet: page.sheetName, rows: page.rows.length });
    return {
      spreadsheetTitle: page.spreadsheetTitle,
      sheetName: page.sheetName,
      header: page.header,
      rows: page.rows,
      rowCount: page.rows.length,
    };
  },
});

export const sheetsUpdateTool = registerTool({
  key: "google_sheets.update",
  name: "Update Google Sheet rows",
  description:
    "Writes values back into named columns of specific rows - typically to mark a queued job as picked up or done. Only the named cells are touched.",
  category: "data",
  requiredCapability: "call_external_api",
  integrationProvider: "google_sheets",
  allowMockFallback: false,
  timeoutMs: 30_000,
  inputSchema: z.object({
    updates: z
      .array(
        z.object({
          rowNumber: z.number().int().min(2, "Row 1 is the header and is never written"),
          values: z.record(z.string(), z.string()),
        }),
      )
      .min(1)
      .max(200),
  }),
  outputSchema: z.object({ updatedCells: z.number(), updatedRows: z.number() }),
  async execute(input, ctx) {
    const creds = await resolveCredentials(ctx.organizationId, "google_sheets", ctx.projectId);
    if (!creds.configured) throw new IntegrationNotConfiguredError("google_sheets", creds.missing);

    const result = await updateRows(
      {
        serviceAccountJson: creds.values.serviceAccountJson,
        spreadsheetId: creds.settings.spreadsheetId,
        sheetName: creds.settings.sheetName,
      },
      input.updates,
    );

    ctx.logger.info("updated job queue", { cells: result.updatedCells });
    return result;
  },
});
