/**
 * Shared UI primitives.
 *
 * Server-component safe (no hooks, no browser APIs) so dashboard pages can be
 * rendered on the server and stream. Anything interactive lives in its own
 * "use client" module.
 */
import type { ReactNode } from "react";

// --- layout ----------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-5">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-[var(--color-ink)]">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-[13px] text-[var(--color-ink-2)]">{description}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  padded = true,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  className?: string;
}) {
  return (
    <section className={`fm-card overflow-hidden ${className}`}>
      {title ? (
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{title}</h2>
            {description ? <p className="mt-0.5 text-[12px] text-[var(--color-ink-3)]">{description}</p> : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function Grid({ cols = 3, children, className = "" }: { cols?: 2 | 3 | 4; children: ReactNode; className?: string }) {
  const map = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" } as const;
  return <div className={`grid grid-cols-1 gap-4 ${map[cols]} ${className}`}>{children}</div>;
}

// --- data display ----------------------------------------------------------

export function Stat({
  label,
  value,
  sub,
  tone = "default",
  href,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "ok" | "warn" | "danger" | "info";
  href?: string;
}) {
  const toneColor = {
    default: "var(--color-ink)",
    ok: "var(--color-ok)",
    warn: "var(--color-warn)",
    danger: "var(--color-danger)",
    info: "var(--color-info)",
  }[tone];

  const body = (
    <div className="fm-card h-full px-4 py-3.5 transition-colors hover:border-[var(--color-border-strong)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-ink-3)]">{label}</div>
      <div className="mt-1.5 text-[26px] font-semibold leading-none tracking-[-0.02em]" style={{ color: toneColor }}>
        {value}
      </div>
      {sub ? <div className="mt-1.5 text-[12px] text-[var(--color-ink-3)]">{sub}</div> : null}
    </div>
  );

  return href ? <a href={href}>{body}</a> : body;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="fm-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-[14px] font-medium text-[var(--color-ink-2)]">{title}</p>
      {hint ? <p className="max-w-md text-[12.5px] text-[var(--color-ink-3)]">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`fm-mono text-[var(--color-ink-2)] ${className}`}>{children}</span>;
}

export function KeyValue({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-[var(--color-border)]">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
          <dt className="shrink-0 text-[12px] text-[var(--color-ink-3)]">{r.label}</dt>
          <dd className="text-right text-[13px] text-[var(--color-ink)]">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// --- badges ----------------------------------------------------------------

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "brand" | "mock";

const TONE_STYLE: Record<Tone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: "var(--color-surface-2)", fg: "var(--color-ink-2)", bd: "var(--color-border-strong)" },
  ok: { bg: "var(--color-ok-soft)", fg: "var(--color-ok)", bd: "var(--color-ok)" },
  warn: { bg: "var(--color-warn-soft)", fg: "var(--color-warn)", bd: "var(--color-warn)" },
  danger: { bg: "var(--color-danger-soft)", fg: "var(--color-danger)", bd: "var(--color-danger)" },
  info: { bg: "var(--color-info-soft)", fg: "var(--color-info)", bd: "var(--color-info)" },
  brand: { bg: "var(--color-brand-soft)", fg: "var(--color-brand-ink)", bd: "var(--color-brand)" },
  mock: { bg: "var(--color-mock-soft)", fg: "var(--color-mock)", bd: "var(--color-mock)" },
};

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  const s = TONE_STYLE[tone];
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11px] font-semibold leading-[1.4] whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, borderColor: s.bd }}
    >
      {children}
    </span>
  );
}

/**
 * The MOCK badge is used everywhere synthetic data is displayed. It is not
 * decoration: the product rule is that mock data is never presented as real.
 */
