# Moneta

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Self-hosted personal finance aggregation for the UK: connects your bank
accounts through TrueLayer (Open Banking), keeps a normalized local history in
PostgreSQL, and pushes transactions into [Actual Budget](https://actualbudget.org)
automatically.

```text
UK Banks ──Open Banking──▶ TrueLayer ──▶ Moneta Sync Service
                                            │
                                            ├──▶ PostgreSQL (canonical history)
                                            └──▶ Actual Budget (budgeting UI)
```

Single-user, read-only, runs entirely on your own hardware. The local database
is the source of truth — TrueLayer and Actual are both replaceable. Full
design: [`spec.md`](spec.md).

## Quickstart

Prerequisites: Docker with Compose, a [TrueLayer console](https://console.truelayer.com)
app (sandbox works out of the box; live access needs approval).

```bash
cp .env.example .env
# fill in:
#   API_TOKEN=$(openssl rand -hex 24)
#   APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
#   TRUELAYER_CLIENT_ID / TRUELAYER_CLIENT_SECRET   (see docs/truelayer-setup.md)
#   ACTUAL_PASSWORD / ACTUAL_SYNC_ID                (see docs/actual-setup.md)
docker compose up -d
```

Then:

1. Open **http://localhost:3000/ui**, paste your `API_TOKEN`.
2. Connect a bank (`POST /connections/truelayer` returns the auth URL — see
   [docs/truelayer-setup.md](docs/truelayer-setup.md) for the walkthrough).
3. Transactions sync on the `SYNC_CRON` schedule (default every 6 hours), or
   press **Sync now** in the UI.
4. Budget in Actual at **http://localhost:5006** — accounts and transactions
   appear there automatically ([docs/actual-setup.md](docs/actual-setup.md)).

## API

All endpoints except `/health`, `/ui`, and the OAuth callback require
`Authorization: Bearer $API_TOKEN`.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `GET /status` | connections, accounts, balances, last sync run |
| `POST /connections/truelayer` | start a bank authorization |
| `GET /connections` · `DELETE /connections/:id` | list / soft-disable |
| `POST /connections/:id/reauthorize` | renew an expired consent |
| `GET /accounts` | accounts with latest balances |
| `POST /sync` · `POST /sync/:accountId` | manual sync |
| `GET /sync/runs` | sync history with error details |
| `GET /export/transactions.csv` | full history export |

## Development

```bash
npm install
docker compose up -d postgres
npm test          # unit + integration tests (uses a finance_test database)
npm run dev       # tsx watch mode
```

Money is stored as integer pence (`BIGINT`), negative = money out. Sync is
idempotent — rerunning never duplicates transactions, locally or in Actual.

Backups: dump PostgreSQL (`pg_dump finance`), back up the Actual data volume,
and keep `.env` somewhere safe — see spec §37.

## Roadmap

Moneta's canonical local history (PostgreSQL) is the foundation for
AI-native personal finance planning — that's the direction the project is
headed, on top of the current sync/budgeting MVP. See [spec.md](spec.md) for
the full design and current status.

## Using with Claude Code

This project includes a [`CLAUDE.md`](CLAUDE.md) that gives Claude Code full
context on commands, architecture, and configuration.

```bash
claude    # Start Claude Code — reads CLAUDE.md automatically
```

## License

MIT — see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
