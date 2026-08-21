/**
 * Seed / demo data.
 *
 * Idempotent: safe to re-run. Creates the organization, a demo operator, the
 * project + website, brand knowledge, the agent catalog, the skill library, the
 * component library, page families, data sources, competitors and the AI
 * visibility prompt library.
 *
 * It does NOT create keywords, opportunities, pages or metrics - those must come
 * from actually running the agents, so that what you see in the dashboard is
 * something the system genuinely produced.
 *
 * Run:  npm run seed
 */
import "dotenv/config";
import { prisma } from "../src/core/db/client";
import { hashPassword } from "../src/core/security/crypto";
import { writeJson } from "../src/core/db/json";
import { AGENT_DEFINITIONS } from "../src/agents/definitions";
import { SKILLS, AGENT_SKILL_MAP } from "../src/skills/definitions";
import { COMPONENT_LIBRARY } from "../src/engine/templates/component-library";
import { DEFAULT_BRAND } from "../src/modules/brand/brand";
import { WORKFLOWS } from "../src/engine/workflow/definitions";
import { loadCompetitors } from "../src/engine/data/adapters/static-dataset";
import { defaultPromptLibrary } from "../src/modules/ai-visibility/platforms";
import { INTEGRATION_CATALOG } from "../src/integrations/catalog";
import { DEFAULT_ROUTE_POLICY } from "../src/agents/content-strategy.agent";

const DEMO_EMAIL = "admin@faresmatch.local";
const DEMO_PASSWORD = "faresmatch-demo-2026";

