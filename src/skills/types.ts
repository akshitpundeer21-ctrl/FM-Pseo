/**
 * Skill management contracts + the version lifecycle state machine.
 *
 * A Skill is an identity. A SkillVersion is an immutable snapshot of its
 * configuration. Agents resolve to a version, never to "the skill", which is
 * what makes a historical run reproducible.
 */
import { z } from "zod";

// --- lifecycle -------------------------------------------------------------

export const SKILL_VERSION_STATUSES = ["DRAFT", "TESTING", "READY", "ACTIVE", "ARCHIVED"] as const;
export const SkillVersionStatusSchema = z.enum(SKILL_VERSION_STATUSES);
export type SkillVersionStatus = (typeof SKILL_VERSION_STATUSES)[number];

export const SkillStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

/**
 * Permitted transitions.
 *
 *   DRAFT -> TESTING -> READY -> ACTIVE -> ARCHIVED
 *
 * plus ARCHIVED -> ACTIVE (rollback) and TESTING/READY -> DRAFT (reopen for
 * editing). ACTIVE -> DRAFT is deliberately absent: an active version is
 * immutable, so changing it means creating a NEW draft version.
 */
export const VERSION_TRANSITIONS: Record<SkillVersionStatus, SkillVersionStatus[]> = {
  DRAFT: ["TESTING", "ARCHIVED"],
  TESTING: ["READY", "DRAFT", "ARCHIVED"],
  READY: ["ACTIVE", "DRAFT", "ARCHIVED"],
  ACTIVE: ["ARCHIVED"],
  ARCHIVED: ["ACTIVE"],
};

export function canTransition(from: SkillVersionStatus, to: SkillVersionStatus): boolean {
  return VERSION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionError(from: SkillVersionStatus, to: SkillVersionStatus): string {
  const allowed = VERSION_TRANSITIONS[from] ?? [];
  return allowed.length
    ? `Cannot move a version from ${from} to ${to}. Allowed from ${from}: ${allowed.join(", ")}.`
    : `A version in ${from} cannot be transitioned.`;
}

/** Only a DRAFT may be edited. Everything else is frozen. */
export function isEditable(status: string): boolean {
  return status === "DRAFT";
}

// --- configuration shapes --------------------------------------------------

export const IO_TYPES = ["string", "number", "boolean", "url", "enum", "array", "object"] as const;
export const IoTypeSchema = z.enum(IO_TYPES);
export type IoType = (typeof IO_TYPES)[number];

export const SkillIoFieldSchema = z.object({
  name: z.string().min(1).max(60),
  type: IoTypeSchema,
  required: z.boolean(),
  description: z.string().max(400).default(""),
  /** Human-readable rule, e.g. "3-letter IATA code". Also used by the sandbox. */
  validation: z.string().max(200).optional(),
  enumValues: z.array(z.string()).optional(),
});
export type SkillIoField = z.infer<typeof SkillIoFieldSchema>;

export const SkillExampleSchema = z.object({
  name: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).default({}),
  expectedOutput: z.string().max(4000).default(""),
  notes: z.string().max(500).optional(),
});
export type SkillExample = z.infer<typeof SkillExampleSchema>;

export const SkillModelGuidanceSchema = z.object({
  tier: z.enum(["fast", "balanced", "deep"]).optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(64).max(8000).optional(),
  notes: z.string().max(1000).optional(),
});
export type SkillModelGuidance = z.infer<typeof SkillModelGuidanceSchema>;

/** Everything an operator can edit on a draft version. */
export const SkillVersionConfigSchema = z.object({
  instructions: z.string().min(1).max(20000),
  methodology: z.array(z.string().max(600)).max(40).default([]),
  constraints: z.array(z.string().max(600)).max(40).default([]),
  qualityCriteria: z.array(z.string().max(600)).max(40).default([]),
  safetyRules: z.array(z.string().max(600)).max(40).default([]),
  businessRules: z.array(z.string().max(600)).max(40).default([]),
  inputs: z.array(SkillIoFieldSchema).max(40).default([]),
  outputs: z.array(SkillIoFieldSchema).max(40).default([]),
  outputContract: z.record(z.string(), z.string()).default({}),
  examples: z.array(SkillExampleSchema).max(20).default([]),
  /** Tools the skill REQUESTS. Intersected with the agent's allowlist at runtime. */
  allowedTools: z.array(z.string().max(80)).max(40).default([]),
  modelGuidance: SkillModelGuidanceSchema.default({}),
});
export type SkillVersionConfig = z.infer<typeof SkillVersionConfigSchema>;

