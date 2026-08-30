import type { PrismaClient, Transaction } from "@prisma/client";
import { ensureAccountLink } from "./account-linker.js";
import type { ActualGateway, ActualImportTransaction } from "./gateway.js";

export interface ExportSummary {
  exported: number;
  failed: number;
}

export interface ActualExportServiceDeps {
  prisma: PrismaClient;
  gateway: ActualGateway;
  now?: () => number;
}

function toImportTransaction(actualAccountId: string, tx: Transaction): ActualImportTransaction {
  const date = (tx.bookedDate ?? tx.timestamp).toISOString().slice(0, 10);
  return {
    account: actualAccountId,
    date,
    // Actual uses integer minor units with negative outflows — same
    // convention as ours (spec §13/§25), so this is a plain narrowing.
    amount: Number(tx.amountMinor),
    imported_id: tx.id,
    ...(tx.merchantName ? { payee_name: tx.merchantName } : {}),
    imported_payee: tx.description,
    notes: tx.description,
    cleared: tx.status === "SETTLED",
  };
}

export class ActualExportService {
  private readonly prisma: PrismaClient;
  private readonly gateway: ActualGateway;
  private readonly now: () => number;

  constructor(deps: ActualExportServiceDeps) {
    this.prisma = deps.prisma;
    this.gateway = deps.gateway;
    this.now = deps.now ?? Date.now;
  }

  /** Rows needing export: never-imported, failed, or changed since import (spec §26). */
  private async pendingRows(accountIds?: string[]): Promise<Transaction[]> {
    return this.prisma.$queryRawUnsafe<Transaction[]>(
      `SELECT * FROM transactions
       WHERE deleted_at IS NULL
         AND (import_status IN ('NOT_IMPORTED', 'IMPORT_ERROR')
              OR (import_status = 'IMPORTED' AND updated_at > imported_at))
         ${accountIds ? `AND account_id IN (${accountIds.map((_, i) => `$${i + 1}`).join(",")})` : ""}
       ORDER BY account_id, timestamp`,
      ...(accountIds ?? []),
    );
  }

  async exportAccounts(accountIds?: string[]): Promise<ExportSummary> {
    const raw = await this.pendingRows(accountIds);
    if (raw.length === 0) {
      return { exported: 0, failed: 0 };
    }
    // $queryRaw returns snake_case columns — remap the fields we use.
    const rows = raw.map((r) => {
      const rec = r as unknown as Record<string, unknown>;
      return {
        id: rec.id as string,
        accountId: rec.account_id as string,
        status: rec.status as Transaction["status"],
        timestamp: rec.timestamp as Date,
        bookedDate: rec.booked_date as Date | null,
        amountMinor: rec.amount_minor as bigint,
        description: rec.description as string,
        merchantName: rec.merchant_name as string | null,
      };
    });

    const byAccount = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byAccount.get(row.accountId) ?? [];
      list.push(row);
      byAccount.set(row.accountId, list);
    }

    let exported = 0;
    let failed = 0;
    await this.gateway.open();
    try {
      for (const [accountId, batch] of byAccount) {
        try {
          const actualAccountId = await ensureAccountLink(this.prisma, this.gateway, accountId);
          const payload = batch.map((row) =>
            toImportTransaction(actualAccountId, row as unknown as Transaction),
          );
          const result = await this.gateway.importTransactions(actualAccountId, payload);
          const addedIds = [...result.added];
          for (const row of batch) {
            const actualTransactionId = addedIds.shift();
            await this.prisma.transaction.update({
              where: { id: row.id },
              data: {
                importStatus: "IMPORTED",
                importedAt: new Date(this.now()),
                // pin updatedAt to importedAt so this bookkeeping write does
                // not itself count as a "changed since import" signal
                updatedAt: new Date(this.now()),
                ...(actualTransactionId ? { actualTransactionId } : {}),
              },
            });
          }
          exported += batch.length;
        } catch {
          await this.prisma.transaction.updateMany({
            where: { id: { in: batch.map((row) => row.id) } },
            data: { importStatus: "IMPORT_ERROR" },
          });
          failed += batch.length;
        }
      }
    } finally {
      await this.gateway.close();
    }
    return { exported, failed };
  }
}
