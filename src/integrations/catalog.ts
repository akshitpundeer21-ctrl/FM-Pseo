/**
 * Integration catalog.
 *
 * A declarative description of every external service the OS can talk to: what
 * credentials it needs, which env vars act as a fallback, and whether a mock
 * adapter exists. The Integrations dashboard is rendered from this catalog, so
 * adding a provider is a data change, not a UI change.
 */
import type { IntegrationCategory } from "@/core/types/enums";

export interface CredentialField {
  key: string;
  label: string;
  help?: string;
  /** Env var consulted when no encrypted credential is stored. */
  envVar?: string;
  optional?: boolean;
}

export interface IntegrationDefinition {
  provider: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  docsUrl?: string;
  credentials: CredentialField[];
  /** Non-secret settings (site url, property id, ...). */
  settings?: CredentialField[];
  /** A labelled mock adapter exists, so the OS still works without keys. */
  hasMock: boolean;
  /** What breaks / degrades when this is not connected. */
  degradesTo: string;
}

export const INTEGRATION_CATALOG: IntegrationDefinition[] = [
  {
    provider: "anthropic",
    name: "Anthropic (Claude)",
    category: "LLM",
    description: "Primary LLM provider for content generation, planning and AI-visibility probing.",
    docsUrl: "https://docs.anthropic.com/en/api/getting-started",
    credentials: [{ key: "apiKey", label: "API key", envVar: "ANTHROPIC_API_KEY", help: "sk-ant-..." }],
    hasMock: true,
    degradesTo: "Deterministic mock composer writes copy from structured data only. Output is labelled MOCK.",
  },
  {
    provider: "openai",
    name: "OpenAI",
    category: "LLM",
    description: "Alternative LLM provider. The router picks whichever provider is configured.",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    credentials: [{ key: "apiKey", label: "API key", envVar: "OPENAI_API_KEY", help: "sk-..." }],
    hasMock: true,
    degradesTo: "Same as Anthropic - falls back to the deterministic mock composer.",
  },
  {
    provider: "dataforseo",
    name: "DataForSEO",
    category: "KEYWORD_DATA",
    description: "Keyword volume, difficulty, CPC and SERP data used by the Keyword Research Agent.",
    docsUrl: "https://docs.dataforseo.com/v3/",
    credentials: [
      { key: "login", label: "API login", envVar: "DATAFORSEO_LOGIN" },
      { key: "password", label: "API password", envVar: "DATAFORSEO_PASSWORD" },
    ],
    hasMock: true,
    degradesTo: "Keyword metrics come from the bundled corpus in data/mock/keywords.json, labelled MOCK.",
  },
  {
    provider: "google_search_console",
    name: "Google Search Console",
    category: "SEARCH_CONSOLE",
    description: "Query/page level clicks, impressions, CTR and position for the connected website.",
    docsUrl: "https://developers.google.com/webmaster-tools/search-console-api-original",
    credentials: [
      { key: "serviceAccountJson", label: "Service account JSON", envVar: "GOOGLE_SERVICE_ACCOUNT_JSON", optional: true },
      { key: "refreshToken", label: "OAuth refresh token", envVar: "GOOGLE_OAUTH_REFRESH_TOKEN", optional: true },
      { key: "clientId", label: "OAuth client id", envVar: "GOOGLE_OAUTH_CLIENT_ID", optional: true },
      { key: "clientSecret", label: "OAuth client secret", envVar: "GOOGLE_OAUTH_CLIENT_SECRET", optional: true },
    ],
    settings: [{ key: "siteUrl", label: "Verified property URL", envVar: "GSC_SITE_URL" }],
    hasMock: true,
    degradesTo: "Search performance uses a synthetic, clearly-labelled MOCK series. Never presented as real traffic.",
  },
  {
    provider: "ga4",
    name: "Google Analytics 4",
    category: "ANALYTICS",
    description: "Sessions and conversions per landing page, joined to published programmatic pages.",
    docsUrl: "https://developers.google.com/analytics/devguides/reporting/data/v1",
    credentials: [{ key: "serviceAccountJson", label: "Service account JSON", envVar: "GOOGLE_SERVICE_ACCOUNT_JSON" }],
    settings: [{ key: "propertyId", label: "GA4 property id", envVar: "GA4_PROPERTY_ID" }],
    hasMock: true,
    degradesTo: "Sessions/conversions come from the MOCK analytics series.",
  },
  {
    provider: "amadeus",
    name: "Amadeus Self-Service",
    category: "TRAVEL_DATA",
    description: "Live flight offers, routes and airport reference data for the Dynamic Data Engine.",
    docsUrl: "https://developers.amadeus.com/self-service",
    credentials: [
      { key: "clientId", label: "Client ID", envVar: "AMADEUS_CLIENT_ID" },
      { key: "clientSecret", label: "Client secret", envVar: "AMADEUS_CLIENT_SECRET" },
    ],
    hasMock: true,
    degradesTo:
      "Route/airport/airline reference data comes from the bundled static dataset. Prices and live schedules are NOT generated at all.",
  },
  {
    provider: "duffel",
    name: "Duffel",
    category: "TRAVEL_DATA",
    description: "Flight search and offers API - alternative travel data provider.",
    docsUrl: "https://duffel.com/docs/api",
    credentials: [{ key: "apiKey", label: "Access token", envVar: "DUFFEL_API_KEY" }],
    hasMock: true,
    degradesTo: "Same as Amadeus - static reference data only, no invented prices.",
  },
  {
    provider: "wordpress",
    name: "WordPress (REST API)",
    category: "CMS",
    description: "Publishing target. Creates/updates posts or pages through the WP REST API.",
    docsUrl: "https://developer.wordpress.org/rest-api/",
    credentials: [
      { key: "username", label: "Username", envVar: "WORDPRESS_USERNAME" },
      { key: "applicationPassword", label: "Application password", envVar: "WORDPRESS_APP_PASSWORD" },
    ],
    settings: [{ key: "baseUrl", label: "Site base URL", envVar: "WORDPRESS_BASE_URL" }],
    hasMock: false,
    degradesTo: "Publishing falls back to the local_static adapter, which writes real files served at /site/*.",
  },
  {
    provider: "webhook_cms",
    name: "Generic CMS webhook",
    category: "CMS",
    description: "POSTs the rendered page payload (HTML + JSON-LD + metadata) to your own endpoint.",
    credentials: [{ key: "secret", label: "Shared secret (HMAC)", envVar: "PUBLISH_WEBHOOK_SECRET", optional: true }],
    settings: [{ key: "url", label: "Webhook URL", envVar: "PUBLISH_WEBHOOK_URL" }],
    hasMock: false,
    degradesTo: "Publishing falls back to the local_static adapter.",
  },
  {
    provider: "perplexity",
    name: "Perplexity",
    category: "AI_VISIBILITY",
    description: "Answer-engine platform probed by the AI Visibility module for mentions and citations.",
    docsUrl: "https://docs.perplexity.ai/",
    credentials: [{ key: "apiKey", label: "API key", envVar: "PERPLEXITY_API_KEY" }],
    hasMock: true,
    degradesTo: "AI visibility runs against the deterministic mock assistant. Metrics are labelled MOCK.",
  },
  {
    provider: "internal_crawler",
    name: "Built-in crawler",
    category: "CRAWLER",
    description: "First-party fetch-based crawler used by the Technical SEO Agent. No credentials required.",
    credentials: [],
    hasMock: false,
    degradesTo: "Always available. Respects robots.txt and a configurable concurrency limit.",
  },
];

export function findIntegration(provider: string): IntegrationDefinition | undefined {
  return INTEGRATION_CATALOG.find((i) => i.provider === provider);
}

export function catalogByCategory(): Record<string, IntegrationDefinition[]> {
  return INTEGRATION_CATALOG.reduce<Record<string, IntegrationDefinition[]>>((acc, def) => {
    (acc[def.category] ??= []).push(def);
    return acc;
  }, {});
}
