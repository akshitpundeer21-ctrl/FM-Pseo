/**
 * Prisma client singleton.
 *
 * Next.js dev-mode hot reload re-evaluates modules; without the global cache we
 * would leak a new connection pool on every edit.
 */
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __faresmatchPrisma: PrismaClient | undefined;
}

function create(): PrismaClient {
  return new PrismaClient({
    log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient = global.__faresmatchPrisma ?? create();

if (process.env.NODE_ENV !== "production") {
  global.__faresmatchPrisma = prisma;
}

export type { PrismaClient };
