/**
 * Route-handler helpers.
 *
 * Centralises error shaping, auth, rate limiting and tenant resolution so route
 * files stay thin and every endpoint fails the same, legible way.
 */
import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import { toAppError } from "@/core/errors";
import { requireAuth, requirePermission, type AuthContext } from "@/core/security/auth";
import type { UserPermission } from "@/core/security/rbac";
import { assertRateLimit } from "@/control-plane/budget";
import { prisma } from "@/core/db/client";
import { scopedLogger } from "@/core/logging/logger";

const log = scopedLogger("api");

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data as Record<string, unknown>, { status });
}

export function fail(e: unknown) {
  if (e instanceof ZodError) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "Invalid request body", details: e.flatten() } }, { status: 422 });
  }
  const err = toAppError(e);
  if (err.status >= 500) log.error("unhandled api error", { code: err.code, message: err.message });
  return NextResponse.json(err.toJSON(), { status: err.status });
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const json = await req.json().catch(() => ({}));
  return schema.parse(json);
}

/** Guard a mutating endpoint: auth + permission + per-user rate limit. */
export async function guard(permission: UserPermission, limit = 60): Promise<AuthContext> {
  const auth = await requirePermission(permission);
  assertRateLimit({ key: `${auth.userId}:${permission}`, limit, windowMs: 60_000 });
  return auth;
}

export async function guardRead(): Promise<AuthContext> {
  return requireAuth();
}

/** The caller's active project. Every console query is scoped through this. */
export async function activeProject(auth: AuthContext) {
  const project = await prisma.project.findFirst({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: "asc" },
  });
  if (!project) throw toAppError(new Error("No project exists in this organization"));
  return project;
}
