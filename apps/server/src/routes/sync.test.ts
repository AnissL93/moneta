import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config/config.js";
import { createTestPrisma, truncateAll } from "../db/test-helpers.js";
import {
  type BankingProvider,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderTokens,
  type ProviderTransaction,
} from "../providers/banking-provider.js";
import { ConnectionService } from "../services/connections/connection-service.js";
import { SyncEngine } from "../services/sync/sync-engine.js";
import { buildServer } from "../server.js";

const prisma = createTestPrisma();
const token = "0123456789abcdef0123456789abcdef";
const auth = { authorization: `Bearer ${token}` };

class FakeProvider implements BankingProvider {
  buildAuthUrl(state: string): string {
    return `https://auth.example.com/?state=${state}`;
  }
  async exchangeCode(): Promise<ProviderTokens> {
    return { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
  }
  async refreshTokens(): Promise<ProviderTokens> {
    return { accessToken: "a2", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 };
  }
  async getAccounts(): Promise<ProviderAccount[]> {
    return [{ providerAccountId: "tl-acc-1", name: "Main", type: "CURRENT", currency: "GBP" }];
  }
  async getBalance(): Promise<ProviderBalance> {
    return { currentMinor: 10000n, availableMinor: 9000n, currency: "GBP" };
  }
  async getTransactions(): Promise<ProviderTransaction[]> {
    const timestamp = new Date("2026-08-27T10:00:00Z");
    return [
      {
        providerTransactionId: "tx-1",
        status: "SETTLED",
        timestamp,
        bookedDate: new Date("2026-08-27T00:00:00Z"),
        amountMinor: -450n,
        currency: "GBP",
        description: "COSTA",
      },
    ];
  }
  async getPendingTransactions(): Promise<ProviderTransaction[]> {
    return [];
  }
}

async function makeServer(withEngine = true): Promise<{ server: FastifyInstance }> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    API_TOKEN: token,
  });
  const provider = new FakeProvider();
  const connectionService = new ConnectionService({
    prisma,
    provider,
    encryptionKey: "c".repeat(64),
  });
  const syncEngine = new SyncEngine({
    prisma,
    connectionService,
    provider,
    config: {
      syncOverlapDays: 7,
      initialSyncDays: 365,
      pendingExpiryDays: 14,
      storeRawProviderData: false,
    },
  });
  const server = buildServer(config, {
    prisma,
    connectionService,
    ...(withEngine ? { syncEngine } : {}),
  });
  // establish one connection via the HTTP flow
  const { state } = (
    await server.inject({ method: "POST", url: "/connections/truelayer", headers: auth })
  ).json() as { state: string };
  await server.inject({ method: "GET", url: `/auth/truelayer/callback?code=c&state=${state}` });
  return { server };
}

describe("sync routes", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("requires auth", async () => {
    const { server } = await makeServer();
    expect((await server.inject({ method: "POST", url: "/sync" })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/sync/runs" })).statusCode).toBe(401);
  });

  it("runs a full sync and reports the run", async () => {
    const { server } = await makeServer();
    const response = await server.inject({ method: "POST", url: "/sync", headers: auth });
    expect(response.statusCode).toBe(202);
    const { runs } = response.json() as { runs: string[] };
    expect(runs).toHaveLength(1);
    expect(await prisma.transaction.count()).toBe(1);

    const listing = await server.inject({ method: "GET", url: "/sync/runs", headers: auth });
    const body = listing.json() as {
      runs: Array<{ id: string; status: string; transactionsInserted: number; errors: unknown[] }>;
    };
    expect(body.runs[0]!.id).toBe(runs[0]);
    expect(body.runs[0]!.status).toBe("SUCCESS");
    expect(body.runs[0]!.transactionsInserted).toBe(1);
  });

  it("syncs a single account and 404s unknown accounts", async () => {
    const { server } = await makeServer();
    const account = await prisma.account.findFirstOrThrow();
    const ok = await server.inject({
      method: "POST",
      url: `/sync/${account.id}`,
      headers: auth,
    });
    expect(ok.statusCode).toBe(202);
    expect((ok.json() as { runId: string }).runId).toBeTruthy();

    const missing = await server.inject({
      method: "POST",
      url: "/sync/00000000-0000-0000-0000-000000000000",
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("returns 503 when the sync engine is not configured", async () => {
    const { server } = await makeServer(false);
    const response = await server.inject({ method: "POST", url: "/sync", headers: auth });
    expect(response.statusCode).toBe(503);
  });
});
