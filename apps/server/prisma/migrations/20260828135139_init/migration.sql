-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'REAUTH_REQUIRED', 'EXPIRED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CURRENT', 'SAVINGS', 'CREDIT_CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SETTLED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('NOT_IMPORTED', 'IMPORTED', 'IMPORT_ERROR');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncErrorType" AS ENUM ('AUTHORIZATION_EXPIRED', 'RATE_LIMIT', 'PROVIDER_UNAVAILABLE', 'BANK_UNAVAILABLE', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'DATABASE_ERROR', 'ACTUAL_ERROR', 'UNKNOWN');

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_connection_id" TEXT NOT NULL,
    "institution_name" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "encrypted_credentials" TEXT,
    "consent_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_successful_sync" TIMESTAMP(3),

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT,
    "type" "AccountType" NOT NULL DEFAULT 'OTHER',
    "currency" TEXT NOT NULL,
    "account_number_last4" TEXT,
    "sort_code_masked" TEXT,
    "institution_name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_successful_sync" TIMESTAMP(3),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balances" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "current_amount_minor" BIGINT,
    "available_amount_minor" BIGINT,
    "currency" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_transaction_id" TEXT,
    "status" "TransactionStatus" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "booked_date" DATE,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "merchant_name" TEXT,
    "transaction_type" TEXT,
    "category" TEXT,
    "running_balance_minor" BIGINT,
    "raw_hash" TEXT NOT NULL,
    "raw_payload" JSONB,
    "import_status" "ImportStatus" NOT NULL DEFAULT 'NOT_IMPORTED',
    "actual_transaction_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actual_account_links" (
    "id" TEXT NOT NULL,
    "local_account_id" TEXT NOT NULL,
    "actual_account_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actual_account_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "SyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "accounts_processed" INTEGER NOT NULL DEFAULT 0,
    "transactions_received" INTEGER NOT NULL DEFAULT 0,
    "transactions_inserted" INTEGER NOT NULL DEFAULT 0,
    "transactions_updated" INTEGER NOT NULL DEFAULT 0,
    "transactions_skipped" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_errors" (
    "id" TEXT NOT NULL,
    "sync_run_id" TEXT NOT NULL,
    "account_id" TEXT,
    "error_type" "SyncErrorType" NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "connections_provider_provider_connection_id_key" ON "connections"("provider", "provider_connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_connection_id_provider_account_id_key" ON "accounts"("connection_id", "provider_account_id");

-- CreateIndex
CREATE INDEX "balances_account_id_observed_at_idx" ON "balances"("account_id", "observed_at");

-- CreateIndex
CREATE INDEX "transactions_account_id_booked_date_idx" ON "transactions"("account_id", "booked_date");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_account_id_provider_transaction_id_key" ON "transactions"("account_id", "provider_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_account_id_raw_hash_key" ON "transactions"("account_id", "raw_hash");

-- CreateIndex
CREATE UNIQUE INDEX "actual_account_links_local_account_id_key" ON "actual_account_links"("local_account_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actual_account_links" ADD CONSTRAINT "actual_account_links_local_account_id_fkey" FOREIGN KEY ("local_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_errors" ADD CONSTRAINT "sync_errors_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_errors" ADD CONSTRAINT "sync_errors_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
