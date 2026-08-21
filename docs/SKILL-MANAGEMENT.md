# Skill management

The skill library is a full management system: an authorised operator can create, edit, version, test,
activate, deactivate, assign, remove and roll back skills from the dashboard, without touching agent code.

For what each seeded skill *says*, see [SKILLS.md](SKILLS.md). This document covers how they are managed.

---

## The model

```
Skill                    identity: key, name, category, description, status, activeVersion
  └── SkillVersion       immutable snapshot: instructions, procedure, rules, input/output
                         schema, examples, requested tools, model guidance
AgentSkill               assignment: agent + skill + priority + optional pinned version
SkillTestCase            a reusable sample input
SkillTestRun             one sandboxed execution, with full telemetry
AuditLog                 every change, with actor, previous state and new state
```

A **Skill** is an identity. A **SkillVersion** is the content. Agents resolve to a version, never to "the
skill", which is what makes a historical run reproducible.

---

## Lifecycle

```
DRAFT ──► TESTING ──► READY ──► ACTIVE ──► ARCHIVED
  ▲          │           │                     │
  └──────────┴───────────┘                     │
        (reopen for editing)                   │
                                               │
              ARCHIVED ──► ACTIVE  ◄───────────┘
                  (rollback)
```

| Transition | Allowed | Notes |
| --- | :-: | --- |
| DRAFT → TESTING | ● | |
| TESTING → READY | ● | |
| READY → ACTIVE | ● | via the activation endpoint only |
| ACTIVE → ARCHIVED | ● | refused while agents are still assigned |
| ARCHIVED → ACTIVE | ● | this is rollback |
| TESTING/READY → DRAFT | ● | reopen for editing |
| DRAFT → READY | ✕ | must be tested first |
| DRAFT/TESTING/READY → ACTIVE directly | ✕ | activation walks the lifecycle itself |
| ACTIVE → DRAFT | ✕ | an active version is immutable — create a new draft instead |
| ARCHIVED → DRAFT | ✕ | history is not rewritten |

**Only a DRAFT is editable.** Everything else is frozen. Editing an active skill therefore means creating
a new draft; the active version keeps serving production until the draft is activated.

---

## Activation

Activation is two calls on purpose.

**`preflight`** runs and returns, without changing anything:

1. configuration validation (instructions, schemas, tool existence, embedded-secret scan)
2. input/output schema validation
3. tool permission resolution against the assigned agents
4. the skill's saved test cases — or a synthesised one from the declared inputs, so activation always
   exercises the version rather than rubber-stamping it

**`activate`** requires `confirmed: true` and refuses if preflight did not pass. It then:

- walks the lifecycle (DRAFT → TESTING → READY → ACTIVE), recording each transition
- **archives** the previously active version — never deletes it
- points `Skill.activeVersionId` at the new version

Agents pick it up on their **next** run. Completed runs are untouched.

## Rollback

`POST /api/skills/:id` with `{ action: "rollback", targetVersionId }`. The target becomes ACTIVE, the
version it replaces becomes ARCHIVED, and the event is audited as a rollback rather than an activation.
Nothing is deleted, so you can roll forward again.

---

## Runtime resolution

Every agent run resolves the full chain and records the result:

```
agent
  → assignment (enabled? skill ACTIVE?)
    → pinned version, else the skill's active version
      → configuration
        → effective tool permissions
          → execution
            → validation
```

`AgentRun.skillsUsedJson` stores, per skill:

```json
[{ "skillId": "…", "skillKey": "seo_keyword_research", "name": "SEO Keyword Research",
   "versionId": "…", "version": 3, "versionStatus": "ACTIVE", "pinned": false }]
```

The agent detail page renders this as a **Skill versions** column on every run. Because versions are
immutable and never deleted, a run from last month still reports the exact instructions that produced it.

An assignment that **pins** a version ignores the active version entirely — an explicit operator decision,
shown as `pinned` everywhere it applies.

---

## Tool permissions

A skill **requests** tools. The Control Plane decides.

```
effective = agent allowlist  ∩  union(requested by resolved skills)
```

Three rules, in precedence order:

1. **A skill can never widen.** A tool the agent does not hold is reported as `denied` and is never
   granted, whatever the skill asks for. This is enforced in `computeEffectiveTools` *and* independently
   by `ControlPlane.assertToolAllowed` at execution time.
2. **Where declarations overlap the agent's allowlist, they narrow the run** to that overlap. A tool
   outside the resolved scope is refused by `executeTool` with the effective scope named in the error.
