/**
 * Role-based access control for human users.
 *
 * Distinct from the agent Control Plane: this governs what a *person* may do
 * through the dashboard/API. Agent capabilities live in src/control-plane.
 */
import { ForbiddenError } from "@/core/errors";
import type { Role } from "@/core/types/enums";

export type UserPermission =
  | "project:read"
  | "project:write"
  | "project:delete"
  | "brand:write"
  | "integration:read"
  | "integration:write"
  | "agent:read"
  | "agent:configure"
  | "task:read"
  | "task:run"
  | "content:read"
  | "content:write"
  | "approval:read"
  | "approval:decide"
  | "publish:execute"
  | "settings:write"
  | "org:manage";

const MATRIX: Record<Role, UserPermission[]> = {
  OWNER: [
    "project:read",
    "project:write",
    "project:delete",
    "brand:write",
    "integration:read",
    "integration:write",
    "agent:read",
    "agent:configure",
    "task:read",
    "task:run",
    "content:read",
    "content:write",
    "approval:read",
    "approval:decide",
    "publish:execute",
    "settings:write",
    "org:manage",
  ],
  ADMIN: [
    "project:read",
    "project:write",
    "brand:write",
    "integration:read",
    "integration:write",
    "agent:read",
    "agent:configure",
    "task:read",
    "task:run",
    "content:read",
    "content:write",
    "approval:read",
    "approval:decide",
    "publish:execute",
    "settings:write",
  ],
  EDITOR: [
    "project:read",
    "brand:write",
    "integration:read",
    "agent:read",
    "task:read",
    "task:run",
    "content:read",
    "content:write",
    "approval:read",
  ],
  VIEWER: ["project:read", "integration:read", "agent:read", "task:read", "content:read", "approval:read"],
};

export function roleHas(role: Role, permission: UserPermission): boolean {
  return MATRIX[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: Role): UserPermission[] {
  return [...(MATRIX[role] ?? [])];
}

export function assertPermission(role: Role, permission: UserPermission): void {
  if (!roleHas(role, permission)) {
    throw new ForbiddenError(`Role ${role} lacks permission "${permission}"`, { role, permission });
  }
}

export const ROLE_ORDER: Role[] = ["VIEWER", "EDITOR", "ADMIN", "OWNER"];

export function atLeast(role: Role, minimum: Role): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum);
}
