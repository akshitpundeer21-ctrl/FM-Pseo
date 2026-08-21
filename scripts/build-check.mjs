/**
 * Verification build into a separate output directory.
 *
 * `next build` and `next dev` both write to .next. Running a build while the dev
 * server is up replaces the dev chunks on disk; the dev server keeps serving
 * manifests that point at the old filenames, every <script> and stylesheet 404s,
 * and the dev overlay surfaces the resulting load event as "[object Event]".
 *
 * This builds into .next-build instead, so "does it still compile?" never
 * disturbs a running dev server. Use `npm run build` for a real deploy build.
 *
 * Run:  npm run build:check
 */
import { spawn } from "node:child_process";

const child = spawn("next", ["build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NEXT_DIST_DIR: ".next-build" },
});

child.on("exit", (code) => process.exit(code ?? 1));
