/**
 * Template renderer.
 *
 * Assembles a page from: template blocks + resolved dynamic data + generated AI
 * slots + page-level context. It also does the composition accounting that
 * implements the configurable template/dynamic/AI mix - the ratio is measured
 * from what was actually rendered, and compared against the page family's
 * configured policy. Nothing is hard-coded to 70/30.
 *
 * A block whose required bindings did not resolve is skipped with a recorded
 * reason. If that block was marked required, the render reports a hard failure
 * and the page is not publishable.
 */
import { componentByKey, type ComponentDefinition, type RenderInput } from "@/engine/templates/component-library";
import { evaluateCondition } from "@/engine/templates/expression";
import { lookup } from "@/engine/data/types";
import type { ContentSource } from "@/core/types/enums";
import { wordCount } from "@/core/utils/text";

export interface TemplateBlockSpec {
  blockKey: string;
  componentKey: string;
  sequence: number;
  isRequired: boolean;
  condition?: string | null;
  config?: Record<string, unknown>;
  /** Overrides the component's own classification when set on the template. */
  contentSource?: ContentSource;
}

export interface RenderedBlock {
  blockKey: string;
  componentKey: string;
  componentVersion: number;
  sequence: number;
  source: ContentSource;
  html: string;
  text: string;
  usedPaths: string[];
  slots: Record<string, string>;
  rendered: boolean;
  skippedReason?: string;
  isRequired: boolean;
  aiChars: number;
  wordCount: number;
}

export interface CompositionReport {
  templateChars: number;
  dynamicChars: number;
  aiChars: number;
  totalChars: number;
  templateShare: number;
  dynamicShare: number;
  aiShare: number;
  /** Configured policy for this page family, if any. */
  policy?: CompositionPolicy;
  withinPolicy: boolean;
  policyNotes: string[];
}

/** Per-family composition policy. Operator-configurable; never hard-coded. */
export interface CompositionPolicy {
  /** Minimum share of the page that must be page-specific (dynamic + AI). */
  minUniqueShare?: number;
  /** Maximum share that may come from the reusable template layer. */
  maxTemplateShare?: number;
  /** Maximum share that may be model-generated prose. */
  maxAiShare?: number;
  /** Minimum number of distinct resolved data points referenced on the page. */
  minDistinctDataPoints?: number;
}

export interface RenderResult {
  blocks: RenderedBlock[];
  html: string;
  text: string;
  composition: CompositionReport;
  missingRequiredBlocks: string[];
  distinctDataPoints: string[];
  wordCount: number;
}

export type SlotGenerator = (params: {
  block: TemplateBlockSpec;
  component: ComponentDefinition;
  slotName: string;
  task: string;
  instruction: string;
  maxTokens?: number;
  complexity?: number;
  values: Record<string, unknown>;
}) => Promise<string | null>;

export interface RenderParams {
  blocks: TemplateBlockSpec[];
  values: Record<string, unknown>;
  page: RenderInput["page"];
  generateSlot?: SlotGenerator;
  policy?: CompositionPolicy;
}

