import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readStringArray } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { roleHas } from "@/core/security/rbac";
import { SkillLibrary, type SkillRow } from "@/app/(console)/skills/skill-library";
import { CreateSkillButton } from "@/app/(console)/skills/create-skill-button";
import { Badge, Callout, Grid, PageHeader, Stat } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const { auth } = await requireProject();
  const canWrite = roleHas(auth.role, "skill:write");

  const [skills, agents] = await Promise.all([
    prisma.skill.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        activeVersion: true,
        versions: { orderBy: { version: "desc" } },
        agents: { include: { agent: { select: { key: true, name: true } }, pinnedVersion: true } },
      },
    }),
    prisma.agent.findMany({ orderBy: { name: "asc" }, select: { key: true, name: true } }),
  ]);

  const rows: SkillRow[] = skills.map((s) => ({
    id: s.id,
    key: s.key,
    name: s.name,
    category: s.category,
    description: s.description,
    status: s.status,
    activeVersion: s.activeVersion?.version ?? null,
    activeVersionStatus: s.activeVersion?.status ?? null,
    versionCount: s.versions.length,
    draftVersion: s.versions.find((v) => v.status === "DRAFT")?.version ?? null,
    allowedTools: readStringArray(s.activeVersion?.allowedToolsJson ?? "[]"),
    assignedAgents: s.agents.map((a) => ({
      key: a.agent.key,
      name: a.agent.name,
      pinnedVersion: a.pinnedVersion?.version ?? null,
      enabled: a.isEnabled,
    })),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));

  const categories = [...new Set(skills.map((s) => s.category))].sort();
  const totalVersions = skills.reduce((n, s) => n + s.versions.length, 0);
  const drafts = rows.filter((r) => r.draftVersion !== null).length;
  const unassigned = rows.filter((r) => r.assignedAgents.length === 0).length;
  const noActive = rows.filter((r) => r.activeVersion === null).length;

  return (
    <>
      <PageHeader
        title="Skill library"
        description="Skills are versioned, testable configuration. Editing never overwrites what is live: it creates a draft that only reaches agents once you activate it."
        meta={
          <>
            <Badge tone="neutral">{skills.length} skills</Badge>
            <Badge tone="neutral">{totalVersions} versions</Badge>
            {drafts ? <Badge tone="info">{drafts} with a draft</Badge> : null}
            {!canWrite ? <Badge tone="warn">read-only for your role</Badge> : null}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link href="/skills/playground" className="fm-btn">
              Playground
            </Link>
            {canWrite ? <CreateSkillButton categories={categories} /> : null}
          </div>
        }
      />

      <Grid cols={4} className="mb-4">
        <Stat label="Skills" value={skills.length} sub={`${categories.length} categories`} />
        <Stat label="Versions" value={totalVersions} sub="immutable once activated" />
        <Stat label="Drafts open" value={drafts} sub={drafts ? "awaiting test + activation" : "none in progress"} tone={drafts ? "info" : "default"} />
        <Stat
          label="Needs attention"
          value={noActive + unassigned}
          sub={`${noActive} without an active version · ${unassigned} unassigned`}
          tone={noActive ? "warn" : "default"}
        />
      </Grid>

      <div className="mb-4">
        <Callout tone="info" title="How a skill reaches an agent">
          The runtime resolves <strong>agent → assignment → active version → configuration → effective tools</strong>. An
          assignment can pin a specific version instead of following active. Whatever resolves is recorded on the run, so a
          run from last week still reports the exact version that produced it.
        </Callout>
      </div>

      <SkillLibrary skills={rows} agents={agents} categories={categories} canWrite={canWrite} />
    </>
  );
}
