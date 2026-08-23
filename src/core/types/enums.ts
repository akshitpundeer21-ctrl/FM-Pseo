/**
 * Enum-like unions.
 *
 * The database stores these as strings (portable across SQLite/Postgres); Zod
 * schemas here are the single source of truth for what the strings may be.
 */
import { z } from "zod";

export const RoleSchema = z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]);
export type Role = z.infer<typeof RoleSchema>;

export const ApprovalModeSchema = z.enum(["MANUAL", "SEMI_AUTOMATIC", "AUTOMATIC"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const TaskStatusSchema = z.enum([
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING",
  "REVIEW",
  "APPROVED",
  "REJECTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED", "REJECTED"];

export const ValidationStatusSchema = z.enum(["PENDING", "PASSED", "FAILED", "SKIPPED"]);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

export const RunStatusSchema = z.enum(["RUNNING", "SUCCEEDED", "FAILED", "TIMEOUT", "ESCALATED", "SKIPPED"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const WorkflowRunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const SearchIntentSchema = z.enum([
  "INFORMATIONAL",
  "NAVIGATIONAL",
  "COMMERCIAL",
  "TRANSACTIONAL",
  "QUESTION",
]);
export type SearchIntent = z.infer<typeof SearchIntentSchema>;

export const EntityTypeSchema = z.enum([
  "ROUTE",
  "AIRPORT",
  "AIRLINE",
  "CITY",
  "COUNTRY",
  "DESTINATION",
  "POLICY",
  "BRAND",
  "GENERIC",
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const PageStatusSchema = z.enum([
  "DRAFT",
  "GENERATED",
  "VALIDATED",
  "REVIEW",
  "APPROVED",
  "REJECTED",
  "PUBLISHED",
  "UNPUBLISHED",
]);
export type PageStatus = z.infer<typeof PageStatusSchema>;

export const ContentSourceSchema = z.enum(["TEMPLATE", "DYNAMIC", "AI", "HUMAN", "HYBRID"]);
export type ContentSource = z.infer<typeof ContentSourceSchema>;

export const VerificationStatusSchema = z.enum(["UNVERIFIED", "VERIFIED", "DISPUTED", "REJECTED", "STALE"]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const OpportunityDecisionSchema = z.enum(["BUILD", "REVIEW", "REJECT"]);
export type OpportunityDecision = z.infer<typeof OpportunityDecisionSchema>;

export const ApprovalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const LogLevelSchema = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const IntegrationCategorySchema = z.enum([
  "LLM",
  "KEYWORD_DATA",
  "SEARCH_CONSOLE",
  "ANALYTICS",
  "CMS",
  "TRAVEL_DATA",
  "CRAWLER",
  "AI_VISIBILITY",
  // A spreadsheet or similar acting as a work queue for the orchestrator.
  "WORKFLOW_SOURCE",
]);
export type IntegrationCategory = z.infer<typeof IntegrationCategorySchema>;

export const IntegrationStatusSchema = z.enum(["NOT_CONFIGURED", "CONFIGURED", "ERROR", "DISABLED"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const ModelTierSchema = z.enum(["fast", "balanced", "deep"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const AgentKindSchema = z.enum(["ORCHESTRATOR", "SPECIALIST", "GUARDIAN"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * Capability flags checked by the Control Plane before an agent acts.
 * Publishing is deliberately its own capability - content agents never get it.
 */
export const CapabilitySchema = z.enum([
  "read_project",
  "read_analytics",
  "write_keywords",
  "write_opportunities",
  "write_page_family",
  "write_template",
  "write_content",
  "write_facts",
  "write_links",
  "write_schema",
  "write_recommendations",
  "request_approval",
  "publish",
  "unpublish",
  "spend_budget",
  "call_llm",
  "call_external_api",
  "crawl_web",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const PAGE_TYPES = [
  "ROUTE",
  "AIRPORT",
  "AIRPORT_TRANSFERS",
  "AIRLINE",
  "AIRLINE_BAGGAGE",
  "DESTINATION",
  "GUIDE",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];
