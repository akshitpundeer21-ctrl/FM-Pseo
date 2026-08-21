"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Undo2 } from "lucide-react";

export function RollbackButton({ pageId }: { pageId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function rollback() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/pages/${pageId}/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data?.error?.message ?? "Rollback failed");
        return;
      }
      setMessage(
        data.rolledBack
          ? `Restored version ${data.restoredVersion} and republished it.`
          : "No earlier published version existed, so the page was unpublished.",
      );
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <div className="inline-flex flex-col items-end gap-1">
        <button className="fm-btn fm-btn-danger" onClick={() => setConfirming(true)}>
          <Undo2 size={14} /> Roll back
        </button>
        {message ? <span className="text-[11.5px] text-[var(--color-ink-3)]">{message}</span> : null}
      </div>
    );
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-[var(--color-ink-2)]">Restore the previous published version?</span>
        <button className="fm-btn fm-btn-danger" onClick={rollback} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} Confirm
        </button>
        <button className="fm-btn" onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      {message ? <span className="text-[11.5px] text-[var(--color-ink-3)]">{message}</span> : null}
    </div>
  );
}
