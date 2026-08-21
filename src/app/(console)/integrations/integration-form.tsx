"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

export interface IntegrationView {
  provider: string;
  name: string;
  category: string;
  description: string;
  docsUrl?: string;
  status: string;
  hasMock: boolean;
  degradesTo: string;
  credentials: { key: string; label: string; present: boolean; source: string; hint: string }[];
  settings: { key: string; label: string; value: string }[];
  lastError: string | null;
}

/**
 * Credential entry. Values are POSTed once and encrypted server-side; the form
 * never receives a stored secret back — only a display hint.
 */
export function IntegrationForm({ integration }: { integration: IntegrationView }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>(
    Object.fromEntries(integration.settings.map((s) => [s.key, s.value])),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: integration.provider, credentials: values, settings }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error?.message ?? "Save failed" });
        return;
      }
      setValues({});
      setMessage({ ok: true, text: "Saved and encrypted. The value is never returned to the browser." });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: string) {
    setBusy(true);
    try {
      await fetch("/api/integrations", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: integration.provider, key }),
      });
      setMessage({ ok: true, text: `Removed ${key}.` });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!integration.credentials.length && !integration.settings.length) {
    return <p className="text-[12px] text-[var(--color-ink-3)]">No credentials required.</p>;
  }

  return (
    <div className="space-y-2.5">
      {integration.credentials.map((c) => (
        <div key={c.key}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="text-[11.5px] font-medium text-[var(--color-ink-2)]" htmlFor={`${integration.provider}-${c.key}`}>
              {c.label}
            </label>
            {c.present ? (
              <span className="flex items-center gap-1.5 text-[10.5px] text-[var(--color-ink-3)]">
                <span className="font-mono">{c.hint}</span>
                <span className="rounded border border-[var(--color-border)] px-1">{c.source}</span>
                {c.source === "database" ? (
                  <button onClick={() => remove(c.key)} disabled={busy} title="Remove stored credential" className="text-[var(--color-danger)]">
                    <Trash2 size={12} />
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          <input
            id={`${integration.provider}-${c.key}`}
            type="password"
            autoComplete="off"
            className="fm-input !py-1.5 !text-[12px]"
            placeholder={c.present ? "Enter a new value to rotate" : "Paste the value to connect"}
            value={values[c.key] ?? ""}
            onChange={(e) => setValues({ ...values, [c.key]: e.target.value })}
          />
        </div>
      ))}

      {integration.settings.map((s) => (
        <div key={s.key}>
          <label className="mb-1 block text-[11.5px] font-medium text-[var(--color-ink-2)]" htmlFor={`${integration.provider}-set-${s.key}`}>
            {s.label} <span className="text-[var(--color-ink-4)]">(not a secret)</span>
          </label>
          <input
            id={`${integration.provider}-set-${s.key}`}
            className="fm-input !py-1.5 !text-[12px]"
            value={settings[s.key] ?? ""}
            onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })}
          />
        </div>
      ))}

      <div className="flex items-center gap-2 pt-1">
        <button
          className="fm-btn fm-btn-primary !py-1.5 !text-[12px]"
          onClick={save}
          disabled={busy || (Object.values(values).every((v) => !v.trim()) && !integration.settings.length)}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null} Save
        </button>
        {message ? (
          <span className="text-[11.5px]" style={{ color: message.ok ? "var(--color-ok)" : "var(--color-danger)" }}>
            {message.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
