# The skill library

A skill is a reusable, versioned instruction set describing **how** to perform a class of work. Skills are
data, not code: they live in the `Skill` table, attach to agents through `AgentSkill`, and are composed
into the agent's system prompt at run time. An operator can edit a methodology in the dashboard and the
next run picks it up — no redeploy, no code change.

Each skill carries four things:

| Part | Purpose |
| --- | --- |
| `instructions` | Injected verbatim into the system prompt |
| `methodology[]` | The ordered procedure to follow |
| `constraints[]` | Hard rules. Violating one should fail validation, not merely look wrong |
| `outputContract{}` | The shape the agent is expected to produce |

Browse them live at `/skills`.

---

## Skills vs brand knowledge

They answer different questions and are composed separately:

```
SKILL              →  how to perform the task        (src/skills)
BRAND KNOWLEDGE    →  what the output must be like   (src/modules/brand)
DYNAMIC DATA       →  what is actually true          (src/engine/data)
```

The system prompt for any agent run is:

```
role description
+ brand knowledge (voice, audience, banned terms, formatting, editorial rules)
+ every attached skill (instructions + procedure + hard rules + output contract)
+ "if required information is missing, say so and omit the claim rather than guessing"
```

Brand rules are not only injected — `checkBrandCompliance` re-checks the generated text deterministically
afterwards, and its findings feed the quality gate.

---

## The 15 seeded skills

### Research

**SEO Keyword Research** — work from entities rather than adjectives; expand every seed into four demand
shapes (core commercial, long-tail modifier, question, code form); never treat raw volume as priority;
flag anything an existing page already targets as cannibalisation rather than opportunity.

**Search Intent Classification** — intent is about what the searcher wants to *do* next, not the grammar
of the query. Map intent to page type, record the reason, and never create a standalone page for a
QUESTION an existing entity page can answer in a section.

**Competitor Research** — compare on coverage and depth, not vanity metrics. Describe only what is
observable; never assert a competitor's internal methodology as fact.

### Strategy

**Programmatic SEO** — a page family is a URL pattern *plus* a template *plus* a data contract; define all
three before generating anything. Existence of a combination is not a reason to create a page. Prefer
fewer, substantially better pages. Plan the internal link graph as part of the design.

**Orchestration Planning** — read the objective for entities, outcome and constraints; run only the stages
that are actually required; delegate each stage to the agent whose role owns it; decide where approval is
needed; stop on a failed required stage rather than silently skipping it.

### Content

**Travel Content Writing** — lead with what the traveller needs to decide. Be concrete, but only write a
number that came from resolved data. Never state a price, schedule, baggage allowance or policy without a
verified source — omit the sentence instead.

### Optimization

**Answer Engine Optimization (AEO)** — every targeted question gets a self-contained 40–60 word answer
immediately under a heading in the phrasing people actually type. The answer must survive being lifted out
of the page entirely.

**Generative Engine Optimization (GEO)** — optimise for clarity, entity precision and citability. Name
entities in disambiguated form (full airport name plus IATA, full carrier name, city plus country). State
sources and recency on the page itself. Never describe answer-engine behaviour as ranking, and never
promise a citation.

**Clear Factual Answering (CFA)** — express facts in extractable structures: key-value summaries,
comparison tables, explicit entity relationships. One canonical statement of each fact per page.

### Technical

**Technical SEO** — status, canonical, robots, title/meta length, heading hierarchy, structured-data
validity, orphans. Report severity honestly. Never report a check as passed if the page could not be
fetched.

**Structured Data** — only emit a type whose required properties are backed by real page content. Never
mark up content the user cannot see. Invalid JSON-LD blocks publication.

**Internal Linking** — link because the target genuinely helps the reader, not to hit a number. Use the
entity graph. Every published page needs at least one inbound internal link.

### Quality

**Fact Verification** — every checkable claim needs a source, a timestamp and a confidence. Prices,
schedules, baggage rules, fees, visa rules and carrier policies are time-sensitive and require a live
source. Never mark a claim verified on the strength of model fluency.

**Content Quality Control** — judge utility first. Check differentiation against siblings: if swapping two
city names produces the other page, it is too thin. A failing page goes to review or rejection, never to
publication with a warning.

### Measurement

**AI Visibility Measurement** — answer engines do not rank pages. Measure mention rate, citation rate,
query coverage and share of voice. Sample repeatedly. Record platform, model, timestamp and full response.
Never claim causality without a controlled comparison.

---

## Which agent has which skill

| Agent | Skills |
| --- | --- |
| `master_orchestrator` | Orchestration Planning · Programmatic SEO |
| `keyword_research` | SEO Keyword Research · Search Intent Classification · Competitor Research |
| `programmatic_opportunity` | Programmatic SEO · Search Intent Classification · SEO Keyword Research |
| `content_strategy` | Programmatic SEO · Travel Content Writing · Search Intent Classification |
| `content_generation` | Travel Content Writing · AEO · CFA |
| `fact_verification` | Fact Verification |
| `seo_optimization` | AEO · GEO · CFA · Structured Data |
| `technical_seo` | Technical SEO · Structured Data |
| `internal_linking` | Internal Linking |
| `publishing` | Technical SEO |
| `search_performance` | SEO Keyword Research |
| `ai_visibility` | AI Visibility · GEO · Competitor Research |
| `quality_control` | Content Quality Control · Fact Verification · Technical SEO |

---

## Adding or editing a skill

Add an entry to `SKILLS` in `src/skills/definitions.ts` and map it to agents in `AGENT_SKILL_MAP`, then
re-run `npm run seed` (upserts, so it is safe to re-run).

To change an existing skill's wording without a deploy, edit the row in the database — `skillsForAgent()`
reads it fresh on every run. Bump `version` when the change is material, so run history remains
interpretable.
