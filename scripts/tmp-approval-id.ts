import "dotenv/config";
import { prisma } from "../src/core/db/client";
(async () => {
  const a = await prisma.approval.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "desc" } });
  console.log(a?.id ?? "NONE");
})().finally(() => prisma.$disconnect());
