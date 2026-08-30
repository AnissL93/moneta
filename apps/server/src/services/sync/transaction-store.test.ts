import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma, truncateAll } from "../../db/test-helpers.js";
import type { ProviderTransaction } from "../../providers/banking-provider.js";
import { normalizeBatch } from "./normalize.js";
import { upsertTransactions } from "./transaction-store.js";

const prisma = createTestPrisma();
let accountId: string;

function tx(overrides: Partial<ProviderTransaction>): ProviderTransaction {
  return {
    status: "SETTLED",
    timestamp: new Date("2026-08-20T14:30:00Z"),
    bookedDate: new Date("2026-08-20T00:00:00Z"),
    amountMinor: -450n,
    currency: "GBP",
    description: "COSTA COFFEE LEEDS",
    ...overrides,
  };
}

async function seedAccount(): Promise<string> {
  const connection = await prisma.connection.create({
    data: { provider: "truelayer", providerConnectionId: crypto.randomUUID() },
  });
  const account = await prisma.account.create({
    data: {
      connectionId: connection.id,
      providerAccountId: "tl-acc-1",
      name: "Main",
      type: "CURRENT",
      currency: "GBP",
    },
  });
  return account.id;
}

describe("upsertTransactions", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
    accountId = await seedAccount();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("inserts a fresh batch and counts it", async () => {
    const batch = normalizeBatch(accountId, [
      tx({ providerTransactionId: "tx-1" }),
      tx({ providerTransactionId: "tx-2", amountMinor: -1000n }),
    ]);
    const counts = await upsertTransactions(prisma, accountId, batch, false);
    expect(counts).toEqual({ received: 2, inserted: 2, updated: 0, skipped: 0 });
    expect(await prisma.transaction.count()).toBe(2);
  });

  it("is idempotent: re-running an identical batch changes nothing", async () => {
    const batch = normalizeBatch(accountId, [tx({ providerTransactionId: "tx-1" }), tx({})]);
    await upsertTransactions(prisma, accountId, batch, false);
    const counts = await upsertTransactions(prisma, accountId, batch, false);
    expect(counts).toEqual({ received: 2, inserted: 0, updated: 0, skipped: 2 });
    expect(await prisma.transaction.count()).toBe(2);
  });

  it("updates when a mutable field changes", async () => {
    await upsertTransactions(
      prisma,
      accountId,
      normalizeBatch(accountId, [tx({ providerTransactionId: "tx-1" })]),
      false,
    );
    const counts = await upsertTransactions(
      prisma,
      accountId,
      normalizeBatch(accountId, [
        tx({ providerTransactionId: "tx-1", description: "COSTA COFFEE LEEDS LTD" }),
      ]),
      false,
    );
    expect(counts.updated).toBe(1);
    const row = await prisma.transaction.findFirstOrThrow();
    expect(row.description).toBe("COSTA COFFEE LEEDS LTD");
  });

  it("moves pending to settled under the same provider id", async () => {
    await upsertTransactions(
      prisma,
      accountId,
      normalizeBatch(accountId, [tx({ providerTransactionId: "tx-1", status: "PENDING" })]),
      false,
    );
    const counts = await upsertTransactions(
      prisma,
      accountId,
      normalizeBatch(accountId, [tx({ providerTransactionId: "tx-1", status: "SETTLED" })]),
      false,
    );
    expect(counts.updated).toBe(1);
    const row = await prisma.transaction.findFirstOrThrow();
    expect(row.status).toBe("SETTLED");
  });

  it("keeps two genuinely identical id-less transactions", async () => {
    const batch = normalizeBatch(accountId, [tx({}), tx({})]);
    const counts = await upsertTransactions(prisma, accountId, batch, false);
    expect(counts.inserted).toBe(2);
  });

  it("does not resurrect soft-deleted rows", async () => {
    const batch = normalizeBatch(accountId, [tx({ providerTransactionId: "tx-1" })]);
    await upsertTransactions(prisma, accountId, batch, false);
    await prisma.transaction.updateMany({ data: { deletedAt: new Date() } });
    const counts = await upsertTransactions(prisma, accountId, batch, false);
    expect(counts).toEqual({ received: 1, inserted: 0, updated: 0, skipped: 1 });
    const row = await prisma.transaction.findFirstOrThrow();
    expect(row.deletedAt).not.toBeNull();
  });

  it("stores the raw payload only when enabled", async () => {
    await upsertTransactions(
      prisma,
      accountId,
      normalizeBatch(accountId, [tx({ providerTransactionId: "tx-raw" })]),
      true,
    );
    await upsertTransactions(
      prisma,
      accountId,
      normalizeBatch(accountId, [tx({ providerTransactionId: "tx-bare", amountMinor: -1n })]),
      false,
    );
    const withRaw = await prisma.transaction.findFirstOrThrow({
      where: { providerTransactionId: "tx-raw" },
    });
    const withoutRaw = await prisma.transaction.findFirstOrThrow({
      where: { providerTransactionId: "tx-bare" },
    });
    expect(withRaw.rawPayload).not.toBeNull();
    expect(withoutRaw.rawPayload).toBeNull();
  });
});
