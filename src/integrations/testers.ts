/**
 * Connection tests.
 *
 * One safe probe per provider, answering a single question: with the
 * credentials currently stored, can we reach this service and see what we were
 * configured to see?
 *
 * Three hard rules:
 *
 *   1. READ-ONLY. Every probe is a GET or an auth handshake. Nothing here
 *      creates, updates, deletes, publishes or spends. A test must never have a
 *      side effect on the customer's account.
 *   2. NO SECRETS IN THE RESULT. The returned message is shown in the browser
 *      and written to Integration.lastError, so it names what failed, never the
 *      value that failed. Provider error bodies are scrubbed before they are
 *      surfaced.
 *   3. HONEST OUTCOMES. "Not configured" is not a failure and does not say
 *      "connection failed". A provider we cannot test is reported as untestable
 *      rather than silently passing.
 */
import { resolveCredentials } from "@/integrations/service";
import { findIntegration } from "@/integrations/catalog";
import { scopedLogger } from "@/core/logging/logger";

const log = scopedLogger("integrations.test");

export type TestOutcome = "OK" | "FAILED" | "NOT_CONFIGURED" | "NOT_TESTABLE";

export interface ConnectionTestResult {
  provider: string;
  outcome: TestOutcome;
  ok: boolean;
  /** Safe to render and to store. Never contains a credential. */
  message: string;
  /** Non-secret detail worth showing, e.g. the repo or property the key can see. */
  detail?: Record<string, string | number | boolean>;
  durationMs: number;
}

/** Anything credential-shaped that a provider might echo back in an error. */
const SECRETISH = /(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{10,}|Basic\s+[A-Za-z0-9+/=]{10,}|"private_key"\s*:\s*"[^"]*")/g;

/** Trims a provider's error body to something safe and useful. */
export function safeMessage(raw: string, max = 220): string {
  return raw.replace(SECRETISH, "[redacted]").replace(/\s+/g, " ").trim().slice(0, max);
}

const TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Per-provider probes. Each receives already-resolved credentials + settings.
// ---------------------------------------------------------------------------

type Probe = (creds: Record<string, string>, settings: Record<string, string>) => Promise<Omit<ConnectionTestResult, "provider" | "durationMs">>;

