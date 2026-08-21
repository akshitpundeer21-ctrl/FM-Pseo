/**
 * Integration credentials.
 *
 * POST stores an encrypted credential or a non-secret setting. The plaintext is
 * never echoed back - the response contains only a display hint.
 * DELETE removes a stored credential.
 */
import { z } from "zod";
import { fail, guard, ok, parseBody, activeProject } from "@/app/api/_lib/handler";
import { deleteCredential, listIntegrations, setCredential, setIntegrationSettings } from "@/integrations/service";
import { audit } from "@/control-plane/audit";

const Body = z.object({
  provider: z.string().min(1),
  credentials: z.record(z.string(), z.string()).optional(),
  settings: z.record(z.string(), z.string()).optional(),
});

export async function POST(req: Request) {
  try {
    const auth = await guard("integration:write", 30);
    const body = await parseBody(req, Body);
    const project = await activeProject(auth);

    for (const [key, value] of Object.entries(body.credentials ?? {})) {
      if (!value.trim()) continue;
      await setCredential({
        organizationId: auth.organizationId,
        provider: body.provider,
        key,
        value,
        actorId: auth.userId,
      });
    }

    if (body.settings && Object.keys(body.settings).length) {
      await setIntegrationSettings(auth.organizationId, body.provider, body.settings);
    }

    await audit({
      organizationId: auth.organizationId,
      projectId: project.id,
      actorType: "USER",
      actorId: auth.userId,
      action: "integration.configured",
      entityType: "INTEGRATION",
      entityId: body.provider,
      meta: { keys: Object.keys(body.credentials ?? {}), settings: Object.keys(body.settings ?? {}) },
    });

    const integrations = await listIntegrations(auth.organizationId, project.id);
    return ok({ ok: true, integration: integrations.find((i) => i.provider === body.provider) });
  } catch (e) {
    return fail(e);
  }
}

const DeleteBody = z.object({ provider: z.string(), key: z.string() });

export async function DELETE(req: Request) {
  try {
    const auth = await guard("integration:write", 30);
    const body = await parseBody(req, DeleteBody);
    await deleteCredential(auth.organizationId, body.provider, body.key);
    await audit({
      organizationId: auth.organizationId,
      actorType: "USER",
      actorId: auth.userId,
      action: "integration.credential_removed",
      entityType: "INTEGRATION",
      entityId: body.provider,
      meta: { key: body.key },
    });
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
