import type {
  ProviderAccount,
  ProviderBalance,
  ProviderTransaction,
} from "../banking-provider.js";

export interface RawTrueLayerAccount {
  account_id: string;
  account_type?: string;
  display_name?: string;
  currency: string;
  account_number?: { number?: string; sort_code?: string };
  provider?: { provider_id?: string; display_name?: string };
}

export interface RawTrueLayerBalance {
  currency: string;
  current?: number;
  available?: number;
}

const ACCOUNT_TYPE_MAP: Record<string, ProviderAccount["type"]> = {
  TRANSACTION: "CURRENT",
  SAVINGS: "SAVINGS",
  BUSINESS_TRANSACTION: "CURRENT",
  BUSINESS_SAVINGS: "SAVINGS",
};

/** Decimal major units (e.g. 12.34) → integer pence, sign preserved (spec §13). */
export function toMinorUnits(major: number): bigint {
  return BigInt(Math.round(major * 100));
}

function maskSortCode(sortCode: string): string {
  return `**-**-${sortCode.slice(-2)}`;
}

export function mapAccount(raw: RawTrueLayerAccount): ProviderAccount {
  const number = raw.account_number?.number;
  const sortCode = raw.account_number?.sort_code;
  const institution = raw.provider?.display_name ?? raw.provider?.provider_id;
  return {
    providerAccountId: raw.account_id,
    name: raw.display_name ?? raw.provider?.display_name ?? "Account",
    type: ACCOUNT_TYPE_MAP[raw.account_type ?? ""] ?? "OTHER",
    currency: raw.currency,
    ...(number ? { accountNumberLast4: number.slice(-4) } : {}),
    ...(sortCode ? { sortCodeMasked: maskSortCode(sortCode) } : {}),
    ...(institution ? { institutionName: institution } : {}),
  };
}

export interface RawTrueLayerTransaction {
  transaction_id?: string;
  timestamp: string;
  description?: string;
  amount: number;
  currency: string;
  transaction_type?: string;
  transaction_category?: string;
  transaction_classification?: string[];
  merchant_name?: string;
  running_balance?: { currency?: string; amount?: number };
}

/** Canonical sign (spec §13): DEBIT ⇒ −|amount|, CREDIT ⇒ +|amount|, unknown ⇒ trust provider. */
function canonicalAmountMinor(amount: number, transactionType?: string): bigint {
  const minor = toMinorUnits(amount);
  const magnitude = minor < 0n ? -minor : minor;
  if (transactionType === "DEBIT") return -magnitude;
  if (transactionType === "CREDIT") return magnitude;
  return minor;
}

function utcDateOf(timestamp: Date): Date {
  return new Date(
    Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate()),
  );
}

export function mapTransaction(
  raw: RawTrueLayerTransaction,
  status: "PENDING" | "SETTLED",
): ProviderTransaction {
  const timestamp = new Date(raw.timestamp);
  const classification = raw.transaction_classification;
  const runningBalance = raw.running_balance?.amount;
  return {
    ...(raw.transaction_id ? { providerTransactionId: raw.transaction_id } : {}),
    status,
    timestamp,
    bookedDate: utcDateOf(timestamp),
    amountMinor: canonicalAmountMinor(raw.amount, raw.transaction_type),
    currency: raw.currency,
    description: raw.description?.trim() || "(no description)",
    ...(raw.merchant_name ? { merchantName: raw.merchant_name } : {}),
    ...(raw.transaction_category ? { transactionType: raw.transaction_category } : {}),
    ...(classification && classification.length > 0
      ? { category: classification.join(" / ") }
      : {}),
    ...(runningBalance !== undefined
      ? { runningBalanceMinor: toMinorUnits(runningBalance) }
      : {}),
  };
}

export function mapBalance(raw: RawTrueLayerBalance): ProviderBalance {
  return {
    currentMinor: raw.current === undefined ? null : toMinorUnits(raw.current),
    availableMinor: raw.available === undefined ? null : toMinorUnits(raw.available),
    currency: raw.currency,
  };
}
