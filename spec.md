# UK Personal Finance Aggregator — Technical Specification

**Status:** Draft / MVP
**Version:** 0.2
**Target user:** Single personal user
**Primary market:** United Kingdom
**Primary currency:** GBP
**Deployment model:** Self-hosted
**Primary objective:** Automatically aggregate personal UK bank-account data into a locally controlled financial database and Actual Budget instance.

---

## 1. Overview

Build a self-hosted personal finance aggregation service that connects the user's UK bank accounts through an Open Banking provider, periodically imports account balances and transactions, stores a normalized local copy, and synchronizes transactions into Actual Budget.

The system is intended exclusively for the owner's personal financial data.

Initial architecture:

```text
UK Banks
  │
  │ Open Banking
  ▼
TrueLayer
  │
  │ Data API
  ▼
Moneta Sync Service
  │
  ├──────────────► Local PostgreSQL / SQLite
  │
  └──────────────► Actual Budget API
                       │
                       ▼
                 Actual Budget UI
```

The system must retain its own normalized historical dataset so that TrueLayer is treated as a replaceable data provider rather than the permanent source of truth.

---

## 2. Goals

The MVP must allow the user to:

1. Connect one or more supported UK bank accounts.
2. Retrieve available accounts from each bank connection.
3. Retrieve account balances.
4. Retrieve settled transactions.
5. Retrieve pending transactions where supported.
6. Automatically refresh data on a configurable schedule.
7. Store imported data locally.
8. Prevent duplicate transaction imports.
9. Synchronize transactions into Actual Budget.
10. Recover from temporary bank/API failures without corrupting data.
11. Detect when a bank connection requires reauthorization.
12. Reauthorize without deleting previously imported history.
13. Run entirely through Docker on a personal computer, server or NAS.
14. Export all locally stored data without dependence on the aggregation provider.

TrueLayer's Data API supports account, balance and transaction access; its newer Data API v3 uses explicit connection resources and scopes including `accounts`, `balance`, and `transactions`.

---

## 3. Non-goals

The MVP will NOT:

* initiate bank payments;
* transfer money;
* provide lending or credit decisions;
* support multiple application users;
* expose financial information publicly;
* automatically move money;
* attempt to replace bank authentication;
* scrape online banking websites;
* classify every transaction using machine learning;
* provide tax or investment advice;
* store bank login passwords;
* become an FCA-regulated consumer-facing Open Banking product.

The system is read-only.

---

## 4. Product principles

### 4.1 Local data ownership

Once a transaction has been successfully downloaded, the application should retain it locally indefinitely unless explicitly deleted by the user.

TrueLayer should not be the historical database.

### 4.2 Provider independence

Business logic must not directly depend on TrueLayer response formats.

The application should implement a provider interface:

```ts
interface BankingProvider {
  createConnection(): Promise<Connection>;
  refreshConnection(connectionId: string): Promise<Connection>;
  getAccounts(connectionId: string): Promise<Account[]>;
  getBalances(accountId: string): Promise<Balance>;
  getTransactions(
    accountId: string,
    from: Date,
    to: Date
  ): Promise<Transaction[]>;
}
```

Initial implementation:

```text
BankingProvider
    └── TrueLayerProvider
```

Future providers could include:

```text
PlaidProvider
YapilyProvider
ManualCSVProvider
BankAPIProvider
```

without requiring changes to the internal financial model.

---

## 5. Proposed technology stack

### Backend

**Node.js + TypeScript**

Reasons:

* TrueLayer integration is straightforward.
* Actual Budget provides an official Node package.
* One runtime can handle both the bank integration and Actual synchronization.

Actual Budget exposes programmatic functionality through the `@actual-app/api` NPM package rather than a conventional HTTP REST API.

Recommended framework:

```text
Node.js
TypeScript
Fastify
Zod
Prisma or Drizzle ORM
```

### Database

Production recommendation:

```text
PostgreSQL
```

Optional lightweight installation:

```text
SQLite
```

PostgreSQL should be the default Docker configuration.

Support exactly one database engine in the MVP (PostgreSQL). SQLite can follow later; do not maintain two schemas and two sets of migration quirks from day one.

### Scheduler

MVP:

```text
node-cron
```

or a simple internal scheduled worker.

Avoid introducing Redis/BullMQ until required.

### User interface

MVP:

```text
Actual Budget
```

The custom application does not require a full financial dashboard initially.

A minimal administration page may later expose:

