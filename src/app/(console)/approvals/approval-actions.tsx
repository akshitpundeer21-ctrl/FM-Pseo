"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";

/**
 * Approve or reject. Approving resumes whichever workflow run is parked on this
 * approval, so the pipeline continues from exactly where it stopped.
 */
export function ApprovalActions({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<false | "APPROVED" | "REJECTED">(false);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function decide(decision: "APPROVED" | "REJECTED") {
    setBusy(decision);
    setMessage(null);
    try {
      const res = await fetch(`/api/approvals/${approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, notes: notes || undefined }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setMessage({ ok: false, text: data?.error?.message ?? data?.error ?? "Failed" });
        return;
      }
      const resumed = data.resumed;
      setMessage({
        ok: true,
        text:
          decision === "APPROVED"
            ? resumed
              ? `Approved. Workflow resumed and is now ${String(resumed.status).toLowerCase().replace(/_/g, " ")}.`
              : "Approved."
            : "Rejected. The workflow was cancelled and the page marked rejected.",
      });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <input
        className="fm-input !py-1.5 !text-[12px]"
        placeholder="Decision note (optional, recorded in the audit log)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="flex gap-2">
        <button className="fm-btn fm-btn-ok" onClick={() => decide("APPROVED")} disabled={Boolean(busy)}>
          {busy === "APPROVED" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve &amp; continue
        </button>
        <button className="fm-btn fm-btn-danger" onClick={() => decide("REJECTED")} disabled={Boolean(busy)}>
          {busy === "REJECTED" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Reject
        </button>
      </div>
      {message ? (
        <p className="text-[11.5px]" style={{ color: message.ok ? "var(--color-ok)" : "var(--color-danger)" }}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
