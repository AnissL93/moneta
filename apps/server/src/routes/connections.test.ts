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
import { buildServer } from "../server.js";

const prisma = createTestPrisma();
const token = "0123456789abcdef0123456789abcdef";
const auth = { authorization: `Bearer ${token}` };

class FakeProvider implements BankingProvider {
  buildAuthUrl(state: string): string {
    return `https://auth.example.com/?state=${state}`;
  }
  async exchangeCode(): Promise<ProviderTokens> {
    return { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 3_500_000 };
  }
  async refreshTokens(): Promise<ProviderTokens> {
    return { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: Date.now() + 3_500_000 };
  }
  async getAccounts(): Promise<ProviderAccount[]> {
    return [
      {
        providerAccountId: "tl-acc-1",
        name: "Main Current",
        type: "CURRENT",
        currency: "GBP",
        accountNumberLast4: "5678",
        institutionName: "Mock Bank",
      },
    ];
  }
  async getBalance(): Promise<ProviderBalance> {
    return { currentMinor: 123456n, availableMinor: 100000n, currency: "GBP" };
  }
  async getTransactions(): Promise<ProviderTransaction[]> {
    return [];
  }
  async getPendingTransactions(): Promise<ProviderTransaction[]> {
    return [];
  }
}

function makeServer(): FastifyInstance {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    API_TOKEN: token,
  });
  const connectionService = new ConnectionService({
    prisma,
    provider: new FakeProvider(),
    encryptionKey: "c".repeat(64),
  });
  return buildServer(config, { prisma, connectionService });
}

describe("connection routes", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("requires the bearer token on connection routes", async () => {
    const server = makeServer();
    expect((await server.inject({ method: "GET", url: "/connections" })).statusCode).toBe(401);
    expect(
      (await server.inject({ method: "POST", url: "/connections/truelayer" })).statusCode,
    ).toBe(401);
  });

  it("starts an auth session", async () => {
    const server = makeServer();
    const response = await server.inject({
      method: "POST",
      url: "/connections/truelayer",
      headers: auth,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { authUrl: string; state: string };
    expect(body.authUrl).toContain(body.state);
  });

  it("completes the callback without auth and persists accounts", async () => {
    const server = makeServer();
    const { state } = (
      await server.inject({ method: "POST", url: "/connections/truelayer", headers: auth })
    ).json() as { state: string };

    const callback = await server.inject({
      method: "GET",
      url: `/auth/truelayer/callback?code=the-code&state=${state}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("Bank connected");
    expect(await prisma.account.count()).toBe(1);
  });

  it("rejects a callback with a bad state", async () => {
    const server = makeServer();
    const response = await server.inject({
      method: "GET",
      url: "/auth/truelayer/callback?code=c&state=bogus",
    });
    expect(response.statusCode).toBe(400);
  });

  it("surfaces provider error redirects as 400", async () => {
    const server = makeServer();
    const response = await server.inject({
      method: "GET",
      url: "/auth/truelayer/callback?error=access_denied",
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("access_denied");
  });

  it("lists connections and accounts with string-serialized balances", async () => {
    const server = makeServer();
    const { state } = (
      await server.inject({ method: "POST", url: "/connections/truelayer", headers: auth })
    ).json() as { state: string };
    await server.inject({ method: "GET", url: `/auth/truelayer/callback?code=c&state=${state}` });

    const connections = (
      await server.inject({ method: "GET", url: "/connections", headers: auth })
    ).json() as { connections: Array<{ status: string; institutionName: string }> };
    expect(connections.connections[0]).toMatchObject({
      status: "ACTIVE",
      institutionName: "Mock Bank",
    });

    const accounts = (
      await server.inject({ method: "GET", url: "/accounts", headers: auth })
    ).json() as {
      accounts: Array<{ name: string; latestBalance: { currentMinor: string } | null }>;
    };
    expect(accounts.accounts[0]!.name).toBe("Main Current");
    expect(accounts.accounts[0]!.latestBalance?.currentMinor).toBe("123456");
  });

  it("reauthorizes an existing connection and 404s an unknown one", async () => {
    const server = makeServer();
    const { state } = (
      await server.inject({ method: "POST", url: "/connections/truelayer", headers: auth })
    ).json() as { state: string };
    await server.inject({ method: "GET", url: `/auth/truelayer/callback?code=c&state=${state}` });
    const connection = await prisma.connection.findFirstOrThrow();

    const ok = await server.inject({
      method: "POST",
      url: `/connections/${connection.id}/reauthorize`,
      headers: auth,
    });
    expect(ok.statusCode).toBe(201);

    const missing = await server.inject({
      method: "POST",
      url: "/connections/00000000-0000-0000-0000-000000000000/reauthorize",
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("soft-disables a connection on DELETE", async () => {
    const server = makeServer();
    const { state } = (
      await server.inject({ method: "POST", url: "/connections/truelayer", headers: auth })
    ).json() as { state: string };
    await server.inject({ method: "GET", url: `/auth/truelayer/callback?code=c&state=${state}` });
    const connection = await prisma.connection.findFirstOrThrow();

    const response = await server.inject({
      method: "DELETE",
      url: `/connections/${connection.id}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "DISABLED" });
    expect(await prisma.account.count()).toBe(1);
  });

  it("returns 503 on connection routes when truelayer is not configured", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      API_TOKEN: token,
    });
    const server = buildServer(config, { prisma });
    const response = await server.inject({
      method: "POST",
      url: "/connections/truelayer",
      headers: auth,
    });
    expect(response.statusCode).toBe(503);
  });
});
