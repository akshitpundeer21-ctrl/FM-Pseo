/**
 * Publish a new version of the orchestration_planning skill that declares the
 * Google Sheets tools.
 *
 * Why this needs a script rather than a seed change:
 *
 *   Effective tools = agent allowlist ∩ union(allowedTools of resolved skills).
 *
 * Granting the Master Orchestrator google_sheets.read/update in
 * src/agents/definitions.ts is necessary but NOT sufficient: its skill still
 * declares only llm.generate and travel.reference, so the intersection silently
 * revokes the grant. The skill has to declare them too.
 *
 * And skill versions are immutable by design, so `npm run seed` will not edit
 * the live version - it skips any skill that already has one. The correct path
 * is the one an operator would take in the dashboard: create a draft from the
 * active version, add the tools, activate it. That is what this does, through
 * the same service functions the API uses, so every step lands in the audit log
 * and the previous version is archived rather than destroyed.
 *
 * Idempotent: exits without doing anything if the active version already
 * declares the tools.
 *
 * Run:  npx tsx scripts/grant-sheets-to-orchestrator.ts
 */
import "dotenv/config";
import { prisma } from "../src/core/db/client";
import { readJson } from "../src/core/db/json";
import { activateVersion, configFromVersion, createDraftVersion, transitionVersion } from "../src/skills/service";

const SKILL_KEY = "orchestration_planning";
const NEW_TOOLS = ["google_sheets.read", "google_sheets.update"];

async function main() {
  const skill = await prisma.skill.findUnique({
    where: { key: SKILL_KEY },
    include: { activeVersion: true },
  });
  if (!skill?.activeVersion) {
    console.error(`No active version of "${SKILL_KEY}" found. Run npm run seed first.`);
    process.exitCode = 1;
    return;
  }

  const current = readJson<string[]>(skill.activeVersion.allowedToolsJson, []);
  const missing = NEW_TOOLS.filter((t) => !current.includes(t));
  if (!missing.length) {
    console.log(`v${skill.activeVersion.version} already declares ${NEW_TOOLS.join(", ")} — nothing to do.`);
    return;
  }

  const owner = await prisma.membership.findFirst({ where: { role: "OWNER" }, include: { user: true } });
  const ctx = {
    organizationId: owner?.organizationId ?? "",
    actorId: owner?.userId ?? "system",
    actorName: owner?.user.name ?? "system",
  };

  const config = configFromVersion(skill.activeVersion);
  const draft = await createDraftVersion(
    skill.id,
    {
      fromVersionId: skill.activeVersion.id,
      config: { ...config, allowedTools: [...current, ...missing] },
      changeSummary: `Declare ${missing.join(" and ")} so the Master Orchestrator's grant is not narrowed away.`,
    },
    ctx,
  );

  // Walk the lifecycle the same way the activation endpoint does.
  await transitionVersion(skill.id, draft.id, "TESTING", ctx);
  await transitionVersion(skill.id, draft.id, "READY", ctx);
  await activateVersion(skill.id, draft.id, ctx);

  const after = await prisma.skill.findUnique({ where: { key: SKILL_KEY }, include: { activeVersion: true } });
  console.log(
    `Activated ${SKILL_KEY} v${after?.activeVersion?.version} (was v${skill.activeVersion.version}, now archived).`,
  );
  console.log(`  allowedTools: ${readJson<string[]>(after?.activeVersion?.allowedToolsJson ?? "[]", []).join(", ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
