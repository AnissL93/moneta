import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma, truncateAll } from "../../db/test-helpers.js";
import {
  type BankingProvider,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderTokens,
  type ProviderTransaction,
  ProviderRequestError,
  ReauthRequiredError,
} from "../../providers/banking-provider.js";
import { ActualExportService } from "../../integrations/actual/export-service.js";
import { FakeActualGateway } from "../../integrations/actual/fake-gateway.js";
import { ConnectionService } from "../connections/connection-service.js";
import { SyncEngine, SyncInProgressError } from "./sync-engine.js";

const prisma = createTestPrisma();
const NOW = Date.parse("2026-08-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function settledTx(id: string, daysAgo: number, amountMinor: bigint): ProviderTransaction {
  const timestamp = new Date(NOW - daysAgo * DAY);
  return {
    providerTransactionId: id,
    status: "SETTLED",
    timestamp,
    bookedDate: new Date(Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate())),
    amountMinor,
    currency: "GBP",
    description: `PAYMENT ${id}`,
    merchantName: "Shop",
  };
}

class FakeProvider implements BankingProvider {
  accounts: ProviderAccount[] = [
    { providerAccountId: "tl-acc-1", name: "Main", type: "CURRENT", currency: "GBP" },
    { providerAccountId: "tl-acc-2", name: "Saver", type: "SAVINGS", currency: "GBP" },
  ];
  transactionsByAccount = new Map<string, ProviderTransaction[]>();
  pendingByAccount = new Map<string, ProviderTransaction[]>();
  requestedWindows: Array<{ account: string; from: Date; to: Date }> = [];
  failAccounts = new Map<string, Error>();
  balanceDelayMs = 0;

  buildAuthUrl(state: string): string {
    return `https://auth.example.com/?state=${state}`;
  }
  async exchangeCode(): Promise<ProviderTokens> {
    return { accessToken: "a", refreshToken: "r", expiresAt: NOW + 3_600_000 };
  }
  async refreshTokens(): Promise<ProviderTokens> {
    return { accessToken: "a2", refreshToken: "r2", expiresAt: NOW + 3_600_000 };
  }
  async getAccounts(): Promise<ProviderAccount[]> {
    return this.accounts;
  }
  async getBalance(_t: string, account: string): Promise<ProviderBalance> {
    if (this.balanceDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.balanceDelayMs));
    }
    const failure = this.failAccounts.get(account);
    if (failure) throw failure;
    return { currentMinor: 10000n, availableMinor: 9000n, currency: "GBP" };
  }
  async getTransactions(
    _t: string,
    account: string,
    from: Date,
    to: Date,
  ): Promise<ProviderTransaction[]> {
    this.requestedWindows.push({ account, from, to });
    return this.transactionsByAccount.get(account) ?? [];
  }
  async getPendingTransactions(_t: string, account: string): Promise<ProviderTransaction[]> {
    return this.pendingByAccount.get(account) ?? [];
  }
}

async function setup(fake: FakeProvider) {
  const connectionService = new ConnectionService({
    prisma,
    provider: fake,
    encryptionKey: "c".repeat(64),
    now: () => NOW,
  });
  const { state } = await connectionService.createAuthSession();
  const { connectionId } = await connectionService.handleCallback({ code: "c", state });
  const engine = new SyncEngine({
    prisma,
    connectionService,
    provider: fake,
    config: {
      syncOverlapDays: 7,
      initialSyncDays: 365,
      pendingExpiryDays: 14,
      storeRawProviderData: false,
    },
    now: () => NOW,
  });
  return { engine, connectionId, connectionService };
}

