/**
 * Console shell.
 *
 * Every page under (console) requires an authenticated session and resolves the
 * active project from the caller's organization, so tenant isolation happens
 * once here rather than in each page.
 */
import { redirect } from "next/navigation";
import { currentAuth } from "@/core/security/auth";
import { prisma } from "@/core/db/client";
import { env } from "@/core/config/env";
import { Sidebar } from "@/ui/sidebar";
import { LogoutButton } from "@/ui/logout-button";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const auth = await currentAuth();
  if (!auth) redirect("/login");

  const project = await prisma.project.findFirst({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: "asc" },
  });

  const [pendingApprovals, errorCount] = project
    ? await Promise.all([
        prisma.approval.count({ where: { projectId: project.id, status: "PENDING" } }),
        prisma.logEntry.count({
          where: { projectId: project.id, level: "ERROR", createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        }),
      ])
    : [0, 0];

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        orgName={auth.organizationName}
        projectName={project?.name ?? "No project"}
        demoMode={env().DEMO_MODE}
        pendingApprovals={pendingApprovals}
        errorCount={errorCount}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5">
          <div className="flex items-center gap-3 text-[12px] text-[var(--color-ink-3)]">
            <span>
              Signed in as <span className="text-[var(--color-ink-2)]">{auth.name}</span>
            </span>
            <span className="rounded border border-[var(--color-border)] px-1.5 py-[1px] text-[11px]">{auth.role}</span>
          </div>
          <LogoutButton />
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-[1400px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