async function main() {
  console.log("Seeding FaresMatch AI OS…\n");

  // --- organization + user -------------------------------------------------
  const org = await prisma.organization.upsert({
    where: { slug: "faresmatch" },
    update: {},
    create: {
      name: "FaresMatch",
      slug: "faresmatch",
      plan: "mvp",
      monthlyTokenBudget: Number(process.env.DEFAULT_MONTHLY_TOKEN_BUDGET ?? 5_000_000),
      monthlyCostBudget: Number(process.env.DEFAULT_MONTHLY_COST_BUDGET_USD ?? 250),
      settingsJson: writeJson({ demo: true }),
    },
  });
  console.log(`  organization  ${org.name}`);

  const { hash, salt } = hashPassword(DEMO_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { email: DEMO_EMAIL, name: "Demo Operator", passwordHash: hash, passwordSalt: salt },
  });
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
    update: { role: "OWNER" },
    create: { userId: user.id, organizationId: org.id, role: "OWNER" },
  });
  console.log(`  user          ${user.email}  (password: ${DEMO_PASSWORD})`);

  // --- project + website ---------------------------------------------------
  const project = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: "faresmatch-global" } },
    update: {},
    create: {
      organizationId: org.id,
      name: "FaresMatch Global",
      slug: "faresmatch-global",
      description: "Programmatic SEO, AEO and GEO programme for international flight routes.",
      approvalMode: (process.env.DEFAULT_APPROVAL_MODE as string) ?? "SEMI_AUTOMATIC",
      confidenceThreshold: 0.7,
      settingsJson: writeJson({
        // In AUTOMATIC mode only these actions may run unattended. Publishing is
        // deliberately absent.
        autoApprovedActions: ["keyword_research", "opportunity_scoring", "crawl", "ai_visibility_run"],
      }),
    },
  });
  console.log(`  project       ${project.name}`);

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const website = await prisma.website.findFirst({ where: { projectId: project.id } });
  if (!website) {
    await prisma.website.create({
      data: {
        projectId: project.id,
        name: "FaresMatch (local static site)",
        domain: new URL(appUrl).host,
        baseUrl: `${appUrl}/site`,
        cms: "local_static",
        environment: "local",
        sitemapUrl: `${appUrl}/sitemap.xml`,
        robotsUrl: `${appUrl}/robots.txt`,
        verified: true,
      },
    });
    console.log(`  website       ${appUrl}/site  (local_static publishing target)`);
  }

  // --- brand knowledge -----------------------------------------------------
  await prisma.brandProfile.upsert({
    where: { projectId: project.id },
    update: {},
    create: {
      projectId: project.id,
      brandName: "FaresMatch",
      voice: DEFAULT_BRAND.voice,
      tone: DEFAULT_BRAND.tone,
      targetAudience: DEFAULT_BRAND.targetAudience,
      writingStyle: DEFAULT_BRAND.writingStyle,
      readingLevel: DEFAULT_BRAND.readingLevel,
      preferredTermsJson: writeJson(DEFAULT_BRAND.preferredTerms),
      avoidWordsJson: writeJson(DEFAULT_BRAND.avoidWords),
      avoidClaimsJson: writeJson(DEFAULT_BRAND.avoidClaims),
      ctaStyle: DEFAULT_BRAND.ctaStyle,
      formattingJson: writeJson(DEFAULT_BRAND.formatting),
      seoRulesJson: writeJson(DEFAULT_BRAND.seoRules),
      aeoRulesJson: writeJson(DEFAULT_BRAND.aeoRules),
      geoRulesJson: writeJson(DEFAULT_BRAND.geoRules),
      qualityStandardsJson: writeJson(DEFAULT_BRAND.qualityStandards),
      linkingRulesJson: writeJson(DEFAULT_BRAND.linkingRules),
      publishingRulesJson: writeJson(DEFAULT_BRAND.publishingRules),
      editorialRulesJson: writeJson(DEFAULT_BRAND.editorialRules),
    },
  });
  console.log("  brand profile FaresMatch voice + SEO/AEO/GEO rules");

  // --- skills --------------------------------------------------------------
  for (const skill of SKILLS) {
    await prisma.skill.upsert({
      where: { key: skill.key },
      update: {
        name: skill.name,
        category: skill.category,
        description: skill.description,
        instructions: skill.instructions,
        methodologyJson: writeJson(skill.methodology),
        constraintsJson: writeJson(skill.constraints),
        outputContractJson: writeJson(skill.outputContract),
      },
      create: {
        key: skill.key,
        name: skill.name,
        category: skill.category,
        description: skill.description,
        instructions: skill.instructions,
        methodologyJson: writeJson(skill.methodology),
        constraintsJson: writeJson(skill.constraints),
        outputContractJson: writeJson(skill.outputContract),
      },
    });
  }
  console.log(`  skills        ${SKILLS.length} skills in the library`);

  // --- agents + skill assignments -----------------------------------------
  for (const def of AGENT_DEFINITIONS) {
    const agent = await prisma.agent.upsert({
      where: { key: def.key },
      update: {
        name: def.name,
        description: def.description,
        role: def.role,
        kind: def.kind,
        allowedToolsJson: writeJson(def.allowedTools),
        permissionsJson: writeJson(def.capabilities),
        inputSchemaJson: writeJson(def.inputContract),
        outputSchemaJson: writeJson(def.outputContract),
        validationRulesJson: writeJson(def.validationRules),
        confidenceThreshold: def.confidenceThreshold,
        maxRetries: def.maxRetries,
        timeoutMs: def.timeoutMs,
        modelTier: def.modelTier,
      },
      create: {
        key: def.key,
        name: def.name,
        description: def.description,
        role: def.role,
        kind: def.kind,
        organizationId: org.id,
        allowedToolsJson: writeJson(def.allowedTools),
        permissionsJson: writeJson(def.capabilities),
        inputSchemaJson: writeJson(def.inputContract),
        outputSchemaJson: writeJson(def.outputContract),
        validationRulesJson: writeJson(def.validationRules),
        confidenceThreshold: def.confidenceThreshold,
        maxRetries: def.maxRetries,
        timeoutMs: def.timeoutMs,
        modelTier: def.modelTier,
      },
    });

    const skillKeys = AGENT_SKILL_MAP[def.key] ?? [];
    for (const [index, skillKey] of skillKeys.entries()) {
      const skill = await prisma.skill.findUnique({ where: { key: skillKey } });
      if (!skill) continue;
      await prisma.agentSkill.upsert({
        where: { agentId_skillId: { agentId: agent.id, skillId: skill.id } },
        update: { priority: index * 10 },
        create: { agentId: agent.id, skillId: skill.id, priority: index * 10 },
      });
    }
  }
  console.log(`  agents        ${AGENT_DEFINITIONS.length} agents with skills attached`);

  // --- component library ---------------------------------------------------
  for (const c of COMPONENT_LIBRARY) {
    await prisma.componentDef.upsert({
      where: { key: c.key },
      update: {
        name: c.name,
        category: c.category,
        description: c.description,
        version: c.version,
        propsSchemaJson: writeJson(c.defaults),
        defaultsJson: writeJson(c.defaults),
        dataBindingsJson: writeJson({ required: c.requiredBindings, optional: c.optionalBindings }),
        aiSlotsJson: writeJson(c.aiSlots),
        validationJson: writeJson(c.requiredBindings.map((b) => `requires ${b}`)),
      },
      create: {
        key: c.key,
        name: c.name,
        category: c.category,
        description: c.description,
        version: c.version,
        propsSchemaJson: writeJson(c.defaults),
        defaultsJson: writeJson(c.defaults),
        dataBindingsJson: writeJson({ required: c.requiredBindings, optional: c.optionalBindings }),
        aiSlotsJson: writeJson(c.aiSlots),
        validationJson: writeJson(c.requiredBindings.map((b) => `requires ${b}`)),
      },
    });
  }
  console.log(`  components    ${COMPONENT_LIBRARY.length} reusable components`);

  // --- page families -------------------------------------------------------
  const families = [
    {
      key: "route",
      name: "Route pages",
      urlPattern: "/flights/{origin}/{destination}",
      entityTypes: ["ROUTE", "AIRPORT", "CITY", "AIRLINE"],
      minOpportunityScore: 55,
      description: "One page per origin/destination pair that clears the opportunity gate.",
    },
    {
      key: "airport",
      name: "Airport pages",
      urlPattern: "/airports/{iata}",
      entityTypes: ["AIRPORT", "CITY"],
      minOpportunityScore: 60,
      description: "Airport hub pages. Template not yet built - defined as an extension point.",
    },
    {
      key: "airline",
      name: "Airline pages",
      urlPattern: "/airlines/{iata}",
      entityTypes: ["AIRLINE"],
      minOpportunityScore: 62,
      description: "Carrier pages. Requires a carrier-policy data source before content can be generated.",
    },
    {
      key: "destination",
      name: "Destination pages",
      urlPattern: "/destinations/{city}",
      entityTypes: ["CITY", "COUNTRY"],
      minOpportunityScore: 58,
      description: "Destination guides. Template not yet built - defined as an extension point.",
    },
  ];

  for (const f of families) {
    await prisma.pageFamily.upsert({
      where: { projectId_key: { projectId: project.id, key: f.key } },
      update: {},
      create: {
        projectId: project.id,
        key: f.key,
        name: f.name,
        description: f.description,
        urlPattern: f.urlPattern,
        entityTypesJson: writeJson(f.entityTypes),
        compositionJson: writeJson({
          policy: f.key === "route" ? DEFAULT_ROUTE_POLICY : {},
          requiredBindings:
            f.key === "route"
              ? [
                  "origin.city",
                  "origin.airportName",
                  "destination.city",
                  "destination.airportName",
                  "route.distanceKm",
                  "route.typicalDurationMinutes",
                  "route.typicalStops",
                  "route.airlines",
                ]
              : [],
        }),
        qualityThresholdsJson: writeJson({ minScore: 70, minDifferentiation: 0.3, minWordCount: 450 }),
        minOpportunityScore: f.minOpportunityScore,
        status: f.key === "route" ? "ACTIVE" : "PLANNED",
      },
    });
  }
  console.log(`  page families ${families.length} (1 active: route)`);

  // --- data sources --------------------------------------------------------
  const dataSources = [
    {
      key: "static_reference",
      name: "Bundled static reference dataset",
      type: "STATIC_DATASET",
      adapter: "static_reference",
      isMock: true,
      trustLevel: 0.55,
      config: { note: "Airports, airlines and routes. Approximate reference data. No prices or schedules." },
    },
    {
      key: "amadeus",
      name: "Amadeus Self-Service (live offers)",
      type: "API",
      adapter: "amadeus",
      isMock: false,
      trustLevel: 0.92,
      config: { note: "Not connected. Required for any live price or availability data." },
    },
  ];
  for (const ds of dataSources) {
    await prisma.dataSource.upsert({
      where: { projectId_key: { projectId: project.id, key: ds.key } },
      update: {},
      create: {
        projectId: project.id,
        key: ds.key,
        name: ds.name,
        type: ds.type,
        adapter: ds.adapter,
        configJson: writeJson(ds.config),
        status: ds.key === "amadeus" ? "NOT_CONFIGURED" : "ACTIVE",
        isMock: ds.isMock,
        trustLevel: ds.trustLevel,
      },
    });
  }
  console.log(`  data sources  ${dataSources.length}`);

  // --- competitors ---------------------------------------------------------
  for (const c of loadCompetitors()) {
    await prisma.competitor.upsert({
      where: { projectId_domain: { projectId: project.id, domain: c.domain } },
      update: {},
      create: {
        projectId: project.id,
        name: c.name,
        domain: c.domain,
        notes: `${c.type} — seed competitive set (illustrative, replace with your real set)`,
        isPrimary: c.isPrimary,
      },
    });
  }
  console.log(`  competitors   ${loadCompetitors().length}`);

  // --- AI visibility prompt library ---------------------------------------
  const existingPrompts = await prisma.aIPrompt.count({ where: { projectId: project.id } });
  if (existingPrompts === 0) {
    const prompts = [
      ...defaultPromptLibrary("Delhi", "Toronto", "FaresMatch"),
      ...defaultPromptLibrary("Mumbai", "London", "FaresMatch").slice(0, 4),
      { prompt: "What should I check before booking a long-haul flight with a connection?", category: "GENERAL", intent: "INFORMATIONAL" },
      { prompt: "Which sites let me compare flight prices across multiple airlines?", category: "COMPETITIVE", intent: "COMMERCIAL" },
    ];
    for (const p of prompts) {
      await prisma.aIPrompt.create({
        data: {
          projectId: project.id,
          prompt: p.prompt,
          category: p.category,
          intent: p.intent,
          entitiesJson: writeJson([]),
        },
      });
    }
    console.log(`  ai prompts    ${prompts.length} prompts in the visibility library`);
  }

  // --- integration rows (status is derived at read time) -------------------
  for (const def of INTEGRATION_CATALOG) {
    const existing = await prisma.integration.findFirst({
      where: { organizationId: org.id, provider: def.provider, projectId: null },
    });
    if (!existing) {
      await prisma.integration.create({
        data: {
          organizationId: org.id,
          provider: def.provider,
          category: def.category,
          name: def.name,
          status: def.credentials.length === 0 ? "CONFIGURED" : "NOT_CONFIGURED",
          isMock: def.hasMock,
        },
      });
    }
  }
  console.log(`  integrations  ${INTEGRATION_CATALOG.length} catalog entries`);

  // --- workflow definitions ------------------------------------------------
  for (const w of WORKFLOWS) {
    await prisma.workflow.upsert({
      where: { key: w.key },
      update: {
        name: w.name,
        description: w.description,
        stepsJson: writeJson(
          w.steps.map((s, i) => ({
            key: s.key,
            name: s.name,
            description: s.description,
            agentKey: s.agentKey,
            sequence: i,
            requiresApproval: Boolean(s.requiresApproval),
            optional: Boolean(s.optional),
          })),
        ),
      },
      create: {
        key: w.key,
        name: w.name,
        description: w.description,
        version: w.version,
        stepsJson: writeJson(
          w.steps.map((s, i) => ({
            key: s.key,
            name: s.name,
            description: s.description,
            agentKey: s.agentKey,
            sequence: i,
            requiresApproval: Boolean(s.requiresApproval),
            optional: Boolean(s.optional),
          })),
        ),
      },
    });
  }
  console.log(`  workflows     ${WORKFLOWS.length}`);

  console.log(`
Seed complete.

  Sign in at ${appUrl}/login
    email:    ${DEMO_EMAIL}
    password: ${DEMO_PASSWORD}

  No keywords, pages or metrics were seeded. Give the Master Orchestrator a goal
  from the dashboard to make the system produce them.
`);
}

main()
  .catch((e) => {
    console.error("\nSeed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
