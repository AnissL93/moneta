import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config/config.js";
import { createTestPrisma, truncateAll } from "../db/test-helpers.js";
import { buildServer } from "../server.js";

const prisma = createTestPrisma();
const token = "0123456789abcdef0123456789abcdef";
const auth = { authorization: `Bearer ${token}` };

function makeServer(): FastifyInstance {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    API_TOKEN: token,
  });
  return buildServer(config, { prisma });
}

async function seedData() {
  const connection = await prisma.connection.create({
    data: {
      provider: "truelayer",
      providerConnectionId: crypto.randomUUID(),
      institutionName: "Mock Bank",
      lastSuccessfulSync: new Date("2026-08-28T06:00:00Z"),
    },
  });
  const account = await prisma.account.create({
    data: {
      connectionId: connection.id,
      providerAccountId: "tl-1",
      name: "Main, Current",
      type: "CURRENT",
      currency: "GBP",
      lastSuccessfulSync: new Date("2026-08-28T06:00:00Z"),
    },
  });
  await prisma.balance.create({
    data: { accountId: account.id, currentAmountMinor: 123456n, currency: "GBP" },
  });
  await prisma.transaction.create({
    data: {
      accountId: account.id,
      providerTransactionId: "tx-1",
      status: "SETTLED",
      timestamp: new Date("2026-08-27T10:00:00Z"),
      bookedDate: new Date("2026-08-27T00:00:00Z"),
      amountMinor: -450n,
      currency: "GBP",
      description: 'COSTA "COFFEE", LEEDS',
      merchantName: "Costa",
      category: "Food / Coffee",
      rawHash: "h1",
    },
  });
  await prisma.transaction.create({
    data: {
      accountId: account.id,
      status: "PENDING",
      timestamp: new Date("2026-08-28T10:00:00Z"),
      bookedDate: new Date("2026-08-28T00:00:00Z"),
      amountMinor: -1000n,
      currency: "GBP",
      description: "DELETED ROW",
      rawHash: "h2",
      deletedAt: new Date(),
    },
  });
  await prisma.syncRun.create({
    data: {
      connectionId: connection.id,
      status: "SUCCESS",
      finishedAt: new Date("2026-08-28T06:00:05Z"),
      transactionsInserted: 1,
    },
  });
}

describe("status and export routes", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
    await seedData();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("requires auth on both routes", async () => {
    const server = makeServer();
    expect((await server.inject({ method: "GET", url: "/status" })).statusCode).toBe(401);
    expect(
      (await server.inject({ method: "GET", url: "/export/transactions.csv" })).statusCode,
    ).toBe(401);
  });

  it("summarizes connections, accounts, and the last run", async () => {
    const server = makeServer();
    const response = await server.inject({ method: "GET", url: "/status", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      database: string;
      actualConfigured: boolean;
      connections: Array<{
        institutionName: string;
        status: string;
        accounts: Array<{
          name: string;
          transactionCount: number;
          latestBalance: { currentMinor: string } | null;
        }>;
      }>;
      lastRun: { status: string } | null;
    };
    expect(body.database).toBe("ok");
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]!.institutionName).toBe("Mock Bank");
    const account = body.connections[0]!.accounts[0]!;
    expect(account.transactionCount).toBe(1); // soft-deleted row not counted
    expect(account.latestBalance?.currentMinor).toBe("123456");
    expect(body.lastRun?.status).toBe("SUCCESS");
  });

  it("exports CSV with exact spec columns, quoting, and signed decimal amounts", async () => {
    const server = makeServer();
    const response = await server.inject({
      method: "GET",
      url: "/export/transactions.csv",
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    const [header, row, ...rest] = response.body.trim().split("\n");
    expect(header).toBe(
      "account,date,amount,currency,merchant,description,category,status,provider,provider_transaction_id",
    );
    expect(row).toBe(
      '"Main, Current",2026-08-27,-4.50,GBP,Costa,"COSTA ""COFFEE"", LEEDS",Food / Coffee,SETTLED,truelayer,tx-1',
    );
    expect(rest).toHaveLength(0); // soft-deleted row excluded
  });
});

describe("ui route", () => {
  it("serves the static shell without auth and without data", async () => {
    const server = makeServer();
    const response = await server.inject({ method: "GET", url: "/ui" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Moneta");
    expect(response.body).not.toContain("Mock Bank"); // no data inlined
  });
});
