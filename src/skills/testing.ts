/**
 * Skill sandbox.
 *
 * Executes one skill VERSION against a sample input and reports everything an
 * operator needs to judge it: input, version, model, tool permissions, output,
 * validation, confidence, tokens, cost and duration.
 *
 * Safety contract - this is the whole point of a sandbox:
 *  - it runs generation only; no side-effectful tool is ever invoked
 *  - it writes nothing except its own SkillTestRun row and the usage ledger
 *  - it cannot publish, cannot create pages, cannot mutate project data
 *  - it resolves and REPORTS effective tool permissions, but does not exercise
 *    them, so a test can never reach a CMS or a paid data provider by accident
 */
import { prisma } from "@/core/db/client";
import { readStringArray, writeJson } from "@/core/db/json";
import { scopedLogger } from "@/core/logging/logger";
import { describeError } from "@/core/errors";
import { createRouter } from "@/llm/router";
import { renderSingleSkill } from "@/skills/registry";
import { computeEffectiveTools, type ResolvedSkill } from "@/skills/types";
import { validateSkillInput, type ValidationFinding } from "@/skills/validation";
import { recordUsage } from "@/control-plane/budget";

const log = scopedLogger("skills.sandbox");

export interface SkillTestParams {
  skill: ResolvedSkill;
  input: Record<string, unknown>;
  /** Scope tool resolution to this agent, if the test is agent-specific. */
  agentKey?: string;
  testCaseId?: string;
  expectations?: TestExpectation[];
  organizationId: string;
  projectId?: string;
  actorId?: string;
  /** Persist the run. False for the playground's ad-hoc comparisons. */
  persist?: boolean;
}

export interface TestExpectation {
  type: "contains" | "not_contains" | "matches" | "min_words" | "max_words" | "json_field";
  value: string;
}

export interface SkillTestResult {
  id: string | null;
  status: "PASSED" | "FAILED" | "ERROR";
  skillId: string;
  skillKey: string;
  skillName: string;
  versionId: string;
  version: number;
  versionStatus: string;
  agentKey: string | null;
  input: Record<string, unknown>;
  output: string;
  model: string;
  provider: string;
  isMock: boolean;
  toolsRequested: string[];
  effectiveTools: string[];
  deniedTools: string[];
  toolsUsed: string[];
  validation: ValidationFinding[];
  errors: string[];
  confidence: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
}