export const EMPTY_CONFIG: SkillVersionConfig = {
  instructions: "",
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
};

// --- resolved runtime shape ------------------------------------------------

/**
 * What the runtime actually loads: an assignment resolved all the way down to a
 * concrete, immutable version.
 */
export interface ResolvedSkill extends SkillVersionConfig {
  skillId: string;
  skillKey: string;
  name: string;
  category: string;
  description: string;
  versionId: string;
  versionNumber: number;
  versionStatus: SkillVersionStatus;
  priority: number;
  /** True when the assignment pins this version rather than following active. */
  pinned: boolean;
}

/** The record written onto every AgentRun, for reproducibility. */
export interface SkillUsageRecord {
  skillId: string;
  skillKey: string;
  name: string;
  versionId: string;
  version: number;
  versionStatus: string;
  pinned: boolean;
}

export function toUsageRecord(skill: ResolvedSkill): SkillUsageRecord {
  return {
    skillId: skill.skillId,
    skillKey: skill.skillKey,
    name: skill.name,
    versionId: skill.versionId,
    version: skill.versionNumber,
    versionStatus: skill.versionStatus,
    pinned: skill.pinned,
  };
}

// --- tool scoping ----------------------------------------------------------

export interface EffectiveToolScope {
  /** Tools the agent is permitted to use. */
  agentTools: string[];
  /** Union of everything the resolved skills asked for. */
  requestedTools: string[];
  /** What the run may actually reach. */
  effectiveTools: string[];
  /** Requested but not granted, because the agent does not hold them. */
  deniedTools: string[];
  /** True when narrowing is in force for this run. */
  narrowed: boolean;
  /**
   * Set when skills declared tools but none of them are held by this agent, so
   * narrowing was not applied. A configuration smell worth surfacing, not a
   * permission change the operator intended.
   */
  narrowingSkippedReason?: string;
}

/**
 * The one function that decides what a run may touch.
 *
 * The guarantee, in order of precedence:
 *
 *  1. A skill can NEVER widen. A tool the agent does not hold is reported as
 *     denied and is never granted, whatever the skill asks for.
 *  2. Where a skill's declarations overlap the agent's allowlist, they narrow
 *     the run to that overlap.
 *  3. Where they do not overlap at all, narrowing is skipped and the reason is
 *     recorded. An empty intersection means the declarations describe a
 *     different agent's context - a skill attached for its methodology, not for
 *     its tools - and silently revoking every tool the agent holds would break
 *     the agent rather than protect anything. The ceiling in (1) is unaffected.
 */
export function computeEffectiveTools(agentTools: string[], skills: { allowedTools: string[] }[]): EffectiveToolScope {
  const requested = [...new Set(skills.flatMap((s) => s.allowedTools).filter(Boolean))];
  const wildcard = agentTools.includes("*");

  if (!requested.length) {
    return { agentTools, requestedTools: [], effectiveTools: agentTools, deniedTools: [], narrowed: false };
  }

  const granted = wildcard ? requested : requested.filter((t) => agentTools.includes(t));
  const denied = wildcard ? [] : requested.filter((t) => !agentTools.includes(t));

  if (!granted.length && agentTools.length) {
    return {
      agentTools,
      requestedTools: requested,
      effectiveTools: agentTools,
      deniedTools: denied,
      narrowed: false,
      narrowingSkippedReason: `No requested tool (${requested.join(", ")}) is on this agent's allowlist, so the declarations do not apply to it. The agent's own allowlist stands; nothing was granted that it did not already hold.`,
    };
  }

  return { agentTools, requestedTools: requested, effectiveTools: granted, deniedTools: denied, narrowed: true };
}
