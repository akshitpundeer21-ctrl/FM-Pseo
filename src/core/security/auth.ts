/**
 * Session authentication + tenant resolution. SERVER ONLY.
 *
 * Sessions are opaque random tokens in an httpOnly cookie. Only an HMAC of the
 * token is stored, so a database leak cannot be replayed as a login.
 */
import { cookies } from "next/headers";
import { prisma } from "@/core/db/client";
import { env } from "@/core/config/env";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "@/core/security/crypto";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "@/core/errors";
import { RoleSchema, type Role } from "@/core/types/enums";
import { assertPermission, type UserPermission } from "@/core/security/rbac";

export const SESSION_COOKIE = "fm_session";

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName: string;
  role: Role;
}

export async function registerUser(params: {
  email: string;
  name: string;
  password: string;
  organizationId: string;
  role?: Role;
}) {
  const email = params.email.trim().toLowerCase();
  if (!email.includes("@")) throw new ValidationError("A valid email address is required");
  if (params.password.length < 8) throw new ValidationError("Password must be at least 8 characters");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ValidationError("A user with that email already exists");

  const { hash, salt } = hashPassword(params.password);
  const user = await prisma.user.create({
    data: { email, name: params.name, passwordHash: hash, passwordSalt: salt },
  });
  await prisma.membership.create({
    data: { userId: user.id, organizationId: params.organizationId, role: params.role ?? "ADMIN" },
  });
  return user;
}

/** Verify credentials and create a session row. Returns the raw token. */
export async function login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user || !user.isActive) throw new UnauthenticatedError("Invalid email or password");
  if (!verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    throw new UnauthenticatedError("Invalid email or password");
  }

  const token = newSessionToken();
  const ttlHours = env().SESSION_TTL_HOURS;
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      userAgent: meta?.userAgent?.slice(0, 250),
      ipAddress: meta?.ip,
      expiresAt: new Date(Date.now() + ttlHours * 3600_000),
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { token, user, maxAgeSeconds: ttlHours * 3600 };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Resolve the caller from the session cookie. Returns null when signed out. */
export async function currentAuth(): Promise<AuthContext | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token ? authFromToken(token) : null;
}

export async function authFromToken(token: string): Promise<AuthContext | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { memberships: { include: { organization: true } } } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  const membership = session.user.memberships[0];
  if (!membership) return null;

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    organizationId: membership.organizationId,
    organizationName: membership.organization.name,
    role: RoleSchema.catch("VIEWER").parse(membership.role),
  };
}

export async function requireAuth(): Promise<AuthContext> {
  const auth = await currentAuth();
  if (!auth) throw new UnauthenticatedError();
  return auth;
}

export async function requirePermission(permission: UserPermission): Promise<AuthContext> {
  const auth = await requireAuth();
  assertPermission(auth.role, permission);
  return auth;
}

/** Tenant isolation: every project lookup must go through this. */
export async function assertProjectAccess(auth: AuthContext, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
  if (!project) throw new ForbiddenError("Project not found in your organization");
  if (project.organizationId !== auth.organizationId) {
    throw new ForbiddenError("Project belongs to a different organization");
  }
}
