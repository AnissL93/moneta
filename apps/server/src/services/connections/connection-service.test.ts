import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma, truncateAll } from "../../db/test-helpers.js";
import {
  type BankingProvider,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderTokens,
  type ProviderTransaction,
  ReauthRequiredError,
} from "../../providers/banking-provider.js";
import { ConnectionService } from "./connection-service.js";

const prisma = createTestPrisma();
const encryptionKey = "c".repeat(64);

class FakeProvider implements BankingProvider {
  exchangeCalls: string[] = [];
  refreshCalls: string[] = [];
  failRefresh = false;
  tokenCounter = 0;
  accounts: ProviderAccount[] = [
    {
      providerAccountId: "tl-acc-1",
      name: "Main Current",
      type: "CURRENT",
      currency: "GBP",
      accountNumberLast4: "5678",
      sortCodeMasked: "**-**-56",
      institutionName: "Mock Bank",
    },
    {
      providerAccountId: "tl-acc-2",
      name: "Rainy Day",
      type: "SAVINGS",
      currency: "GBP",
      institutionName: "Mock Bank",
    },
  ];

  buildAuthUrl(state: string): string {
    return `https://auth.example.com/?state=${state}`;
  }

  async exchangeCode(code: string): Promise<ProviderTokens> {
    this.exchangeCalls.push(code);
    this.tokenCounter += 1;
    return {
      accessToken: `access-${this.tokenCounter}`,
      refreshToken: `refresh-${this.tokenCounter}`,
      expiresAt: Date.now() + 3_500_000,
    };
  }

  async refreshTokens(refreshToken: string): Promise<ProviderTokens> {
    this.refreshCalls.push(refreshToken);
    if (this.failRefresh) {
      throw new ReauthRequiredError();
    }
    this.tokenCounter += 1;
    return {
      accessToken: `access-${this.tokenCounter}`,
      refreshToken: `refresh-${this.tokenCounter}`,
      expiresAt: Date.now() + 3_500_000,
    };
  }

  async getAccounts(): Promise<ProviderAccount[]> {
    return this.accounts;
  }

  async getBalance(_token: string, providerAccountId: string): Promise<ProviderBalance> {
    return {
      currentMinor: providerAccountId === "tl-acc-1" ? 123456n : 500000n,
      availableMinor: 100000n,
      currency: "GBP",
    };
  }

  async getTransactions(): Promise<ProviderTransaction[]> {
    return [];
  }

  async getPendingTransactions(): Promise<ProviderTransaction[]> {
    return [];
  }
}

function makeService(provider: BankingProvider, now?: () => number): ConnectionService {
  return new ConnectionService({
    prisma,
    provider,
    encryptionKey,
    ...(now ? { now } : {}),
  });
}

