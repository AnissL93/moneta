# Actual Budget Setup Guide

Phase 4 exports synced bank transactions into Actual automatically. One-time
setup:

## 1. Create the budget

1. Open the Actual UI at <http://localhost:5006>.
2. On first visit, set the **server password** (this becomes `ACTUAL_PASSWORD`).
3. Create a budget file (or import an existing one).
4. In *Settings → Advanced settings → Sync ID*, copy the UUID
   (this is `ACTUAL_SYNC_ID`). Copy it exactly from that screen — Actual has
   several internal UUIDs per budget (file id, group id, local id) and
   `downloadBudget` accepts only the one labelled **Sync ID** (the group id).
   If the service logs `Budget "…" not found`, the value came from the wrong
   place; the correct one can also be read from the server:
   `curl -s http://localhost:5006/sync/list-user-files -H "X-ACTUAL-TOKEN: <token>"`
   → use the `groupId` field.
5. If you enabled end-to-end encryption on the budget file, note that
   password too (`ACTUAL_ENCRYPTION_PASSWORD`); otherwise leave it empty.

## 2. Configure the service

Fill in `.env`:

```env
ACTUAL_SERVER_URL=http://actual-server:5006
ACTUAL_PASSWORD=<server password>
ACTUAL_SYNC_ID=<sync id uuid>
ACTUAL_ENCRYPTION_PASSWORD=
ACTUAL_DATA_DIR=/data/actual-cache
```

`ACTUAL_SERVER_URL` uses the Docker-internal hostname; the data dir is a
mounted volume where `@actual-app/api` caches the budget file.

Restart: `docker compose up -d --build moneta`.

Without these three values the service runs bank sync only and logs
"Actual Budget not configured — transactions stay local only".

## 3. How the export behaves

- Export runs automatically at the end of every sync run (scheduled or manual).
- The first export creates or links Actual accounts by name — a local account
  named "Main Current" links to an open Actual account of the same name
  (case-insensitive), otherwise a new Actual account is created. The link is
  persisted in `actual_account_links` and never re-derived (spec §24).
- Transactions carry `imported_id` = the local transaction id, so repeated
  syncs never duplicate them in Actual (spec §26).
- Pending transactions arrive uncleared; when they settle, the next export
  updates the cleared flag.
- Categorize freely in Actual — the exporter never overwrites payee, category,
  or notes on existing transactions, and nothing flows back into the local DB.
- If Actual is down, the sync run records an `ACTUAL_ERROR` (visible in
  `GET /sync/runs`) and the affected rows are retried on the next run.

## 4. Verify

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/sync
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/sync/runs | head -c 600
```

Then open Actual at <http://localhost:5006> — the bank accounts and their
transactions should be there, ready to categorize.
