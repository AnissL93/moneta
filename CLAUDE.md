# Moneta

**Version:** 0.1.0 | **Port:** 3000 | **Stack:** TypeScript, npm workspaces, Fastify, Prisma, PostgreSQL, Docker

## What
Self-hosted, single-user personal finance aggregator for the UK: syncs bank
accounts via TrueLayer (Open Banking) into a canonical PostgreSQL history and
pushes transactions into Actual Budget. AI-native financial planning features
are the project's direction — see the roadmap note in README.md.

## Quick Start

```bash
./setup.sh                    # First-time setup
docker compose up -d          # Start moneta + postgres + actual-server
npm test                      # Run tests (needs compose postgres up)
```

## Commands

```bash
# Development
npm install                          # Install dependencies (workspace root)
npm run dev                          # tsx watch mode (apps/server)
npm run build                        # tsc build (apps/server)
docker compose up -d postgres        # Start only postgres for local dev

# Testing
npm test                             # vitest run, uses a finance_test database
                                      # (auto-created by apps/server/vitest.global-setup.ts)

# Prisma (run from apps/server)
npm run prisma:generate -w apps/server   # Regenerate Prisma client
npm run prisma:migrate -w apps/server    # Create/apply a dev migration

# Docker (primary runtime)
cp .env.example .env
docker compose up -d --build         # moneta (:3000), postgres (:5432), actual-server (:5006)
```

## Architecture

```
apps/server/src/
  index.ts               entry point
  server.ts               Fastify app assembly
  config/                 env var loading + validation
  db/                     Prisma client wiring, test helpers
  providers/               BankingProvider interface + TrueLayer implementation, retry wrapper
  services/
    connections/           bank connection lifecycle (auth, reauthorize, disable)
    sync/                   account/transaction sync from provider into Postgres
    reconciliation/         idempotent matching against existing local/Actual records
  integrations/actual/     Actual Budget API client
  jobs/scheduler.ts        node-cron scheduled sync
  routes/                  connections, sync, status, ui (Fastify route handlers)
docker/                  Dockerfile + entrypoint.sh (runs prisma migrate deploy, then starts server)
docs/                    truelayer-setup.md, actual-setup.md walkthroughs
spec.md                  full design/technical specification
```

Banks (via TrueLayer) are the external data source; PostgreSQL is the source
of truth; Actual Budget is a downstream, replaceable budgeting UI. The
scheduler triggers `services/sync` on `SYNC_CRON`, which calls the provider,
writes to Postgres via Prisma, and reconciles into Actual.

## Key Files

- `apps/server/src/server.ts` — Fastify app assembly, route registration
- `apps/server/src/providers/banking-provider.ts` — provider interface (swap TrueLayer for another bank API)
- `apps/server/src/services/sync/` — core sync logic, idempotency
- `apps/server/prisma/schema.prisma` — database schema
- `docker-compose.yml` — moneta / postgres / actual-server services
- `spec.md` — authoritative design doc

## Configuration

All configuration is via environment variables. See `.env.example`:

| Variable | Required | Description |
|----------|----------|--------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `API_TOKEN` | yes | Bearer token securing all non-public endpoints |
| `TRUELAYER_CLIENT_ID` / `TRUELAYER_CLIENT_SECRET` | yes | TrueLayer console app credentials |
| `TRUELAYER_REDIRECT_URI` | yes | OAuth callback URL |
| `TRUELAYER_ENVIRONMENT` | no | `sandbox` (default) or `live` |
| `APP_ENCRYPTION_KEY` | yes | Encrypts stored provider tokens/raw data |
| `SYNC_CRON` | no | Cron schedule for auto-sync (default every 6 hours) |
| `SYNC_OVERLAP_DAYS` / `INITIAL_SYNC_DAYS` / `PENDING_EXPIRY_DAYS` | no | Sync window tuning |
| `ACTUAL_SERVER_URL` / `ACTUAL_PASSWORD` / `ACTUAL_SYNC_ID` | yes | Actual Budget connection (sync ID is the Actual budget's group ID) |
| `ACTUAL_ENCRYPTION_PASSWORD` | no | Only if the Actual budget file uses end-to-end encryption |
| `STORE_RAW_PROVIDER_DATA` | no | Persist raw provider payloads for debugging |

Money is stored as integer pence (`BIGINT`); negative values mean money out.
Sync is idempotent — rerunning never duplicates transactions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
