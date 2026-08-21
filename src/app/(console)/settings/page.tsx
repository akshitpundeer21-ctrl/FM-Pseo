import { prisma } from "@/core/db/client";
import { readRecord } from "@/core/db/json";
import { requireProject } from "@/app/(console)/_lib/data";
import { SettingsForm } from "@/app/(console)/settings/settings-form";
import { Badge, Callout, Card, Grid, KeyValue, Meter, Mono, PageHeader, Table } from "@/ui/primitives";
import { budgetStatus } from "@/control-plane/budget";
import { env, envIntegrationStatus, publicConfig } from "@/core/config/env";
import { createRouter } from "@/llm/router";
import { formatMoney, formatNumber } from "@/core/utils/text";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { auth, project } = await requireProject();

  const [org, budget, usage] = await Promise.all([
    prisma.organization.findUnique({ where: { id: auth.organizationId } }),
    budgetStatus(auth.organizationId),
    prisma.usageRecord.findMany({ where: { organizationId: auth.organizationId }, orderBy: { updatedAt: "desc" }, take: 12 }),
  ]);

  const settings = readRecord(project.settingsJson);
  const autoApproved = Array.isArray(settings.autoApprovedActions) ? (settings.autoApprovedActions as string[]) : [];
  const llm = createRouter({ organizationId: auth.organizationId, projectId: project.id }).describe();
  const envStatus = envIntegrationStatus();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Operating policy for this project: how much autonomy the system has, what it may spend, and which model providers it can reach."
        meta={
          <>
            <Badge tone="brand">{project.approvalMode.replace("_", "-")}</Badge>
            <Badge tone={budget.exhausted ? "danger" : "neutral"}>
              {formatMoney(budget.costUsd)} / {formatMoney(budget.costBudget)} this period
            </Badge>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Autonomy & budget">
          <SettingsForm
            approvalMode={project.approvalMode}
            confidenceThreshold={project.confidenceThreshold}
            autoApprovedActions={autoApproved}
            monthlyTokenBudget={org?.monthlyTokenBudget ?? 5_000_000}
            monthlyCostBudget={org?.monthlyCostBudget ?? 250}
          />
        </Card>

        <div className="space-y-4">
          <Card title="Budget consumption" description={`Period ${budget.period}`}>
            <div className="space-y-3">
              <Meter value={budget.tokenPct * 100} label={`Tokens — ${formatNumber(budget.tokensUsed)} of ${formatNumber(budget.tokenBudget)}`} tone={budget.tokenPct > 0.9 ? "danger" : "brand"} />
              <Meter value={budget.costPct * 100} label={`Cost — ${formatMoney(budget.costUsd)} of ${formatMoney(budget.costBudget)}`} tone={budget.costPct > 0.9 ? "danger" : "brand"} />
            </div>
            {budget.exhausted ? (
              <p className="mt-3 text-[11.5px] text-[var(--color-danger)]">
                Budget exhausted — billable tool calls are blocked until the budget is raised or the period rolls over.
              </p>
            ) : null}
          </Card>

          <Card title="Model routing" description="Which provider serves a generation request, and why.">
            <KeyValue
              rows={[
                { label: "Default provider", value: <Mono>{llm.defaultProvider}</Mono> },
                { label: "Configured providers", value: llm.configured.length ? llm.configured.join(", ") : <span className="text-[var(--color-ink-3)]">none</span> },
                { label: "Mock fallback", value: llm.demoFallback ? <Badge tone="mock">enabled</Badge> : <Badge tone="danger">disabled</Badge> },
                { label: "Fast tier", value: <Mono>{env().LLM_MODEL_FAST}</Mono> },
                { label: "Balanced tier", value: <Mono>{env().LLM_MODEL_BALANCED}</Mono> },
                { label: "Deep tier", value: <Mono>{env().LLM_MODEL_DEEP}</Mono> },
              ]}
            />
            {!llm.configured.length ? (
              <p className="mt-2 text-[11.5px] text-[var(--color-mock)]">
                No LLM provider is configured. All generation runs through the deterministic mock composer, which writes only
                from resolved data and labels its output MOCK.
              </p>
            ) : null}
          </Card>
        </div>
      </div>

      <Grid cols={2} className="mb-5">
        <Card title="Environment" description="Read-only view of the process configuration. Secrets are never displayed.">
          <KeyValue
            rows={[
              { label: "NODE_ENV", value: <Mono>{publicConfig().nodeEnv}</Mono> },
              { label: "APP_URL", value: <Mono>{publicConfig().appUrl}</Mono> },
              { label: "DEMO_MODE", value: <Badge tone={publicConfig().demoMode ? "mock" : "ok"}>{String(publicConfig().demoMode)}</Badge> },
              { label: "Publish adapter", value: <Mono>{env().PUBLISH_ADAPTER}</Mono> },
              { label: "AI visibility platforms", value: <Mono>{env().AI_VISIBILITY_PLATFORMS}</Mono> },
              { label: "Crawler user agent", value: <Mono>{env().CRAWLER_USER_AGENT}</Mono> },
            ]}
          />
        </Card>

        <Card title="Credentials present in the environment" description="Whether a key exists — never its value." padded={false}>
          <Table head={["Provider", "Env credential"]}>
            {Object.entries(envStatus).map(([k, v]) => (
              <tr key={k}>
                <td>
                  <Mono className="!text-[var(--color-ink)]">{k}</Mono>
                </td>
                <td>{v ? <Badge tone="ok">present</Badge> : <Badge tone="neutral">absent</Badge>}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </Grid>

      <Card title="Usage ledger" description="Every billable call is recorded against the organization." padded={false}>
        <Table head={["Period", "Category", "Calls", "Tokens in", "Tokens out", "Cost"]}>
          {usage.map((u) => (
            <tr key={u.id}>
              <td>
                <Mono>{u.period}</Mono>
              </td>
              <td className="text-[12px]">{u.category}</td>
              <td className="fm-mono">{u.calls}</td>
              <td className="fm-mono">{formatNumber(u.tokensIn)}</td>
              <td className="fm-mono">{formatNumber(u.tokensOut)}</td>
              <td className="fm-mono">{formatMoney(u.costUsd)}</td>
            </tr>
          ))}
          {!usage.length ? (
            <tr>
              <td colSpan={6}>
                <span className="text-[12px] text-[var(--color-ink-4)]">No usage recorded yet.</span>
              </td>
            </tr>
          ) : null}
        </Table>
      </Card>
    </>
  );
}
