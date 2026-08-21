# HTTP API

All endpoints are under `/api`. Authentication is a `fm_session` httpOnly cookie set by the login
endpoint. Every mutating endpoint checks authentication, an RBAC permission and a per-user rate limit.

Errors share one shape:

```json
{ "error": { "code": "FORBIDDEN", "message": "…", "details": null, "retryable": false } }
```

Codes: `UNAUTHENTICATED` (401) · `FORBIDDEN` / `TOOL_NOT_PERMITTED` (403) · `NOT_FOUND` (404) ·
`VALIDATION_FAILED` / `QUALITY_GATE_FAILED` (422) · `CONFLICT` (409) · `RATE_LIMITED` (429) ·
`BUDGET_EXCEEDED` / `APPROVAL_REQUIRED` / `INTEGRATION_NOT_CONFIGURED` (400) · `AGENT_TIMEOUT` (504) ·
everything else (500).

---

## POST /api/auth/login

```json
{ "email": "admin@faresmatch.local", "password": "faresmatch-demo-2026" }
```

Sets the session cookie. Rate limited to 10 attempts per minute per email + IP.

## POST /api/auth/logout

Deletes the session row and clears the cookie.

---

## POST /api/goals

The main entry point. Runs the Master Orchestrator, then (unless `dryRun`) executes the workflow.

**Permission** `task:run` · **Rate limit** 20/min

```json
{
  "objective": "Create an SEO growth strategy around Delhi to Toronto flights",
  "context": "optional extra context",
  "origin": "DEL",
  "destination": "YYZ",
  "pageFamilyKey": "route",
  "workflowKey": "master_seo_growth",
  "dryRun": false
}
```

Only `objective` is required. `origin`/`destination` pin the entities instead of relying on parsing;
`workflowKey` overrides the orchestrator's choice.

**Response**

```json
{
  "ok": true,
  "plan": { "workflowKey": "…", "entities": {…}, "plan": [ … ], "approvalGates": ["Publish"], "narrative": "…" },
  "workflowRunId": "cmt…",
  "status": "WAITING_APPROVAL",
  "completedSteps": ["technical_audit", "keyword_research", "…"],
  "waitingOn": { "stepKey": "publish", "approvalId": "cmt…" },
  "failedStep": null,
  "error": null,
  "outputs": { "keyword_research": {…}, "quality_control": {…} }
}
```

`status` is `COMPLETED`, `WAITING_APPROVAL`, `FAILED` or `CANCELLED`. With `dryRun: true` the plan is
returned and nothing is executed.

---

## POST /api/approvals/:id

**Permission** `approval:decide` · **Rate limit** 60/min

```json
{ "decision": "APPROVED", "notes": "optional, recorded in the audit log" }
```

Approving resumes whichever workflow run is parked on the approval and returns its new state. Rejecting
cancels the run and marks the page and version `REJECTED`.

```json
{ "ok": true, "decision": "APPROVED", "resumed": { "workflowRunId": "…", "status": "COMPLETED", "completedSteps": [ … ] } }
```

Deciding an already-decided approval returns 409.

---

## POST /api/workflows/:id/resume

**Permission** `task:run`

Resumes a paused run from the first step that has not completed. Idempotent — a completed run returns
`COMPLETED` without re-running anything.

---

## POST /api/agents/:key/run

Run one agent directly. The Control Plane still applies every permission, budget and approval rule.

**Permission** `task:run` · **Rate limit** 40/min

```json
{ "input": { "origin": "DEL", "destination": "YYZ", "limit": 120 } }
```

**Response** includes `agentRunId`, `taskId`, `summary`, `nextAction`, `confidence`, `escalated`,
`isMock`, `toolsUsed`, `costUsd`, `latencyMs`, `error` and the full typed `output`.

Useful inputs:

| Agent | Input |
| --- | --- |
| `keyword_research` | `{ origin, destination, limit, includeSiblingRoutes }` |
| `programmatic_opportunity` | `{ pageFamilyKey, maxCandidates, candidates? }` |
| `technical_seo` | `{ websiteId, maxPages }` |
| `internal_linking` | `{ projectWide: true }` or `{ pageId }` |
| `search_performance` | `{ days, dimension, simulateHistoryDays? }` |
| `ai_visibility` | `{ platforms?, limit }` |
| `quality_control` | `{ pageVersionId }` |
| `publishing` | `{ pageVersionId, adapter? }` |

---

## POST /api/pages/:id/rollback

**Permission** `publish:execute` · **Rate limit** 20/min

```json
{ "toVersion": 2 }
```

Restores and republishes the target version. With no earlier published version it unpublishes instead.
Both outcomes are audited.

```json
{ "ok": true, "rolledBack": true, "unpublished": false, "restoredVersion": 2 }
```

---

## POST /api/integrations

**Permission** `integration:write` · **Rate limit** 30/min

```json
{
  "provider": "dataforseo",
  "credentials": { "login": "…", "password": "…" },
  "settings": { "siteUrl": "https://example.com" }
}
```

Credentials are encrypted before storage. The response contains the updated integration view with a
display **hint** only — never the value.

## DELETE /api/integrations

```json
{ "provider": "dataforseo", "key": "login" }
```

---

## PATCH /api/brand

**Permission** `brand:write`

Any subset of: `brandName`, `voice`, `tone`, `targetAudience`, `writingStyle`, `readingLevel`, `ctaStyle`,
`preferredTerms[]`, `avoidWords[]`, `avoidClaims[]`, `editorialRules[]`, `seoRules{}`, `aeoRules{}`,
`geoRules{}`, `qualityStandards{}`, `linkingRules{}`, `publishingRules{}`.

The profile version increments on every change; the next agent run picks it up.

---

## PATCH /api/settings

**Permission** `settings:write`

```json
{
  "approvalMode": "SEMI_AUTOMATIC",
  "confidenceThreshold": 0.7,
  "autoApprovedActions": ["keyword_research", "opportunity_scoring"],
  "monthlyTokenBudget": 5000000,
  "monthlyCostBudget": 250
}
```

`autoApprovedActions` only has an effect in `AUTOMATIC` mode.

---

## POST /api/search

Flight search. Requires authentication; rate limited to 60/min.

```json
{ "origin": "DEL", "destination": "YYZ", "departDate": "2026-11-02", "passengers": 1, "cabin": "ECONOMY" }
```

Accepts IATA codes or city names. Resolves the route, attempts live offers, links the matching landing
page and records the search as demand.

```json
{
  "ok": true,
  "origin": {…}, "destination": {…},
  "route": { "distanceKm": 11640, "typicalDurationMinutes": 922, "typicalStops": 0, … },
  "offers": [],
  "liveAvailable": false,
  "liveMessage": "No live flight data provider is connected…",
  "landingPage": { "url": "/flights/del/yyz", "status": "PUBLISHED", "href": "/site/flights/del/yyz", … },
  "landingUrl": "/flights/del/yyz"
}
```

`offers` is empty and `liveAvailable` is false unless a credentialed travel provider is connected. No
placeholder fares are ever returned.

---

## Public routes

| Route | Purpose |
| --- | --- |
| `GET /site` | Index of everything published |
| `GET /site/<path>` | A published page, served from disk |
| `GET /sitemap.xml` | Generated from `PUBLISHED` pages only |
| `GET /robots.txt` | Allows `/site/`, disallows the console and the API |