```text
Connections
Accounts
Last sync
Sync errors
Reauthorization
Manual sync
```

---

## 6. Components

The system consists of five logical components.

```text
┌───────────────────────────┐
│       Auth Service        │
│ TrueLayer authorization   │
└──────────────┬────────────┘
               │
               ▼
┌───────────────────────────┐
│      Banking Adapter      │
│ TrueLayer API abstraction │
└──────────────┬────────────┘
               │
               ▼
┌───────────────────────────┐
│       Sync Engine         │
│ incremental synchronization│
└─────────┬─────────┬───────┘
          │         │
          ▼         ▼
┌───────────────┐ ┌────────────────┐
│ Local DB      │ │ Actual Adapter │
│ canonical data│ │ Actual Budget  │
└───────────────┘ └────────────────┘
```

---

## 7. TrueLayer integration

### 7.1 API version

The application targets **Data API v1** (classic OAuth2 code flow plus synchronous `GET /data/v1/...` endpoints).

TrueLayer recommends Data API v3 for first-time integrations, but v3's connection model is built around hosted UI journeys, user PII in connection requests, and asynchronous webhook delivery — a poor fit for a self-hosted service bound to localhost/VPN. v1 remains fully supported and matches the deployment model. See ADR-006. The `BankingProvider` abstraction keeps a later v3 (or other-provider) migration contained.

All TrueLayer-specific code must remain inside:

```text
/src/providers/truelayer/
```

Example:

```text
src/
  providers/
    banking-provider.ts
    truelayer/
      client.ts
      auth.ts
      connections.ts
      accounts.ts
      transactions.ts
      mapper.ts
```

### 7.2 Token lifecycle

TrueLayer issues short-lived access tokens together with a longer-lived refresh token.

The application must:

* refresh access tokens automatically when they expire (or shortly before);
* persist the newest refresh token immediately after every refresh — refresh tokens may rotate, and losing the newest one breaks the connection;
* treat a failed refresh as `REAUTH_REQUIRED`, not as a fatal error.

### 7.3 Consent lifetime

UK Open Banking connections do not last forever: consent must be periodically reconfirmed (historically on a ~90-day cycle).

Therefore:

* store `consent_expires_at` on each connection when the provider exposes it;
* surface upcoming expiry in the status UI *before* the connection breaks;
* treat consent expiry as a normal lifecycle event (`REAUTH_REQUIRED`), not an error.

### 7.4 Environments

Develop against the TrueLayer sandbox first. Live (production) data access requires approval in the TrueLayer console; obtaining live access is a hard prerequisite for the MVP and should be started early, in parallel with Phase 1.

---

## 8. Required permissions

Request the minimum required permissions:

```text
accounts
balance
transactions
```

Optional future permissions:

```text
info
```

Do not request permissions unrelated to the application.

TrueLayer scopes determine which financial data the application may access.

---

## 9. Connection flow

### Initial bank connection

User flow:

```text
Settings
   ↓
Add bank
   ↓
Select bank/provider
   ↓
TrueLayer authorization
   ↓
Bank authentication
   ↓
User consent
   ↓
Return to callback
   ↓
Store connection
   ↓
Discover accounts
   ↓
Initial historical sync
```

The application never receives the user's online banking password.

Authentication occurs through the bank/Open Banking authorization process.

---

## 10. Connection state

Each connection has one of the following states:

```text
ACTIVE
REAUTH_REQUIRED
EXPIRED
ERROR
DISABLED
```

Example:

```ts
type ConnectionStatus =
  | "ACTIVE"
  | "REAUTH_REQUIRED"
  | "EXPIRED"
  | "ERROR"
  | "DISABLED";
```

When authorization expires, historical data must remain available.

A reauthorization operation updates the connection credentials but MUST NOT create duplicate accounts or transactions.

---

## 11. Account model

Normalized internal model:

```ts
interface Account {
  id: string;

  provider: "truelayer";

  providerConnectionId: string;
  providerAccountId: string;

  name: string;
  displayName?: string;

  type:
    | "CURRENT"
    | "SAVINGS"
    | "CREDIT_CARD"
    | "OTHER";

  currency: string;

  accountNumberLast4?: string;
  sortCodeMasked?: string;

  institutionName?: string;

  currentBalance?: Decimal;
  availableBalance?: Decimal;

  active: boolean;

  createdAt: Date;
  updatedAt: Date;
  lastSyncedAt?: Date;
}
```

