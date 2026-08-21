import Link from "next/link";
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { roleHas } from "@/core/security/rbac";
import { Playground, type PlaygroundSkill } from "@/app/(console)/skills/playground/playground";
import { Callout, PageHeader } from "@/ui/primitives";
import type { SkillIoField } from "@/skills/types";

export const dynamic = "force-dynamic";

export default async function PlaygroundPage({ searchParams }: { searchParams: Promise<{ skill?: string }> }) {
  const { auth } = await requireProject();
  const sp = await searchParams;

  if (!roleHas(auth.role, "skill:test")) {
    return (
      <>
        <PageHeader title="Skill playground" description="Try a skill version against a sample input." />
        <Callout tone="warn" title="Your role cannot run skill tests">
          The playground requires the skill:test permission.
        </Callout>
      </>
    );
  }

  const [skills, agents] = await Promise.all([
    prisma.skill.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      include: {
        activeVersion: true,
        versions: { orderBy: { version: "desc" } },
        agents: { include: { agent: { select: { key: true } } } },
      },
    }),
    prisma.agent.findMany({ orderBy: { name: "asc" }, select: { key: true, name: true } }),
  ]);

  const rows: PlaygroundSkill[] = skills
    .filter((s) => s.versions.length > 0)
    .map((s) => {
      const source = s.activeVersion ?? s.versions[0];
      return {
        id: s.id,
        key: s.key,
        name: s.name,
        category: s.category,
        activeVersionId: s.activeVersionId,
        draftVersionId: s.versions.find((v) => v.status === "DRAFT")?.id ?? null,
        versions: s.versions.map((v) => ({ id: v.id, version: v.version, status: v.status })),
        inputs: readJson<SkillIoField[]>(source.inputSchemaJson, []).map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          description: f.description,
        })),
        assignedAgentKeys: s.agents.map((a) => a.agent.key),
      };
    });

  return (
    <>
      <PageHeader
        title="Skill playground"
        description="Select an agent, a skill and a version, supply a sample input, and inspect exactly what the skill produces before anything is activated."
        actions={
          <Link href="/skills" className="fm-btn">
            Back to library
          </Link>
        }
      />

      <div className="mb-4">
        <Callout tone="info" title="Nothing here touches production">
          The playground runs generation only. It writes a test-run record and the usage ledger entry, and nothing else: no
          pages, no publishes, no project data.
        </Callout>
      </div>

      <Playground skills={rows} agents={agents} initialSkillId={sp.skill} />
    </>
  );
}
