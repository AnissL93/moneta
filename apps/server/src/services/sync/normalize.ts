import { createHash } from "node:crypto";
import type { ProviderTransaction } from "../../providers/banking-provider.js";

export type NormalizedTransaction = ProviderTransaction & { rawHash: string };

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Fingerprint tuple for id-less rows (spec §14, amended): identity without provider help. */
function fingerprintKey(accountId: string, tx: ProviderTransaction): string {
  return [
    accountId,
    tx.bookedDate.toISOString().slice(0, 10),
    tx.amountMinor.toString(),
    normalizeDescription(tx.description),
    tx.merchantName?.toUpperCase() ?? "",
  ].join("|");
}

/**
 * Assigns each transaction its stable raw_hash:
 * - provider id present ⇒ hash of the id alone (survives description edits);
 * - otherwise ⇒ spec §14 fingerprint + occurrence index so two genuinely
 *   identical transactions in one batch both survive (deterministic sort
 *   makes the assignment order-independent).
 */
export function normalizeBatch(
  accountId: string,
  transactions: ProviderTransaction[],
): NormalizedTransaction[] {
  const sorted = [...transactions].sort((a, b) => {
    const t = a.timestamp.getTime() - b.timestamp.getTime();
    if (t !== 0) return t;
    if (a.amountMinor !== b.amountMinor) return a.amountMinor < b.amountMinor ? -1 : 1;
    return a.description.localeCompare(b.description);
  });

  const occurrences = new Map<string, number>();
  const hashes = new Map<ProviderTransaction, string>();
  for (const tx of sorted) {
    if (tx.providerTransactionId) {
      hashes.set(tx, sha256(`${accountId}|ptid|${tx.providerTransactionId}`));
      continue;
    }
    const key = fingerprintKey(accountId, tx);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    hashes.set(tx, sha256(`${key}|${occurrence}`));
  }

  return transactions.map((tx) => ({ ...tx, rawHash: hashes.get(tx)! }));
}
