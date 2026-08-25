# Deployment

The MVP is built to run locally first. Everything below is what changes when you move it off localhost.

---

## Before anything else

- [ ] Change the demo password, or delete `admin@faresmatch.local` and create a real account
- [ ] Generate fresh `APP_ENCRYPTION_KEY` and `SESSION_SECRET` (32 random bytes each)
- [ ] Set `DEMO_MODE=false` so a missing integration fails loudly instead of falling back to a mock
- [ ] Set `APP_URL` to the real origin — canonicals, sitemap entries and publish URLs derive from it
- [ ] Move to PostgreSQL
- [ ] Confirm `.env` is not committed (it is gitignored)

Rotating `APP_ENCRYPTION_KEY` invalidates every stored credential — they must be re-entered. Decrypting
with the wrong key fails closed with a clear error rather than returning garbage.

---

## PostgreSQL

The schema already uses `provider = "postgresql"`. Set your connection string in `.env`:

```
DATABASE_URL="postgresql://user:password@host:5432/faresmatch?schema=public&connection_limit=10"
```

Then push the schema and seed:

```bash
npx prisma db push
npx tsx scripts/seed.ts
```

Consider adding, once you have traffic: partial indexes on `Page.status` and `Task.status`, and a
retention policy for `LogEntry` and `AgentRun`.

---

## Build and run

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

`npm start` serves on `PORT` (default 3000). Put it behind a TLS-terminating proxy.

### Docker sketch

```dockerfile
FROM node:24-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/data ./data
COPY --from=build /app/public ./public
COPY package*.json ./
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
```

`data/` must be present — the reference datasets are read from disk at run time.

If you keep the `local_static` publishing adapter, `PUBLISH_LOCAL_DIR` needs a **persistent volume**.
Container filesystems are ephemeral; published files would vanish on redeploy. For any real deployment,
publish to a CMS or object storage instead.

---

## Vercel + Supabase

The recommended serverless setup. Vercel runs the Next.js app; Supabase provides PostgreSQL.

### Supabase setup

1. Create a project at [supabase.com](https://supabase.com)
2. Copy the **Connection string (Transaction)** from Settings → Database → Connection string
3. It looks like: `postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres`

### Vercel setup

1. Import the repo from GitHub
2. Set environment variables in the Vercel project settings:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase connection string |
| `APP_URL` | `https://your-domain.vercel.app` |
| `APP_ENCRYPTION_KEY` | Fresh 32-byte hex key |
| `SESSION_SECRET` | Fresh 32-byte hex key |
| `PUBLISH_ADAPTER` | `database` |
| `DEMO_MODE` | `true` (or `false` with real provider keys) |
| `NODE_ENV` | `production` |

3. The build command is auto-detected (`vercel-build` script runs `prisma generate && prisma migrate deploy && next build`)
4. First deploy creates the database tables via `prisma migrate deploy`

### How published pages are served on Vercel

`PUBLISH_ADAPTER=database` stores the full rendered HTML in `Page.publishedHtml`. The `/site/*` route
reads from the database instead of the filesystem. Existing adapters (webhook, wordpress) continue to
work alongside it.

---

## Serverless notes

1. **`local_static` will not work on serverless** — there is no persistent writable filesystem. Use the
   `database`, `webhook`, or `wordpress` adapter.
2. **Workflow runs are long.** A full growth workflow takes 30–60 seconds, which exceeds some function
   timeouts. Move the engine behind a queue first (see below).

Use a pooled Postgres connection (PgBouncer, Neon, Supabase pooler) and set `connection_limit` accordingly.

---

## Background processing

Workflows currently execute inline in the request. For production:

1. `POST /api/goals` enqueues instead of executing, and returns the run id immediately.
2. A worker calls `startWorkflow` / `resumeWorkflow`.
3. Approving an approval enqueues a resume rather than resuming inline.

The engine is already resumable and persists its context on every step, which is the part that usually
makes this migration hard. BullMQ + Redis, or any hosted queue, will do.

The same worker should run scheduled monitoring: a daily Search Performance run and a weekly AI Visibility
sweep.

---

## Scaling considerations

**Rate limiting** is in-process. With more than one instance, move `src/control-plane/budget.ts`'s window
store to Redis.

**Budgets** are already database-backed and therefore correct across instances.

**Crawling** should move to a dedicated worker with a global politeness budget once you crawl anything
beyond your own site. The `Crawler` interface exists for swapping in a hosted service.

**Logging** — `LogEntry` grows quickly. Either add a retention job or send logs to a real log sink and keep
only WARN+ in the database.

---

## Security checklist

- [ ] Fresh `APP_ENCRYPTION_KEY` and `SESSION_SECRET`, stored in a secret manager, not in a file
- [ ] `DEMO_MODE=false`
- [ ] TLS terminated in front of the app (`secure` cookies switch on automatically in production)
- [ ] Real accounts with least-privilege roles (`VIEWER` / `EDITOR` / `ADMIN` / `OWNER`)
- [ ] `SESSION_TTL_HOURS` shortened from the 168-hour default if appropriate
- [ ] Database backups, including the `Credential` table
- [ ] Monitoring on the audit log for `page.published`, `approval.rejected` and `control_plane.deny:*`
- [ ] Budgets set to values you are willing to actually spend

---

## Configuration reference

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Connection string |
| `APP_URL` | Public origin; canonicals and publish URLs derive from it |
| `APP_ENCRYPTION_KEY` | 32-byte key for credential encryption |
| `SESSION_SECRET` | Session cookie HMAC key |
| `SESSION_TTL_HOURS` | Session lifetime (default 168) |
| `DEMO_MODE` | Mock fallback on/off |
| `DEFAULT_APPROVAL_MODE` | Approval posture for new projects |
| `PUBLISH_ADAPTER` | `local_static` \| `database` \| `webhook` \| `wordpress` |
| `PUBLISH_LOCAL_DIR` | Where `local_static` writes |
| `AI_VISIBILITY_PLATFORMS` | Which answer engines to probe |
| `CRAWLER_*` | User agent, page cap, concurrency, timeout |
| `DEFAULT_MONTHLY_*_BUDGET` | Budget defaults for new organizations |
| `AGENT_MAX_RETRIES`, `AGENT_TIMEOUT_MS` | Agent execution guardrails |

Provider credentials are listed in [INTEGRATIONS.md](INTEGRATIONS.md). Prefer entering them through
`/integrations` (encrypted at rest) over environment variables.
