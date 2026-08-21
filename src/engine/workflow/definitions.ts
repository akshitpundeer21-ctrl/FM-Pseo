/**
 * Workflow definitions.
 *
 * The master workflow implements the end-to-end pipeline from the spec:
 *
 *   GOAL -> AUDIT -> KEYWORDS -> INTENT -> OPPORTUNITY -> FAMILY/TEMPLATE ->
 *   DATA -> PLAN -> GENERATE -> VERIFY -> OPTIMIZE -> LINK -> SCHEMA ->
 *   QUALITY -> APPROVAL -> PUBLISH -> SITEMAP -> SEARCH MONITORING ->
 *   AI VISIBILITY -> ANALYSIS -> RECOMMENDATIONS -> back to the orchestrator.
 *
 * A step declares which agent owns it, how to build its input from the run
 * context, and how its output feeds the next step. Steps are data + pure
 * functions, so a workflow is inspectable and resumable.
 */

export interface WorkflowContext {
  projectId: string;
  organizationId: string;
  goalId?: string;
  websiteId?: string;
  objective: string;
  entities: { origin?: string; destination?: string; originCity?: string; destinationCity?: string };
  pageFamilyKey: string;
  /** Accumulated step outputs, keyed by step key. */
  outputs: Record<string, any>;
}

export interface WorkflowStepDefinition {
  key: string;
  name: string;
  description: string;
  agentKey: string;
  /** Approval gate before this step executes. */
  requiresApproval?: boolean;
  /** Failure does not stop the workflow. */
  optional?: boolean;
  /** Skip when false. */
  shouldRun?: (ctx: WorkflowContext) => boolean;
  buildInput: (ctx: WorkflowContext) => unknown;
  /** Merge the agent output into the context. Return false to halt the run. */
  applyOutput?: (ctx: WorkflowContext, output: any) => void | false;
}

export interface WorkflowDefinition {
  key: string;
  name: string;
  description: string;
  version: number;
  steps: WorkflowStepDefinition[];
}