describe("SyncEngine", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("uses the initial window on first sync and ingests transactions", async () => {
    const fake = new FakeProvider();
    fake.transactionsByAccount.set("tl-acc-1", [
      settledTx("tx-1", 2, -450n),
      settledTx("tx-2", 40, -1000n),
    ]);
    const { engine, connectionId } = await setup(fake);
    fake.requestedWindows = [];

    const runId = await engine.syncConnection(connectionId);

    const window = fake.requestedWindows.find((w) => w.account === "tl-acc-1")!;
    expect(NOW - window.from.getTime()).toBe(365 * DAY);
    expect(await prisma.transaction.count()).toBe(2);

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("SUCCESS");
    expect(run.accountsProcessed).toBe(2);
    expect(run.transactionsInserted).toBe(2);
    expect(run.finishedAt).not.toBeNull();
  });

  it("uses the overlap window on subsequent syncs and stays idempotent", async () => {
    const fake = new FakeProvider();
    fake.transactionsByAccount.set("tl-acc-1", [settledTx("tx-1", 2, -450n)]);
    const { engine, connectionId } = await setup(fake);
    await engine.syncConnection(connectionId);
    fake.requestedWindows = [];

    const secondRunId = await engine.syncConnection(connectionId);

    const window = fake.requestedWindows.find((w) => w.account === "tl-acc-1")!;
    expect(NOW - window.from.getTime()).toBe(7 * DAY);
    expect(await prisma.transaction.count()).toBe(1);
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: secondRunId } });
    expect(run.transactionsInserted).toBe(0);
    expect(run.transactionsSkipped).toBe(1);
  });

  it("continues other accounts when one fails, recording a classified error", async () => {
    const fake = new FakeProvider();
    fake.transactionsByAccount.set("tl-acc-2", [settledTx("tx-9", 1, -100n)]);
    const { engine, connectionId } = await setup(fake);
    fake.failAccounts.set("tl-acc-1", new ProviderRequestError("rate limited", 429));

    const runId = await engine.syncConnection(connectionId);

    const run = await prisma.syncRun.findUniqueOrThrow({
      where: { id: runId },
      include: { errors: true },
    });
    expect(run.status).toBe("PARTIAL");
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]!.errorType).toBe("RATE_LIMIT");
    expect(await prisma.transaction.count()).toBe(1);
  });

  it("marks the connection REAUTH_REQUIRED and fails the run on auth expiry", async () => {
    const fake = new FakeProvider();
    const { engine, connectionId } = await setup(fake);
    fake.failAccounts.set("tl-acc-1", new ReauthRequiredError());
    fake.failAccounts.set("tl-acc-2", new ReauthRequiredError());

    const runId = await engine.syncConnection(connectionId);

    const run = await prisma.syncRun.findUniqueOrThrow({
      where: { id: runId },
      include: { errors: true },
    });
    expect(run.status).toBe("FAILED");
    expect(run.errors.some((e) => e.errorType === "AUTHORIZATION_EXPIRED")).toBe(true);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(connection.status).toBe("REAUTH_REQUIRED");
  });

  it("skips non-ACTIVE connections", async () => {
    const fake = new FakeProvider();
    const { engine, connectionId } = await setup(fake);
    await prisma.connection.update({
      where: { id: connectionId },
      data: { status: "DISABLED" },
    });
    expect(await engine.syncAll()).toEqual([]);
    expect(await prisma.syncRun.count()).toBe(0);
  });

  it("reconciles pending rows against settled arrivals", async () => {
    const fake = new FakeProvider();
    fake.pendingByAccount.set("tl-acc-1", [
      { ...settledTx("", 1, -450n), status: "PENDING", providerTransactionId: undefined },
    ]);
    const { engine, connectionId } = await setup(fake);
    await engine.syncConnection(connectionId);
    expect(await prisma.transaction.count({ where: { status: "PENDING", deletedAt: null } })).toBe(1);

    // next sync: pending gone upstream, settled twin arrives
    fake.pendingByAccount.set("tl-acc-1", []);
    fake.transactionsByAccount.set("tl-acc-1", [settledTx("tx-settled", 0, -450n)]);
    await engine.syncConnection(connectionId);

    const live = await prisma.transaction.findMany({ where: { deletedAt: null } });
    expect(live).toHaveLength(1);
    expect(live[0]!.status).toBe("SETTLED");
  });

  it("rejects concurrent syncs of the same connection", async () => {
    const fake = new FakeProvider();
    fake.balanceDelayMs = 150;
    const { engine, connectionId } = await setup(fake);

    const first = engine.syncConnection(connectionId);
    await expect(engine.syncConnection(connectionId)).rejects.toBeInstanceOf(
      SyncInProgressError,
    );
    await first;
  });

  it("syncs a single account via syncAccount", async () => {
    const fake = new FakeProvider();
    fake.transactionsByAccount.set("tl-acc-2", [settledTx("tx-s", 1, -100n)]);
    const { engine } = await setup(fake);
    const account = await prisma.account.findFirstOrThrow({
      where: { providerAccountId: "tl-acc-2" },
    });
    fake.requestedWindows = [];

    await engine.syncAccount(account.id);

    expect(fake.requestedWindows.map((w) => w.account)).toEqual(["tl-acc-2"]);
    expect(await prisma.transaction.count()).toBe(1);
  });
});

describe("SyncEngine + Actual export", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  async function setupWithActual(fake: FakeProvider, gateway: FakeActualGateway) {
    const connectionService = new ConnectionService({
      prisma,
      provider: fake,
      encryptionKey: "c".repeat(64),
      now: () => NOW,
    });
    const { state } = await connectionService.createAuthSession();
    const { connectionId } = await connectionService.handleCallback({ code: "c", state });
    const engine = new SyncEngine({
      prisma,
      connectionService,
      provider: fake,
      config: {
        syncOverlapDays: 7,
        initialSyncDays: 365,
        pendingExpiryDays: 14,
        storeRawProviderData: false,
      },
      actualExporter: new ActualExportService({ prisma, gateway, now: () => NOW }),
      now: () => NOW,
    });
    return { engine, connectionId };
  }

  it("exports synced transactions to Actual within the same run", async () => {
    const fake = new FakeProvider();
    fake.transactionsByAccount.set("tl-acc-1", [settledTx("tx-1", 2, -450n)]);
    const gateway = new FakeActualGateway();
    const { engine, connectionId } = await setupWithActual(fake, gateway);

    const runId = await engine.syncConnection(connectionId);

    expect(gateway.importedBatches).toHaveLength(1);
    expect(gateway.importedBatches[0]!.transactions[0]!.amount).toBe(-450);
    const row = await prisma.transaction.findFirstOrThrow();
    expect(row.importStatus).toBe("IMPORTED");
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("SUCCESS");
  });

  it("records ACTUAL_ERROR without failing the bank sync when Actual is down", async () => {
    const fake = new FakeProvider();
    fake.transactionsByAccount.set("tl-acc-1", [settledTx("tx-1", 2, -450n)]);
    const gateway = new FakeActualGateway();
    gateway.failImports = true;
    const { engine, connectionId } = await setupWithActual(fake, gateway);

    const runId = await engine.syncConnection(connectionId);

    const run = await prisma.syncRun.findUniqueOrThrow({
      where: { id: runId },
      include: { errors: true },
    });
    expect(run.status).toBe("SUCCESS");
    expect(run.errors.some((e) => e.errorType === "ACTUAL_ERROR")).toBe(true);
    const row = await prisma.transaction.findFirstOrThrow();
    expect(row.importStatus).toBe("IMPORT_ERROR");
  });
});