function hasBinding(values: Record<string, unknown>, path: string): boolean {
  const v = lookup(values, path);
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export async function renderTemplate(params: RenderParams): Promise<RenderResult> {
  const blocks: RenderedBlock[] = [];
  const missingRequiredBlocks: string[] = [];
  const distinct = new Set<string>();

  const ordered = [...params.blocks].sort((a, b) => a.sequence - b.sequence);

  for (const spec of ordered) {
    const component = componentByKey(spec.componentKey);
    if (!component) {
      blocks.push(emptyBlock(spec, 1, `Component "${spec.componentKey}" is not in the library`));
      if (spec.isRequired) missingRequiredBlocks.push(spec.blockKey);
      continue;
    }

    // 1. Conditional rendering.
    if (spec.condition && !evaluateCondition(spec.condition, params.values)) {
      blocks.push(emptyBlock(spec, component.version, `Condition "${spec.condition}" evaluated false`));
      if (spec.isRequired) missingRequiredBlocks.push(spec.blockKey);
      continue;
    }

    // 2. Required data bindings.
    const missingBindings = component.requiredBindings.filter((p) => !hasBinding(params.values, p));
    if (missingBindings.length) {
      blocks.push(emptyBlock(spec, component.version, `Missing required data: ${missingBindings.join(", ")}`));
      if (spec.isRequired) missingRequiredBlocks.push(spec.blockKey);
      continue;
    }

    // 3. AI slots.
    const slots: Record<string, string> = {};
    let aiChars = 0;
    for (const slot of component.aiSlots) {
      if (!params.generateSlot) continue;
      try {
        const text = await params.generateSlot({
          block: spec,
          component,
          slotName: slot.name,
          task: slot.task,
          instruction: slot.instruction,
          maxTokens: slot.maxTokens,
          complexity: slot.complexity,
          values: params.values,
        });
        if (text && text.trim()) {
          slots[slot.name] = text.trim();
          aiChars += text.trim().length;
        }
      } catch {
        // A failed optional slot degrades the block; a failed required slot is
        // caught below when the component reports it could not render.
      }
    }

    // 4. Render.
    const input: RenderInput = {
      props: { ...component.defaults, ...(spec.config ?? {}) },
      values: params.values,
      slots,
      page: params.page,
    };
    const extraIssues = component.validate?.(input) ?? [];
    if (extraIssues.length) {
      blocks.push(emptyBlock(spec, component.version, extraIssues.join("; ")));
      if (spec.isRequired) missingRequiredBlocks.push(spec.blockKey);
      continue;
    }

    const out = component.render(input);
    if (!out.html.trim()) {
      blocks.push(emptyBlock(spec, component.version, out.skippedReason ?? "Component produced no output"));
      if (spec.isRequired) missingRequiredBlocks.push(spec.blockKey);
      continue;
    }

    for (const p of out.usedPaths) if (hasBinding(params.values, p)) distinct.add(p);

    blocks.push({
      blockKey: spec.blockKey,
      componentKey: component.key,
      componentVersion: component.version,
      sequence: spec.sequence,
      source: spec.contentSource ?? component.contentSource,
      html: out.html,
      text: out.text,
      usedPaths: out.usedPaths,
      slots,
      rendered: true,
      isRequired: spec.isRequired,
      aiChars,
      wordCount: wordCount(out.text),
    });
  }

  const html = blocks.filter((b) => b.rendered).map((b) => b.html).join("\n");
  const text = blocks.filter((b) => b.rendered).map((b) => b.text).join("\n\n");

  return {
    blocks,
    html,
    text,
    composition: computeComposition(blocks, distinct.size, params.policy),
    missingRequiredBlocks,
    distinctDataPoints: [...distinct],
    wordCount: wordCount(text),
  };
}

function emptyBlock(spec: TemplateBlockSpec, version: number, reason: string): RenderedBlock {
  return {
    blockKey: spec.blockKey,
    componentKey: spec.componentKey,
    componentVersion: version,
    sequence: spec.sequence,
    source: spec.contentSource ?? "TEMPLATE",
    html: "",
    text: "",
    usedPaths: [],
    slots: {},
    rendered: false,
    skippedReason: reason,
    isRequired: spec.isRequired,
    aiChars: 0,
    wordCount: 0,
  };
}

/**
 * Measure the actual template / dynamic / AI mix of the rendered page and
 * compare it with the family's policy.
 */
export function computeComposition(
  blocks: RenderedBlock[],
  distinctDataPoints: number,
  policy?: CompositionPolicy,
): CompositionReport {
  let templateChars = 0;
  let dynamicChars = 0;
  let aiChars = 0;

  for (const b of blocks) {
    if (!b.rendered) continue;
    const len = b.text.length;
    if (b.source === "AI") {
      aiChars += len;
    } else if (b.source === "DYNAMIC") {
      dynamicChars += len;
    } else if (b.source === "HYBRID") {
      // Split a hybrid block by the share of its text that came from AI slots.
      const ai = Math.min(b.aiChars, len);
      aiChars += ai;
      dynamicChars += len - ai;
    } else {
      templateChars += len;
    }
  }

  const totalChars = templateChars + dynamicChars + aiChars || 1;
  const templateShare = templateChars / totalChars;
  const dynamicShare = dynamicChars / totalChars;
  const aiShare = aiChars / totalChars;
  const uniqueShare = dynamicShare + aiShare;

  const notes: string[] = [];
  let withinPolicy = true;

  if (policy) {
    if (policy.minUniqueShare !== undefined && uniqueShare < policy.minUniqueShare) {
      withinPolicy = false;
      notes.push(
        `Page-specific share ${(uniqueShare * 100).toFixed(0)}% is below the family minimum of ${(policy.minUniqueShare * 100).toFixed(0)}%.`,
      );
    }
    if (policy.maxTemplateShare !== undefined && templateShare > policy.maxTemplateShare) {
      withinPolicy = false;
      notes.push(
        `Reusable template share ${(templateShare * 100).toFixed(0)}% exceeds the family maximum of ${(policy.maxTemplateShare * 100).toFixed(0)}%.`,
      );
    }
    if (policy.maxAiShare !== undefined && aiShare > policy.maxAiShare) {
      withinPolicy = false;
      notes.push(
        `Model-generated share ${(aiShare * 100).toFixed(0)}% exceeds the family maximum of ${(policy.maxAiShare * 100).toFixed(0)}%.`,
      );
    }
    if (policy.minDistinctDataPoints !== undefined && distinctDataPoints < policy.minDistinctDataPoints) {
      withinPolicy = false;
      notes.push(`Only ${distinctDataPoints} distinct data points resolved; the family requires ${policy.minDistinctDataPoints}.`);
    }
  }

  return {
    templateChars,
    dynamicChars,
    aiChars,
    totalChars,
    templateShare: Number(templateShare.toFixed(3)),
    dynamicShare: Number(dynamicShare.toFixed(3)),
    aiShare: Number(aiShare.toFixed(3)),
    policy,
    withinPolicy,
    policyNotes: notes,
  };
}