const PROBES: Record<string, Probe> = {
  /** GET the repository. Confirms the token is valid AND can see that repo. */
  async github(creds, settings) {
    const { owner, repo } = settings;
    if (!owner || !repo) {
      return { outcome: "NOT_CONFIGURED", ok: false, message: "Set the repository owner and name before testing." };
    }
    const res = await fetchWithTimeout(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: {
        authorization: `Bearer ${creds.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "faresmatch-aios",
      },
    });

    if (res.status === 401) return { outcome: "FAILED", ok: false, message: "GitHub rejected the token (401). Check it has not expired." };
    if (res.status === 404) {
      return {
        outcome: "FAILED",
        ok: false,
        message: `GitHub returned 404 for ${owner}/${repo}. Either the repository does not exist or the token cannot see it.`,
      };
    }
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `GitHub returned HTTP ${res.status}: ${safeMessage(await res.text())}` };

    const body = (await res.json()) as { full_name?: string; default_branch?: string; permissions?: { push?: boolean } };
    const canPush = body.permissions?.push === true;
    return {
      outcome: "OK",
      ok: true,
      message: canPush
        ? `Connected to ${body.full_name} with write access.`
        : `Reached ${body.full_name}, but this token is read-only — publishing would fail.`,
      detail: {
        repository: body.full_name ?? `${owner}/${repo}`,
        defaultBranch: body.default_branch ?? "unknown",
        canWrite: canPush,
        branchConfigured: settings.branch || body.default_branch || "main",
      },
    };
  },

  /** Reads the spreadsheet's metadata only - no cell is read or written. */
  async google_sheets(creds, settings) {
    if (!settings.spreadsheetId) {
      return { outcome: "NOT_CONFIGURED", ok: false, message: "Set the spreadsheet ID before testing." };
    }
    const { googleAccessToken, serviceAccountEmail } = await import("@/integrations/clients/google-auth");
    let token: string;
    try {
      token = await googleAccessToken(creds.serviceAccountJson, ["https://www.googleapis.com/auth/spreadsheets.readonly"]);
    } catch (e) {
      return { outcome: "FAILED", ok: false, message: `Could not obtain a Google token: ${safeMessage((e as Error).message)}` };
    }

    const res = await fetchWithTimeout(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(settings.spreadsheetId)}?fields=properties.title,sheets.properties.title`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    if (res.status === 403 || res.status === 404) {
      const email = serviceAccountEmail(creds.serviceAccountJson);
      return {
        outcome: "FAILED",
        ok: false,
        message: `Google returned ${res.status}. Share the spreadsheet with ${email ?? "the service account's client_email"} and try again.`,
      };
    }
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `Google Sheets returned HTTP ${res.status}: ${safeMessage(await res.text())}` };

    const body = (await res.json()) as { properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] };
    const tabs = (body.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[];
    const wanted = settings.sheetName;
    if (wanted && !tabs.includes(wanted)) {
      return {
        outcome: "FAILED",
        ok: false,
        message: `Opened "${body.properties?.title}" but it has no tab named "${wanted}". Tabs present: ${tabs.join(", ")}.`,
      };
    }
    return {
      outcome: "OK",
      ok: true,
      message: `Connected to "${body.properties?.title}" (${tabs.length} tab${tabs.length === 1 ? "" : "s"}).`,
      detail: { spreadsheet: body.properties?.title ?? "", tabs: tabs.join(", ") },
    };
  },

  /** Lists sites the credential can see, then checks the configured property. */
  async google_search_console(creds, settings) {
    const { googleAccessToken } = await import("@/integrations/clients/google-auth");
    if (!creds.serviceAccountJson) {
      return {
        outcome: "NOT_TESTABLE",
        ok: false,
        message: "Only the service-account path can be tested automatically. An OAuth refresh token is not exercised here.",
      };
    }
    let token: string;
    try {
      token = await googleAccessToken(creds.serviceAccountJson, ["https://www.googleapis.com/auth/webmasters.readonly"]);
    } catch (e) {
      return { outcome: "FAILED", ok: false, message: `Could not obtain a Google token: ${safeMessage((e as Error).message)}` };
    }

    const res = await fetchWithTimeout("https://searchconsole.googleapis.com/webmasters/v3/sites", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `Search Console returned HTTP ${res.status}: ${safeMessage(await res.text())}` };

    const body = (await res.json()) as { siteEntry?: { siteUrl?: string }[] };
    const sites = (body.siteEntry ?? []).map((s) => s.siteUrl).filter(Boolean) as string[];
    if (settings.siteUrl && !sites.includes(settings.siteUrl)) {
      return {
        outcome: "FAILED",
        ok: false,
        message: `Authenticated, but ${settings.siteUrl} is not among the ${sites.length} verified propert${sites.length === 1 ? "y" : "ies"} this account can see.`,
      };
    }
    return {
      outcome: "OK",
      ok: true,
      message: `Connected. ${sites.length} verified propert${sites.length === 1 ? "y" : "ies"} visible.`,
      detail: { properties: sites.slice(0, 5).join(", ") },
    };
  },

  /** Reads GA4 property metadata. No report is run, so no quota is spent. */
  async ga4(creds, settings) {
    if (!settings.propertyId) return { outcome: "NOT_CONFIGURED", ok: false, message: "Set the GA4 property id before testing." };
    const { googleAccessToken } = await import("@/integrations/clients/google-auth");
    let token: string;
    try {
      token = await googleAccessToken(creds.serviceAccountJson, ["https://www.googleapis.com/auth/analytics.readonly"]);
    } catch (e) {
      return { outcome: "FAILED", ok: false, message: `Could not obtain a Google token: ${safeMessage((e as Error).message)}` };
    }

    const id = settings.propertyId.replace(/^properties\//, "");
    const res = await fetchWithTimeout(`https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 403) {
      return { outcome: "FAILED", ok: false, message: "Google returned 403. Grant the service account Viewer on this GA4 property." };
    }
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `GA4 returned HTTP ${res.status}: ${safeMessage(await res.text())}` };
    const body = (await res.json()) as { displayName?: string };
    return { outcome: "OK", ok: true, message: `Connected to GA4 property "${body.displayName}".`, detail: { property: body.displayName ?? id } };
  },

  /** Amadeus token endpoint. Issuing a token is the cheapest valid handshake. */
  async amadeus(creds) {
    const res = await fetchWithTimeout("https://test.api.amadeus.com/v1/security/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
    });
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `Amadeus rejected the credentials (HTTP ${res.status}): ${safeMessage(await res.text())}` };
    const body = (await res.json()) as { expires_in?: number };
    return { outcome: "OK", ok: true, message: "Amadeus issued an access token.", detail: { tokenExpiresInSeconds: body.expires_in ?? 0 } };
  },

  async duffel(creds) {
    const res = await fetchWithTimeout("https://api.duffel.com/air/airlines?limit=1", {
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        "Duffel-Version": "v2",
        accept: "application/json",
      },
    });
    if (res.status === 401) return { outcome: "FAILED", ok: false, message: "Duffel rejected the access token (401)." };
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `Duffel returned HTTP ${res.status}: ${safeMessage(await res.text())}` };
    return { outcome: "OK", ok: true, message: "Duffel accepted the access token." };
  },

  /** Lists models - the standard cheap authenticated GET. */
  async openai(creds) {
    const res = await fetchWithTimeout("https://api.openai.com/v1/models?limit=1", {
      headers: { authorization: `Bearer ${creds.apiKey}` },
    });
    if (res.status === 401) return { outcome: "FAILED", ok: false, message: "OpenAI rejected the API key (401)." };
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `OpenAI returned HTTP ${res.status}: ${safeMessage(await res.text())}` };
    return { outcome: "OK", ok: true, message: "OpenAI accepted the API key." };
  },

  async anthropic(creds) {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": creds.apiKey, "anthropic-version": "2023-06-01" },
    });
    if (res.status === 401) return { outcome: "FAILED", ok: false, message: "Anthropic rejected the API key (401)." };
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `Anthropic returned HTTP ${res.status}: ${safeMessage(await res.text())}` };
    return { outcome: "OK", ok: true, message: "Anthropic accepted the API key." };
  },

  /** Returns the account's remaining credit - read-only and free. */
  async dataforseo(creds) {
    const auth = Buffer.from(`${creds.login}:${creds.password}`).toString("base64");
    const res = await fetchWithTimeout("https://api.dataforseo.com/v3/appendix/user_data", {
      headers: { authorization: `Basic ${auth}` },
    });
    if (res.status === 401) return { outcome: "FAILED", ok: false, message: "DataForSEO rejected the login (401)." };
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `DataForSEO returned HTTP ${res.status}: ${safeMessage(await res.text())}` };
    const body = (await res.json()) as { tasks?: { result?: { money?: { balance?: number } }[] }[] };
    const balance = body.tasks?.[0]?.result?.[0]?.money?.balance;
    return {
      outcome: "OK",
      ok: true,
      message: balance === undefined ? "DataForSEO accepted the login." : `DataForSEO accepted the login. Balance: ${balance}.`,
    };
  },

  async semrush(creds) {
    const res = await fetchWithTimeout(`https://api.semrush.com/analytics/v1/?type=api_units_balance&key=${encodeURIComponent(creds.apiKey)}`);
    const text = await res.text();
    if (/ERROR\s*50|NOTHING FOUND|ERROR 120/i.test(text)) {
      return { outcome: "FAILED", ok: false, message: `Semrush rejected the API key: ${safeMessage(text)}` };
    }
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `Semrush returned HTTP ${res.status}: ${safeMessage(text)}` };
    return { outcome: "OK", ok: true, message: `Semrush accepted the API key. ${safeMessage(text, 80)}` };
  },

  async ahrefs(creds) {
    const res = await fetchWithTimeout("https://api.ahrefs.com/v3/subscription-info/limits-and-usage", {
      headers: { authorization: `Bearer ${creds.apiKey}`, accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) {
      return { outcome: "FAILED", ok: false, message: `Ahrefs rejected the API token (${res.status}).` };
    }
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `Ahrefs returned HTTP ${res.status}: ${safeMessage(await res.text())}` };
    return { outcome: "OK", ok: true, message: "Ahrefs accepted the API token." };
  },

  /** Reads the REST root and confirms the user can be identified. */
  async wordpress(creds, settings) {
    if (!settings.baseUrl) return { outcome: "NOT_CONFIGURED", ok: false, message: "Set the site base URL before testing." };
    const base = settings.baseUrl.replace(/\/+$/, "");
    const auth = Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString("base64");
    const res = await fetchWithTimeout(`${base}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { authorization: `Basic ${auth}` },
    });
    if (res.status === 401) return { outcome: "FAILED", ok: false, message: "WordPress rejected the application password (401)." };
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `WordPress returned HTTP ${res.status}: ${safeMessage(await res.text())}` };
    const body = (await res.json()) as { name?: string; capabilities?: Record<string, boolean> };
    const canPublish = body.capabilities?.publish_pages === true || body.capabilities?.publish_posts === true;
    return {
      outcome: "OK",
      ok: true,
      message: canPublish
        ? `Connected as ${body.name} with publishing rights.`
        : `Connected as ${body.name}, but this user cannot publish — publishing would fail.`,
      detail: { user: body.name ?? "", canPublish },
    };
  },

  /** A HEAD to the configured endpoint. Deliberately sends no payload. */
  async webhook_cms(_creds, settings) {
    if (!settings.url) return { outcome: "NOT_CONFIGURED", ok: false, message: "Set the webhook URL before testing." };
    try {
      const res = await fetchWithTimeout(settings.url, { method: "HEAD" });
      return res.status < 500
        ? { outcome: "OK", ok: true, message: `Endpoint reachable (HTTP ${res.status}). Note this only proves reachability, not that it accepts a publish payload.` }
        : { outcome: "FAILED", ok: false, message: `Endpoint returned HTTP ${res.status}.` };
    } catch (e) {
      return { outcome: "FAILED", ok: false, message: `Could not reach the endpoint: ${safeMessage((e as Error).message)}` };
    }
  },

  async perplexity(creds) {
    const res = await fetchWithTimeout("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${creds.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    });
    if (res.status === 401) return { outcome: "FAILED", ok: false, message: "Perplexity rejected the API key (401)." };
    if (!res.ok) return { outcome: "FAILED", ok: false, message: `Perplexity returned HTTP ${res.status}: ${safeMessage(await res.text())}` };
    return { outcome: "OK", ok: true, message: "Perplexity accepted the API key. (This probe spends one token.)" };
  },
};

/** Providers with no external service to reach. */
const UNTESTABLE: Record<string, string> = {
  internal_crawler: "The built-in crawler needs no credentials and is always available.",
};

export function isTestable(provider: string): boolean {
  return provider in PROBES;
}

/**
 * Runs the connection test for a provider.
 *
 * Never throws: a probe that blows up is reported as FAILED with a scrubbed
 * message, because a stack trace in the dashboard helps nobody and may carry
 * fragments of a request.
 */
export async function testConnection(
  organizationId: string,
  provider: string,
  projectId?: string,
): Promise<ConnectionTestResult> {
  const started = Date.now();
  const done = (r: Omit<ConnectionTestResult, "provider" | "durationMs">): ConnectionTestResult => ({
    provider,
    durationMs: Date.now() - started,
    ...r,
  });

  if (!findIntegration(provider)) {
    return done({ outcome: "NOT_TESTABLE", ok: false, message: `"${provider}" is not in the integration catalog.` });
  }
  if (UNTESTABLE[provider]) {
    return done({ outcome: "NOT_TESTABLE", ok: false, message: UNTESTABLE[provider] });
  }
  const probe = PROBES[provider];
  if (!probe) {
    return done({ outcome: "NOT_TESTABLE", ok: false, message: "No connection test is implemented for this provider yet." });
  }

  const resolved = await resolveCredentials(organizationId, provider, projectId);
  if (!resolved.configured) {
    return done({
      outcome: "NOT_CONFIGURED",
      ok: false,
      message: `Not configured. Missing: ${resolved.missing.join(", ") || "credentials"}.`,
    });
  }

  try {
    const result = await probe(resolved.values, resolved.settings);
    log.info("connection test", { provider, outcome: result.outcome });
    return done(result);
  } catch (e) {
    const message = (e as Error).name === "AbortError"
      ? `The provider did not respond within ${TIMEOUT_MS / 1000}s.`
      : safeMessage((e as Error).message);
    log.warn("connection test threw", { provider, error: message });
    return done({ outcome: "FAILED", ok: false, message });
  }
}
