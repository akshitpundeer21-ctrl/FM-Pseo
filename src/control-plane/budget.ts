/**
 * Budget + rate limiting.
 *
 * Two independent guards:
 *  1. Monthly spend ledger per organization (tokens + USD), checked BEFORE an
 *     agent is allowed to call a paid tool, and updated after every call.
 *  2. An in-process sliding-window rate limiter for API routes and outbound
 *     provider calls, so a runaway loop cannot hammer a vendor.
 */
import { prisma } from "@/core/db/client";
import { BudgetExceededError, AppError } from "@/core/errors";

export interface BudgetStatus {
  period: string;
  tokensUsed: number;
  costUsd: number;
  tokenBudget: number;
  costBudget: number;
  tokenPct: number;
  costPct: number;
  exhausted: boolean;
}

export function currentPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function budgetStatus(organizationId: string): Promise<BudgetStatus> {
  const period = currentPeriod();
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const records = await prisma.usageRecord.findMany({ where: { organizationId, period } });

  const tokensUsed = records.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
  const costUsd = records.reduce((s, r) => s + r.costUsd, 0);
  const tokenBudget = org?.monthlyTokenBudget ?? 5_000_000;
  const costBudget = org?.monthlyCostBudget ?? 250;

  return {
    period,
    tokensUsed,
    costUsd,
    tokenBudget,
    costBudget,
    tokenPct: tokenBudget ? tokensUsed / tokenBudget : 0,
    costPct: costBudget ? costUsd / costBudget : 0,
    exhausted: tokensUsed >= tokenBudget || costUsd >= costBudget,
  };
}

/** Throws when the org has run out of budget for the current period. */
export async function assertBudgetAvailable(organizationId: string, what: string) {
  const status = await budgetStatus(organizationId);
  if (status.exhausted) {
    throw new BudgetExceededError(
      `Monthly budget exhausted for ${status.period} (${status.tokensUsed.toLocaleString()} tokens / $${status.costUsd.toFixed(2)}). Blocked: ${what}.`,
      status,
    );
  }
  return status;
}

export async function recordUsage(params: {
  organizationId: string;
  projectId?: string;
  category?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  calls?: number;
}) {
  const period = currentPeriod();
  const category = params.category ?? "llm";

  // `projectId` is nullable, and Prisma's compound-unique input rejects null,
  // so the ledger row is located with findFirst rather than upsert.
  const existing = await prisma.usageRecord.findFirst({
    where: {
      organizationId: params.organizationId,
      projectId: params.projectId ?? null,
      period,
      category,
    },
    select: { id: true },
  });

  if (existing) {
    await prisma.usageRecord.update({
      where: { id: existing.id },
      data: {
        tokensIn: { increment: params.tokensIn ?? 0 },
        tokensOut: { increment: params.tokensOut ?? 0 },
        costUsd: { increment: params.costUsd ?? 0 },
        calls: { increment: params.calls ?? 1 },
      },
    });
    return;
  }

  await prisma.usageRecord.create({
    data: {
      organizationId: params.organizationId,
      projectId: params.projectId ?? null,
      period,
      category,
      tokensIn: params.tokensIn ?? 0,
      tokensOut: params.tokensOut ?? 0,
      costUsd: params.costUsd ?? 0,
      calls: params.calls ?? 1,
    },
  });
}

// --- in-process rate limiter ----------------------------------------------

interface Window {
  hits: number[];
}

const windows = new Map<string, Window>();

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

export function rateLimit({ key, limit, windowMs }: RateLimitOptions): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  const w = windows.get(key) ?? { hits: [] };
  w.hits = w.hits.filter((t) => now - t < windowMs);
  const allowed = w.hits.length < limit;
  if (allowed) w.hits.push(now);
  windows.set(key, w);
  const oldest = w.hits[0] ?? now;
  return { allowed, remaining: Math.max(0, limit - w.hits.length), resetMs: Math.max(0, windowMs - (now - oldest)) };
}

export function assertRateLimit(opts: RateLimitOptions) {
  const res = rateLimit(opts);
  if (!res.allowed) {
    throw new AppError("RATE_LIMITED", `Rate limit exceeded for "${opts.key}". Retry in ${Math.ceil(res.resetMs / 1000)}s.`, {
      details: res,
    });
  }
  return res;
}

/** Test helper. */
export function resetRateLimits() {
  windows.clear();
}
