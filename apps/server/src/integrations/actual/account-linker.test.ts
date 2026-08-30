import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma, truncateAll } from "../../db/test-helpers.js";
import { ensureAccountLink } from "./account-linker.js";
import { FakeActualGateway } from "./fake-gateway.js";

const prisma = createTestPrisma();
let localAccountId: string;

async function seedAccount(name = "Main Current", type: "CURRENT" | "CREDIT_CARD" = "CURRENT") {
  const connection = await prisma.connection.create({
    data: { provider: "truelayer", providerConnectionId: crypto.randomUUID() },
  });
  const account = await prisma.account.create({
    data: {
      connectionId: connection.id,
      providerAccountId: crypto.randomUUID(),
      name,
      type,
      currency: "GBP",
    },
  });
  return account.id;
}

describe("ensureAccountLink", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
    localAccountId = await seedAccount();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("links to an existing Actual account by case-insensitive name", async () => {
    const gateway = new FakeActualGateway();
    gateway.accounts = [{ id: "actual-1", name: "MAIN CURRENT", closed: false }];

    const actualId = await ensureAccountLink(prisma, gateway, localAccountId);

    expect(actualId).toBe("actual-1");
    expect(gateway.createdAccounts).toHaveLength(0);
    const link = await prisma.actualAccountLink.findUniqueOrThrow({
      where: { localAccountId },
    });
    expect(link.actualAccountId).toBe("actual-1");
  });

  it("ignores closed Actual accounts when matching", async () => {
    const gateway = new FakeActualGateway();
    gateway.accounts = [{ id: "actual-closed", name: "Main Current", closed: true }];
    const actualId = await ensureAccountLink(prisma, gateway, localAccountId);
    expect(actualId).not.toBe("actual-closed");
    expect(gateway.createdAccounts).toHaveLength(1);
  });

  it("creates a new Actual account with a mapped type when no match exists", async () => {
    const creditCardId = await seedAccount("Amex", "CREDIT_CARD");
    const gateway = new FakeActualGateway();

    await ensureAccountLink(prisma, gateway, creditCardId);

    expect(gateway.createdAccounts).toEqual([{ name: "Amex", type: "credit" }]);
  });

  it("disambiguates same-named accounts by currency (multi-currency banks)", async () => {
    const connection = await prisma.connection.create({
      data: { provider: "truelayer", providerConnectionId: crypto.randomUUID() },
    });
    const [gbp, usd] = await Promise.all(
      ["GBP", "USD"].map((currency) =>
        prisma.account.create({
          data: {
            connectionId: connection.id,
            providerAccountId: crypto.randomUUID(),
            name: "Huiying Lan",
            type: "CURRENT",
            currency,
          },
        }),
      ),
    );
    const gateway = new FakeActualGateway();

    const gbpActual = await ensureAccountLink(prisma, gateway, gbp!.id);
    const usdActual = await ensureAccountLink(prisma, gateway, usd!.id);

    expect(gbpActual).not.toBe(usdActual);
    expect(gateway.createdAccounts.map((a) => a.name).sort()).toEqual([
      "Huiying Lan (GBP)",
      "Huiying Lan (USD)",
    ]);
  });

  it("still matches an existing Actual account by the disambiguated name", async () => {
    const connection = await prisma.connection.create({
      data: { provider: "truelayer", providerConnectionId: crypto.randomUUID() },
    });
    const [gbp, usd] = await Promise.all(
      ["GBP", "USD"].map((currency) =>
        prisma.account.create({
          data: {
            connectionId: connection.id,
            providerAccountId: crypto.randomUUID(),
            name: "Huiying Lan",
            type: "CURRENT",
            currency,
          },
        }),
      ),
    );
    const gateway = new FakeActualGateway();
    gateway.accounts = [
      { id: "actual-gbp", name: "huiying lan (gbp)", closed: false },
      { id: "actual-usd", name: "Huiying Lan (USD)", closed: false },
    ];

    expect(await ensureAccountLink(prisma, gateway, gbp!.id)).toBe("actual-gbp");
    expect(await ensureAccountLink(prisma, gateway, usd!.id)).toBe("actual-usd");
    expect(gateway.createdAccounts).toHaveLength(0);
  });

  it("reuses an existing link without touching the gateway", async () => {
    const gateway = new FakeActualGateway();
    const first = await ensureAccountLink(prisma, gateway, localAccountId);
    gateway.accounts = []; // if the gateway were consulted again, matching would fail
    const second = await ensureAccountLink(prisma, gateway, localAccountId);
    expect(second).toBe(first);
    expect(gateway.createdAccounts).toHaveLength(1);
  });
});