Sensitive full account numbers should not be stored unless there is a clear functional need.

Prefer:

```text
****1234
```

rather than a complete account number.

---

## 12. Transaction model

Canonical transaction structure:

```ts
interface Transaction {
  id: string;

  provider: "truelayer";
  providerTransactionId?: string;

  accountId: string;

  status:
    | "PENDING"
    | "SETTLED";

  timestamp: Date;
  bookedDate?: Date;

  amount: Decimal;
  currency: string;

  description: string;

  merchantName?: string;

  transactionType?: string;
  category?: string;

  runningBalance?: Decimal;

  rawHash: string;

  importedToActual: boolean;
  actualTransactionId?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

TrueLayer's transaction APIs provide data including transaction descriptions, amounts, merchant-related information and categories where available.

All timestamps are stored in UTC. `bookedDate` is a calendar date (no time zone); use it, not the timestamp, for date-based matching and for export to Actual.

---

## 13. Monetary conventions

Never store monetary values using JavaScript floating-point arithmetic.

Acceptable representations:

```text
Decimal
```

or:

```text
integer minor units
```

Example:

```text
£12.34
```

becomes:

```text
1234 pence
```

Recommended internal representation:

```ts
amountMinor: bigint
currency: "GBP"
```

External provider values should be normalized immediately after ingestion.

Sign convention (canonical, applied everywhere):

```text
negative = money out (debit)
positive = money in  (credit)
```

Normalize each provider's sign convention to this at ingestion. This matches Actual Budget, which also expects integer minor units with negative amounts for outflows.

---

## 14. Transaction identity and deduplication

Transaction deduplication is a critical requirement.

Preferred unique identifier:

```text
provider + provider_account_id + provider_transaction_id
```

Database constraint:

```text
UNIQUE(provider, provider_account_id, provider_transaction_id)
```

However, provider transaction IDs cannot universally be assumed to remain available or identical in every lifecycle state.

Therefore implement a fallback fingerprint:

```text
SHA256(
  account_id
  + normalized_date
  + normalized_amount
  + normalized_description
  + merchant_name
)
```

Store:

```text
raw_hash
```

Use this only as a fallback deduplication mechanism.

**Fingerprint collisions are real.** Two genuinely distinct transactions can share account, date, amount, description and merchant (e.g. two identical coffees on the same day). To avoid silently dropping the second one, include an occurrence index in the fingerprint:

```text
SHA256(
  account_id
  + normalized_date
  + normalized_amount
  + normalized_description
  + merchant_name
  + occurrence_index
)
```

where `occurrence_index` is the ordinal (0, 1, 2, …) of otherwise-identical rows within the same provider response. Only rows missing a provider transaction ID should ever rely on the fingerprint.

Because `UNIQUE(account_id, raw_hash)` applies to every row, rows that *do* have a provider transaction ID store `raw_hash = SHA256(account_id + "ptid" + provider_transaction_id)` instead of the content fingerprint — otherwise two genuinely distinct transactions with identical content but different provider IDs would collide on the constraint, and a description correction upstream would change the hash of an unchanged transaction.

Note: TrueLayer exposes several identifiers (its own transaction ID plus normalised provider transaction IDs). Verify empirically during Phase 2 which of them survives reauthorization unchanged, and use that one as `provider_transaction_id`.

---

## 15. Pending transaction handling

A pending transaction may later become a settled transaction.

Do NOT immediately treat:

```text
Pending Starbucks £4.50
```

and:

```text
Settled Starbucks £4.50
```

as permanently independent transactions.

Reconciliation should attempt matching based on:

```text
account
amount
merchant
date proximity
provider metadata
```

When a pending transaction becomes settled:

```text
PENDING
   ↓
SETTLED
```

prefer updating/replacing the pending record instead of generating two permanent transactions.

Pending transactions that never settle (declined payments, expired card authorizations) must not linger forever. If a pending transaction has stopped appearing in provider responses and has not settled within a configurable window:

```env
PENDING_EXPIRY_DAYS=14
```

mark it as removed (soft delete — keep the row) and flag it for review if it was already exported to Actual.

---

## 16. Initial synchronization

When an account is first connected:

```text
1. Retrieve account metadata
2. Retrieve balance
3. Retrieve available historical transactions
4. Normalize
5. Store locally
6. Deduplicate
7. Import into Actual
8. Record sync cursor
```

Configuration:

```env
INITIAL_SYNC_DAYS=365
```

Default:

```text
365 days
```

If the provider exposes less history, import whatever is available.

---

## 17. Incremental synchronization

Normal scheduled synchronization:

```text
lastSuccessfulSync
       │
       ▼
