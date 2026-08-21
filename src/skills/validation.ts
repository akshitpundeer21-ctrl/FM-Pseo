/**
 * Skill configuration validation.
 *
 * Runs before a version may be activated. Errors block activation; warnings are
 * shown but do not. The checks are deliberately concrete - a validator that only
 * says "looks fine" is worth nothing at an approval gate.
 */
import { listTools } from "@/tools/registry";
import "@/tools/definitions";
import type { SkillIoField, SkillVersionConfig } from "@/skills/types";

export interface ValidationFinding {
  check: string;
  passed: boolean;
  severity: "ERROR" | "WARNING" | "INFO";
  message: string;
}

export interface ValidationReport {
  findings: ValidationFinding[];
  errors: number;
  warnings: number;
  valid: boolean;
}

function ioFieldFindings(fields: SkillIoField[], label: string): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const names = fields.map((f) => f.name.trim().toLowerCase());
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);

  out.push({
    check: `${label}_unique_names`,
    passed: duplicates.length === 0,
    severity: "ERROR",
    message: duplicates.length ? `Duplicate ${label} field name(s): ${[...new Set(duplicates)].join(", ")}` : `${label} field names are unique`,
  });

  const unnamed = fields.filter((f) => !f.name.trim());
  out.push({
    check: `${label}_named`,
    passed: unnamed.length === 0,
    severity: "ERROR",
    message: unnamed.length ? `${unnamed.length} ${label} field(s) have no name` : `Every ${label} field is named`,
  });

  const badEnum = fields.filter((f) => f.type === "enum" && !(f.enumValues ?? []).length);
  out.push({
    check: `${label}_enum_values`,
    passed: badEnum.length === 0,
    severity: "ERROR",
    message: badEnum.length
      ? `Enum field(s) with no permitted values: ${badEnum.map((f) => f.name).join(", ")}`
      : `Enum fields declare their permitted values`,
  });

  const undocumented = fields.filter((f) => !f.description.trim());
  if (fields.length) {
    out.push({
      check: `${label}_documented`,
      passed: undocumented.length === 0,
      severity: "WARNING",
      message: undocumented.length
        ? `${undocumented.length} ${label} field(s) have no description: ${undocumented.map((f) => f.name).join(", ")}`
        : `Every ${label} field is described`,
    });
  }

  return out;
}

/**
 * Validate a version's configuration.
 *
 * `agentAllowlists` (agentKey -> allowed tools) lets the validator report a tool
 * the skill asks for that none of its assigned agents can actually provide -
 * which is not an error (a skill may be assigned elsewhere later) but is almost
 * always a mistake worth surfacing.
 */
