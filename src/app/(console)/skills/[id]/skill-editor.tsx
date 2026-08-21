"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Badge } from "@/ui/primitives";

export interface IoField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  validation?: string;
  enumValues?: string[];
}

export interface EditableConfig {
  instructions: string;
  methodology: string[];
  constraints: string[];
  qualityCriteria: string[];
  safetyRules: string[];
  businessRules: string[];
  inputs: IoField[];
  outputs: IoField[];
  outputContract: Record<string, string>;
  examples: { name: string; input: Record<string, unknown>; expectedOutput: string; notes?: string }[];
  allowedTools: string[];
  modelGuidance: { tier?: string; temperature?: number; maxTokens?: number; notes?: string };
}

const IO_TYPES = ["string", "number", "boolean", "url", "enum", "array", "object"];

/**
 * Edits a DRAFT version in place. The editor is never shown for a non-draft:
 * versions are immutable once they leave DRAFT, so the caller renders a "create
 * a new draft" prompt instead.
 */
export function SkillEditor({
  skillId,
  versionId,
  version,
  initial,
  initialChangeSummary,
  availableTools,
}: {
  skillId: string;
  versionId: string;
  version: number;
  initial: EditableConfig;
  initialChangeSummary: string;
  availableTools: { key: string; name: string; category: string }[];
}) {
  const router = useRouter();
  const [c, setC] = useState<EditableConfig>(initial);
  const [changeSummary, setChangeSummary] = useState(initialChangeSummary);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [validation, setValidation] = useState<{ findings: { check: string; passed: boolean; severity: string; message: string }[] } | null>(null);

  const set = (patch: Partial<EditableConfig>) => setC({ ...c, ...patch });
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/skills/${skillId}/versions/${versionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: c, changeSummary }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error?.message ?? "Save failed" });
        return;
      }
      setValidation(data.validation ?? null);
      const errs = data.validation?.errors ?? 0;
      setMessage({
        ok: errs === 0,
        text: errs === 0 ? `Saved v${version}. It stays a draft until you activate it.` : `Saved, but ${errs} blocking issue(s) must be fixed before activation.`,
      });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="fm-card p-4">
        <Field label="Instructions" hint="Injected verbatim into the agent's system prompt.">
          <textarea className="fm-input min-h-[200px] font-mono text-[12.5px]" value={c.instructions} onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="fm-card p-4">
          <Field label="Procedure" hint="Ordered steps. One per line.">
            <textarea className="fm-input min-h-[130px] text-[12.5px]" value={c.methodology.join("\n")} onChange={(e) => set({ methodology: lines(e.target.value) })} />
          </Field>
        </div>
        <div className="fm-card p-4">
          <Field label="Hard rules (constraints)" hint="Violating one should fail validation. One per line.">
            <textarea className="fm-input min-h-[130px] text-[12.5px]" value={c.constraints.join("\n")} onChange={(e) => set({ constraints: lines(e.target.value) })} />
          </Field>
        </div>
        <div className="fm-card p-4">
          <Field label="Safety requirements" hint="Rules that protect users or the business. One per line.">
            <textarea className="fm-input min-h-[110px] text-[12.5px]" value={c.safetyRules.join("\n")} onChange={(e) => set({ safetyRules: lines(e.target.value) })} />
          </Field>
        </div>
        <div className="fm-card p-4">
          <Field label="Business rules" hint="Commercial logic this skill must respect. One per line.">
            <textarea className="fm-input min-h-[110px] text-[12.5px]" value={c.businessRules.join("\n")} onChange={(e) => set({ businessRules: lines(e.target.value) })} />
          </Field>
        </div>
      </div>

      <div className="fm-card p-4">
        <Field label="Quality requirements" hint="What 'good' looks like for this skill's output. One per line.">
          <textarea className="fm-input min-h-[100px] text-[12.5px]" value={c.qualityCriteria.join("\n")} onChange={(e) => set({ qualityCriteria: lines(e.target.value) })} />
        </Field>
      </div>

      <IoEditor
        title="Inputs"
        hint="What the skill expects to be given. Required inputs are checked before a test runs."
        fields={c.inputs}
        onChange={(inputs) => set({ inputs })}
      />
      <IoEditor
        title="Outputs"
        hint="The expected output structure. Required fields are checked after generation."
        fields={c.outputs}
        onChange={(outputs) => set({ outputs })}
      />

      <div className="fm-card p-4">
        <div className="mb-2">
          <div className="text-[12px] font-semibold text-[var(--color-ink-2)]">Requested tools</div>
          <p className="text-[11.5px] text-[var(--color-ink-3)]">
            A skill can only <strong>narrow</strong> what an agent may use. Anything selected here is intersected with the
            agent&rsquo;s own allowlist at runtime — it can never grant a tool the agent does not already hold.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {availableTools.map((t) => (
            <label key={t.key} className="flex items-start gap-2 rounded border border-[var(--color-border)] p-2 text-[12px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={c.allowedTools.includes(t.key)}
                onChange={(e) =>
                  set({ allowedTools: e.target.checked ? [...c.allowedTools, t.key] : c.allowedTools.filter((x) => x !== t.key) })
                }
              />
              <span className="min-w-0">
                <span className="block font-mono text-[11px] text-[var(--color-ink)]">{t.key}</span>
                <span className="block truncate text-[11px] text-[var(--color-ink-3)]">{t.name}</span>
              </span>
            </label>
          ))}
        </div>
        {c.allowedTools.length === 0 ? (
          <p className="mt-2 text-[11.5px] text-[var(--color-ink-4)]">
            Nothing selected — the agent&rsquo;s own allowlist applies unchanged.
          </p>
        ) : null}
      </div>

      <div className="fm-card p-4">
        <div className="mb-2 text-[12px] font-semibold text-[var(--color-ink-2)]">Model guidance</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className="mb-1 block text-[11px] text-[var(--color-ink-3)]">Tier</label>
            <select
              className="fm-input"
              value={c.modelGuidance.tier ?? ""}
              onChange={(e) => set({ modelGuidance: { ...c.modelGuidance, tier: e.target.value || undefined } })}
            >
              <option value="">agent default</option>
              <option value="fast">fast</option>
              <option value="balanced">balanced</option>
              <option value="deep">deep</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[var(--color-ink-3)]">Temperature</label>
            <input
              className="fm-input"
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={c.modelGuidance.temperature ?? ""}
              onChange={(e) =>
                set({ modelGuidance: { ...c.modelGuidance, temperature: e.target.value === "" ? undefined : Number(e.target.value) } })
              }
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[var(--color-ink-3)]">Max tokens</label>
            <input
              className="fm-input"
              type="number"
              min={64}
              max={8000}
              value={c.modelGuidance.maxTokens ?? ""}
              onChange={(e) =>
                set({ modelGuidance: { ...c.modelGuidance, maxTokens: e.target.value === "" ? undefined : Number(e.target.value) } })
              }
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[var(--color-ink-3)]">Notes</label>
            <input
              className="fm-input"
              value={c.modelGuidance.notes ?? ""}
              onChange={(e) => set({ modelGuidance: { ...c.modelGuidance, notes: e.target.value || undefined } })}
            />
          </div>
        </div>
      </div>

      <ExampleEditor examples={c.examples} onChange={(examples) => set({ examples })} />

      {validation?.findings.length ? (
        <div className="fm-card p-4">
          <div className="mb-2 text-[12px] font-semibold text-[var(--color-ink-2)]">Validation</div>
          <div className="space-y-1">
            {validation.findings
              .filter((f) => !f.passed)
              .map((f) => (
                <div key={f.check} className="flex items-start gap-2 text-[12px]">
                  <Badge tone={f.severity === "ERROR" ? "danger" : "warn"}>{f.severity}</Badge>
                  <span className="text-[var(--color-ink-2)]">{f.message}</span>
                </div>
              ))}
            {validation.findings.every((f) => f.passed) ? (
              <span className="text-[12px] text-[var(--color-ok)]">Every check passed.</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="sticky bottom-0 z-10 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="fm-input max-w-[420px] !py-1.5 !text-[12px]"
            placeholder="Change summary (recorded in the audit log)"
            value={changeSummary}
            onChange={(e) => setChangeSummary(e.target.value)}
          />
          <button className="fm-btn fm-btn-primary" onClick={save} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save draft
          </button>
          {message ? (
            <span className="text-[12px]" style={{ color: message.ok ? "var(--color-ok)" : "var(--color-danger)" }}>
              {message.text}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function IoEditor({
  title,
  hint,
  fields,
  onChange,
}: {
  title: string;
  hint: string;
  fields: IoField[];
  onChange: (fields: IoField[]) => void;
}) {
  const update = (i: number, patch: Partial<IoField>) => onChange(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <div className="fm-card p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-[var(--color-ink-2)]">{title}</div>
          <p className="text-[11.5px] text-[var(--color-ink-3)]">{hint}</p>
        </div>
        <button
          className="fm-btn !px-2 !py-1 !text-[11.5px]"
          onClick={() => onChange([...fields, { name: "", type: "string", required: false, description: "" }])}
        >
          <Plus size={12} /> Add field
        </button>
      </div>

      {fields.length ? (
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="grid grid-cols-1 items-start gap-2 rounded border border-[var(--color-border)] p-2 sm:grid-cols-[1.1fr_0.8fr_auto_1.6fr_1fr_auto]">
              <input className="fm-input !py-1.5 !text-[12px]" placeholder="name" value={f.name} onChange={(e) => update(i, { name: e.target.value })} />
              <select className="fm-input !py-1.5 !text-[12px]" value={f.type} onChange={(e) => update(i, { type: e.target.value })}>
                {IO_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 px-1 text-[11.5px] text-[var(--color-ink-2)]">
                <input type="checkbox" checked={f.required} onChange={(e) => update(i, { required: e.target.checked })} />
                required
              </label>
              <input
                className="fm-input !py-1.5 !text-[12px]"
                placeholder="description"
                value={f.description}
                onChange={(e) => update(i, { description: e.target.value })}
              />
              <input
                className="fm-input !py-1.5 !text-[12px]"
                placeholder={f.type === "enum" ? "a, b, c" : "validation rule"}
                value={f.type === "enum" ? (f.enumValues ?? []).join(", ") : (f.validation ?? "")}
                onChange={(e) =>
                  f.type === "enum"
                    ? update(i, { enumValues: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })
                    : update(i, { validation: e.target.value || undefined })
                }
              />
              <button
                className="fm-btn !px-2 !py-1"
                title="Remove field"
                onClick={() => onChange(fields.filter((_, idx) => idx !== i))}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--color-ink-4)]">No fields declared.</p>
      )}
    </div>
  );
}

function ExampleEditor({
  examples,
  onChange,
}: {
  examples: { name: string; input: Record<string, unknown>; expectedOutput: string; notes?: string }[];
  onChange: (v: { name: string; input: Record<string, unknown>; expectedOutput: string; notes?: string }[]) => void;
}) {
  const [errors, setErrors] = useState<Record<number, string>>({});

  return (
    <div className="fm-card p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-[var(--color-ink-2)]">Examples</div>
          <p className="text-[11.5px] text-[var(--color-ink-3)]">Sample input and the output it should produce. Included in the prompt.</p>
        </div>
        <button
          className="fm-btn !px-2 !py-1 !text-[11.5px]"
          onClick={() => onChange([...examples, { name: "", input: {}, expectedOutput: "" }])}
        >
          <Plus size={12} /> Add example
        </button>
      </div>

      {examples.length ? (
        <div className="space-y-3">
          {examples.map((ex, i) => (
            <div key={i} className="rounded border border-[var(--color-border)] p-2.5">
              <div className="mb-2 flex items-center gap-2">
                <input
                  className="fm-input !py-1.5 !text-[12px]"
                  placeholder="Example name"
                  value={ex.name}
                  onChange={(e) => onChange(examples.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))}
                />
                <button className="fm-btn !px-2 !py-1" onClick={() => onChange(examples.filter((_, idx) => idx !== i))}>
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] text-[var(--color-ink-3)]">Input (JSON)</label>
                  <textarea
                    className="fm-input min-h-[80px] font-mono text-[11.5px]"
                    defaultValue={JSON.stringify(ex.input, null, 2)}
                    onBlur={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value || "{}");
                        onChange(examples.map((x, idx) => (idx === i ? { ...x, input: parsed } : x)));
                        setErrors({ ...errors, [i]: "" });
                      } catch {
                        setErrors({ ...errors, [i]: "Not valid JSON - the previous value was kept." });
                      }
                    }}
                  />
                  {errors[i] ? <p className="mt-1 text-[11px] text-[var(--color-danger)]">{errors[i]}</p> : null}
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-[var(--color-ink-3)]">Expected output</label>
                  <textarea
                    className="fm-input min-h-[80px] text-[11.5px]"
                    value={ex.expectedOutput}
                    onChange={(e) => onChange(examples.map((x, idx) => (idx === i ? { ...x, expectedOutput: e.target.value } : x)))}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--color-ink-4)]">No examples.</p>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1">
        <span className="text-[12px] font-semibold text-[var(--color-ink-2)]">{label}</span>
        {hint ? <p className="text-[11.5px] text-[var(--color-ink-3)]">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}
