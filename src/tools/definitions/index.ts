/**
 * Tool registration entry point.
 *
 * Importing this module registers every tool exactly once. Anything that needs
 * the registry (agents, the /api/agents route, the dashboard's Tools view)
 * imports from here, not from the individual definition files.
 */
import "@/tools/definitions/research";
import "@/tools/definitions/data";
import "@/tools/definitions/technical";
import "@/tools/definitions/publishing";
import "@/tools/definitions/integrations";

export { describeTools, executeTool, getTool, listTools } from "@/tools/registry";

/** Tool keys grouped for readable agent allowlists in the seed. */
export const TOOL_KEYS = {
  keywordDiscover: "keyword.discover",
  competitors: "research.competitors",
  travelReference: "travel.reference",
  dataResolve: "data.resolve",
  travelOffers: "travel.offers",
  factsLookup: "facts.lookup",
  crawl: "web.crawl",
  fetchUrl: "web.fetch",
  llmGenerate: "llm.generate",
  publish: "cms.publish",
  unpublish: "cms.unpublish",
  searchPerformance: "analytics.search_performance",
  aiVisibilityProbe: "ai_visibility.probe",
  githubPublish: "github.publish",
  githubUnpublish: "github.unpublish",
  sheetsRead: "google_sheets.read",
  sheetsUpdate: "google_sheets.update",
} as const;
