/**
 * GitHub Contents API client.
 *
 * Used by the github.publish tool to commit a rendered page to a repository,
 * which a connected host (Vercel, Netlify, Pages) then deploys.
 *
 * Scope is deliberately narrow: read a file's SHA, write a file, delete a file.
 * There is no branch creation, no PR, no workflow dispatch and no repo
 * administration. A publishing credential should not be able to do more than
 * publish.
 *
 * The token is passed in by the tool layer, which resolved it server-side. It
 * is never logged, never returned, and never placed in an error message.
 */
import { IntegrationNotConfiguredError, PublishError } from "@/core/errors";
import { scopedLogger } from "@/core/logging/logger";

const log = scopedLogger("github");
const API = "https://api.github.com";

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch?: string;
  /** Directory inside the repo, e.g. "content/flights". */
  contentPath?: string;
}

export interface CommitResult {
  path: string;
  commitSha: string;
  htmlUrl: string;
  /** True when the file already existed and was replaced. */
  updated: boolean;
}

/** Strips anything token-shaped out of a provider error before it propagates. */
function safe(text: string): string {
  return text
    .replace(/(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function assertConfigured(config: Partial<GitHubConfig>): asserts config is GitHubConfig {
  const missing = (["token", "owner", "repo"] as const).filter((k) => !config[k]);
  if (missing.length) throw new IntegrationNotConfiguredError("github", missing as unknown as string[]);
}

/**
 * Joins the configured content directory with a site-relative page URL, and
 * refuses anything that would escape the directory.
 */
export function repoPathFor(urlPath: string, contentPath?: string, extension = ".html"): string {
  const clean = urlPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
  if (!clean) throw new PublishError("github", "Refusing to publish: the page URL resolved to an empty path.");
  const dir = (contentPath ?? "").replace(/^\/+|\/+$/g, "");
  return `${dir ? `${dir}/` : ""}${clean}${extension}`;
}

async function gh(config: GitHubConfig, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "faresmatch-aios",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

/** The blob SHA of an existing file, or null when it does not exist. */
export async function fileSha(config: Partial<GitHubConfig>, repoPath: string): Promise<string | null> {
  assertConfigured(config);
  const branch = config.branch || "main";
  const res = await gh(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${repoPath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(branch)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new PublishError("github", `Could not read ${repoPath}: HTTP ${res.status} ${safe(await res.text())}`);
  const body = (await res.json()) as { sha?: string };
  return body.sha ?? null;
}

/**
 * Create or replace a file on the configured branch.
 *
 * Passing the existing SHA is what makes this an update rather than a failed
 * create, and it is also GitHub's optimistic-concurrency check: if someone else
 * changed the file since we read it, the call is rejected rather than
 * overwriting their work.
 */
export async function putFile(
  config: Partial<GitHubConfig>,
  params: { repoPath: string; content: string; message: string },
): Promise<CommitResult> {
  assertConfigured(config);
  const branch = config.branch || "main";
  const existing = await fileSha(config, params.repoPath);

  const res = await gh(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${params.repoPath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: params.message,
        content: Buffer.from(params.content, "utf8").toString("base64"),
        branch,
        ...(existing ? { sha: existing } : {}),
      }),
    },
  );

  if (res.status === 409) {
    throw new PublishError("github", `${params.repoPath} changed in the repository since it was read. Nothing was overwritten.`);
  }
  if (res.status === 403) {
    throw new PublishError("github", "GitHub refused the commit (403). The token is probably read-only on this repository.");
  }
  if (!res.ok) {
    throw new PublishError("github", `Commit failed: HTTP ${res.status} ${safe(await res.text())}`);
  }

  const body = (await res.json()) as { commit?: { sha?: string; html_url?: string }; content?: { html_url?: string } };
  log.info("committed to github", {
    repo: `${config.owner}/${config.repo}`,
    path: params.repoPath,
    branch,
    updated: Boolean(existing),
  });

  return {
    path: params.repoPath,
    commitSha: body.commit?.sha ?? "",
    htmlUrl: body.content?.html_url ?? body.commit?.html_url ?? "",
    updated: Boolean(existing),
  };
}

/** Remove a published file. Used by the unpublish path. */
export async function deleteFile(
  config: Partial<GitHubConfig>,
  params: { repoPath: string; message: string },
): Promise<{ deleted: boolean }> {
  assertConfigured(config);
  const branch = config.branch || "main";
  const sha = await fileSha(config, params.repoPath);
  if (!sha) return { deleted: false };

  const res = await gh(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${params.repoPath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    { method: "DELETE", body: JSON.stringify({ message: params.message, sha, branch }) },
  );
  if (!res.ok) throw new PublishError("github", `Delete failed: HTTP ${res.status} ${safe(await res.text())}`);
  log.warn("deleted from github", { repo: `${config.owner}/${config.repo}`, path: params.repoPath });
  return { deleted: true };
}
