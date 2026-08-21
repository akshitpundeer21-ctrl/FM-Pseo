"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

/**
 * Creates a skill and its v1 DRAFT, then drops the operator straight into the
 * editor. Nothing is live until the draft is activated.
 */
export function CreateSkillButton({ categories }: { categories: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState(categories[0] ?? "RESEARCH");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          category,
          description,
          changeSummary: "Initial version.",
          config: {
            instructions,
            methodology: [],
            constraints: [],
            qualityCriteria: [],
            safetyRules: [],
            businessRules: [],
            inputs: [],
            outputs: [],
            outputContract: {},
            examples: [],
            allowedTools: [],
            modelGuidance: {},
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? "Could not create the skill");
        return;
      }
      router.push(`/skills/${data.skillId}?tab=edit`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="fm-btn fm-btn-primary" onClick={() => setOpen(true)}>
        <Plus size={14} /> Create skill
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="fm-card w-full max-w-[560px] p-5">
        <h2 className="text-[15px] font-semibold">Create a skill</h2>
        <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
          This creates the skill and a v1 draft. Nothing changes for any agent until you assign it and activate the version.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="skill-name">
              Name
            </label>
            <input id="skill-name" className="fm-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Keyword Clustering" />
            <p className="mt-1 text-[11px] text-[var(--color-ink-4)]">The key is derived from the name and must be unique.</p>
          </div>

          <div>
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="skill-category">
              Category
            </label>
            <input
              id="skill-category"
              className="fm-input"
              list="skill-categories"
              value={category}
              onChange={(e) => setCategory(e.target.value.toUpperCase())}
            />
            <datalist id="skill-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>

          <div>
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="skill-desc">
              Description
            </label>
            <input
              id="skill-desc"
              className="fm-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line on what this skill is for."
            />
          </div>

          <div>
            <label className="mb-1 block text-[11.5px] font-semibold text-[var(--color-ink-2)]" htmlFor="skill-instructions">
              Instructions
            </label>
            <textarea
              id="skill-instructions"
              className="fm-input min-h-[110px]"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="The reusable instructions injected into the agent's prompt. You can refine this, plus inputs, outputs and rules, in the editor."
            />
          </div>
        </div>

        {error ? (
          <div
            className="mt-3 rounded-lg border p-2.5 text-[12px]"
            style={{ background: "var(--color-danger-soft)", borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
          >
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button className="fm-btn" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
          <button className="fm-btn fm-btn-primary" onClick={create} disabled={busy || name.trim().length < 2 || instructions.trim().length < 10}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create draft
          </button>
        </div>
      </div>
    </div>
  );
}
