import { z } from "zod";
import { cookies } from "next/headers";
import { login, SESSION_COOKIE } from "@/core/security/auth";
import { fail, ok, parseBody } from "@/app/api/_lib/handler";
import { assertRateLimit } from "@/control-plane/budget";
import { audit } from "@/control-plane/audit";
import { prisma } from "@/core/db/client";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const body = await parseBody(req, Body);
    // Brute-force guard, keyed by email + client address.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    assertRateLimit({ key: `login:${body.email}:${ip}`, limit: 10, windowMs: 60_000 });

    const result = await login(body.email, body.password, { userAgent: req.headers.get("user-agent") ?? undefined, ip });

    const store = await cookies();
    store.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: result.maxAgeSeconds,
    });

    const membership = await prisma.membership.findFirst({ where: { userId: result.user.id } });
    if (membership) {
      await audit({
        organizationId: membership.organizationId,
        actorType: "USER",
        actorId: result.user.id,
        action: "auth.login",
        entityType: "USER",
        entityId: result.user.id,
        ipAddress: ip,
      });
    }

    return ok({ ok: true, user: { id: result.user.id, email: result.user.email, name: result.user.name } });
  } catch (e) {
    return fail(e);
  }
}
