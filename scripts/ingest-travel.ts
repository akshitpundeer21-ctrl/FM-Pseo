/**
 * Populate the Travel Data Layer.
 *
 * Reads from a travel data provider and writes normalized, provenance-carrying
 * rows into the travel tables. Safe to re-run: a lower-trust source never
 * overwrites a higher-trust one, so re-running the bundled provider will not
 * clobber anything ingested from a credentialed API.
 *
 * Run:  npx tsx scripts/ingest-travel.ts [--dry-run] [--provider bundled_reference]
 */
import "dotenv/config";
import { prisma } from "../src/core/db/client";
import { BundledReferenceProvider } from "../src/modules/travel/providers/bundled";
import { ingestFromProvider } from "../src/modules/travel/ingest";
import { travelDataStats } from "../src/modules/travel/service";
import type { TravelDataProvider } from "../src/modules/travel/types";

const PROVIDERS: Record<string, () => TravelDataProvider> = {
  bundled_reference: () => new BundledReferenceProvider(),
};

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const providerKey = args[args.indexOf("--provider") + 1] ?? "bundled_reference";

  const factory = PROVIDERS[providerKey];
  if (!factory) {
    console.error(`Unknown provider "${providerKey}". Known: ${Object.keys(PROVIDERS).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const provider = factory();
  console.log(`\nIngesting travel data from "${provider.name}"${dryRun ? " (dry run)" : ""}…\n`);

  const report = await ingestFromProvider(provider, { dryRun });

  if (!report.available) {
    console.log(`  UNAVAILABLE — ${report.unavailableReason}`);
    return;
  }

  for (const [kind, c] of Object.entries(report.counts)) {
    console.log(`  ${kind.padEnd(16)} created ${String(c.created).padStart(4)}   updated ${String(c.updated).padStart(4)}   skipped ${String(c.skipped).padStart(4)}`);
  }

  if (report.rejected.length) {
    console.log(`\n  ${report.rejected.length} row(s) rejected — nothing was silently dropped:`);
    for (const r of report.rejected.slice(0, 15)) console.log(`    ${r.kind.padEnd(14)} ${r.key.padEnd(22)} ${r.reason}`);
    if (report.rejected.length > 15) console.log(`    … and ${report.rejected.length - 15} more`);
  }

  const stats = await travelDataStats();
  console.log(`\n  Travel Data Layer now holds:`);
  for (const [k, v] of Object.entries(stats.counts)) console.log(`    ${k.padEnd(16)} ${v}`);
  console.log(
    `\n  Provenance: ${stats.provenance.allReferenceData ? "ALL rows are approximate reference data (isMock)." : `${stats.provenance.mockAirports} of the airports and ${stats.provenance.mockRoutes} of the routes are reference data.`}`,
  );
  console.log(`  Took ${report.durationMs} ms.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