lastSuccessfulSync - overlapWindow
       │
       ▼
      now
```

Recommended overlap:

```env
SYNC_OVERLAP_DAYS=7
```

For example, if the previous successful sync occurred:

```text
20 Aug
```

the next request should fetch from approximately:

```text
13 Aug → today
```

rather than strictly:

```text
20 Aug → today
```

The overlap helps detect:

* changed transaction descriptions;
* pending → settled transitions;
* late-posted transactions;
* provider corrections.

Deduplication makes repeated ingestion safe.

---

## 18. Synchronization frequency

Recommended default:

```text
4 times per day
```

Example schedule:

```text
06:00
12:00
18:00
23:00
```

The scheduler must be configurable.

```env
SYNC_CRON=0 */6 * * *
```

Do not aggressively poll banks.

Provider and bank-side rate limits must be respected. TrueLayer documents rate-limit responses, including HTTP `429`, for account transaction requests.

---

## 19. Synchronization algorithm

Pseudo-code:

```ts
async function syncConnection(connectionId: string) {
  const connection = await getConnection(connectionId);

  if (connection.status !== "ACTIVE") {
    return;
  }

  const accounts =
    await bankingProvider.getAccounts(connection.providerConnectionId);

  for (const remoteAccount of accounts) {
    const account = await upsertAccount(remoteAccount);

    try {
      const balance =
        await bankingProvider.getBalances(remoteAccount.id);

      await updateBalance(account.id, balance);

      const from =
        getSyncStart(account.lastSuccessfulSync);

      const transactions =
        await bankingProvider.getTransactions(
          remoteAccount.id,
          from,
          new Date()
        );

      for (const transaction of transactions) {
        await upsertTransaction(
          normalizeTransaction(transaction)
        );
      }

      await reconcilePendingTransactions(account.id);

      await syncAccountToActual(account.id);

      await markAccountSyncSuccessful(account.id);

    } catch (error) {
      await recordSyncFailure(account.id, error);
    }
  }
}
```

One account failing must not stop synchronization of other accounts.

---

## 20. Idempotency

Every synchronization operation must be safe to execute repeatedly.

For example:

```text
sync()
sync()
sync()
```

must produce the same final dataset as:

```text
sync()
```

assuming provider data has not changed.

This requirement applies to:

* accounts;
* balances;
* transactions;
* Actual imports.

---

## 21. Local database schema

Suggested schema:

```text
connections
accounts
balances
transactions
actual_account_links
sync_runs
sync_errors
settings
```

### connections

```text
id
provider
provider_connection_id
institution_name
status
encrypted_credentials
consent_expires_at
created_at
updated_at
last_successful_sync
```

### accounts

```text
id
connection_id
provider_account_id
name
type
currency
account_number_last4
institution_name
active
created_at
updated_at
last_successful_sync
```

### balances

```text
id
account_id
current_amount_minor
available_amount_minor
currency
observed_at
```

Balance history should be retained rather than overwriting the previous value.

This enables future net-worth charts without reconstructing historical balances.

### transactions

```text
id
account_id
provider_transaction_id
status
timestamp
booked_date
amount_minor
currency
description
merchant_name
category
raw_hash
raw_payload
imported_to_actual
actual_transaction_id
deleted_at
created_at
updated_at
```

Constraints:

```text
UNIQUE(account_id, provider_transaction_id)  -- partial: WHERE provider_transaction_id IS NOT NULL
UNIQUE(account_id, raw_hash)
```

### actual_account_links

```text
id
local_account_id
actual_account_id
created_at
```

### sync_runs

```text
id
connection_id
started_at
finished_at
status
accounts_processed
transactions_received
transactions_inserted
transactions_updated
transactions_skipped
```

### sync_errors

```text
id
sync_run_id
account_id
error_type
message
created_at
```

### settings

Simple key/value storage for runtime-adjustable configuration and internal cursors:

```text
key
value
updated_at
```

---

## 22. Raw provider payloads

Store optional raw provider responses for debugging:

```json
{
  "raw_payload": { }
}
```

Benefits:

* debugging mapping problems;
* future reprocessing;
* examining changes in provider response structure.

However:

1. raw data must never be logged to stdout;
2. raw payloads should be considered sensitive;
3. raw data retention must be configurable.

Example:

```env
STORE_RAW_PROVIDER_DATA=true
```

---

## 23. Actual Budget integration

Actual Budget is the primary financial UI.

Integration should use:

```text
@actual-app/api
```

rather than expecting a REST service. Actual explicitly documents its API as an NPM package intended for tasks including custom transaction importers/exporters.

Create:

```text
/src/integrations/actual/
```

with:

```text
client.ts
accounts.ts
transactions.ts
mapper.ts
```

Operational notes for `@actual-app/api`:

* the client works by downloading the budget file locally (`downloadBudget(syncId)`), mutating it, then syncing back — it needs a persistent local data directory, which must be a mounted volume in Docker;
* if the budget file uses end-to-end encryption, the encryption password must be supplied to `downloadBudget` (see `ACTUAL_ENCRYPTION_PASSWORD` in configuration);
* the API holds the budget open between calls; initialize once per sync run and shut down cleanly.

---

## 24. Account mapping to Actual

The first time a new bank account is discovered:

```text
Local bank account
        ↓
