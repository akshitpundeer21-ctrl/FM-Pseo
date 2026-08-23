/**
 * Google authentication.
 *
 * Today this implements the SERVICE ACCOUNT path only: a signed JWT exchanged
 * for a short-lived access token. That choice is deliberate and documented in
 * docs/INTEGRATIONS.md - the app has no OAuth infrastructure (no redirect
 * route, no consent flow, no PKCE, no refresh loop), and inventing one is a far
 * larger change than these modules need.
 *
 * The seam for OAuth is `googleAccessToken`: everything that talks to a Google
 * API asks this one function for a bearer token and does not care where it came
 * from. Adding a refresh-token grant later means adding a branch here, not
 * touching a single caller.
 *
 * Nothing in this file logs, returns or embeds the private key.
 */
import crypto from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh a little before expiry so a token is never used on its last second. */
const EXPIRY_SKEW_MS = 60_000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * In-process token cache, keyed by service account + scopes. Access tokens are
 * short-lived secrets: they are deliberately NOT written to the ProviderCache
 * table, which is for provider responses, not credentials.
 */
const tokenCache = new Map<string, CachedToken>();

function parseServiceAccount(json: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The service account credential is not valid JSON.");
  }
  const sa = parsed as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) {
    throw new Error("The service account JSON is missing client_email or private_key.");
  }
  return sa as ServiceAccount;
}

/** The address a spreadsheet or property must be shared with. Not a secret. */
export function serviceAccountEmail(json: string): string | null {
  try {
    return parseServiceAccount(json).client_email;
  } catch {
    return null;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RS256-signed assertion, per Google's service-account flow. */
function buildAssertion(sa: ServiceAccount, scopes: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: scopes.join(" "),
      aud: sa.token_uri ?? TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(
    // The key arrives from JSON with literal \n sequences.
    sa.private_key.replace(/\\n/g, "\n"),
  );
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Exchange a service account for an access token, cached until shortly before
 * it expires.
 *
 * Throws a message safe to show an operator: it names what is wrong with the
 * credential, never any part of its value.
 */
export async function googleAccessToken(serviceAccountJson: string, scopes: string[]): Promise<string> {
  if (!serviceAccountJson) throw new Error("No Google service account is configured.");
  const sa = parseServiceAccount(serviceAccountJson);

  // Key the cache on the account identity + scopes, never on the key material.
  const cacheKey = `${sa.client_email}::${[...scopes].sort().join(" ")}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;

  let assertion: string;
  try {
    assertion = buildAssertion(sa, scopes);
  } catch {
    throw new Error("The service account's private_key could not be used to sign a request. Check the JSON was pasted intact.");
  }

  const res = await fetch(sa.token_uri ?? TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`Google refused the service account: ${detail}`);
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google returned no access token.");

  tokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}

/** Drops cached tokens for an account. Called when its credential changes. */
export function forgetGoogleTokens(serviceAccountJson?: string): void {
  if (!serviceAccountJson) {
    tokenCache.clear();
    return;
  }
  const email = serviceAccountEmail(serviceAccountJson);
  if (!email) return;
  for (const key of tokenCache.keys()) {
    if (key.startsWith(`${email}::`)) tokenCache.delete(key);
  }
}
