"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, GitBranch, Loader2, Rocket, Undo2, XCircle } from "lucide-react";
import { Badge, StatusBadge } from "@/ui/primitives";

interface PreflightTest {
  id: string | null;
  status: string;
  confidence: number;
  model: string;
  isMock: boolean;
  durationMs: number;
  failures: string[];
  warnings: string[];
  output: string;
  effectiveTools: string[];
  deniedTools: string[];
}

interface Preflight {
  validation: { findings: { check: string; passed: boolean; severity: string; message: string }[]; errors: number; warnings: number; valid: boolean };
  tests: PreflightTest[];
  canActivate: boolean;
  currentStatus: string;
}

/**
 * Lifecycle controls for one version.
 *
 * Activation is deliberately two steps: preflight validates the configuration
 * and runs the skill's tests, the operator reads the results, and only then does
 * the confirm button apply the change.
 */
export function VersionActions({
  skillId,
  versionId,
  version,
  status,
  isActive,
  canWrite,
  canActivate,
}: {
  skillId: string;
  versionId: string;
  version: number;
  status: string;
  isActive: boolean;
  canWrite: boolean;
  canActivate: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(`/api/skills/${skillId}/versions/${versionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error?.message ?? "Request failed" });
        if (data?.error?.details?.tests) setPreflight(data.error.details as Preflight);
        return null;
      }
      return data;
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runPreflight() {
    const data = await call({ action: "preflight" }, "preflight");
    if (data?.preflight) setPreflight(data.preflight as Preflight);
  }

  async function activate() {
    const data = await call({ action: "activate", confirmed: true }, "activate");
    if (data?.ok) {
      setPreflight(null);
      setMessage({ ok: true, text: data.message });
      router.refresh();
    }
  }

  async function transition(to: string) {
    const data = await call({ action: "transition", to }, `to:${to}`);
    if (data?.ok) {
      setMessage({ ok: true, text: `v${version} is now ${to}.` });
      router.refresh();
    }
  }

  async function newDraft() {
    setBusy("draft");
    setMessage(null);
    try {
      const res = await fetch(`/api/skills/${skillId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromVersionId: versionId, changeSummary: `Draft based on v${version}.` }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error?.message ?? "Could not create a draft" });
        return;
      }
      router.push(`/skills/${skillId}?version=${data.versionId}&tab=edit`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function rollback() {
    setBusy("rollback");
    setMessage(null);
    try {
      const res = await fetch(`/api/skills/${skillId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rollback", targetVersionId: versionId }),
      });
      const data = await res.json();
      setMessage({ ok: res.ok, text: res.ok ? data.message : (data?.error?.message ?? "Rollback failed") });
      if (res.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const showActivate = canActivate && !isActive && status !== "ARCHIVED";
  const showRollback = canActivate && status === "ARCHIVED";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canWrite ? (
          <button className="fm-btn" onClick={newDraft} disabled={Boolean(busy)}>
            {busy === "draft" ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />} New draft from v{version}
          </button>
        ) : null}

        {canWrite && status === "TESTING" ? (
          <button className="fm-btn" onClick={() => transition("READY")} disabled={Boolean(busy)}>
            Mark ready
          </button>
        ) : null}
        {canWrite && (status === "TESTING" || status === "READY") ? (
          <button className="fm-btn" onClick={() => transition("DRAFT")} disabled={Boolean(busy)}>
            Reopen as draft
          </button>
        ) : null}
        {canWrite && status === "DRAFT" ? (
          <button className="fm-btn" onClick={() => transition("TESTING")} disabled={Boolean(busy)}>
            Move to testing
          </button>
        ) : null}

        {showActivate ? (
          <button className="fm-btn fm-btn-primary" onClick={runPreflight} disabled={Boolean(busy)}>
            {busy === "preflight" ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} Activate v{version}…
          </button>
        ) : null}

        {showRollback ? (
          <button className="fm-btn fm-btn-ok" onClick={rollback} disabled={Boolean(busy)}>
            {busy === "rollback" ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />} Roll back to v{version}
          </button>
        ) : null}

        {canWrite && !isActive && status !== "ARCHIVED" ? (
          <button className="fm-btn" onClick={() => transition("ARCHIVED")} disabled={Boolean(busy)} title="Archive without deleting">
            Archive
          </button>
        ) : null}
      </div>

      {message ? (
        <p className="text-[12px]" style={{ color: message.ok ? "var(--color-ok)" : "var(--color-danger)" }}>
          {message.text}
        </p>
      ) : null}

      {preflight ? (
        <PreflightDialog
          preflight={preflight}
          version={version}
          busy={busy === "activate"}
          onCancel={() => setPreflight(null)}
          onConfirm={activate}
        />
      ) : null}
    </div>
  );
}

function PreflightDialog({
  preflight,
  version,
  busy,
  onCancel,
  onConfirm,
}: {
  preflight: Preflight;
  version: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const failed = preflight.validation.findings.filter((f) => !f.passed);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="fm-card my-8 w-full max-w-[720px] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">Activate v{version}?</h2>
            <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
              Agents pick this up on their <strong>next</strong> run. Completed runs keep the version they actually used, and
              the version being replaced is archived rather than deleted.
            </p>
          </div>
          <Badge tone={preflight.canActivate ? "ok" : "danger"}>{preflight.canActivate ? "checks passed" : "blocked"}</Badge>
        </div>

        <section className="mt-4">
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
            Configuration ({preflight.validation.errors} error, {preflight.validation.warnings} warning)
          </h3>
          {failed.length ? (
            <div className="space-y-1">
              {failed.map((f) => (
                <div key={f.check} className="flex items-start gap-2 text-[12px]">
                  {f.severity === "ERROR" ? (
                    <XCircle size={13} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
                  ) : (
                    <span className="mt-0.5 shrink-0 text-[var(--color-warn)]">!</span>
                  )}
                  <span className="text-[var(--color-ink-2)]">{f.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--color-ok)]">
              <CheckCircle2 size={13} /> Every configuration check passed.
            </p>
          )}
        </section>

        <section className="mt-4">
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
            Automated tests ({preflight.tests.length})
          </h3>
          <div className="space-y-2">
            {preflight.tests.map((t, i) => (
              <div key={t.id ?? i} className="rounded border border-[var(--color-border)] p-2.5">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <StatusBadge status={t.status === "PASSED" ? "COMPLETED" : t.status} />
                  <span className="text-[var(--color-ink-3)]">confidence {t.confidence.toFixed(2)}</span>
                  <span className="text-[var(--color-ink-3)]">· {t.model || "n/a"}</span>
                  {t.isMock ? <Badge tone="mock">MOCK</Badge> : null}
                  <span className="text-[var(--color-ink-3)]">· {t.durationMs}ms</span>
                </div>
                {t.failures.map((f) => (
                  <p key={f} className="mt-1 text-[11.5px] text-[var(--color-danger)]">
                    {f}
                  </p>
                ))}
                {t.warnings.map((w) => (
                  <p key={w} className="mt-1 text-[11.5px] text-[var(--color-warn)]">
                    {w}
                  </p>
                ))}
                {t.effectiveTools.length || t.deniedTools.length ? (
                  <p className="mt-1 text-[11px] text-[var(--color-ink-4)]">
                    effective tools: {t.effectiveTools.join(", ") || "none"}
                    {t.deniedTools.length ? ` · denied: ${t.deniedTools.join(", ")}` : ""}
                  </p>
                ) : null}
                {t.output ? (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-[11px] text-[var(--color-ink-3)]">show output</summary>
                    <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-2)] p-2 text-[11px]">
                      {t.output}
                    </pre>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <div className="mt-5 flex justify-end gap-2">
          <button className="fm-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="fm-btn fm-btn-primary" onClick={onConfirm} disabled={busy || !preflight.canActivate}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} Confirm activation
          </button>
        </div>
      </div>
    </div>
  );
}