/** Render the sample input as the user turn the skill will actually receive. */
function buildUserPrompt(skill: ResolvedSkill, input: Record<string, unknown>): string {
  const lines: string[] = ["Perform this skill against the following input."];

  if (Object.keys(input).length) {
    lines.push("", "Input:");
    for (const [k, v] of Object.entries(input)) {
      lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  } else {
    lines.push("", "(no input supplied)");
  }

  const outputs = skill.outputs.length
    ? skill.outputs.map((o) => `  - ${o.name}${o.required ? " (required)" : ""}: ${o.description || o.type}`)
    : Object.entries(skill.outputContract).map(([k, v]) => `  - ${k}: ${v}`);

  if (outputs.length) lines.push("", "Produce output covering:", ...outputs);

  return lines.join("\n");
}

export async function runSkillTest(params: SkillTestParams): Promise<SkillTestResult> {
  const started = Date.now();
  const { skill, input } = params;

  // --- resolve the tool scope this run would have had -----------------------
  let agentTools: string[] = [];
  if (params.agentKey) {
    const agent = await prisma.agent.findUnique({ where: { key: params.agentKey } });
    agentTools = agent ? readStringArray(agent.allowedToolsJson) : [];
  }
  const scope = computeEffectiveTools(agentTools, [skill]);

  // --- validate the sample input against the declared schema ---------------
  const validation: ValidationFinding[] = validateSkillInput(skill.inputs, input);
  const errors: string[] = [];

  let outputText = "";
  let model = "";
  let provider = "";
  let isMock = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  const toolsUsed: string[] = [];
  let status: SkillTestResult["status"] = "PASSED";

  const inputBlocking = validation.some((f) => !f.passed && f.severity === "ERROR");

  if (inputBlocking) {
    status = "FAILED";
    errors.push("Sample input does not satisfy the skill's declared input schema.");
  } else {
    try {
      const router = createRouter({ organizationId: params.organizationId, projectId: params.projectId });
      const guidance = skill.modelGuidance ?? {};

      // Generation only. No tool executor is wired into the sandbox at all.
      const res = await router.complete({
        task: "skill_test",
        tier: guidance.tier,
        temperature: guidance.temperature,
        maxTokens: guidance.maxTokens ?? 900,
        messages: [
          { role: "system", content: renderSingleSkill(skill) },
          { role: "user", content: buildUserPrompt(skill, input) },
        ],
        variables: { input, skill: { name: skill.name, outputs: skill.outputs, outputContract: skill.outputContract } },
      });

      outputText = res.text;
      model = res.model;
      provider = res.provider;
      isMock = res.isMock;
      tokensIn = res.tokensIn;
      tokensOut = res.tokensOut;
      costUsd = res.costUsd;
      toolsUsed.push("llm.generate");

      await recordUsage({
        organizationId: params.organizationId,
        projectId: params.projectId,
        category: "skill_test",
        tokensIn,
        tokensOut,
        costUsd,
      });
    } catch (e) {
      status = "ERROR";
      errors.push(describeError(e));
      log.error("skill test failed", { skill: skill.skillKey, version: skill.versionNumber, error: describeError(e) });
    }
  }

  // --- validate the output --------------------------------------------------
  if (status !== "ERROR") {
    validation.push({
      check: "output_produced",
      passed: outputText.trim().length > 0,
      severity: "ERROR",
      message: outputText.trim().length ? `Produced ${outputText.trim().length} characters` : "The skill produced no output",
    });

    const lowered = outputText.toLowerCase();
    for (const field of skill.outputs.filter((o) => o.required)) {
      const mentioned = lowered.includes(field.name.toLowerCase().replace(/_/g, " ")) || lowered.includes(field.name.toLowerCase());
      validation.push({
        check: `output:${field.name}`,
        passed: mentioned,
        severity: "WARNING",
        message: mentioned
          ? `Required output "${field.name}" is present`
          : `Required output "${field.name}" was not detectable in the response`,
      });
    }

    for (const expectation of params.expectations ?? []) {
      validation.push(evaluateExpectation(expectation, outputText));
    }

    if (scope.deniedTools.length) {
      validation.push({
        check: "tool_permissions",
        passed: false,
        severity: "WARNING",
        message: `Requested but not granted by ${params.agentKey ?? "the selected agent"}: ${scope.deniedTools.join(", ")}. The skill would run without them.`,
      });
    } else if (scope.requestedTools.length) {
      validation.push({
        check: "tool_permissions",
        passed: true,
        severity: "INFO",
        message: params.agentKey
          ? `All ${scope.requestedTools.length} requested tool(s) are granted by ${params.agentKey}`
          : `${scope.requestedTools.length} tool(s) requested; select an agent to resolve effective permissions`,
      });
    }

    const blocking = validation.filter((f) => !f.passed && f.severity === "ERROR");
    if (blocking.length) status = "FAILED";
  }

  const scored = validation.filter((f) => f.severity !== "INFO");
  const passedCount = scored.filter((f) => f.passed).length;
  const confidence = status === "ERROR" ? 0 : scored.length ? Number((passedCount / scored.length).toFixed(2)) : 0.5;

  const durationMs = Date.now() - started;

  let id: string | null = null;
  if (params.persist !== false) {
    const row = await prisma.skillTestRun.create({
      data: {
        skillId: skill.skillId,
        skillVersionId: skill.versionId,
        testCaseId: params.testCaseId,
        agentKey: params.agentKey,
        projectId: params.projectId,
        status,
        inputJson: writeJson(input),
        outputText: outputText.slice(0, 12000),
        model,
        provider,
        toolsRequestedJson: writeJson(scope.requestedTools),
        effectiveToolsJson: writeJson(scope.effectiveTools),
        toolsUsedJson: writeJson(toolsUsed),
        validationJson: writeJson(validation),
        errorsJson: writeJson(errors),
        confidence,
        tokensIn,
        tokensOut,
        costUsd,
        durationMs,
        isMock,
        createdBy: params.actorId,
      },
    });
    id = row.id;
  }

  log.info("skill test complete", {
    projectId: params.projectId,
    skill: skill.skillKey,
    version: skill.versionNumber,
    status,
    durationMs,
  });

  return {
    id,
    status,
    skillId: skill.skillId,
    skillKey: skill.skillKey,
    skillName: skill.name,
    versionId: skill.versionId,
    version: skill.versionNumber,
    versionStatus: skill.versionStatus,
    agentKey: params.agentKey ?? null,
    input,
    output: outputText,
    model,
    provider,
    isMock,
    toolsRequested: scope.requestedTools,
    effectiveTools: scope.effectiveTools,
    deniedTools: scope.deniedTools,
    toolsUsed,
    validation,
    errors,
    confidence,
    tokensIn,
    tokensOut,
    costUsd,
    durationMs,
  };
}

function evaluateExpectation(expectation: TestExpectation, output: string): ValidationFinding {
  const text = output.toLowerCase();
  const value = expectation.value;

  switch (expectation.type) {
    case "contains": {
      const passed = text.includes(value.toLowerCase());
      return { check: `expect:contains`, passed, severity: "ERROR", message: passed ? `Contains "${value}"` : `Expected the output to contain "${value}"` };
    }
    case "not_contains": {
      const passed = !text.includes(value.toLowerCase());
      return {
        check: `expect:not_contains`,
        passed,
        severity: "ERROR",
        message: passed ? `Does not contain "${value}"` : `Output contains "${value}", which it must not`,
      };
    }
    case "matches": {
      let passed = false;
      try {
        passed = new RegExp(value, "i").test(output);
      } catch {
        return { check: "expect:matches", passed: false, severity: "ERROR", message: `"${value}" is not a valid regular expression` };
      }
      return { check: "expect:matches", passed, severity: "ERROR", message: passed ? `Matches /${value}/i` : `Expected the output to match /${value}/i` };
    }
    case "min_words": {
      const words = output.trim().split(/\s+/).filter(Boolean).length;
      const min = Number(value);
      return {
        check: "expect:min_words",
        passed: words >= min,
        severity: "ERROR",
        message: words >= min ? `${words} words (min ${min})` : `Only ${words} words, expected at least ${min}`,
      };
    }
    case "max_words": {
      const words = output.trim().split(/\s+/).filter(Boolean).length;
      const max = Number(value);
      return {
        check: "expect:max_words",
        passed: words <= max,
        severity: "ERROR",
        message: words <= max ? `${words} words (max ${max})` : `${words} words, expected at most ${max}`,
      };
    }
    case "json_field": {
      try {
        const match = output.match(/\{[\s\S]*\}/);
        const parsed = match ? JSON.parse(match[0]) : null;
        const passed = Boolean(parsed && Object.prototype.hasOwnProperty.call(parsed, value));
        return {
          check: "expect:json_field",
          passed,
          severity: "ERROR",
          message: passed ? `JSON output has field "${value}"` : `Expected a JSON object with field "${value}"`,
        };
      } catch {
        return { check: "expect:json_field", passed: false, severity: "ERROR", message: `Output is not parseable JSON` };
      }
    }
    default:
      return { check: "expect:unknown", passed: true, severity: "INFO", message: "Unknown expectation type, skipped" };
  }
}
