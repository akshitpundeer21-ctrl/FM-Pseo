/**
 * Integration + credential service. SERVER ONLY.
 *
 * Contract:
 *  - Secrets are encrypted with AES-256-GCM before they touch the database.
 *  - `resolveCredentials()` is the ONLY way to obtain plaintext, and it is
 *    called from the tool-execution layer, never from a prompt builder.
 *  - Anything returned to the UI goes through `toPublicIntegration()`, which
 *    strips ciphertext and returns a display hint only.
 */
import { prisma } from "@/core/db/client";
import { readRecord, writeJson } from "@/core/db/json";
import { env } from "@/core/config/env";
import { decryptSecret, encryptSecret, secretHint } from "@/core/security/crypto";
import { NotFoundError, ValidationError } from "@/core/errors";
import { scopedLogger } from "@/core/logging/logger";
import { INTEGRATION_CATALOG, findIntegration, type IntegrationDefinition } from "@/integrations/catalog";
import type { IntegrationStatus } from "@/core/types/enums";

const log = scopedLogger("integrations");

export interface PublicIntegration {
  id: string | null;
  provider: string;
  name: string;
  category: string;
  description: string;
  docsUrl?: string;
  status: IntegrationStatus;
  isMock: boolean;
  hasMock: boolean;
  degradesTo: string;
  /** Per-credential presence + hint. Never the value. */
  credentials: { key: string; label: string; present: boolean; source: "database" | "environment" | "missing"; hint: string }[];
  settings: { key: string; label: string; value: string }[];
  lastCheckedAt: string | null;
  lastError: string | null;
}

function envValue(name?: string): string {
  if (!name) return "";
  const e = env() as unknown as Record<string, unknown>;
  const v = e[name];
  return typeof v === "string" ? v : "";
}

/** Merge catalog + stored rows into the view model used by the dashboard. */
export async function listIntegrations(organizationId: string, projectId?: string): Promise<PublicIntegration[]> {
  const rows = await prisma.integration.findMany({
    where: { organizationId, OR: [{ projectId: null }, { projectId: projectId ?? undefined }] },
    include: { credentials: true },
  });

  return INTEGRATION_CATALOG.map((def) => {
    const row = rows.find((r) => r.provider === def.provider);
    const stored = new Map((row?.credentials ?? []).map((c) => [c.key, c]));
    const config = readRecord(row?.configJson);

    const credentials = def.credentials.map((field) => {
      const dbCred = stored.get(field.key);
      const envVal = envValue(field.envVar);
      if (dbCred) {
        return { key: field.key, label: field.label, present: true, source: "database" as const, hint: dbCred.hint };
      }
      if (envVal) {
        return { key: field.key, label: field.label, present: true, source: "environment" as const, hint: secretHint(envVal) };
      }
      return { key: field.key, label: field.label, present: false, source: "missing" as const, hint: "" };
    });

    const required = def.credentials.filter((c) => !c.optional).map((c) => c.key);
    const optionalOnly = def.credentials.length > 0 && required.length === 0;
    const requiredSatisfied = required.every((k) => credentials.find((c) => c.key === k)?.present);
    const anyPresent = credentials.some((c) => c.present);
    const satisfied = def.credentials.length === 0 || (optionalOnly ? anyPresent : requiredSatisfied);

    const status: IntegrationStatus = row?.status === "DISABLED"
      ? "DISABLED"
      : row?.lastError
        ? "ERROR"
        : satisfied
          ? "CONFIGURED"
          : "NOT_CONFIGURED";

    const settings = (def.settings ?? []).map((s) => ({
      key: s.key,
      label: s.label,
      value: (config[s.key] as string) || envValue(s.envVar) || "",
    }));

    return {
      id: row?.id ?? null,
      provider: def.provider,
      name: def.name,
      category: def.category,
      description: def.description,
      docsUrl: def.docsUrl,
      status,
      isMock: !satisfied && def.hasMock,
      hasMock: def.hasMock,
      degradesTo: def.degradesTo,
      credentials,
      settings,
      lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
    };
  });
}

