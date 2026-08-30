import type { PrismaClient, SyncErrorType } from "@prisma/client";
import {
  type BankingProvider,
  ProviderRequestError,
  ReauthRequiredError,
} from "../../providers/banking-provider.js";
import type { ActualExportService } from "../../integrations/actual/export-service.js";
import type { ConnectionService } from "../connections/connection-service.js";
import { reconcilePending } from "../reconciliation/pending-reconciler.js";
import { normalizeBatch } from "./normalize.js";
import { type UpsertCounts, upsertTransactions } from "./transaction-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class SyncInProgressError extends Error {
  constructor(connectionId: string) {
    super(`sync already running for connection ${connectionId}`);
    this.name = "SyncInProgressError";
  }
}

export interface SyncEngineConfig {
  syncOverlapDays: number;
  initialSyncDays: number;
  pendingExpiryDays: number;
  storeRawProviderData: boolean;
}

export interface SyncEngineDeps {
  prisma: PrismaClient;
  connectionService: ConnectionService;
  provider: BankingProvider;
  config: SyncEngineConfig;
  actualExporter?: ActualExportService;
  now?: () => number;
}

/** Spec §27 classification: decides retry semantics and connection state. */
function classifyError(error: unknown): SyncErrorType {
  if (error instanceof ReauthRequiredError) return "AUTHORIZATION_EXPIRED";
  if (error instanceof ProviderRequestError) {
    if (error.httpStatus === 429) return "RATE_LIMIT";
    if (error.httpStatus >= 500) return "PROVIDER_UNAVAILABLE";
    return "INVALID_RESPONSE";
  }
  if (error instanceof TypeError) return "NETWORK_ERROR";
  return "UNKNOWN";
}

export class SyncEngine {
  private readonly prisma: PrismaClient;
  private readonly connectionService: ConnectionService;
  private readonly provider: BankingProvider;
  private readonly config: SyncEngineConfig;
  private readonly actualExporter: ActualExportService | undefined;
  private readonly now: () => number;
  // Per-connection lock (spec §36): single process, so an in-memory set suffices.
  private readonly running = new Set<string>();

  constructor(deps: SyncEngineDeps) {
    this.prisma = deps.prisma;
    this.connectionService = deps.connectionService;
    this.provider = deps.provider;
    this.config = deps.config;
    this.actualExporter = deps.actualExporter;
    this.now = deps.now ?? Date.now;
  }

  isRunning(connectionId: string): boolean {
    return this.running.has(connectionId);
  }

