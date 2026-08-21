"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";

export interface BrandValues {
  brandName: string;
  voice: string;
  tone: string;
  targetAudience: string;
  writingStyle: string;
  readingLevel: string;
  ctaStyle: string;
  preferredTerms: string[];
  avoidWords: string[];
  avoidClaims: string[];
  editorialRules: string[];
}

/**
 * Editing brand knowledge changes what every future agent run produces — no
 * prompt anywhere is rewritten by hand.
 */
export function BrandForm({ initial }: { initial: BrandValues }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (patch: Partial<BrandValues>) => setV({ ...v, ...patch });
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/brand", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(v),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error?.message ?? "Save failed" });
        return;
      }
      setMessage({ ok: true, text: "Saved. The next agent run picks this up." });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Brand name">
          <input className="fm-input" value={v.brandName} onChange={(e) => set({ brandName: e.target.value })} />
        </Field>
        <Field label="Reading level">
          <input className="fm-input" value={v.readingLevel} onChange={(e) => set({ readingLevel: e.target.value })} />
        </Field>
      </div>

      <Field label="Voice">
        <textarea className="fm-input min-h-[54px]" value={v.voice} onChange={(e) => set({ voice: e.target.value })} />
      </Field>
      <Field label="Tone">
        <textarea className="fm-input min-h-[46px]" value={v.tone} onChange={(e) => set({ tone: e.target.value })} />
      </Field>
      <Field label="Target audience">
        <textarea className="fm-input min-h-[54px]" value={v.targetAudience} onChange={(e) => set({ targetAudience: e.target.value })} />
      </Field>
      <Field label="Writing style">
        <textarea className="fm-input min-h-[46px]" value={v.writingStyle} onChange={(e) => set({ writingStyle: e.target.value })} />
      </Field>
      <Field label="CTA style">
        <textarea className="fm-input min-h-[46px]" value={v.ctaStyle} onChange={(e) => set({ ctaStyle: e.target.value })} />
      </Field>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field label="Preferred terminology (one per line)">
          <textarea
            className="fm-input min-h-[90px] font-mono text-[12px]"
            value={v.preferredTerms.join("\n")}
            onChange={(e) => set({ preferredTerms: lines(e.target.value) })}
          />
        </Field>
        <Field label="Words to avoid (enforced — a match blocks the quality gate)">
          <textarea
            className="fm-input min-h-[90px] font-mono text-[12px]"
            value={v.avoidWords.join("\n")}
            onChange={(e) => set({ avoidWords: lines(e.target.value) })}
          />
        </Field>
      </div>

      <Field label="Claims to avoid (guidance for generation, enforced by fact verification)">
        <textarea
          className="fm-input min-h-[100px] text-[12px]"
          value={v.avoidClaims.join("\n")}
          onChange={(e) => set({ avoidClaims: lines(e.target.value) })}
        />
      </Field>

      <Field label="Editorial rules">
        <textarea
          className="fm-input min-h-[90px] text-[12px]"
          value={v.editorialRules.join("\n")}
          onChange={(e) => set({ editorialRules: lines(e.target.value) })}
        />
      </Field>

      <div className="flex items-center gap-3">
        <button className="fm-btn fm-btn-primary" onClick={save} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} Save brand knowledge
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]">{label}</label>
      {children}
    </div>
  );
}
