/**
 * Vitest global setup.
 *
 * Builds a dedicated test database from the same migrations the app uses, then
 * seeds the configuration. Tests therefore run against the real schema and the
 * real seed - not a stub - while leaving the development database untouched.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default async function globalSetup() {
  const dbFile = path.join(process.cwd(), "prisma", "test.db");
  const url = `file:${dbFile.replace(/\\/g, "/")}`;

  for (const suffix of ["", "-journal"]) {
    const f = `${dbFile}${suffix}`;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }

  const env = { ...process.env, DATABASE_URL: url, LOG_SILENT: "true" };

  execSync("npx prisma db push --skip-generate --accept-data-loss", { env, stdio: "pipe" });
  execSync("npx tsx scripts/seed.ts", { env, stdio: "pipe" });

  return async () => {
    // Leave the file behind for post-mortem inspection; it is gitignored.
  };
}