export async function ensureIntegrationRow(organizationId: string, provider: string, projectId?: string) {
  const def = findIntegration(provider);
  if (!def) throw new NotFoundError("Integration provider", provider);

  const existing = await prisma.integration.findFirst({ where: { organizationId, provider, projectId: projectId ?? null } });
  if (existing) return existing;

  return prisma.integration.create({
    data: {
      organizationId,
      projectId: projectId ?? null,
      provider,
      category: def.category,
      name: def.name,
      status: "NOT_CONFIGURED",
      isMock: def.hasMock,
    },
  });
}

/** Store (or rotate) a secret. Plaintext is discarded after encryption. */
export async function setCredential(params: {
  organizationId: string;
  provider: string;
  key: string;
  value: string;
  projectId?: string;
  actorId?: string;
}) {
  const def = findIntegration(params.provider);
  if (!def) throw new NotFoundError("Integration provider", params.provider);
  if (!def.credentials.some((c) => c.key === params.key)) {
    throw new ValidationError(`"${params.key}" is not a credential of ${params.provider}`);
  }
  if (!params.value.trim()) throw new ValidationError("Credential value cannot be empty");

  const integration = await ensureIntegrationRow(params.organizationId, params.provider, params.projectId);
  const enc = encryptSecret(params.value.trim());

  await prisma.credential.upsert({
    where: { integrationId_key: { integrationId: integration.id, key: params.key } },
    update: { ...enc, hint: secretHint(params.value.trim()), rotatedAt: new Date(), createdBy: params.actorId },
    create: { integrationId: integration.id, key: params.key, ...enc, hint: secretHint(params.value.trim()), createdBy: params.actorId },
  });

  await prisma.integration.update({
    where: { id: integration.id },
    data: { status: "CONFIGURED", isMock: false, lastError: null, lastCheckedAt: new Date() },
  });

  log.info("credential stored", { provider: params.provider, key: params.key, organizationId: params.organizationId });
  return { ok: true };
}

export async function deleteCredential(organizationId: string, provider: string, key: string, projectId?: string) {
  const integration = await prisma.integration.findFirst({ where: { organizationId, provider, projectId: projectId ?? null } });
  if (!integration) return { ok: true };
  await prisma.credential.deleteMany({ where: { integrationId: integration.id, key } });
  const remaining = await prisma.credential.count({ where: { integrationId: integration.id } });
  await prisma.integration.update({
    where: { id: integration.id },
    data: { status: remaining ? "CONFIGURED" : "NOT_CONFIGURED", isMock: remaining === 0 },
  });
  log.warn("credential deleted", { provider, key, organizationId });
  return { ok: true };
}

/**
 * Fully disconnect a provider: remove every stored secret, clear its settings
 * and mark it disabled.
 *
 * Distinct from deleteCredential, which removes one key and leaves the rest in
 * place. That contract is unchanged - the shipped dashboard depends on it.
 *
 * DISABLED rather than NOT_CONFIGURED is deliberate: it records that an
 * operator turned this off, so an env-var fallback silently taking over reads
 * as the deliberate choice it is rather than looking like it was never set up.
 */
export async function disconnectIntegration(
  organizationId: string,
  provider: string,
  projectId?: string,
): Promise<{ ok: true; removedCredentials: number }> {
  const integration = await prisma.integration.findFirst({
    where: { organizationId, provider, projectId: projectId ?? null },
  });
  if (!integration) return { ok: true, removedCredentials: 0 };

  const { count } = await prisma.credential.deleteMany({ where: { integrationId: integration.id } });
  await prisma.integration.update({
    where: { id: integration.id },
    data: { status: "DISABLED", isMock: true, configJson: "{}", lastError: null, lastCheckedAt: new Date() },
  });

  log.warn("integration disconnected", { provider, organizationId, removedCredentials: count });
  return { ok: true, removedCredentials: count };
}

/** Re-enable a disconnected provider without re-entering credentials it still holds. */
export async function enableIntegration(organizationId: string, provider: string, projectId?: string) {
  const integration = await prisma.integration.findFirst({
    where: { organizationId, provider, projectId: projectId ?? null },
  });
  if (!integration) return { ok: true };
  const remaining = await prisma.credential.count({ where: { integrationId: integration.id } });
  await prisma.integration.update({
    where: { id: integration.id },
    data: { status: remaining ? "CONFIGURED" : "NOT_CONFIGURED", isMock: remaining === 0 },
  });
  return { ok: true };
}

