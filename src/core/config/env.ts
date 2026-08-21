/**
 * Typed, validated environment configuration.
 *
 * This module is SERVER-ONLY. Nothing here may be imported from a client
 * component - secrets would end up in the browser bundle. The only values ever
 * sent to the browser are the explicitly whitelisted ones in `publicConfig()`.
 */
import { z } from "zod";

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const intish = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return v === undefined || v === "" || Number.isNaN(n) ? def : n;
    });

const floatish = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return v === undefined || v === "" || Number.isNaN(n) ? def : n;
    });

const str = (def = "") =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: str("http://localhost:3000"),
  PORT: intish(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  APP_ENCRYPTION_KEY: str(""),
  SESSION_SECRET: str(""),
  SESSION_TTL_HOURS: intish(168),

  DEMO_MODE: boolish(true),
  DEFAULT_APPROVAL_MODE: z
    .enum(["MANUAL", "SEMI_AUTOMATIC", "AUTOMATIC"])
    .default("SEMI_AUTOMATIC")
    .catch("SEMI_AUTOMATIC"),

  LLM_DEFAULT_PROVIDER: str("mock"),
  ANTHROPIC_API_KEY: str(""),
  ANTHROPIC_BASE_URL: str("https://api.anthropic.com"),
  OPENAI_API_KEY: str(""),
  OPENAI_BASE_URL: str("https://api.openai.com/v1"),
  LLM_MODEL_FAST: str("claude-haiku-4-5-20251001"),
  LLM_MODEL_BALANCED: str("claude-sonnet-5"),
  LLM_MODEL_DEEP: str("claude-opus-5"),

  KEYWORD_PROVIDER: str("mock"),
  DATAFORSEO_LOGIN: str(""),
  DATAFORSEO_PASSWORD: str(""),
  SERP_PROVIDER_KEY: str(""),

  GOOGLE_SERVICE_ACCOUNT_JSON: str(""),
  GOOGLE_OAUTH_CLIENT_ID: str(""),
  GOOGLE_OAUTH_CLIENT_SECRET: str(""),
  GOOGLE_OAUTH_REFRESH_TOKEN: str(""),
  GSC_SITE_URL: str(""),
  GA4_PROPERTY_ID: str(""),

  TRAVEL_DATA_PROVIDER: str("mock"),
  AMADEUS_CLIENT_ID: str(""),
  AMADEUS_CLIENT_SECRET: str(""),
  DUFFEL_API_KEY: str(""),

  PUBLISH_ADAPTER: str("local_static"),
  PUBLISH_LOCAL_DIR: str("./published"),
  PUBLISH_WEBHOOK_URL: str(""),
  PUBLISH_WEBHOOK_SECRET: str(""),
  WORDPRESS_BASE_URL: str(""),
  WORDPRESS_USERNAME: str(""),
  WORDPRESS_APP_PASSWORD: str(""),

  AI_VISIBILITY_PLATFORMS: str("mock"),
  PERPLEXITY_API_KEY: str(""),

  CRAWLER_USER_AGENT: str("FaresMatchAIOS/0.1 (+https://faresmatch.local/bot)"),
  CRAWLER_MAX_PAGES: intish(200),
  CRAWLER_CONCURRENCY: intish(4),
  CRAWLER_TIMEOUT_MS: intish(15000),

  DEFAULT_MONTHLY_TOKEN_BUDGET: intish(5_000_000),
  DEFAULT_MONTHLY_COST_BUDGET_USD: floatish(250),
  AGENT_MAX_RETRIES: intish(2),
  AGENT_TIMEOUT_MS: intish(120000),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;

/** Parse + cache process.env. Throws a readable error on misconfiguration. */
export function env(): AppEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the cache (tests only). */
export function resetEnvCache() {
  cached = null;
}

/**
 * Non-secret configuration safe to send to the browser.
 * Never add anything credential-shaped here.
 */
export function publicConfig() {
  const e = env();
  return {
    appUrl: e.APP_URL,
    demoMode: e.DEMO_MODE,
    defaultApprovalMode: e.DEFAULT_APPROVAL_MODE,
    nodeEnv: e.NODE_ENV,
  };
}

/**
 * Report which optional integrations actually have credentials in the process
 * environment. Used by the Integrations dashboard so we never claim an API is
 * connected when the key is missing.
 */
export function envIntegrationStatus() {
  const e = env();
  return {
    anthropic: Boolean(e.ANTHROPIC_API_KEY),
    openai: Boolean(e.OPENAI_API_KEY),
    dataforseo: Boolean(e.DATAFORSEO_LOGIN && e.DATAFORSEO_PASSWORD),
    serp: Boolean(e.SERP_PROVIDER_KEY),
    google: Boolean(e.GOOGLE_SERVICE_ACCOUNT_JSON || e.GOOGLE_OAUTH_REFRESH_TOKEN),
    amadeus: Boolean(e.AMADEUS_CLIENT_ID && e.AMADEUS_CLIENT_SECRET),
    duffel: Boolean(e.DUFFEL_API_KEY),
    wordpress: Boolean(e.WORDPRESS_BASE_URL && e.WORDPRESS_APP_PASSWORD),
    webhook: Boolean(e.PUBLISH_WEBHOOK_URL),
    perplexity: Boolean(e.PERPLEXITY_API_KEY),
  };
}