export function MockBadge({ label = "MOCK" }: { label?: string }) {
  return (
    <Badge tone="mock" title="Synthetic data from a bundled dataset or the deterministic mock adapter. Not measured, not live.">
      {label}
    </Badge>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  // task / run
  PENDING: "neutral",
  QUEUED: "neutral",
  RUNNING: "info",
  WAITING: "warn",
  WAITING_APPROVAL: "warn",
  REVIEW: "warn",
  APPROVED: "ok",
  REJECTED: "danger",
  COMPLETED: "ok",
  SUCCEEDED: "ok",
  FAILED: "danger",
  TIMEOUT: "danger",
  CANCELLED: "neutral",
  SKIPPED: "neutral",
  ESCALATED: "warn",
  // page
  DRAFT: "neutral",
  GENERATED: "info",
  VALIDATED: "ok",
  PUBLISHED: "ok",
  UNPUBLISHED: "neutral",
  ROLLED_BACK: "warn",
  // decisions
  PASS: "ok",
  BUILD: "ok",
  REJECT: "danger",
  FAIL: "danger",
  // integration
  CONFIGURED: "ok",
  NOT_CONFIGURED: "neutral",
  ERROR: "danger",
  DISABLED: "neutral",
  ACTIVE: "ok",
  PLANNED: "neutral",
  LIVE: "ok",
  PROPOSED: "info",
  // severity
  HIGH: "danger",
  MEDIUM: "warn",
  LOW: "neutral",
  WARNING: "warn",
  INFO: "info",
  VERIFIED: "ok",
  UNSUPPORTED: "danger",
  REQUIRES_LIVE_SOURCE: "danger",
  UNVERIFIED: "warn",
  DISPUTED: "danger",
  STALE: "warn",
};

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} title={title}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

// --- meters ----------------------------------------------------------------

export function Meter({
  value,
  max = 100,
  tone = "brand",
  label,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = TONE_STYLE[tone].fg;
  return (
    <div className="w-full">
      {label ? (
        <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--color-ink-3)]">
          <span>{label}</span>
          <span className="fm-mono">{value.toFixed(0)}</span>
        </div>
      ) : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)] ring-1 ring-inset ring-[var(--color-border)]">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/** Composition bar: template vs dynamic vs generated share of a page. */
export function CompositionBar({
  template,
  dynamic,
  ai,
  withinPolicy,
}: {
  template: number;
  dynamic: number;
  ai: number;
  withinPolicy?: boolean;
}) {
  const seg = [
    { v: template, c: "var(--color-ink-4)", label: "template" },
    { v: dynamic, c: "var(--color-info)", label: "dynamic data" },
    { v: ai, c: "var(--color-mock)", label: "generated" },
  ];
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full ring-1 ring-inset ring-[var(--color-border)]">
        {seg.map((s) => (
          <div key={s.label} style={{ width: `${s.v * 100}%`, background: s.c }} title={`${s.label}: ${(s.v * 100).toFixed(0)}%`} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-ink-3)]">
        {seg.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.c }} />
            {s.label} {(s.v * 100).toFixed(0)}%
          </span>
        ))}
        {withinPolicy !== undefined ? (
          <Badge tone={withinPolicy ? "ok" : "warn"}>{withinPolicy ? "within policy" : "outside policy"}</Badge>
        ) : null}
      </div>
    </div>
  );
}

/** Minimal dependency-free sparkline for time series. */
export function Sparkline({
  points,
  height = 40,
  tone = "var(--color-brand)",
}: {
  points: number[];
  height?: number;
  tone?: string;
}) {
  if (points.length < 2) {
    return <div className="text-[11px] text-[var(--color-ink-4)]">Not enough data points</div>;
  }
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const w = 100;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = height - ((p - min) / range) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const area = `${d} L${w},${height} L0,${height} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="trend">
      <path d={area} fill={tone} opacity="0.1" />
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Bars({ data, max }: { data: { label: string; value: number; tone?: string }[]; max?: number }) {
  const top = max ?? Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div>
            <div className="mb-1 truncate text-[12px] text-[var(--color-ink-2)]" title={d.label}>
              {d.label}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)] ring-1 ring-inset ring-[var(--color-border)]">
              <div className="h-full rounded-full" style={{ width: `${(d.value / top) * 100}%`, background: d.tone ?? "var(--color-brand)" }} />
            </div>
          </div>
          <span className="fm-mono tabular-nums text-[var(--color-ink-2)]">{d.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// --- misc ------------------------------------------------------------------

export function Callout({ tone = "info", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const s = TONE_STYLE[tone];
  return (
    <div className="rounded-lg border p-3 text-[12.5px]" style={{ background: s.bg, borderColor: s.bd, color: s.fg }}>
      {title ? <div className="mb-1 font-semibold">{title}</div> : null}
      <div className="opacity-95">{children}</div>
    </div>
  );
}

export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}
