/**
 * Append-only audit trail.
 *
 * Every state-changing action performed by a user, an agent or the system is
 * recorded here. Audit writes are awaited (unlike logs) because "who published
 * this page" must not be best-effort.
 */
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";

export type ActorType = "USER" | "AGENT" | "SYSTEM";

export interface AuditEntry {
  organizationId: string;
  projectId?: string;
  actorType: ActorType;
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ipAddress?: string;
}

export async function audit(entry: AuditEntry) {
  return prisma.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      projectId: entry.projectId,
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metaJson: writeJson(entry.meta ?? {}),
      ipAddress: entry.ipAddress,
    },
  });
}

export async function recentAudit(organizationId: string, limit = 100) {
  return prisma.auditLog.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
