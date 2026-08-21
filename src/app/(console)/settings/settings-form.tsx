"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";

const AUTOMATABLE = [
  { key: "keyword_research", label: "Keyword research", risk: "LOW" },
  { key: "opportunity_scoring", label: "Opportunity scoring", risk: "LOW" },
  { key: "crawl", label: "Crawling", risk: "LOW" },
  { key: "ai_visibility_run", label: "AI visibility probes", risk: "LOW" },
  { key: "content_generate", label: "Content generation", risk: "MEDIUM" },
  { key: "internal_link", label: "Internal linking", risk: "LOW" },
  { key: "publish", label: "Publishing", risk: "HIGH" },
];

export function SettingsForm({
  approvalMode,
  confidenceThreshold,
  autoApprovedActions,
  monthlyTokenBudget,
  monthlyCostBudget,
}: {
  approvalMode: string;
  confidenceThreshold: number;
  autoApprovedActions: string[];
  monthlyTokenBudget: number;
  monthlyCostBudget: number;
}) {
  const router = useRouter();
  const [mode, setMode] = useState(approvalMode);
  const [threshold, setThreshold] = useState(confidenceThreshold);
  const [allowlist, setAllowlist] = useState<string[]>(autoApprovedActions);
  const [tokens, setTokens] = useState(monthlyTokenBudget);
  const [cost, setCost] = useState(monthlyCostBudget);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approvalMode: mode,
          confidenceThreshold: threshold,
          autoApprovedActions: allowlist,
          monthlyTokenBudget: tokens,
          monthlyCostBudget: cost,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error?.message ?? "Save failed" });
        return;
      }
      setMessage({ ok: true, text: "Saved. New runs use these settings immediately." });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 text-[12px] font-semibold text-[var(--color-ink-2)]">Approval mode</div>
        <div className="space-y-2">
          {[
            { v: "MANUAL", t: "Manual", d: "Every action is reviewed by a human before it runs." },
            {
              v: "SEMI_AUTOMATIC",
              t: "Semi-automatic (recommended)",
              d: "Low-risk research runs unattended. High-risk actions — publish, unpublish, rollback — and low-confidence runs are reviewed.",
            },
            {
              v: "AUTOMATIC",
              t: "Automatic",
              d: "Only the actions you explicitly allowlist below run unattended. Everything else still comes to approvals.",
            },
          ].map((o) => (
            <label
              key={o.v}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3"
              style={{
                borderColor: mode === o.v ? "var(--color-brand)" : "var(--color-border)",
                background: mode === o.v ? "var(--color-brand-soft)" : "transparent",
              }}
            >
              <input type="radio" name="mode" className="mt-0.5" checked={mode === o.v} onChange={() => setMode(o.v)} />
              <span>
                <span className="block text-[13px] font-medium">{o.t}</span>
                <span className="block text-[11.5px] text-[var(--color-ink-3)]">{o.d}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {mode === "AUTOMATIC" ? (
        <div>
          <div className="mb-2 text-[12px] font-semibold text-[var(--color-ink-2)]">Actions allowed to run unattended</div>
          <div className="space-y-1.5">
            {AUTOMATABLE.map((a) => (
              <label key={a.key} className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={allowlist.includes(a.key)}
                  onChange={(e) =>
                    setAllowlist(e.target.checked ? [...allowlist, a.key] : allowlist.filter((x) => x !== a.key))
                  }
                />
                <span>{a.label}</span>
                <span
                  className="rounded border px-1.5 text-[10px] font-semibold"
                  style={{
                    borderColor: a.risk === "HIGH" ? "var(--color-danger)" : "var(--color-border)",
                    color: a.risk === "HIGH" ? "var(--color-danger)" : "var(--color-ink-3)",
                  }}
                >
                  {a.risk}
                </span>
              </label>
            ))}
          </div>
          {allowlist.includes("publish") ? (
            <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">
              Publishing will run without a human decision. Pages still have to pass the quality gate, but nothing else will
              stop them going live.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-[var(--color-ink-2)]" htmlFor="threshold">
            Confidence threshold
          </label>
          <input
            id="threshold"
            type="number"
            step="0.05"
            min={0}
            max={1}
            className="fm-input"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">Runs below this are escalated instead of accepted.</p>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-[var(--color-ink-2)]" htmlFor="tokens">
            Monthly token budget
          </label>
          <input id="tokens" type="number" className="fm-input" value={tokens} onChange={(e) => setTokens(Number(e.target.value))} />
          <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">Agents are blocked from spending once exhausted.</p>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-[var(--color-ink-2)]" htmlFor="cost">
            Monthly cost budget (USD)
          </label>
          <input id="cost" type="number" step="1" className="fm-input" value={cost} onChange={(e) => setCost(Number(e.target.value))} />
          <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">Checked before any billable tool call.</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="fm-btn fm-btn-primary" onClick={save} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} Save settings
        </button>
        {message ? (
          <span className="text-[12px]" style={{ color: message.ok ? "var(--color-ok)" : "var(--color-danger)" }}>
            {message.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