3. **Where they do not overlap at all, narrowing is skipped and the reason is recorded.** An empty
   intersection means the declarations describe a different agent's context — a skill attached for its
   methodology rather than its tools — and silently revoking every tool the agent holds would break the
   agent rather than protect anything. Rule 1 is unaffected.

Rule 3 exists because it was a real bug: `technical_seo` is attached to the Publishing Agent for its
validation methodology, and it declares crawl tools. A naive global intersection revoked `cms.publish` and
broke the publish path. The guard is covered by a regression test.

A skill can never bypass agent capabilities, user RBAC, approval requirements, publishing gates or
credential boundaries. Configuration validation additionally refuses any version whose text contains a
credential-shaped string — API keys belong in Integrations, never in skill instructions.

---

## The sandbox

"Test skill" executes one version against a sample input and reports: input, version, model, tools
requested, effective tools, tools actually used, output, validation, errors, confidence, token usage,
estimated cost and execution time.

**What it can do:** call the LLM router and write a `SkillTestRun` plus a usage-ledger entry.

**What it cannot do:** publish, create pages, mutate project data, or invoke any side-effectful tool. The
sandbox has no tool executor wired into it at all — tool permissions are *resolved and displayed* so the
intersection is visible, but nothing side-effectful runs.

With no LLM provider configured, the deterministic mock composes a response from the skill's own output
contract. That exercises the schema and the validation path honestly, and the output says so.

### Playground

`/skills/playground` — choose an agent, a skill and a version, supply an input, run it. Set
**Compare against** to run a second version on the same input and read them side by side. This is how a
draft is judged against what is live before anything is activated.

---

## Permissions

Uses the existing RBAC — no second permission system.

| Permission | OWNER | ADMIN | EDITOR | VIEWER |
| --- | :-: | :-: | :-: | :-: |
| `skill:read` | ● | ● | ● | ● |
| `skill:test` | ● | ● | ● | |
| `skill:write` (create, edit, version, transition) | ● | ● | | |
| `skill:activate` (activate, roll back) | ● | ● | | |
| `skill:assign` (assign, unassign, pin) | ● | ● | | |

The UI hides what a role cannot do; the API enforces it regardless.

---

## Audit trail

Every change writes an `AuditLog` row with actor, action, skill, version, timestamp, previous state and
new state. `describeAuditEvent` renders them as sentences, shown on the skill's **History** tab and in
**Logs & audit**:

```
Demo Operator created Route Brief v1.
Demo Operator assigned Route Brief to Internal Linking Agent.
Demo Operator tested Route Brief v1 — PASSED.
Demo Operator activated Route Brief v1.
Demo Operator created Route Brief v2 based on v1.
Demo Operator edited Route Brief v2 (instructions).
Demo Operator activated Route Brief v2, archiving v1.
Demo Operator rolled back Route Brief from v2 to v1.
```

---

## API

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `POST /api/skills` | `skill:write` | Create a skill + v1 draft |
| `PATCH /api/skills/:id` | `skill:write` | Name, description, category, ACTIVE/INACTIVE |
| `POST /api/skills/:id` | varies | `duplicate` · `rollback` · `assign` · `unassign` · `pin` · `set_enabled` |
| `POST /api/skills/:id/versions` | `skill:write` | Create a draft from a version |
| `PATCH /api/skills/:id/versions/:vid` | `skill:write` | Edit a draft (refused for any other status) |
| `POST /api/skills/:id/versions/:vid` | `skill:write` / `skill:activate` | `transition` · `preflight` · `activate` |
| `POST /api/skills/:id/test` | `skill:test` | Run the sandbox, optionally comparing two versions |

---

## Migrating an existing installation

`prisma/migrations/20260821210000_skill_management` creates the new tables and **backfills** a v1 version
for every existing skill from the old flat columns before dropping them, so nothing is lost. Assignments
are preserved. `npm run seed` afterwards enriches the migrated v1 rows with the input/output schemas and
tool declarations from `src/skills/seed-config.ts`, and is safe to re-run: a skill that already has
versions is never overwritten.

---

## Adding a skill in code

The built-in library still lives in `src/skills/definitions.ts` (prose) and `src/skills/seed-config.ts`
(schemas, tool requests, rules). Add to both, map it to agents in `AGENT_SKILL_MAP`, and run `npm run seed`.

Anything created through the dashboard needs none of that — it is data.