/** Records the outcome of a connection test on the integration row. */
export async function recordConnectionTest(
  organizationId: string,
  provider: string,
  result: { ok: boolean; message: string },
  projectId?: string,
) {
  const integration = await prisma.integration.findFirst({
    where: { organizationId, provider, projectId: projectId ?? null },
  });
  if (!integration) return;
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      lastCheckedAt: new Date(),
      // A failed test must not silently clear a DISABLED state.
      status: integration.status === "DISABLED" ? "DISABLED" : result.ok ? "CONFIGURED" : "ERROR",
      lastError: result.ok ? null : result.message.slice(0, 500),
    },
  });
}

export async function setIntegrationSettings(
  organizationId: string,
  provider: string,
  settings: Record<string, unknown>,
  projectId?: string,
) {
  const integration = await ensureIntegrationRow(organizationId, provider, projectId);
  const current = readRecord(integration.configJson);
  await prisma.integration.update({
    where: { id: integration.id },
    data: { configJson: writeJson({ ...current, ...settings }) },
  });
  return { ok: true };
}

export interface ResolvedCredentials {
  provider: string;
  values: Record<string, string>;
  settings: Record<string, string>;
  /** True when every required credential resolved from somewhere. */
  configured: boolean;
  missing: string[];
  source: "database" | "environment" | "mixed" | "none";
  integrationId: string | null;
}

/**
 * Resolve plaintext credentials for a provider: DB first, env fallback.
 * SERVER-ONLY. Callers must not log or forward the returned values.
 */
export async function resolveCredentials(
  organizationId: string,
  provider: string,
  projectId?: string,
): Promise<ResolvedCredentials> {
  const def = findIntegration(provider);
  if (!def) throw new NotFoundError("Integration provider", provider);

  const row = await prisma.integration.findFirst({
    where: { organizationId, provider, projectId: projectId ?? null },
    include: { credentials: true },
  });

  const values: Record<string, string> = {};
  const sources = new Set<string>();

  for (const field of def.credentials) {
    const dbCred = row?.credentials.find((c) => c.key === field.key);
    if (dbCred) {
      values[field.key] = decryptSecret({ ciphertext: dbCred.ciphertext, iv: dbCred.iv, authTag: dbCred.authTag });
      sources.add("database");
      continue;
    }
    const fromEnv = envValue(field.envVar);
    if (fromEnv) {
      values[field.key] = fromEnv;
      sources.add("environment");
    }
  }

  const config = readRecord(row?.configJson);
  const settings: Record<string, string> = {};
  for (const s of def.settings ?? []) {
    settings[s.key] = (config[s.key] as string) || envValue(s.envVar) || "";
  }

  const required = def.credentials.filter((c) => !c.optional).map((c) => c.key);
  const optionalOnly = def.credentials.length > 0 && required.length === 0;
  const missing = required.filter((k) => !values[k]);
  const configured =
    def.credentials.length === 0 ? true : optionalOnly ? Object.keys(values).length > 0 : missing.length === 0;

  return {
    provider,
    values,
    settings,
    configured,
    missing: configured ? [] : missing.length ? missing : def.credentials.map((c) => c.key),
    source: sources.size === 2 ? "mixed" : sources.size === 1 ? ([...sources][0] as "database" | "environment") : "none",
    integrationId: row?.id ?? null,
  };
}

export async function recordIntegrationError(integrationId: string | null, error: string | null) {
  if (!integrationId) return;
  await prisma.integration
    .update({ where: { id: integrationId }, data: { lastError: error, lastCheckedAt: new Date(), status: error ? "ERROR" : "CONFIGURED" } })
    .catch(() => undefined);
}

export function definitionFor(provider: string): IntegrationDefinition {
  const def = findIntegration(provider);
  if (!def) throw new NotFoundError("Integration provider", provider);
  return def;
}