Existing Actual account?
        │
   ┌────┴────┐
   │         │
  Yes        No
   │         │
 Link      Create / ask user
```

Store permanent mapping:

```text
local_account_id
      ↕
actual_account_id
```

Do not infer this mapping repeatedly from account names.

Because the MVP has no rich UI, "ask user" can be implemented as a config-driven mapping (env/JSON/DB seed) or as auto-creation of an Actual account named after the bank account. Either way, the `actual_account_links` table remains the single source of truth once the link exists.

---

## 25. Actual transaction mapping

Convert canonical transaction:

```text
Local transaction
```

into:

```text
Actual transaction
```

Recommended mapping:

```text
date          → transaction booked date
amount        → amount in integer minor units (pence), negative = outflow
payee_name    → merchant name (Actual creates/matches the payee)
imported_payee→ raw provider description (preserved verbatim by Actual)
notes         → original description
imported_id   → local canonical transaction id
account       → mapped Actual account
cleared       → status === "SETTLED"
```

Category should initially remain:

```text
Uncategorised
```

unless deterministic rules exist.

Allow Actual Budget itself to handle normal personal categorization.

---

## 26. Actual import idempotency

A transaction must not be duplicated in Actual after repeated synchronization.

Use `importTransactions()` rather than `addTransactions()`: it reconciles against existing rows, and transactions carrying the same `imported_id` are never added twice. Setting `imported_id` to the local canonical transaction id therefore makes Actual itself enforce idempotency, independently of local state.

Caveat: Actual's reconciliation also fuzzy-matches on amount/date/payee and has a known upstream issue where distinct transactions with *different* `imported_id`s can still be merged. Stable `imported_id`s minimize this but may not fully eliminate it; do not treat Actual's dedup as a substitute for local dedup.

Additionally store the resulting Actual transaction identifier where available:

```text
actual_transaction_id
```

and retain an import state:

```text
NOT_IMPORTED
IMPORTED
IMPORT_ERROR
```

Import failures must be retryable.

Sync into Actual is strictly one-way and additive:

* the pending → settled transition may update the `cleared` flag of an already-imported transaction;
* fields the user typically edits in Actual (payee, category, notes) must never be overwritten by a later sync;
* nothing the user does in Actual is written back to the local canonical database.

---

## 27. Error handling

Errors should be classified.

```ts
enum SyncErrorType {
  AUTHORIZATION_EXPIRED,
  RATE_LIMIT,
  PROVIDER_UNAVAILABLE,
  BANK_UNAVAILABLE,
  NETWORK_ERROR,
  INVALID_RESPONSE,
  DATABASE_ERROR,
  ACTUAL_ERROR,
  UNKNOWN
}
```

Response behavior:

| Error                 | Action                               |
| --------------------- | ------------------------------------ |
| Authorization expired | Set `REAUTH_REQUIRED`                |
| Rate limited          | Retry later                          |
| Provider unavailable  | Retry                                |
| Bank unavailable      | Retry                                |
| Invalid transaction   | Record and skip                      |
| Actual unavailable    | Keep locally and retry Actual import |
| DB unavailable        | Abort sync                           |

Never delete data because an upstream service is temporarily unavailable.

---

## 28. Retry strategy

For transient API failures:

```text
Attempt 1
  ↓ 5 sec
Attempt 2
  ↓ 30 sec
Attempt 3
  ↓ 2 min
