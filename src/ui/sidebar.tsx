"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Blocks,
  Bot,
  Boxes,
  Building2,
  CheckSquare,
  FileText,
  Globe2,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  Link2,
  ListTodo,
  Plug,
  Radar,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Target,
  Upload,
  Wrench,
} from "lucide-react";

const SECTIONS: { label: string; items: { href: string; label: string; icon: React.ComponentType<{ size?: number }> }[] }[] = [
  {
    label: "Operate",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
      { href: "/goals", label: "Goals & workflows", icon: Sparkles },
      { href: "/tasks", label: "Tasks", icon: ListTodo },
      { href: "/agents", label: "Agents", icon: Bot },
      { href: "/approvals", label: "Approvals", icon: CheckSquare },
    ],
  },
  {
    label: "Research",
    items: [
      { href: "/keywords", label: "Keywords", icon: Target },
      { href: "/opportunities", label: "Opportunities", icon: Radar },
      { href: "/competitors", label: "Competitors", icon: Building2 },
    ],
  },
  {
    label: "Build",
    items: [
      { href: "/page-families", label: "Page families", icon: Boxes },
      { href: "/templates", label: "Templates", icon: LayoutTemplate },
      { href: "/components", label: "Components", icon: Blocks },
      { href: "/content", label: "Content", icon: FileText },
      { href: "/publishing", label: "Publishing", icon: Upload },
      { href: "/internal-links", label: "Internal links", icon: Link2 },
    ],
  },
  {
    label: "Measure",
    items: [
      { href: "/technical-seo", label: "Technical SEO", icon: Wrench },
      { href: "/search-performance", label: "Search performance", icon: BarChart3 },
      { href: "/ai-visibility", label: "AI visibility", icon: Activity },
      { href: "/search", label: "Flight search", icon: Search },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/projects", label: "Projects & brand", icon: Globe2 },
      { href: "/skills", label: "Skill library", icon: KeyRound },
      { href: "/integrations", label: "Integrations", icon: Plug },
      { href: "/logs", label: "Logs & audit", icon: ScrollText },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar({
  orgName,
  projectName,
  demoMode,
  pendingApprovals,
  errorCount,
}: {
  orgName: string;
  projectName: string;
  demoMode: boolean;
  pendingApprovals: number;
  errorCount: number;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-[236px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-brand)] text-[13px] font-bold text-white">F</span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold leading-tight">FaresMatch AI OS</div>
            <div className="truncate text-[11px] text-[var(--color-ink-3)]">{orgName}</div>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="truncate rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-[1px] text-[11px] text-[var(--color-ink-2)]">
            {projectName}
          </span>
          {demoMode ? (
            <span
              title="Missing integrations fall back to clearly-labelled mock adapters."
              className="rounded border px-1.5 py-[1px] text-[10px] font-semibold"
              style={{ background: "var(--color-mock-soft)", color: "var(--color-mock)", borderColor: "var(--color-mock)" }}
            >
              DEMO MODE
            </span>
          ) : null}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {SECTIONS.map((section) => (
          <div key={section.label} className="mb-3">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--color-ink-4)]">
              {section.label}
            </div>
            {section.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              const badge =
                item.href === "/approvals" && pendingApprovals > 0
                  ? pendingApprovals
                  : item.href === "/logs" && errorCount > 0
                    ? errorCount
                    : null;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`mb-[1px] flex items-center gap-2.5 rounded-md px-2 py-[6px] text-[13px] transition-colors ${
                    active
                      ? "bg-[var(--color-brand-soft)] font-semibold text-[var(--color-brand-ink)]"
                      : "text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  <Icon size={15} />
                  <span className="flex-1 truncate">{item.label}</span>
                  {badge ? (
                    <span
                      className="rounded-full px-1.5 text-[10px] font-bold"
                      style={{
                        background: item.href === "/logs" ? "var(--color-danger-soft)" : "var(--color-warn-soft)",
                        color: item.href === "/logs" ? "var(--color-danger)" : "var(--color-warn)",
                      }}
                    >
                      {badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--color-border)] px-3 py-2.5">
        <a
          href="/site"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          <Globe2 size={14} /> View published site
        </a>
        {errorCount > 0 ? (
          <Link href="/logs?level=ERROR" className="mt-1.5 flex items-center gap-2 text-[12px] text-[var(--color-danger)]">
            <AlertTriangle size={14} /> {errorCount} error{errorCount === 1 ? "" : "s"} logged
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
