import "dotenv/config";
import { prisma } from "../src/core/db/client";

(async () => {
  const v = await prisma.pageVersion.findFirst({ orderBy: { createdAt: "desc" } });
  if (!v) return console.log("no version");
  const facts = JSON.parse(v.factsJson || "{}");
  console.log("--- VERDICTS ---");
  for (const d of facts.verdicts ?? []) {
    console.log(`[${d.status}] (${d.kind}) "${d.claim}"  <- ${d.evidence ?? ""}`);
  }
  console.log("\n--- STORED FACTS ---");
  const rows = await prisma.fact.findMany({ where: { subject: { startsWith: "route:" } }, orderBy: { retrievedAt: "desc" }, take: 40 });
  const seen = new Set<string>();
  for (const f of rows) {
    if (seen.has(f.predicate)) continue;
    seen.add(f.predicate);
    console.log(`  ${f.predicate} = ${f.value.slice(0, 70)}  (mock=${f.isMock})`);
  }
})().finally(() => prisma.$disconnect());