Fail sync run
```

Scheduled future synchronization then provides an additional retry.

For HTTP 429:

respect provider retry information where available.

Do not retry authorization failures automatically.

---

## 29. Security requirements

Financial data should be treated as highly sensitive.

### Secrets

Store secrets exclusively through environment variables or a secrets mechanism.

Example:

```env
TRUELAYER_CLIENT_ID=
TRUELAYER_CLIENT_SECRET=
APP_ENCRYPTION_KEY=
DATABASE_URL=
ACTUAL_SERVER_URL=
ACTUAL_PASSWORD=
```

Do not commit `.env` files.

`APP_ENCRYPTION_KEY` must be a randomly generated 32-byte key, e.g.:

```bash
openssl rand -hex 32
```

Provide:

```text
.env.example
```

without real credentials.

---

## 30. Credential encryption

Refresh/access credentials stored in the database must be encrypted at rest.

Recommended:

```text
AES-256-GCM
```

using:

```text
APP_ENCRYPTION_KEY
```

The encryption key itself must NOT be stored in the database.

---

## 31. Logging

Allowed:

```text
Sync started
Account abc123 processed
15 transactions received
3 transactions inserted
12 unchanged
```

Not allowed:

```text
full account number
access token
refresh token
client secret
full raw transaction JSON
bank login information
```

Logs should identify accounts with internal UUIDs or masked identifiers.

---

## 32. Application access control

Because the system contains private financial information, its administration interface must not be exposed anonymously.

For local-only installations:

```text
127.0.0.1
```

is acceptable.

For LAN/NAS deployment:

require authentication.

For Internet exposure:

use TLS and authentication through a reverse proxy or VPN.

Recommended:

```text
Tailscale
```

instead of directly exposing the service publicly.

---

## 33. Docker deployment

Target deployment:

```text
docker compose up -d
```

Services:

```yaml
services:
  moneta:
    # custom application

  postgres:
    # canonical financial database

  actual-server:
    # Actual Budget
```

Optional:

```text
Caddy
```

or:

```text
Tailscale
```

---

## 34. Suggested repository structure

```text
moneta/
│
├── apps/
│   └── server/
│       ├── src/
│       │   ├── config/
│       │   ├── db/
│       │   ├── providers/
│       │   │   └── truelayer/
│       │   ├── integrations/
│       │   │   └── actual/
│       │   ├── services/
│       │   │   ├── sync/
│       │   │   └── reconciliation/
│       │   ├── routes/
│       │   ├── jobs/
│       │   └── index.ts
│       │
│       ├── prisma/
│       │   └── schema.prisma
│       │
│       └── package.json
│
├── docker/
│
├── docker-compose.yml
├── .env.example
├── README.md
└── package.json
```

---

## 35. API endpoints

The local application should expose a minimal private API.

All endpoints except `/health` and `GET /auth/truelayer/callback` require authentication (the callback arrives via browser redirect and is protected by a single-use, 10-minute `state` parameter instead). A single static bearer token is sufficient for the MVP:

```env
API_TOKEN=
```

This applies even on a LAN — the endpoints trigger syncs and expose account metadata.

### Health

```http
GET /health
```

Response:

```json
{
  "status": "ok"
}
```

---

### Connections

```http
GET /connections
POST /connections/truelayer
POST /connections/:id/reauthorize
DELETE /connections/:id
```

`DELETE` should disable the connection by default rather than deleting historical financial data.

---

### Accounts

```http
GET /accounts
GET /accounts/:id
```

---

### Sync

```http
POST /sync
POST /sync/:accountId
GET /sync/runs
```

---

## 36. Manual synchronization

The system must support:

```text
Sync now
```

without waiting for the scheduled job.

Manual and scheduled syncs use the exact same synchronization engine.

A lock must prevent:

```text
Sync A
Sync B
```

from running simultaneously against the same connection.

The MVP is a single process, so an in-process per-connection mutex is sufficient; a PostgreSQL advisory lock adds safety if a second instance is ever started accidentally. Do not introduce Redis or a distributed lock for this.

---

## 37. Backup

User financial history must be easily backed up.

Minimum backup:

```text
PostgreSQL dump
Actual Budget data
.env / secret configuration separately
```

Recommended:

```text
daily DB backup
7 daily copies
4 weekly copies
```

Backups containing financial data must be encrypted if stored off-device.

---

## 38. Data export

Provide:

```http
GET /export/transactions.csv
```

or a CLI:

```bash
npm run export -- --format csv
```

Columns:

```text
account
date
amount
currency
merchant
description
category
status
provider
provider_transaction_id
```

The user must be able to leave TrueLayer and Actual without losing financial history.

---

## 39. Configuration

Example `.env.example`:

```env
NODE_ENV=production

