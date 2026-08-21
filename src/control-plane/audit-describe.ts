/**
 * Turns an audit row into the sentence a person would say.
 *
 * "Alex activated SEO Keyword Research v3." reads better in an incident review
 * than `skill.activated / SKILL_VERSION / cmt31x…`, and the raw row is still
 * there underneath for anyone who needs it.
 */
import { readRecord } from "@/core/db/json";

export interface AuditRowLike {
  action: string;
  actorType: string;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  metaJson: string;
}

export function describeAuditEvent(row: AuditRowLike, actorNames: Record<string, string> = {}): string {
  const meta = readRecord(row.metaJson);
  const actor =
    (meta.actorName as string) ||
    (row.actorId ? actorNames[row.actorId] : undefined) ||
    (row.actorType === "AGENT" ? (row.actorId ?? "An agent") : row.actorType === "SYSTEM" ? "The system" : "Someone");

  const skill = (meta.skillName as string) || (meta.skillKey as string) || "a skill";
  const version = meta.version !== undefined && meta.version !== null ? `v${meta.version}` : "";
  const agent = (meta.agentName as string) || (meta.agentKey as string) || "an agent";

  switch (row.action) {
    case "skill.created":
      return `${actor} created ${skill} ${version}.`;
    case "skill.duplicated":
      return `${actor} duplicated ${meta.sourceSkill ?? "a skill"} into ${meta.newSkill ?? skill}.`;
    case "skill.updated":
      return `${actor} edited the details of ${skill}.`;
    case "skill.status_changed":
      return `${actor} set ${skill} to ${(meta.newState as { status?: string })?.status ?? "a new status"}.`;
    case "skill.version_created":
      return `${actor} created ${skill} ${version}${meta.basedOn ? ` based on v${meta.basedOn}` : ""}.`;
    case "skill.version_updated": {
      const fields = Array.isArray(meta.changedFields) ? (meta.changedFields as string[]) : [];
      return `${actor} edited ${skill} ${version}${fields.length ? ` (${fields.slice(0, 4).join(", ")})` : ""}.`;
    }
    case "skill.version_transitioned":
      return `${actor} moved ${skill} ${version} from ${meta.previousState} to ${meta.newState}.`;
    case "skill.activated":
      return `${actor} activated ${skill} ${version}${meta.previousVersion ? `, archiving v${meta.previousVersion}` : ""}.`;
    case "skill.rolled_back":
      return `${actor} rolled back ${skill}${meta.previousVersion ? ` from v${meta.previousVersion}` : ""} to ${version}.`;
    case "skill.assigned":
      return `${actor} assigned ${skill} to ${agent}.`;
    case "skill.unassigned":
      return `${actor} removed ${skill} from ${agent}.`;
    case "skill.assignment_updated":
      return `${actor} updated the ${skill} assignment on ${agent}.`;
    case "skill.version_pinned":
      return `${actor} pinned ${agent} to ${skill} ${meta.newState}.`;
    case "skill.version_unpinned":
      return `${actor} set ${agent} to follow the active version of ${skill}.`;
    case "skill.tested":
      return `${actor} tested ${skill} ${version} — ${meta.newState}${meta.comparedWith ? ` (compared with v${meta.comparedWith})` : ""}.`;

    // Non-skill actions already read well enough; give them a light touch.
    case "page.published":
      return `${actor} published ${meta.url ?? "a page"}.`;
    case "page.rolled_back":
      return `${actor} rolled back ${meta.url ?? "a page"} to v${meta.to}.`;
    case "page.unpublished":
      return `${actor} unpublished ${meta.url ?? "a page"}.`;
    case "approval.requested":
      return `${actor} requested approval: ${meta.title ?? row.entityType}.`;
    case "approval.approved":
      return `${actor} approved ${meta.title ?? row.entityType}.`;
    case "approval.rejected":
      return `${actor} rejected ${meta.title ?? row.entityType}.`;
    case "workflow.started":
      return `${actor} started the ${meta.workflow ?? "workflow"} for "${meta.objective ?? ""}".`;
    case "integration.configured":
      return `${actor} configured the ${row.entityId} integration.`;
    case "brand.updated":
      return `${actor} updated the brand profile.`;
    case "settings.updated":
      return `${actor} changed project settings.`;
    case "auth.login":
      return `${actor} signed in.`;
    default:
      return `${actor} performed ${row.action}${row.entityType ? ` on ${row.entityType.toLowerCase().replace(/_/g, " ")}` : ""}.`;
  }
}

/** True for actions that belong on a skill's own history timeline. */
export function isSkillAuditAction(action: string): boolean {
  return action.startsWith("skill.");
}
