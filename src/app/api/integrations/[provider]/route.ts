/**
 * Per-provider integration actions.
 *
 * POST /api/integrations/:provider  { action: "test" | "disconnect" | "enable" }
 *
 * Added alongside the existing /api/integrations routes rather than changing
 * them: POST there stores credentials and DELETE there removes a single key,
 * and the shipped dashboard depends on both contracts exactly as they are.
 *
 * Nothing here returns a credential. A test result carries a scrubbed message
 * and non-secret detail only.
 */
import { z } from "zod";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import {
  disconnectIntegration,
  enableIntegration,
  listIntegrations,
  recordConnectionTest,
} from "@/integrations/service";
import { testConnection } from "@/integrations/testers";
import { findIntegration } from "@/integrations/catalog";
import { audit } from "@/control-plane/audit";
import { NotFoundError } from "@/core/errors";

const Body = z.object({ action: z.enum(["test", "disconnect", "enable"]) });

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await params;
    if (!findIntegration(provider)) throw new NotFoundError("Integration provider", provider);

    // Testing reaches an external service and disconnecting destroys stored
    // secrets, so both sit behind integration:write, not integration:read.
    const auth = await guard("integration:write", 20);
    const body = await parseBody(req, Body);
    const project = await activeProject(auth);

    if (body.action === "test") {
      const result = await testConnection(auth.organizationId, provider);
      await recordConnectionTest(auth.organizationId, provider, result);
      await audit({
        organizationId: auth.organizationId,
        projectId: project.id,
        actorType: "USER",
        actorId: auth.userId,
        action: "integration.tested",
        entityType: "INTEGRATION",
        entityId: provider,
        meta: { outcome: result.outcome, durationMs: result.durationMs },
      });
      return ok({ result });
    }

    if (body.action === "disconnect") {
      // No projectId: the connect route stores credentials org-wide
      // (setCredential is called without one), so disconnect must clear the
      // same row rather than a project-scoped one that was never written.
      const { removedCredentials } = await disconnectIntegration(auth.organizationId, provider);
      await audit({
        organizationId: auth.organizationId,
        projectId: project.id,
        actorType: "USER",
        actorId: auth.userId,
        action: "integration.disconnected",
        entityType: "INTEGRATION",
        entityId: provider,
        meta: { removedCredentials },
      });
      const integrations = await listIntegrations(auth.organizationId, project.id);
      return ok({ ok: true, removedCredentials, integration: integrations.find((i) => i.provider === provider) });
    }

    await enableIntegration(auth.organizationId, provider);
    await audit({
      organizationId: auth.organizationId,
      projectId: project.id,
      actorType: "USER",
      actorId: auth.userId,
      action: "integration.enabled",
      entityType: "INTEGRATION",
      entityId: provider,
    });
    const integrations = await listIntegrations(auth.organizationId, project.id);
    return ok({ ok: true, integration: integrations.find((i) => i.provider === provider) });
  } catch (e) {
    return fail(e);
  }
}
