import { setTimeout as delay } from "node:timers/promises";
import {
  type BankingProvider,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderTokens,
  type ProviderTransaction,
  ProviderRequestError,
  ReauthRequiredError,
} from "./banking-provider.js";

export interface RetryOptions {
  /** waits between attempts; length = number of retries (spec §28) */
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_DELAYS = [5_000, 30_000, 120_000];

function isTransient(error: unknown): boolean {
  if (error instanceof ReauthRequiredError) return false;
  if (error instanceof ProviderRequestError) {
    // 429: fixed schedule for now; honoring Retry-After is a future refinement.
    return error.httpStatus === 429 || error.httpStatus >= 500;
  }
  // undici/fetch network failures surface as TypeError
  return error instanceof TypeError;
}

/** Wraps any provider with the §28 backoff schedule for transient failures. */
export class RetryingBankingProvider implements BankingProvider {
  private readonly delaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly inner: BankingProvider,
    options: RetryOptions = {},
  ) {
    this.delaysMs = options.delaysMs ?? DEFAULT_DELAYS;
    this.sleep = options.sleep ?? (async (ms) => void (await delay(ms)));
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.delaysMs.length; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!isTransient(error) || attempt === this.delaysMs.length) {
          throw error;
        }
        await this.sleep(this.delaysMs[attempt]!);
      }
    }
    throw lastError;
  }

  buildAuthUrl(state: string): string {
    return this.inner.buildAuthUrl(state);
  }

  async exchangeCode(code: string): Promise<ProviderTokens> {
    return this.withRetry(() => this.inner.exchangeCode(code));
  }

  async refreshTokens(refreshToken: string): Promise<ProviderTokens> {
    return this.withRetry(() => this.inner.refreshTokens(refreshToken));
  }

  async getAccounts(accessToken: string): Promise<ProviderAccount[]> {
    return this.withRetry(() => this.inner.getAccounts(accessToken));
  }

  async getBalance(accessToken: string, providerAccountId: string): Promise<ProviderBalance> {
    return this.withRetry(() => this.inner.getBalance(accessToken, providerAccountId));
  }

  async getTransactions(
    accessToken: string,
    providerAccountId: string,
    from: Date,
    to: Date,
  ): Promise<ProviderTransaction[]> {
    return this.withRetry(() =>
      this.inner.getTransactions(accessToken, providerAccountId, from, to),
    );
  }

  async getPendingTransactions(
    accessToken: string,
    providerAccountId: string,
  ): Promise<ProviderTransaction[]> {
    return this.withRetry(() =>
      this.inner.getPendingTransactions(accessToken, providerAccountId),
    );
  }
}