  async syncAll(): Promise<string[]> {
    const connections = await this.prisma.connection.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });
    const runIds: string[] = [];
    for (const { id } of connections) {
      runIds.push(await this.syncConnection(id));
    }
    return runIds;
  }

  async syncAccount(accountId: string): Promise<string> {
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { connectionId: true },
    });
    return this.syncConnection(account.connectionId, accountId);
  }

  async syncConnection(connectionId: string, onlyAccountId?: string): Promise<string> {
    if (this.running.has(connectionId)) {
      throw new SyncInProgressError(connectionId);
    }
    this.running.add(connectionId);
    try {
      return await this.runSync(connectionId, onlyAccountId);
    } finally {
      this.running.delete(connectionId);
    }
  }

  private async runSync(connectionId: string, onlyAccountId?: string): Promise<string> {
    const connection = await this.prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    if (connection.status !== "ACTIVE") {
      throw new Error(`connection ${connectionId} is ${connection.status}, not ACTIVE`);
    }

    const run = await this.prisma.syncRun.create({ data: { connectionId } });
    const totals: UpsertCounts = { received: 0, inserted: 0, updated: 0, skipped: 0 };
    let accountsProcessed = 0;
    let failures = 0;
    let sawReauth = false;

    const accounts = await this.prisma.account.findMany({
      where: {
        connectionId,
        active: true,
        ...(onlyAccountId ? { id: onlyAccountId } : {}),
      },
    });

    for (const account of accounts) {
      if (sawReauth) break; // no point hammering a dead consent (spec §27)
      try {
        const counts = await this.syncOneAccount(connectionId, account.id, account.providerAccountId, account.lastSuccessfulSync);
        totals.received += counts.received;
        totals.inserted += counts.inserted;
        totals.updated += counts.updated;
        totals.skipped += counts.skipped;
        accountsProcessed += 1;
      } catch (error) {
        failures += 1;
        const errorType = classifyError(error);
        await this.prisma.syncError.create({
          data: {
            syncRunId: run.id,
            accountId: account.id,
            errorType,
            message: error instanceof Error ? error.message : String(error),
          },
        });
        if (errorType === "AUTHORIZATION_EXPIRED") {
          sawReauth = true;
          // ConnectionService.getValidAccessToken already flips the status on
          // refresh failure; cover the data-endpoint 401 path too.
          await this.prisma.connection.update({
            where: { id: connectionId },
            data: { status: "REAUTH_REQUIRED" },
          });
        }
      }
    }

    // Export to Actual after the bank sync. Actual being down must never
    // fail or block the bank sync (spec §27: keep locally, retry next run).
    if (this.actualExporter && accountsProcessed > 0) {
      try {
        const summary = await this.actualExporter.exportAccounts(
          accounts.map((account) => account.id),
        );
        if (summary.failed > 0) {
          await this.prisma.syncError.create({
            data: {
              syncRunId: run.id,
              errorType: "ACTUAL_ERROR",
              message: `${summary.failed} transaction(s) failed to import into Actual`,
            },
          });
        }
      } catch (error) {
        await this.prisma.syncError.create({
          data: {
            syncRunId: run.id,
            errorType: "ACTUAL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    const status =
      failures === 0 ? "SUCCESS" : accountsProcessed > 0 ? "PARTIAL" : "FAILED";
    await this.prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(this.now()),
        status,
        accountsProcessed,
        transactionsReceived: totals.received,
        transactionsInserted: totals.inserted,
        transactionsUpdated: totals.updated,
        transactionsSkipped: totals.skipped,
      },
    });
    if (status === "SUCCESS") {
      await this.prisma.connection.update({
        where: { id: connectionId },
        data: { lastSuccessfulSync: new Date(this.now()) },
      });
    }
    return run.id;
  }

  private async syncOneAccount(
    connectionId: string,
    accountId: string,
    providerAccountId: string,
    lastSuccessfulSync: Date | null,
  ): Promise<UpsertCounts> {
    const accessToken = await this.connectionService.getValidAccessToken(connectionId);

    const balance = await this.provider.getBalance(accessToken, providerAccountId);
    await this.prisma.balance.create({
      data: {
        accountId,
        currentAmountMinor: balance.currentMinor,
        availableAmountMinor: balance.availableMinor,
        currency: balance.currency,
        observedAt: new Date(this.now()),
      },
    });

    // Window rule (spec §16/§17): initial deep fetch, then overlap re-fetches.
    const from = lastSuccessfulSync
      ? new Date(lastSuccessfulSync.getTime() - this.config.syncOverlapDays * DAY_MS)
      : new Date(this.now() - this.config.initialSyncDays * DAY_MS);
    const to = new Date(this.now());

    const settled = await this.provider.getTransactions(
      accessToken,
      providerAccountId,
      from,
      to,
    );
    const pending = await this.provider.getPendingTransactions(accessToken, providerAccountId);

    const batch = normalizeBatch(accountId, [...settled, ...pending]);
    const counts = await upsertTransactions(
      this.prisma,
      accountId,
      batch,
      this.config.storeRawProviderData,
    );

    const seenPendingIds = new Set(
      pending
        .map((tx) => tx.providerTransactionId)
        .filter((id): id is string => id !== undefined),
    );
    await reconcilePending(this.prisma, accountId, {
      now: this.now,
      pendingExpiryDays: this.config.pendingExpiryDays,
      seenPendingIds,
    });

    await this.prisma.account.update({
      where: { id: accountId },
      data: { lastSuccessfulSync: new Date(this.now()) },
    });
    return counts;
  }
}
