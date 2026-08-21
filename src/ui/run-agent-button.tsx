"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Play } from "lucide-react";

/**
 * Triggers one agent run through /api/agents/:key/run and reports the outcome
 * inline. The Control Plane still enforces every permission and budget rule -
 * this is a convenience, not a bypass.
 */
export function RunAgentButton({
  agentKey,
  input,
  label,
  variant = "default",
  hint,
}: {
  agentKey: string;
  input?: Record<string, unknown>;
  label: string;
  variant?: "default" | "primary";
  hint?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; summary?: string; error?: string; isMock?: boolean } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/agents/${agentKey}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: input ?? {} }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, error: data?.error?.message ?? "Run failed" });
        return;
      }
      setResult({ ok: data.ok, summary: data.summary, error: data.error, isMock: data.isMock });
      router.refresh();
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1.5">
      <button className={`fm-btn ${variant === "primary" ? "fm-btn-primary" : ""}`} onClick={run} disabled={busy} title={hint}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {busy ? "Running…" : label}
      </button>
      {result ? (
        <span
          className="max-w-[520px] text-[11.5px]"
          style={{ color: result.ok ? "var(--color-ok)" : "var(--color-danger)" }}
        >
          {result.ok ? result.summary : result.error}
        </span>
      ) : null}
    </div>
  );
}
