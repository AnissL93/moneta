import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma, truncateAll } from "../../db/test-helpers.js";
import { ActualExportService } from "./export-service.js";
import { FakeActualGateway } from "./fake-gateway.js";

const prisma = createTestPrisma();
// midnight, so the DB's real @updatedAt is always later than importedAt in the
// re-export test regardless of the wall clock
const NOW = Date.parse("2026-08-28T00:00:00Z");
let accountId: string;

async function seedAccount(): Promise<string> {
  const connection = await prisma.connection.create({
    data: { provider: "truelayer", providerConnectionId: crypto.randomUUID() },
  });
  const account = await prisma.account.create({
    data: {
      connectionId: connection.id,
      providerAccountId: "tl-acc-1",
      name: "Main Current",
      type: "CURRENT",
      currency: "GBP",
    },
  });
  return account.id;
}

async function seedTransaction(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await prisma.transaction.create({
    data: {
      accountId,
      providerTransactionId: crypto.randomUUID(),
      status: "SETTLED",
      timestamp: new Date("2026-08-27T10:00:00Z"),
      bookedDate: new Date("2026-08-27T00:00:00Z"),
      amountMinor: -450n,
      currency: "GBP",
      description: "COSTA COFFEE LEEDS",
      merchantName: "Costa Coffee",
      rawHash: crypto.randomUUID(),
      ...overrides,
    },
  });
  return row.id;
}

function service(gateway: FakeActualGateway): ActualExportService {
  return new ActualExportService({ prisma, gateway, now: () => NOW });
}

describe("ActualExportService", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
    accountId = await seedAccount();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("exports fresh transactions with the spec §25 mapping", async () => {
    const txId = await seedTransaction();
    const gateway = new FakeActualGateway();

    const result = await service(gateway).exportAccounts();

    expect(result).toEqual({ exported: 1, failed: 0 });
    expect(gateway.openCount).toBe(1);
    expect(gateway.closeCount).toBe(1);
    expect(gateway.importedBatches).toHaveLength(1);
    expect(gateway.importedBatches[0]!.transactions[0]).toEqual({
      account: gateway.importedBatches[0]!.accountId,
      date: "2026-08-27",
      amount: -450,
      imported_id: txId,
      payee_name: "Costa Coffee",
      imported_payee: "COSTA COFFEE LEEDS",
      notes: "COSTA COFFEE LEEDS",
      cleared: true,
    });

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.importStatus).toBe("IMPORTED");
    expect(row.importedAt).toEqual(new Date(NOW));
    expect(row.actualTransactionId).toBeTruthy();
  });

  it("exports nothing on a second run (idempotency)", async () => {
    await seedTransaction();
    const gateway = new FakeActualGateway();
    await service(gateway).exportAccounts();

    const second = await service(gateway).exportAccounts();
    expect(second.exported).toBe(0);
    expect(gateway.importedBatches).toHaveLength(1);
  });

  it("re-exports a transaction updated after import (pending → settled)", async () => {
    const txId = await seedTransaction({ status: "PENDING" });
    const gateway = new FakeActualGateway();
    await service(gateway).exportAccounts();
    expect(gateway.importedBatches[0]!.transactions[0]!.cleared).toBe(false);

    // the settle arrives: store layer updates the row (updatedAt moves forward)
    await prisma.transaction.update({ where: { id: txId }, data: { status: "SETTLED" } });

    const result = await service(gateway).exportAccounts();
    expect(result.exported).toBe(1);
    expect(gateway.importedBatches[1]!.transactions[0]!.cleared).toBe(true);
  });

  it("retries IMPORT_ERROR rows", async () => {
    await seedTransaction({ importStatus: "IMPORT_ERROR" });
    const gateway = new FakeActualGateway();
    const result = await service(gateway).exportAccounts();
    expect(result.exported).toBe(1);
  });

  it("marks rows IMPORT_ERROR when the gateway fails and reports the failure", async () => {
    const txId = await seedTransaction();
    const gateway = new FakeActualGateway();
    gateway.failImports = true;

    const result = await service(gateway).exportAccounts();

    expect(result.failed).toBe(1);
    expect(gateway.closeCount).toBe(1); // budget session still closed
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.importStatus).toBe("IMPORT_ERROR");
  });

  it("never exports soft-deleted rows", async () => {
    await seedTransaction({ deletedAt: new Date() });
    const gateway = new FakeActualGateway();
    const result = await service(gateway).exportAccounts();
    expect(result.exported).toBe(0);
    expect(gateway.importedBatches).toHaveLength(0);
  });

  it("skips the gateway session entirely when nothing needs export", async () => {
    const gateway = new FakeActualGateway();
    const result = await service(gateway).exportAccounts();
    expect(result).toEqual({ exported: 0, failed: 0 });
    expect(gateway.openCount).toBe(0);
  });
});
