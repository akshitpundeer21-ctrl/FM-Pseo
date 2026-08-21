"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Play, ChevronRight } from "lucide-react";

interface PlanStep {
  step: string;
  name: string;
  agentKey: string;
  agentName: string;
  rationale: string;
  requiresApproval: boolean;
  risk: string;
  optional: boolean;
}

interface RunResponse {
  ok: boolean;
  dryRun?: boolean;
  plan?: {
    workflowKey: string;
    workflowName: string;
    objectiveType: string;
    entities: { origin: string | null; destination: string | null; originCity: string | null; destinationCity: string | null; unresolved: string[] };
    plan: PlanStep[];
    approvalGates: string[];
    approvalMode: string;
    narrative: string;
    requiredData: string[];
  };
  workflowRunId?: string;
  status?: string;
  completedSteps?: string[];
  waitingOn?: { stepKey: string; approvalId: string | null } | null;
  failedStep?: string | null;
  error?: string | null;
  outputs?: Record<string, any>;
  stage?: string;
}

const EXAMPLES = [
  "Create an SEO growth strategy around Delhi to Toronto flights",
  "Research keyword opportunities for Mumbai to London flights",
  "Monitor search and AI visibility for the published inventory",
];

export function GoalConsole({ workflows }: { workflows: { key: string; name: string; description: string }[] }) {
  const router = useRouter();
  const [objective, setObjective] = useState(EXAMPLES[0]);
  const [workflowKey, setWorkflowKey] = useState("");
  const [busy, setBusy] = useState<false | "plan" | "run">(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(dryRun: boolean) {
    setBusy(dryRun ? "plan" : "run");
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective, dryRun, workflowKey: workflowKey || undefined }),
      });
      const data = (await res.json()) as RunResponse & { error?: any };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : data.error?.message ?? "Request failed");
        return;
      }
      setResult(data);
      if (!dryRun) router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const plan = result?.plan;

  return (
    <div className="space-y-4">
      <div className="fm-card p-4">
        <label htmlFor="objective" className="mb-1.5 block text-[12px] font-semibold text-[var(--color-ink-2)]">
          Business objective
        </label>
        <textarea
          id="objective"
          className="fm-input min-h-[76px] resize-y"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="e.g. Create an SEO growth strategy around Delhi to Toronto flights"
        />

        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setObjective(ex)}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-[11.5px] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px]">
            <label htmlFor="wf" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
              Workflow
            </label>
            <select id="wf" className="fm-input" value={workflowKey} onChange={(e) => setWorkflowKey(e.target.value)}>
              <option value="">Let the orchestrator decide</option>
              {workflows.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <button className="fm-btn" onClick={() => submit(true)} disabled={Boolean(busy) || objective.trim().length < 5}>
            {busy === "plan" ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
            Plan only
          </button>
          <button className="fm-btn fm-btn-primary" onClick={() => submit(false)} disabled={Boolean(busy) || objective.trim().length < 5}>
            {busy === "run" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {busy === "run" ? "Running the workflow…" : "Plan & execute"}
          </button>
        </div>

        <p className="mt-2 text-[11.5px] text-[var(--color-ink-3)]">
          Executing runs every stage in sequence and can take up to a minute. The run stops at any approval gate and waits
          for you.
        </p>
      </div>

      {error ? (
        <div
          className="rounded-lg border p-3 text-[12.5px]"
          style={{ background: "var(--color-danger-soft)", borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </div>
      ) : null}

      {result?.ok === false && result.stage === "planning" ? (
        <div
          className="rounded-lg border p-3 text-[12.5px]"
          style={{ background: "var(--color-warn-soft)", borderColor: "var(--color-warn)", color: "var(--color-warn)" }}
        >
          {result.error}
        </div>
      ) : null}

      {plan ? (
        <div className="fm-card overflow-hidden">
          <div className="border-b border-[var(--color-border)] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13px] font-semibold">Orchestrator plan</h2>
              <span className="rounded-full border border-[var(--color-border)] px-2 py-[1px] text-[11px] text-[var(--color-ink-2)]">
                {plan.workflowName}
              </span>
              <span className="rounded-full border border-[var(--color-border)] px-2 py-[1px] text-[11px] text-[var(--color-ink-2)]">
                {plan.objectiveType}
              </span>
              {plan.entities.origin && plan.entities.destination ? (
                <span className="rounded-full border border-[var(--color-border)] px-2 py-[1px] text-[11px] text-[var(--color-ink-2)]">
                  {plan.entities.originCity} ({plan.entities.origin}) → {plan.entities.destinationCity} ({plan.entities.destination})
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-[12.5px] text-[var(--color-ink-2)]">{plan.narrative}</p>
          </div>

          <ol className="divide-y divide-[var(--color-border)]">
            {plan.plan.map((s, i) => {
              const state = result?.completedSteps?.includes(s.step)
                ? "done"
                : result?.failedStep === s.step
                  ? "failed"
                  : result?.waitingOn?.stepKey === s.step
                    ? "waiting"
                    : result?.dryRun
                      ? "planned"
                      : "pending";
              const dot =
                state === "done"
                  ? "var(--color-ok)"
                  : state === "failed"
                    ? "var(--color-danger)"
                    : state === "waiting"
                      ? "var(--color-warn)"
                      : "var(--color-border-strong)";
              return (
                <li key={s.step} className="flex items-start gap-3 px-4 py-2.5">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
                  <span className="w-5 shrink-0 text-[12px] tabular-nums text-[var(--color-ink-4)]">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-medium">{s.name}</span>
                      <span className="text-[11.5px] text-[var(--color-ink-3)]">→ {s.agentName}</span>
                      {s.requiresApproval ? (
                        <span
                          className="rounded-full border px-1.5 text-[10px] font-semibold"
                          style={{ background: "var(--color-warn-soft)", color: "var(--color-warn)", borderColor: "var(--color-warn)" }}
                        >
                          APPROVAL
                        </span>
                      ) : null}
                      {s.optional ? <span className="text-[10.5px] text-[var(--color-ink-4)]">optional</span> : null}
                      {state === "waiting" ? (
                        <span className="text-[11px] font-semibold text-[var(--color-warn)]">waiting for you</span>
                      ) : null}
                      {state === "failed" ? <span className="text-[11px] font-semibold text-[var(--color-danger)]">failed</span> : null}
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-[var(--color-ink-3)]">{s.rationale}</p>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-[12px] text-[var(--color-ink-2)]">
            <div>
              <span className="font-semibold">Data this plan needs:</span> {plan.requiredData.join(" · ")}
            </div>
          </div>
        </div>
      ) : null}

      {result && !result.dryRun && result.status ? (
        <RunOutcome result={result} onRefresh={() => router.refresh()} />
      ) : null}
    </div>
  );
}

function RunOutcome({ result, onRefresh }: { result: RunResponse; onRefresh: () => void }) {
  const o = result.outputs ?? {};
  const tone =
    result.status === "COMPLETED"
      ? { bg: "var(--color-ok-soft)", bd: "var(--color-ok)", fg: "var(--color-ok)" }
      : result.status === "WAITING_APPROVAL"
        ? { bg: "var(--color-warn-soft)", bd: "var(--color-warn)", fg: "var(--color-warn)" }
        : { bg: "var(--color-danger-soft)", bd: "var(--color-danger)", fg: "var(--color-danger)" };

  return (
    <div className="fm-card overflow-hidden">
      <div className="border-b px-4 py-2.5 text-[12.5px] font-semibold" style={{ background: tone.bg, borderColor: tone.bd, color: tone.fg }}>
        Workflow {result.status?.replace(/_/g, " ").toLowerCase()}
        {result.error ? ` — ${result.error}` : ""}
      </div>

      <dl className="divide-y divide-[var(--color-border)] px-4">
        {o.keyword_research ? (
          <Row label="Keyword research">
            {o.keyword_research.keywordCount} keywords in {o.keyword_research.clusterCount} clusters
            {o.keyword_research.isMock ? " (mock corpus)" : ""}
          </Row>
        ) : null}
        {o.opportunity_scoring ? (
          <Row label="Opportunity gate">
            {o.opportunity_scoring.evaluated} evaluated → {o.opportunity_scoring.build} BUILD / {o.opportunity_scoring.review} REVIEW /{" "}
            {o.opportunity_scoring.reject} REJECT. Selected {o.opportunity_scoring.selectedUrl ?? "none"}
          </Row>
        ) : null}
        {o.content_generation ? (
          <Row label="Content generation">
            {o.content_generation.url} — {o.content_generation.wordCount} words; composition{" "}
            {(o.content_generation.composition.templateShare * 100).toFixed(0)}/
            {(o.content_generation.composition.dynamicShare * 100).toFixed(0)}/
            {(o.content_generation.composition.aiShare * 100).toFixed(0)} (template/dynamic/generated)
            {o.content_generation.liveOffersAvailable ? "" : " — live prices omitted, no provider connected"}
          </Row>
        ) : null}
        {o.fact_verification ? (
          <Row label="Fact verification">
            {o.fact_verification.gate} — {o.fact_verification.checked} claims checked
            {o.fact_verification.blocking?.length ? `, ${o.fact_verification.blocking.length} blocking` : ""}
          </Row>
        ) : null}
        {o.quality_control ? (
          <Row label="Quality gate">
            {o.quality_control.decision} at {o.quality_control.score}/100
            {o.quality_control.blockingReasons?.length ? ` — ${o.quality_control.blockingReasons[0]}` : ""}
          </Row>
        ) : null}
        {o.publish ? (
          <Row label="Publish">
            <a className="underline" href={o.publish.remoteUrl} target="_blank" rel="noreferrer">
              {o.publish.remoteUrl}
            </a>{" "}
            via {o.publish.adapterUsed}
            {o.publish.fellBack ? " (fallback adapter)" : ""}
          </Row>
        ) : null}
        {o.ai_visibility ? (
          <Row label="AI visibility">
            {o.ai_visibility.runs} probes — mention {(o.ai_visibility.metrics.mentionRate * 100).toFixed(0)}%, citation{" "}
            {(o.ai_visibility.metrics.citationRate * 100).toFixed(0)}%{o.ai_visibility.isMock ? " (mock)" : ""}
          </Row>
        ) : null}
      </dl>

      {result.status === "WAITING_APPROVAL" ? (
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <a href="/approvals" className="fm-btn fm-btn-primary">
            Review and approve
          </a>
          <button className="fm-btn ml-2" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 py-2.5">
      <dt className="w-[150px] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[12.5px] text-[var(--color-ink)]">{children}</dd>
    </div>
  );
}
