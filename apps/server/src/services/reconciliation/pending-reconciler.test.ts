import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma, truncateAll } from "../../db/test-helpers.js";
import { reconcilePending } from "./pending-reconciler.js";

const prisma = createTestPrisma();
let accountId: string;
const NOW = Date.parse("2026-08-28T12:00:00Z");

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

interface RowOpts {
  status: "PENDING" | "SETTLED";
  amountMinor: bigint;
  bookedDate: string;
  merchantName?: string;
  description?: string;
  providerTransactionId?: string;
  updatedAt?: string;
}

async function insertRow(opts: RowOpts): Promise<string> {
  const row = await prisma.transaction.create({
    data: {
      accountId,
      providerTransactionId: opts.providerTransactionId ?? null,
      status: opts.status,
      timestamp: new Date(`${opts.bookedDate}T10:00:00Z`),
      bookedDate: new Date(`${opts.bookedDate}T00:00:00Z`),
      amountMinor: opts.amountMinor,
      currency: "GBP",
      description: opts.description ?? "CARD PAYMENT",
      merchantName: opts.merchantName ?? null,
      rawHash: crypto.randomUUID(),
    },
  });
  if (opts.updatedAt) {
    await prisma.$executeRaw`UPDATE transactions SET updated_at = ${new Date(opts.updatedAt)} WHERE id = ${row.id}`;
  }
  return row.id;
}

function run(seenPendingIds: string[] = [], pendingExpiryDays = 14) {
  return reconcilePending(prisma, accountId, {
    now: () => NOW,
    pendingExpiryDays,
    seenPendingIds: new Set(seenPendingIds),
  });
}

describe("reconcilePending", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
    accountId = await seedAccount();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("soft-deletes a pending row when a matching settled row arrives", async () => {
    const pendingId = await insertRow({
      status: "PENDING",
      amountMinor: -450n,
      bookedDate: "2026-08-25",
      merchantName: "Costa",
    });
    await insertRow({
      status: "SETTLED",
      amountMinor: -450n,
      bookedDate: "2026-08-27",
      merchantName: "COSTA",
      providerTransactionId: "tx-settled",
    });

    const result = await run();
    expect(result.merged).toBe(1);
    const pending = await prisma.transaction.findUniqueOrThrow({ where: { id: pendingId } });
    expect(pending.deletedAt).not.toBeNull();
    const settled = await prisma.transaction.findFirstOrThrow({
      where: { providerTransactionId: "tx-settled" },
    });
    expect(settled.deletedAt).toBeNull();
  });

  it("matches on normalized description when merchants are missing", async () => {
    const pendingId = await insertRow({
      status: "PENDING",
      amountMinor: -999n,
      bookedDate: "2026-08-26",
      description: "  amazon   uk retail ",
    });
    await insertRow({
      status: "SETTLED",
      amountMinor: -999n,
      bookedDate: "2026-08-27",
      description: "AMAZON UK RETAIL",
      providerTransactionId: "tx-a",
    });
    expect((await run()).merged).toBe(1);
    const pending = await prisma.transaction.findUniqueOrThrow({ where: { id: pendingId } });
    expect(pending.deletedAt).not.toBeNull();
  });

  it("does not merge when the amount differs", async () => {
    await insertRow({ status: "PENDING", amountMinor: -450n, bookedDate: "2026-08-25", merchantName: "Costa" });
    await insertRow({
      status: "SETTLED",
      amountMinor: -500n,
      bookedDate: "2026-08-26",
      merchantName: "Costa",
      providerTransactionId: "tx-b",
    });
    expect((await run()).merged).toBe(0);
  });

  it("does not merge when dates are more than five days apart", async () => {
    await insertRow({ status: "PENDING", amountMinor: -450n, bookedDate: "2026-08-10", merchantName: "Costa" });
    await insertRow({
      status: "SETTLED",
      amountMinor: -450n,
      bookedDate: "2026-08-20",
      merchantName: "Costa",
      providerTransactionId: "tx-c",
    });
    expect((await run()).merged).toBe(0);
  });

  it("expires stale pendings that no longer appear at the provider", async () => {
    const staleId = await insertRow({
      status: "PENDING",
      amountMinor: -100n,
      bookedDate: "2026-08-01",
      providerTransactionId: "tx-stale",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const result = await run([], 14);
    expect(result.expired).toBe(1);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: staleId } });
    expect(row.deletedAt).not.toBeNull();
  });

  it("keeps pendings still reported by the provider, however old", async () => {
    await insertRow({
      status: "PENDING",
      amountMinor: -100n,
      bookedDate: "2026-08-01",
      providerTransactionId: "tx-seen",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const result = await run(["tx-seen"], 14);
    expect(result.expired).toBe(0);
  });

  it("keeps recently-updated pendings even when unseen this sync", async () => {
    await insertRow({
      status: "PENDING",
      amountMinor: -100n,
      bookedDate: "2026-08-27",
      updatedAt: "2026-08-27T00:00:00Z",
    });
    expect((await run()).expired).toBe(0);
  });
});
