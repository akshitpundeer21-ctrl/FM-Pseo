import { requireProject } from "@/app/(console)/_lib/data";
import { listIntegrations } from "@/integrations/service";
import { isTestable } from "@/integrations/testers";
import { IntegrationForm } from "@/app/(console)/integrations/integration-form";
import { Badge, Callout, Card, Grid, MockBadge, PageHeader, StatusBadge } from "@/ui/primitives";
import { env } from "@/core/config/env";

export const dynamic = "force-dynamic";

const CATEGORY_LABEL: Record<string, string> = {
  LLM: "Language models",
  KEYWORD_DATA: "Keyword & SERP data",
  SEARCH_CONSOLE: "Search Console",
  ANALYTICS: "Analytics",
  CMS: "Publishing targets",
  TRAVEL_DATA: "Travel data",
  CRAWLER: "Crawling",
  AI_VISIBILITY: "Answer engines",
};

export default async function IntegrationsPage() {
  const { auth, project } = await requireProject();
  const integrations = await listIntegrations(auth.organizationId, project.id);

  const byCategory = integrations.reduce<Record<string, typeof integrations>>((acc, i) => {
    (acc[i.category] ??= []).push(i);
    return acc;
  }, {});

  const connected = integrations.filter((i) => i.status === "CONFIGURED").length;
  const mocked = integrations.filter((i) => i.status === "NOT_CONFIGURED" && i.hasMock);
  const blocked = integrations.filter((i) => i.status === "NOT_CONFIGURED" && !i.hasMock);

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Agents never hold API keys. They request a tool; the Tool Registry resolves the credential server-side, calls the provider and returns a structured result."
        meta={
          <>
            <Badge tone="ok">{connected} connected</Badge>
            <Badge tone="mock">{mocked.length} on mock adapters</Badge>
            {blocked.length ? <Badge tone="warn">{blocked.length} unavailable</Badge> : null}
            <Badge tone="neutral">DEMO_MODE={String(env().DEMO_MODE)}</Badge>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Callout tone="info" title="How credentials are handled">
          Values are encrypted with AES-256-GCM before they touch the database and are decrypted only inside the tool
          execution call stack. They are never returned to the browser, never interpolated into a prompt, and never written to
          a log. The form shows a display hint only.
        </Callout>
        <Callout tone="mock" title="What happens without a key">
          With <strong>DEMO_MODE=true</strong> a missing integration falls back to its labelled mock adapter, and every result
          it produces is flagged MOCK throughout the UI. With DEMO_MODE=false the tool fails loudly instead — nothing is
          fabricated either way. Live flight prices have <em>no</em> mock adapter at all: without a provider the price block
          is simply omitted from the page.
        </Callout>
      </div>

      {Object.entries(byCategory).map(([category, items]) => (
        <section key={category} className="mb-6">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-3)]">
            {CATEGORY_LABEL[category] ?? category}
          </h2>
          <Grid cols={2}>
            {items.map((i) => (
              <div key={i.provider} className="fm-card flex flex-col p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13.5px] font-semibold">{i.name}</h3>
                      <StatusBadge status={i.status} />
                      {i.status === "NOT_CONFIGURED" && i.hasMock ? <MockBadge label="USING MOCK" /> : null}
                    </div>
                    <p className="mt-1 text-[12px] text-[var(--color-ink-2)]">{i.description}</p>
                  </div>
                  {i.docsUrl ? (
                    <a href={i.docsUrl} target="_blank" rel="noreferrer" className="shrink-0 text-[11.5px] text-[var(--color-brand)] hover:underline">
                      Docs
                    </a>
                  ) : null}
                </div>

                <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                  <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-ink-4)]">
                    {i.status === "CONFIGURED" ? "Connected — this integration does real work" : "Not connected — behaviour"}
                  </div>
                  <p className="text-[11.5px] text-[var(--color-ink-2)]">{i.degradesTo}</p>
                </div>

                {i.lastError ? (
                  <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">Last error: {i.lastError}</p>
                ) : null}

                <div className="mt-3 border-t border-[var(--color-border)] pt-3">
                  <IntegrationForm
                    integration={{
                      ...i,
                      testable: isTestable(i.provider),
                      // Only a stored secret can be disconnected; an env-var
                      // fallback is removed from .env, not from here.
                      connected: i.credentials.some((c) => c.source === "database"),
                    }}
                  />
                </div>
              </div>
            ))}
          </Grid>
        </section>
      ))}
    </>
  );
}