export function validateSkillConfig(
  config: SkillVersionConfig,
  agentAllowlists: Record<string, string[]> = {},
): ValidationReport {
  const findings: ValidationFinding[] = [];

  // --- instructions --------------------------------------------------------
  const instructions = config.instructions.trim();
  findings.push({
    check: "instructions_present",
    passed: instructions.length > 0,
    severity: "ERROR",
    message: instructions.length ? "Instructions are present" : "Instructions are empty - the agent would receive nothing",
  });
  findings.push({
    check: "instructions_substantive",
    passed: instructions.length >= 60,
    severity: "WARNING",
    message:
      instructions.length >= 60
        ? `Instructions are ${instructions.length} characters`
        : `Instructions are only ${instructions.length} characters - too thin to steer an agent`,
  });

  // --- procedure and rules -------------------------------------------------
  findings.push({
    check: "methodology_present",
    passed: config.methodology.length > 0,
    severity: "WARNING",
    message: config.methodology.length ? `${config.methodology.length} procedure step(s)` : "No procedure steps defined",
  });
  findings.push({
    check: "constraints_present",
    passed: config.constraints.length > 0,
    severity: "WARNING",
    message: config.constraints.length
      ? `${config.constraints.length} hard rule(s)`
      : "No hard rules - nothing for validation to enforce",
  });

  // --- schemas -------------------------------------------------------------
  findings.push(...ioFieldFindings(config.inputs, "input"));
  findings.push(...ioFieldFindings(config.outputs, "output"));

  const hasOutputContract = config.outputs.length > 0 || Object.keys(config.outputContract).length > 0;
  findings.push({
    check: "output_defined",
    passed: hasOutputContract,
    severity: "ERROR",
    message: hasOutputContract ? "The expected output is defined" : "No output fields or output contract - nothing can be validated",
  });

  if (config.outputs.length) {
    const required = config.outputs.filter((o) => o.required);
    findings.push({
      check: "output_required_fields",
      passed: required.length > 0,
      severity: "WARNING",
      message: required.length ? `${required.length} required output field(s)` : "No output field is marked required",
    });
  }

  // --- tools ---------------------------------------------------------------
  const registered = new Set(listTools().map((t) => t.key));
  const unknown = config.allowedTools.filter((t) => !registered.has(t));
  findings.push({
    check: "tools_exist",
    passed: unknown.length === 0,
    severity: "ERROR",
    message: unknown.length
      ? `Requests tool(s) that are not in the registry: ${unknown.join(", ")}`
      : config.allowedTools.length
        ? `All ${config.allowedTools.length} requested tool(s) exist`
        : "No tools requested - the agent's own allowlist applies unchanged",
  });

  const agentKeys = Object.keys(agentAllowlists);
  if (config.allowedTools.length && agentKeys.length) {
    const grantableAnywhere = new Set(agentKeys.flatMap((k) => agentAllowlists[k]));
    const ungrantable = config.allowedTools.filter((t) => !grantableAnywhere.has(t) && !grantableAnywhere.has("*"));
    findings.push({
      check: "tools_grantable",
      passed: ungrantable.length === 0,
      severity: "WARNING",
      message: ungrantable.length
        ? `No assigned agent can grant: ${ungrantable.join(", ")} - the skill will run without them`
        : "Every requested tool can be granted by at least one assigned agent",
    });
  }

  // --- examples ------------------------------------------------------------
  const emptyExamples = config.examples.filter((e) => !e.expectedOutput.trim());
  if (config.examples.length) {
    findings.push({
      check: "examples_complete",
      passed: emptyExamples.length === 0,
      severity: "WARNING",
      message: emptyExamples.length
        ? `${emptyExamples.length} example(s) have no expected output`
        : `${config.examples.length} worked example(s)`,
    });
  }

  // --- safety --------------------------------------------------------------
  // A skill must never carry a credential. This is a hard block.
  const secretPattern =
    /\b(sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*\S{8,}|bearer\s+[A-Za-z0-9._-]{16,}|password\s*[:=]\s*\S{6,})/i;
  const scanned = [
    config.instructions,
    ...config.methodology,
    ...config.constraints,
    ...config.safetyRules,
    ...config.businessRules,
    ...config.qualityCriteria,
    ...config.examples.map((e) => `${e.expectedOutput} ${JSON.stringify(e.input)}`),
  ].join("\n");
  const secretHit = scanned.match(secretPattern);
  findings.push({
    check: "no_embedded_secrets",
    passed: !secretHit,
    severity: "ERROR",
    message: secretHit
      ? `Configuration appears to contain a credential ("${secretHit[0].slice(0, 24)}…"). Credentials belong in Integrations, never in a skill.`
      : "No credential-shaped strings in the configuration",
  });

  const errors = findings.filter((f) => !f.passed && f.severity === "ERROR").length;
  const warnings = findings.filter((f) => !f.passed && f.severity === "WARNING").length;

  return { findings, errors, warnings, valid: errors === 0 };
}

/** Validate a sample input against a version's declared input schema. */
export function validateSkillInput(inputs: SkillIoField[], value: Record<string, unknown>): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const field of inputs) {
    const provided = value[field.name];
    const missing = provided === undefined || provided === null || provided === "";

    if (field.required && missing) {
      findings.push({
        check: `input:${field.name}`,
        passed: false,
        severity: "ERROR",
        message: `Required input "${field.name}" was not provided`,
      });
      continue;
    }
    if (missing) continue;

    const typeOk = matchesType(provided, field);
    findings.push({
      check: `input:${field.name}`,
      passed: typeOk,
      severity: typeOk ? "INFO" : "ERROR",
      message: typeOk
        ? `"${field.name}" accepted as ${field.type}`
        : `"${field.name}" should be ${field.type}${field.type === "enum" ? ` (one of ${(field.enumValues ?? []).join(", ")})` : ""}, received ${typeof provided}`,
    });
  }

  const declared = new Set(inputs.map((f) => f.name));
  const extra = Object.keys(value).filter((k) => !declared.has(k));
  if (extra.length && inputs.length) {
    findings.push({
      check: "input_undeclared",
      passed: true,
      severity: "WARNING",
      message: `Undeclared input(s) supplied and ignored by validation: ${extra.join(", ")}`,
    });
  }

  return findings;
}

function matchesType(value: unknown, field: SkillIoField): boolean {
  switch (field.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" ? Number.isFinite(value) : Number.isFinite(Number(value));
    case "boolean":
      return typeof value === "boolean" || value === "true" || value === "false";
    case "url":
      if (typeof value !== "string") return false;
      try {
        new URL(value.startsWith("http") ? value : `https://${value}`);
        return true;
      } catch {
        return false;
      }
    case "enum":
      return (field.enumValues ?? []).includes(String(value));
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}
