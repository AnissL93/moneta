export interface ProviderTokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when accessToken expires */
  expiresAt: number;
}

export interface ProviderAccount {
  providerAccountId: string;
  name: string;
  type: "CURRENT" | "SAVINGS" | "CREDIT_CARD" | "OTHER";
  currency: string;
  accountNumberLast4?: string;
  sortCodeMasked?: string;
  institutionName?: string;
}

export interface ProviderBalance {
  currentMinor: bigint | null;
  availableMinor: bigint | null;
  currency: string;
}

export interface ProviderTransaction {
  providerTransactionId?: string;
  status: "PENDING" | "SETTLED";
  timestamp: Date;
  /** UTC midnight of the transaction's calendar date */
  bookedDate: Date;
  /** canonical sign: negative = money out (spec §13) */
  amountMinor: bigint;
  currency: string;
  description: string;
  merchantName?: string;
  transactionType?: string;
  category?: string;
  runningBalanceMinor?: bigint;
}

// Provider-independence boundary (spec §4.2): everything TrueLayer-specific
// stays behind this interface.
export interface BankingProvider {
  buildAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<ProviderTokens>;
  refreshTokens(refreshToken: string): Promise<ProviderTokens>;
  getAccounts(accessToken: string): Promise<ProviderAccount[]>;
  getBalance(accessToken: string, providerAccountId: string): Promise<ProviderBalance>;
  getTransactions(
    accessToken: string,
    providerAccountId: string,
    from: Date,
    to: Date,
  ): Promise<ProviderTransaction[]>;
  getPendingTransactions(
    accessToken: string,
    providerAccountId: string,
  ): Promise<ProviderTransaction[]>;
}

/** Authorization is gone for good — the user must reconnect (spec §7.2, §10). */
export class ReauthRequiredError extends Error {
  constructor(message = "provider authorization expired") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

/** Any other non-success provider response (retryable at the sync layer, spec §27). */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
