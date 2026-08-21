/**
 * Per-worker setup. Must not import the Prisma client: the DATABASE_URL has to
 * be in place before any module reads it.
 */
import path from "node:path";

const dbFile = path.join(process.cwd(), "prisma", "test.db").split(path.sep).join("/");

process.env.DATABASE_URL = `file:${dbFile}`;
process.env.LOG_SILENT = "true";
process.env.DEMO_MODE = "true";
// NODE_ENV is already "test" under vitest and is read-only in the type system.
process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY || "0".repeat(64);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.PUBLISH_LOCAL_DIR = "./published-test";
process.env.APP_URL = "http://localhost:3000";