PORT=3000

DATABASE_URL=postgresql://finance:password@postgres:5432/finance

API_TOKEN=

TRUELAYER_CLIENT_ID=
TRUELAYER_CLIENT_SECRET=
TRUELAYER_REDIRECT_URI=http://localhost:3000/auth/truelayer/callback
TRUELAYER_ENVIRONMENT=sandbox

APP_ENCRYPTION_KEY=

SYNC_CRON=0 */6 * * *
SYNC_OVERLAP_DAYS=7
INITIAL_SYNC_DAYS=365
PENDING_EXPIRY_DAYS=14

ACTUAL_SERVER_URL=http://actual-server:5006
ACTUAL_PASSWORD=
ACTUAL_SYNC_ID=
# only if the budget file uses end-to-end encryption:
ACTUAL_ENCRYPTION_PASSWORD=
ACTUAL_DATA_DIR=/data/actual-cache

STORE_RAW_PROVIDER_DATA=true
```

---

## 40. Observability

Provide a simple status endpoint or dashboard showing:

```text
Barclays Current
Last sync: 12:02
Status: Healthy
Transactions: 1,248

Chase Current
Last sync: 12:03
Status: Healthy
Transactions: 846

Amex
Last sync: 06:01
Status: Reauthorization required
```

The important UX question is:

> “Is my financial data current?”

---

## 41. MVP user interface

A minimal UI is sufficient.

```text
Moneta
────────────────────────────

Connections

Barclays
✓ Connected
Last sync: 12:02
[Sync now] [Reconnect]

Chase UK
✓ Connected
Last sync: 12:03
[Sync now] [Reconnect]

────────────────────────────

Actual Budget
✓ Connected

Database
✓ Healthy
```

No dashboard or charts are required because Actual Budget provides the financial UI.

---

## 42. MVP acceptance criteria

The MVP is complete when all of the following work:

### Bank connection

* User can authorize at least one real UK current account.
* Credentials are stored securely.
* The system can reconnect after application restart.

### Accounts

* Bank accounts can be discovered.
* Account names/types/currencies are stored.
* Balances update successfully.

### Transactions

* At least 12 months of available history is attempted on initial sync.
* Incremental transactions synchronize automatically.
* Duplicate imports do not occur.
* Pending/settled transaction lifecycle is reasonably reconciled.

### Actual Budget

* Bank accounts can be mapped to Actual accounts.
* Transactions automatically appear in Actual.
* Repeated syncs do not duplicate transactions.

### Reliability

* Temporary provider failure does not lose data.
* Actual Budget being offline does not lose downloaded bank transactions.
* Expired bank authorization displays `REAUTH_REQUIRED`.
* Reauthorization does not erase history.

### Deployment

The complete stack starts with:

```bash
docker compose up -d
```

---

## 43. Testing requirements

### Unit tests

Required for:

```text
TrueLayer → canonical account mapping
TrueLayer → canonical transaction mapping
deduplication
transaction fingerprints
pending transaction reconciliation
currency conversion to minor units
Actual transaction mapping
```

### Integration tests

Use TrueLayer sandbox/test facilities where available.

Test:

```text
authorize
discover accounts
fetch transactions
persist
sync Actual
repeat sync
```

Repeated synchronization should produce zero duplicates.

---

## 44. Development phases

### Phase 1 — Local foundation

Implement:

```text
Node/TypeScript project
PostgreSQL
Docker Compose
database schema
health endpoint
```

Success condition:

```text
docker compose up
```

starts the complete local development infrastructure.

---

### Phase 2 — TrueLayer connection

Implement:

```text
authorization
callback
connection persistence
account discovery
balance retrieval
```

Success condition:

```text
Real UK bank
    ↓
TrueLayer
    ↓
accounts table
```

---

### Phase 3 — Transaction ingestion

Implement:

```text
historical sync
incremental sync
normalization
deduplication
pending reconciliation
sync logs
```

Success condition:

Local DB contains accurate bank history.

---

### Phase 4 — Actual Budget

Implement:

```text
@actual-app/api integration
account mapping
transaction import
import idempotency
```

Success condition:

```text
Bank purchase
    ↓