describe("ConnectionService", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates an auth session with a persisted single-use state", async () => {
    const service = makeService(new FakeProvider());
    const { authUrl, state } = await service.createAuthSession();
    expect(authUrl).toContain(state);
    const stored = await prisma.setting.findUnique({ where: { key: `auth_state:${state}` } });
    expect(stored).not.toBeNull();
  });

  it("handles the callback: persists encrypted credentials and discovers accounts", async () => {
    const fake = new FakeProvider();
    const service = makeService(fake);
    const { state } = await service.createAuthSession();

    const result = await service.handleCallback({ code: "auth-code", state });
    expect(fake.exchangeCalls).toEqual(["auth-code"]);
    expect(result.accountsDiscovered).toBe(2);

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: result.connectionId },
    });
    expect(connection.status).toBe("ACTIVE");
    expect(connection.encryptedCredentials).not.toBeNull();
    expect(connection.encryptedCredentials).not.toContain("access-1");
    expect(connection.lastSuccessfulSync).not.toBeNull();

    const accounts = await prisma.account.findMany({ orderBy: { name: "asc" } });
    expect(accounts.map((a) => a.name)).toEqual(["Main Current", "Rainy Day"]);
    expect(accounts[0]!.accountNumberLast4).toBe("5678");

    const balances = await prisma.balance.findMany();
    expect(balances).toHaveLength(2);
    expect(balances.map((b) => b.currentAmountMinor).sort()).toEqual([123456n, 500000n]);
  });

  it("rejects an unknown or reused state", async () => {
    const service = makeService(new FakeProvider());
    await expect(
      service.handleCallback({ code: "c", state: "never-issued" }),
    ).rejects.toThrow(/invalid or expired state/);

    const { state } = await service.createAuthSession();
    await service.handleCallback({ code: "c", state });
    await expect(service.handleCallback({ code: "c2", state })).rejects.toThrow(
      /invalid or expired state/,
    );
  });

  it("rejects an expired state", async () => {
    let clock = Date.now();
    const service = makeService(new FakeProvider(), () => clock);
    const { state } = await service.createAuthSession();
    clock += 11 * 60 * 1000;
    await expect(service.handleCallback({ code: "c", state })).rejects.toThrow(
      /invalid or expired state/,
    );
  });

  it("reauthorizes onto the same connection row without duplicating accounts", async () => {
    const fake = new FakeProvider();
    const service = makeService(fake);
    const first = await service.handleCallback({
      code: "c1",
      state: (await service.createAuthSession()).state,
    });

    await prisma.connection.update({
      where: { id: first.connectionId },
      data: { status: "REAUTH_REQUIRED" },
    });

    const { state } = await service.createAuthSession(first.connectionId);
    const second = await service.handleCallback({ code: "c2", state });

    expect(second.connectionId).toBe(first.connectionId);
    expect(await prisma.connection.count()).toBe(1);
    expect(await prisma.account.count()).toBe(2);
    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    expect(connection.status).toBe("ACTIVE");
  });

  it("returns the current access token while it is fresh", async () => {
    const fake = new FakeProvider();
    const service = makeService(fake);
    const { connectionId } = await service.handleCallback({
      code: "c1",
      state: (await service.createAuthSession()).state,
    });
    expect(await service.getValidAccessToken(connectionId)).toBe("access-1");
    expect(fake.refreshCalls).toHaveLength(0);
  });

  it("refreshes an expired token and persists the rotated refresh token", async () => {
    let clock = Date.now();
    const fake = new FakeProvider();
    const service = makeService(fake, () => clock);
    const { connectionId } = await service.handleCallback({
      code: "c1",
      state: (await service.createAuthSession()).state,
    });

    clock += 4_000_000;
    expect(await service.getValidAccessToken(connectionId)).toBe("access-2");
    expect(fake.refreshCalls).toEqual(["refresh-1"]);

    // rotated refresh token is what gets used next time
    clock += 4_000_000;
    await service.getValidAccessToken(connectionId);
    expect(fake.refreshCalls).toEqual(["refresh-1", "refresh-2"]);
  });

  it("marks the connection REAUTH_REQUIRED when refresh fails", async () => {
    let clock = Date.now();
    const fake = new FakeProvider();
    const service = makeService(fake, () => clock);
    const { connectionId } = await service.handleCallback({
      code: "c1",
      state: (await service.createAuthSession()).state,
    });

    clock += 4_000_000;
    fake.failRefresh = true;
    await expect(service.getValidAccessToken(connectionId)).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(connection.status).toBe("REAUTH_REQUIRED");
  });

  it("disables a connection without deleting history", async () => {
    const service = makeService(new FakeProvider());
    const { connectionId } = await service.handleCallback({
      code: "c1",
      state: (await service.createAuthSession()).state,
    });
    await service.disableConnection(connectionId);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(connection.status).toBe("DISABLED");
    expect(await prisma.account.count()).toBe(2);
    expect(await prisma.balance.count()).toBe(2);
  });

  it("lists connections with summary fields", async () => {
    const service = makeService(new FakeProvider());
    await service.handleCallback({
      code: "c1",
      state: (await service.createAuthSession()).state,
    });
    const list = await service.listConnections();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: "truelayer", status: "ACTIVE" });
  });
});
