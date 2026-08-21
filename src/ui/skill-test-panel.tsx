"use client";

import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Badge, StatusBadge } from "@/ui/primitives";
import { formatMoney } from "@/core/utils/text";

export interface TestVersionOption {
  id: string;
  version: number;
  status: string;
}

export interface SkillTestResultView {
  id: string | null;
  status: string;
  skillName: string;
  version: number;
  versionStatus: string;
  agentKey: string | null;
  input: Record<string, unknown>;
  output: string;
  model: string;
  provider: string;
  isMock: boolean;
  toolsRequested: string[];
  effectiveTools: string[];
  deniedTools: string[];
  toolsUsed: string[];
  validation: { check: string; passed: boolean; severity: string; message: string }[];
  errors: string[];
  confidence: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
}

/**
 * Sandbox runner. Shared by the skill detail page and the playground.
 *
 * The sandbox runs generation only: it cannot publish, cannot create pages and
 * cannot mutate project data. That is stated in the UI because an operator
 * should never have to guess whether a test touched production.
 */
export function SkillTestPanel({
  skillId,
  versions,
  defaultVersionId,
  agents,
  defaultAgentKey,
  inputFields,
  allowCompare = true,
}: {
  skillId: string;
  versions: TestVersionOption[];
  defaultVersionId: string | null;
  agents: { key: string; name: string }[];
  defaultAgentKey?: string | null;
  inputFields: { name: string; type: string; required: boolean; description: string }[];
  allowCompare?: boolean;
}) {
  const [versionId, setVersionId] = useState(defaultVersionId ?? versions[0]?.id ?? "");
  const [compareVersionId, setCompareVersionId] = useState("");
  const [agentKey, setAgentKey] = useState(defaultAgentKey ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [rawInput, setRawInput] = useState("{}");
  const [useRaw, setUseRaw] = useState(inputFields.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SkillTestResultView | null>(null);
  const [comparison, setComparison] = useState<SkillTestResultView | null>(null);

  function buildInput(): Record<string, unknown> {
    if (useRaw) {
      try {
        return JSON.parse(rawInput || "{}");
      } catch {
        throw new Error("Sample input is not valid JSON.");
      }
    }
    const out: Record<string, unknown> = {};
    for (const f of inputFields) {
      const raw = values[f.name];
      if (raw === undefined || raw === "") continue;
      if (f.type === "number") out[f.name] = Number(raw);
      else if (f.type === "boolean") out[f.name] = raw === "true";
      else if (f.type === "array" || f.type === "object") {
        try {
          out[f.name] = JSON.parse(raw);
        } catch {
          out[f.name] = raw;
        }
      } else out[f.name] = raw;
    }
    return out;
  }

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    setComparison(null);
    try {
      const input = buildInput();
      const res = await fetch(`/api/skills/${skillId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          versionId,
          compareVersionId: compareVersionId || undefined,
          agentKey: agentKey || undefined,
          input,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? "The test could not be run");
        return;
      }
      setResult(data.result);
      setComparison(data.comparison ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5 text-[11.5px] text-[var(--color-ink-2)]">
        The sandbox runs <strong>generation only</strong>. It never publishes, never creates pages and never modifies project
        data — it records a test run and nothing else. Tool permissions are resolved and shown, but no side-effectful tool is
        executed.
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Version</label>
          <select className="fm-input" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version} — {v.status.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        {allowCompare ? (
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
              Compare against
            </label>
            <select className="fm-input" value={compareVersionId} onChange={(e) => setCompareVersionId(e.target.value)}>
              <option value="">None</option>
              {versions
                .filter((v) => v.id !== versionId)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version} — {v.status.toLowerCase()}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
            Scope tools to agent
          </label>
          <select className="fm-input" value={agentKey} onChange={(e) => setAgentKey(e.target.value)}>
            <option value="">No agent (tools unresolved)</option>
            {agents.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Sample input</span>
          {inputFields.length ? (
            <button className="text-[11px] text-[var(--color-brand)] hover:underline" onClick={() => setUseRaw(!useRaw)}>
              {useRaw ? "Use the declared fields" : "Edit as JSON"}
            </button>
          ) : null}
        </div>

        {useRaw || !inputFields.length ? (
          <textarea
            className="fm-input min-h-[110px] font-mono text-[12px]"
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            placeholder='{"website": "example.com", "country": "United States"}'
          />
        ) : (
          <div className="space-y-2">
            {inputFields.map((f) => (
              <div key={f.name}>
                <label className="mb-0.5 block text-[11.5px] text-[var(--color-ink-2)]">
                  {f.name}
                  {f.required ? <span className="text-[var(--color-danger)]"> *</span> : null}
                  <span className="ml-1.5 text-[10.5px] text-[var(--color-ink-4)]">{f.type}</span>
                </label>
                <input
                  className="fm-input !py-1.5 !text-[12px]"
                  placeholder={f.description || f.name}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <button className="fm-btn fm-btn-primary" onClick={run} disabled={busy || !versionId}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} Run test
      </button>

      {error ? (
        <div
          className="rounded-lg border p-2.5 text-[12px]"
          style={{ background: "var(--color-danger-soft)", borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </div>
      ) : null}

      {result ? (
        comparison ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ResultCard result={result} label={`v${result.version}`} />
            <ResultCard result={comparison} label={`v${comparison.version}`} />
          </div>
        ) : (
          <ResultCard result={result} />
        )
      ) : null}
    </div>
  );
}

function ResultCard({ result, label }: { result: SkillTestResultView; label?: string }) {
  const failures = result.validation.filter((v) => !v.passed);

  return (
    <div className="fm-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
        {label ? <span className="text-[13px] font-semibold">{label}</span> : null}
        <StatusBadge status={result.status === "PASSED" ? "COMPLETED" : result.status} />
        <Badge tone="neutral">v{result.version} {result.versionStatus.toLowerCase()}</Badge>
        {result.isMock ? <Badge tone="mock">MOCK</Badge> : null}
        <span className="ml-auto text-[11.5px] text-[var(--color-ink-3)]">confidence {result.confidence.toFixed(2)}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-[11.5px] sm:grid-cols-3">
        <Cell label="Model">{result.model || "—"}</Cell>
        <Cell label="Provider">{result.provider || "—"}</Cell>
        <Cell label="Duration">{result.durationMs}ms</Cell>
        <Cell label="Tokens">{result.tokensIn + result.tokensOut}</Cell>
        <Cell label="Cost">{formatMoney(result.costUsd)}</Cell>
        <Cell label="Agent scope">{result.agentKey ?? "none"}</Cell>
      </dl>

      <div className="border-t border-[var(--color-border)] px-4 py-3 text-[11.5px]">
        <div className="mb-1 font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Tools</div>
        <div className="space-y-0.5">
          <div>
            <span className="text-[var(--color-ink-3)]">requested: </span>
            {result.toolsRequested.length ? result.toolsRequested.join(", ") : <span className="text-[var(--color-ink-4)]">none</span>}
          </div>
          <div>
            <span className="text-[var(--color-ink-3)]">effective (agent ∩ skill): </span>
            {result.effectiveTools.length ? (
              <span className="text-[var(--color-ok)]">{result.effectiveTools.join(", ")}</span>
            ) : (
              <span className="text-[var(--color-ink-4)]">none</span>
            )}
          </div>
          {result.deniedTools.length ? (
            <div className="text-[var(--color-danger)]">denied by the agent allowlist: {result.deniedTools.join(", ")}</div>
          ) : null}
          <div>
            <span className="text-[var(--color-ink-3)]">actually used: </span>
            {result.toolsUsed.join(", ") || "—"}
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--color-border)] px-4 py-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
          Validation ({result.validation.filter((v) => v.passed).length}/{result.validation.length} passed)
        </div>
        {failures.length ? (
          <div className="space-y-1">
            {failures.map((f, i) => (
              <div key={`${f.check}-${i}`} className="flex items-start gap-2 text-[11.5px]">
                <Badge tone={f.severity === "ERROR" ? "danger" : "warn"}>{f.severity}</Badge>
                <span className="text-[var(--color-ink-2)]">{f.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11.5px] text-[var(--color-ok)]">Every check passed.</p>
        )}
        {result.errors.map((e) => (
          <p key={e} className="mt-1 text-[11.5px] text-[var(--color-danger)]">
            {e}
          </p>
        ))}
      </div>

      <div className="border-t border-[var(--color-border)] px-4 py-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Output</div>
        <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-2)] p-2.5 text-[11.5px] leading-relaxed">
          {result.output || "(no output)"}
        </pre>
      </div>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase tracking-wide text-[var(--color-ink-4)]">{label}</dt>
      <dd className="font-mono text-[var(--color-ink)]">{children}</dd>
    </div>
  );
}