TrueLayer
    ↓
local DB
    ↓
Actual Budget
```

without manual CSV import.

---

### Phase 5 — Automation

Implement:

```text
scheduled synchronization
retry logic
reauthorization state
manual sync
status UI
```

Success condition:

Routine operation requires no manual intervention except Open Banking reauthorization when required.

---

## 45. Future enhancements

After MVP:

### Automatic categorization

Rule engine:

```text
merchant = "TESCO"
→ Groceries
```

Rules should remain user-controlled.

---

### Merchant normalization

Normalize:

```text
TESCO STORES 2874
TESCO STORES LTD
TESCO 2874
```

into:

```text
Tesco
```

---

### Net-worth tracking

Add:

```text
Cash
Savings
Credit cards
Investments
Mortgage
Property
```

and historical daily snapshots.

---

### Multiple Open Banking providers

Support:

```text
TrueLayer
     │
     ├── unsupported bank
     ▼
Alternative provider
```

through the `BankingProvider` abstraction.

---

### CSV fallback

Allow unsupported institutions to be imported using:

```text
CSV / OFX / QIF
```

with the same canonical transaction model.

---

### Notifications

Notify only when intervention is necessary:

```text
Bank connection expired
Sync failed repeatedly
Actual unavailable
Unexpected transaction import error
```

---

## 46. Architectural decisions

### ADR-001 — Local DB is canonical

**Decision:** Store normalized transaction history locally.

**Reason:** Avoid dependence on TrueLayer availability, retention or future pricing.

---

### ADR-002 — Actual is presentation/budget layer

**Decision:** Actual Budget is not the only canonical copy of raw banking data.

**Reason:** Maintain portability and retain provider metadata.

---

### ADR-003 — Node.js/TypeScript

**Decision:** Use Node.js.

**Reason:** Actual Budget provides its official programmable API through the Node package `@actual-app/api`.

---

### ADR-004 — Provider abstraction

**Decision:** TrueLayer must sit behind a generic interface.

**Reason:** Free/pricing/API availability can change.

Switching:

```text
TrueLayer → another Open Banking provider
```

should not require rewriting transaction storage or Actual integration.

---

### ADR-005 — Read-only system

**Decision:** No payment initiation capability.

**Reason:** The project's objective is personal financial visibility, not banking operations.

This substantially limits operational and security risk.

---

### ADR-006 — TrueLayer Data API v1 over v3

**Decision:** Integrate against Data API v1 (OAuth2 code flow, synchronous data endpoints) rather than v3.

**Reason:** v3's connection resources assume hosted UI journeys, require end-user PII in connection requests, and deliver transaction data asynchronously via webhooks — which requires a publicly reachable endpoint. This system is deliberately bound to localhost/VPN (spec §32), so the webhook model conflicts with the deployment model. v1 is synchronous, fully supported, and simpler to operate self-hosted.

**Revisit if:** TrueLayer announces v1 deprecation, or the deployment model changes to include a public HTTPS endpoint. The `BankingProvider` interface is the migration boundary.

---

## 47. Definition of success

The system succeeds if normal daily usage becomes:

```text
Use bank normally
      ↓
Open Banking sync
      ↓
Local financial history
      ↓
Actual Budget
      ↓
Review / categorize / budget
```

with no recurring:

```text
download CSV
open spreadsheet
copy transactions
remove duplicates
manually update balances
```

required.

The final system should behave like a private, self-hosted version of a personal finance aggregator while keeping long-term financial history under the user's control.

---

## 48. Known risks and open questions

* **TrueLayer live access.** Production data access requires approval in the TrueLayer console. Eligibility and timeline for a single personal user must be confirmed before Phase 2; the sandbox is not a substitute for this check.
* **Provider transaction ID stability.** Whether TrueLayer transaction IDs survive reauthorization unchanged must be verified empirically in Phase 2. The fingerprint fallback (section 14) exists for exactly this risk.
* **Actual's fuzzy deduplication.** Actual can merge distinct transactions with the same amount/date/payee even when `imported_id` differs (known upstream issue). Stable `imported_id`s reduce but may not eliminate this.
* **Consent renewal friction.** Reauthorization every consent cycle is unavoidable and manual; the design goal is to make it a two-click event, not to remove it.
* **History depth varies by bank.** Some banks return far less than 12 months on first sync; `INITIAL_SYNC_DAYS=365` is an upper bound, not a guarantee.