export const MASTER_WORKFLOW: WorkflowDefinition = {
  key: "master_seo_growth",
  name: "Master SEO / AEO / GEO growth workflow",
  description:
    "End-to-end: research a goal, find and score programmatic opportunities, plan and generate a page, verify its facts, optimise it, link it, gate its quality, take approval, publish it, then monitor search and AI visibility and feed the results back.",
  version: 1,
  steps: [
    {
      key: "technical_audit",
      name: "Website audit",
      description: "Crawl what already exists so later stages know the baseline and can detect duplication.",
      agentKey: "technical_seo",
      optional: true,
      shouldRun: (ctx) => Boolean(ctx.websiteId),
      buildInput: (ctx) => ({ websiteId: ctx.websiteId, maxPages: 50 }),
      applyOutput: (ctx, out) => {
        ctx.outputs.technical_audit = { crawled: out.crawled, errors: out.errors, warnings: out.warnings };
      },
    },
    {
      key: "keyword_research",
      name: "Keyword research & intent",
      description: "Discover, classify and cluster keywords for the objective's entities.",
      agentKey: "keyword_research",
      buildInput: (ctx) => ({
        origin: ctx.entities.origin,
        destination: ctx.entities.destination,
        limit: 120,
        includeSiblingRoutes: true,
      }),
      applyOutput: (ctx, out) => {
        ctx.outputs.keyword_research = {
          keywordCount: out.keywordCount,
          clusterCount: out.clusterCount,
          clusterIds: out.clusters.map((c: any) => c.id),
          isMock: out.isMock,
        };
        if (!out.clusterCount) return false;
      },
    },
    {
      key: "opportunity_scoring",
      name: "Programmatic opportunity detection",
      description: "Score every candidate page and decide BUILD / REVIEW / REJECT.",
      agentKey: "programmatic_opportunity",
      buildInput: (ctx) => ({
        pageFamilyKey: ctx.pageFamilyKey,
        clusterIds: ctx.outputs.keyword_research?.clusterIds?.slice(0, 20),
        maxCandidates: 20,
        candidates:
          ctx.entities.origin && ctx.entities.destination
            ? [{ origin: ctx.entities.origin, destination: ctx.entities.destination }]
            : undefined,
      }),
      applyOutput: (ctx, out) => {
        const buildable = out.opportunities.filter((o: any) => o.decision === "BUILD");
        const chosen = buildable[0] ?? out.opportunities.find((o: any) => o.decision === "REVIEW");
        ctx.outputs.opportunity_scoring = {
          evaluated: out.evaluated,
          build: out.build,
          review: out.review,
          reject: out.reject,
          selectedOpportunityId: chosen?.id ?? null,
          selectedUrl: chosen?.candidateUrl ?? null,
          selectedDecision: chosen?.decision ?? null,
        };
        if (!chosen) return false;
      },
    },
    {
      key: "content_strategy",
      name: "Page family, template & content plan",
      description: "Ensure the family and template exist, set the composition policy, plan the page.",
      agentKey: "content_strategy",
      buildInput: (ctx) => ({
        pageFamilyKey: ctx.pageFamilyKey,
        opportunityId: ctx.outputs.opportunity_scoring?.selectedOpportunityId,
      }),
      applyOutput: (ctx, out) => {
        ctx.outputs.content_strategy = {
          pageFamilyId: out.pageFamilyId,
          templateId: out.templateId,
          questions: out.plan.questions,
          primaryKeyword: out.plan.primaryKeyword,
        };
      },
    },
    {
      key: "content_generation",
      name: "Dynamic data collection & content generation",
      description: "Resolve the data contract, generate only the prose the template asks for, assemble the page.",
      agentKey: "content_generation",
      buildInput: (ctx) => ({
        opportunityId: ctx.outputs.opportunity_scoring?.selectedOpportunityId,
        templateId: ctx.outputs.content_strategy?.templateId,
        questions: ctx.outputs.content_strategy?.questions,
      }),
      applyOutput: (ctx, out) => {
        ctx.outputs.content_generation = {
          pageId: out.pageId,
          pageVersionId: out.pageVersionId,
          url: out.url,
          wordCount: out.wordCount,
          composition: out.composition,
          liveOffersAvailable: out.liveOffersAvailable,
        };
      },
    },
    {
      key: "fact_verification",
      name: "Fact verification",
      description: "Match every checkable claim to an attributed source; block anything unsupported.",
      agentKey: "fact_verification",
      buildInput: (ctx) => ({ pageVersionId: ctx.outputs.content_generation?.pageVersionId }),
      applyOutput: (ctx, out) => {
        ctx.outputs.fact_verification = { gate: out.gate, checked: out.checked, blocking: out.blocking };
      },
    },
    {
      key: "optimization",
      name: "SEO / AEO / GEO / CFA optimization",
      description: "Title, meta, answer block, FAQ set, entity clarity, evidence and validated structured data.",
      agentKey: "seo_optimization",
      buildInput: (ctx) => ({
        pageVersionId: ctx.outputs.content_generation?.pageVersionId,
        primaryKeyword: ctx.outputs.content_strategy?.primaryKeyword,
      }),
      applyOutput: (ctx, out) => {
        ctx.outputs.optimization = {
          title: out.title,
          schemas: out.schemas.map((s: any) => s.type),
          coverageGaps: out.geo.coverageGaps,
          answerPresent: out.aeo.answerPresent,
        };
      },
    },
    {
      key: "internal_linking",
      name: "Internal linking",
      description: "Propose links from the entity graph and detect orphans.",
      agentKey: "internal_linking",
      optional: true,
      buildInput: (ctx) => ({ pageId: ctx.outputs.content_generation?.pageId }),
      applyOutput: (ctx, out) => {
        ctx.outputs.internal_linking = { proposed: out.proposed, orphans: out.orphans.length };
      },
    },
    {
      key: "quality_control",
      name: "Quality control gate",
      description: "Run every publication gate and route to approval, review or rejection.",
      agentKey: "quality_control",
      buildInput: (ctx) => ({ pageVersionId: ctx.outputs.content_generation?.pageVersionId }),
      applyOutput: (ctx, out) => {
        ctx.outputs.quality_control = {
          decision: out.decision,
          score: out.score,
          approvalId: out.approvalId,
          blockingReasons: out.blockingReasons,
        };
        if (out.decision === "REJECT") return false;
      },
    },
    {
      key: "publish",
      name: "Publish",
      description: "Publish the approved page through the configured adapter.",
      agentKey: "publishing",
      requiresApproval: true,
      buildInput: (ctx) => ({ pageVersionId: ctx.outputs.content_generation?.pageVersionId }),
      applyOutput: (ctx, out) => {
        ctx.outputs.publish = { published: out.published, remoteUrl: out.remoteUrl, adapterUsed: out.adapterUsed, fellBack: out.fellBack };
      },
    },
    {
      key: "post_publish_audit",
      name: "Post-publish technical verification",
      description: "Crawl the live URL to confirm what was actually published is technically sound.",
      agentKey: "technical_seo",
      optional: true,
      shouldRun: (ctx) => Boolean(ctx.websiteId && ctx.outputs.publish?.published),
      buildInput: (ctx) => ({ websiteId: ctx.websiteId, maxPages: 30 }),
      applyOutput: (ctx, out) => {
        ctx.outputs.post_publish_audit = { crawled: out.crawled, errors: out.errors, orphans: out.orphans.length };
      },
    },
    {
      key: "search_monitoring",
      name: "Search performance monitoring",
      description: "Pull query/page performance for the published inventory and turn movement into recommendations.",
      agentKey: "search_performance",
      optional: true,
      buildInput: () => ({ days: 28, dimension: "query" }),
      applyOutput: (ctx, out) => {
        ctx.outputs.search_monitoring = {
          provider: out.provider,
          isMock: out.isMock,
          clicks: out.clicks,
          impressions: out.impressions,
          recommendations: out.recommendations.length,
        };
      },
    },
    {
      key: "ai_visibility",
      name: "AI visibility monitoring",
      description: "Run the prompt library against answer engines and measure mentions, citations and share of voice.",
      agentKey: "ai_visibility",
      optional: true,
      buildInput: () => ({ limit: 8 }),
      applyOutput: (ctx, out) => {
        ctx.outputs.ai_visibility = { runs: out.runs, metrics: out.metrics, isMock: out.isMock };
      },
    },
  ],
};

export const RESEARCH_ONLY_WORKFLOW: WorkflowDefinition = {
  key: "research_only",
  name: "Research & opportunity assessment",
  description: "Keyword research and opportunity scoring only - no content is generated or published.",
  version: 1,
  steps: MASTER_WORKFLOW.steps.filter((s) => ["keyword_research", "opportunity_scoring"].includes(s.key)),
};

export const MONITORING_WORKFLOW: WorkflowDefinition = {
  key: "monitoring",
  name: "Monitoring cycle",
  description: "Technical audit, search performance and AI visibility for already-published inventory.",
  version: 1,
  steps: MASTER_WORKFLOW.steps.filter((s) =>
    ["technical_audit", "search_monitoring", "ai_visibility"].includes(s.key),
  ),
};

export const WORKFLOWS: WorkflowDefinition[] = [MASTER_WORKFLOW, RESEARCH_ONLY_WORKFLOW, MONITORING_WORKFLOW];

export function workflowByKey(key: string): WorkflowDefinition | undefined {
  return WORKFLOWS.find((w) => w.key === key);
}
