import { describe, expect, it } from "vitest";
import {
  type BankingProvider,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderTokens,
  type ProviderTransaction,
  ProviderRequestError,
  ReauthRequiredError,
} from "./banking-provider.js";
import { RetryingBankingProvider } from "./retrying-provider.js";

class ScriptedProvider implements BankingProvider {
  errors: Error[] = [];
  calls = 0;

  private attempt<T>(value: T): T {
    this.calls += 1;
    const error = this.errors.shift();
    if (error) throw error;
    return value;
  }

  buildAuthUrl(state: string): string {
    return `url-${state}`;
  }
  async exchangeCode(): Promise<ProviderTokens> {
    return this.attempt({ accessToken: "a", refreshToken: "r", expiresAt: 0 });
  }
  async refreshTokens(): Promise<ProviderTokens> {
    return this.attempt({ accessToken: "a", refreshToken: "r", expiresAt: 0 });
  }
  async getAccounts(): Promise<ProviderAccount[]> {
    return this.attempt([]);
  }
  async getBalance(): Promise<ProviderBalance> {
    return this.attempt({ currentMinor: 0n, availableMinor: 0n, currency: "GBP" });
  }
  async getTransactions(): Promise<ProviderTransaction[]> {
    return this.attempt([]);
  }
  async getPendingTransactions(): Promise<ProviderTransaction[]> {
    return this.attempt([]);
  }
}

function make(inner: ScriptedProvider) {
  const sleeps: number[] = [];
  const provider = new RetryingBankingProvider(inner, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { provider, sleeps };
}

describe("RetryingBankingProvider", () => {
  it("retries transient server errors with the §28 schedule", async () => {
    const inner = new ScriptedProvider();
    inner.errors = [
      new ProviderRequestError("boom", 500),
      new ProviderRequestError("boom", 503),
    ];
    const { provider, sleeps } = make(inner);
    await expect(provider.getAccounts("t")).resolves.toEqual([]);
    expect(inner.calls).toBe(3);
    expect(sleeps).toEqual([5_000, 30_000]);
  });

  it("gives up after three retries and rethrows the last error", async () => {
    const inner = new ScriptedProvider();
    inner.errors = [
      new ProviderRequestError("a", 500),
      new ProviderRequestError("b", 500),
      new ProviderRequestError("c", 500),
      new ProviderRequestError("final", 500),
    ];
    const { provider, sleeps } = make(inner);
    await expect(provider.getAccounts("t")).rejects.toThrow("final");
    expect(sleeps).toEqual([5_000, 30_000, 120_000]);
  });

  it("retries rate limits and network errors", async () => {
    const inner = new ScriptedProvider();
    inner.errors = [new ProviderRequestError("429", 429), new TypeError("fetch failed")];
    const { provider, sleeps } = make(inner);
    await expect(provider.getBalance("t", "a")).resolves.toBeTruthy();
    expect(sleeps).toHaveLength(2);
  });

  it("never retries reauth or client errors", async () => {
    const inner = new ScriptedProvider();
    inner.errors = [new ReauthRequiredError()];
    const { provider, sleeps } = make(inner);
    await expect(provider.getAccounts("t")).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(sleeps).toHaveLength(0);

    const inner2 = new ScriptedProvider();
    inner2.errors = [new ProviderRequestError("bad request", 400)];
    const { provider: provider2, sleeps: sleeps2 } = make(inner2);
    await expect(provider2.getAccounts("t")).rejects.toThrow("bad request");
    expect(sleeps2).toHaveLength(0);
  });

  it("passes buildAuthUrl straight through", () => {
    const inner = new ScriptedProvider();
    const { provider } = make(inner);
    expect(provider.buildAuthUrl("s")).toBe("url-s");
  });
});
