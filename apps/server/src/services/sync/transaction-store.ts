import type { Prisma, PrismaClient, Transaction } from "@prisma/client";
import type { NormalizedTransaction } from "./normalize.js";

export interface UpsertCounts {
  received: number;
  inserted: number;
  updated: number;
  skipped: number;
}

function toJsonPayload(tx: NormalizedTransaction): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(tx, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as Prisma.InputJsonValue;
}

function hasChanges(existing: Transaction, tx: NormalizedTransaction): boolean {
  return (
    existing.status !== tx.status ||
    existing.description !== tx.description ||
    (existing.merchantName ?? undefined) !== tx.merchantName ||
    (existing.category ?? undefined) !== tx.category ||
    (existing.transactionType ?? undefined) !== tx.transactionType ||
    existing.bookedDate?.getTime() !== tx.bookedDate.getTime() ||
    (existing.runningBalanceMinor ?? undefined) !== tx.runningBalanceMinor
  );
}

export async function upsertTransactions(
  prisma: PrismaClient,
  accountId: string,
  batch: NormalizedTransaction[],
  storeRaw: boolean,
): Promise<UpsertCounts> {
  const counts: UpsertCounts = { received: batch.length, inserted: 0, updated: 0, skipped: 0 };

  for (const tx of batch) {
    const existing = tx.providerTransactionId
      ? await prisma.transaction.findUnique({
          where: {
            accountId_providerTransactionId: {
              accountId,
              providerTransactionId: tx.providerTransactionId,
            },
          },
        })
      : await prisma.transaction.findUnique({
          where: { accountId_rawHash: { accountId, rawHash: tx.rawHash } },
        });

    if (!existing) {
      await prisma.transaction.create({
        data: {
          accountId,
          providerTransactionId: tx.providerTransactionId ?? null,
          status: tx.status,
          timestamp: tx.timestamp,
          bookedDate: tx.bookedDate,
          amountMinor: tx.amountMinor,
          currency: tx.currency,
          description: tx.description,
          merchantName: tx.merchantName ?? null,
          transactionType: tx.transactionType ?? null,
          category: tx.category ?? null,
          runningBalanceMinor: tx.runningBalanceMinor ?? null,
          rawHash: tx.rawHash,
          ...(storeRaw ? { rawPayload: toJsonPayload(tx) } : {}),
        },
      });
      counts.inserted += 1;
      continue;
    }

    // Soft-deleted rows stay deleted (expired pendings must not come back).
    if (existing.deletedAt || !hasChanges(existing, tx)) {
      counts.skipped += 1;
      continue;
    }

    await prisma.transaction.update({
      where: { id: existing.id },
      data: {
        status: tx.status,
        description: tx.description,
        merchantName: tx.merchantName ?? null,
        category: tx.category ?? null,
        transactionType: tx.transactionType ?? null,
        bookedDate: tx.bookedDate,
        runningBalanceMinor: tx.runningBalanceMinor ?? null,
        ...(storeRaw ? { rawPayload: toJsonPayload(tx) } : {}),
      },
    });
    counts.updated += 1;
  }

  return counts;
}
