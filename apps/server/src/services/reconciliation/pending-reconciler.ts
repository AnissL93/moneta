import type { PrismaClient, Transaction } from "@prisma/client";

const MATCH_WINDOW_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReconcileOptions {
  now: () => number;
  pendingExpiryDays: number;
  /** provider ids of pendings reported in THIS sync's pending fetch */
  seenPendingIds: Set<string>;
}

export interface ReconcileResult {
  merged: number;
  expired: number;
}

function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, " ").toUpperCase();
}

function matches(pending: Transaction, settled: Transaction): boolean {
  if (pending.amountMinor !== settled.amountMinor) return false;
  const pendingDate = pending.bookedDate ?? pending.timestamp;
  const settledDate = settled.bookedDate ?? settled.timestamp;
  if (Math.abs(pendingDate.getTime() - settledDate.getTime()) > MATCH_WINDOW_DAYS * DAY_MS) {
    return false;
  }
  if (pending.merchantName && settled.merchantName) {
    return pending.merchantName.toUpperCase() === settled.merchantName.toUpperCase();
  }
  return normalizeDescription(pending.description) === normalizeDescription(settled.description);
}

/**
 * Spec §15: a settled arrival replaces its pending twin instead of coexisting
 * with it, and pendings that vanish upstream (declined/expired) don't linger.
 * Merges soft-delete the pending row; the settled row is the survivor.
 */
export async function reconcilePending(
  prisma: PrismaClient,
  accountId: string,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const nowDate = new Date(options.now());
  const pendings = await prisma.transaction.findMany({
    where: { accountId, status: "PENDING", deletedAt: null },
    orderBy: { timestamp: "asc" },
  });
  if (pendings.length === 0) return { merged: 0, expired: 0 };

  const settled = await prisma.transaction.findMany({
    where: { accountId, status: "SETTLED", deletedAt: null },
    orderBy: { timestamp: "asc" },
  });

  let merged = 0;
  let expired = 0;
  const claimedSettledIds = new Set<string>();

  for (const pending of pendings) {
    const twin = settled.find((s) => !claimedSettledIds.has(s.id) && matches(pending, s));
    if (twin) {
      claimedSettledIds.add(twin.id);
      await prisma.transaction.update({
        where: { id: pending.id },
        data: { deletedAt: nowDate },
      });
      merged += 1;
      continue;
    }

    const seen =
      pending.providerTransactionId !== null &&
      options.seenPendingIds.has(pending.providerTransactionId);
    const ageMs = options.now() - pending.updatedAt.getTime();
    if (!seen && ageMs > options.pendingExpiryDays * DAY_MS) {
      await prisma.transaction.update({
        where: { id: pending.id },
        data: { deletedAt: nowDate },
      });
      expired += 1;
    }
  }

  return { merged, expired };
}
