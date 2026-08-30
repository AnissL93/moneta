import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

export interface StatusRouteDeps {
  prisma: PrismaClient;
  actualConfigured: boolean;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** minor units bigint → signed decimal major-units string, e.g. -450n → "-4.50" */
function toMajorString(amountMinor: bigint): string {
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const major = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${major}.${cents}`;
}

export function registerStatusRoutes(server: FastifyInstance, deps: StatusRouteDeps): void {
  const { prisma } = deps;

  // Spec §40: "Is my financial data current?"
  server.get("/status", async () => {
    const connections = await prisma.connection.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        accounts: {
          where: { active: true },
          orderBy: { createdAt: "asc" },
          include: {
            balances: { orderBy: { observedAt: "desc" }, take: 1 },
            _count: { select: { transactions: { where: { deletedAt: null } } } },
          },
        },
      },
    });
    const lastRun = await prisma.syncRun.findFirst({
      orderBy: { startedAt: "desc" },
      include: { errors: { select: { errorType: true, message: true } } },
    });

    return {
      database: "ok",
      actualConfigured: deps.actualConfigured,
      connections: connections.map((connection) => ({
        id: connection.id,
        institutionName: connection.institutionName,
        status: connection.status,
        lastSuccessfulSync: connection.lastSuccessfulSync,
        consentExpiresAt: connection.consentExpiresAt,
        accounts: connection.accounts.map((account) => {
          const latest = account.balances[0];
          return {
            id: account.id,
            name: account.name,
            type: account.type,
            lastSuccessfulSync: account.lastSuccessfulSync,
            transactionCount: account._count.transactions,
            latestBalance: latest
              ? {
                  currentMinor: latest.currentAmountMinor?.toString() ?? null,
                  currency: latest.currency,
                  observedAt: latest.observedAt,
                }
              : null,
          };
        }),
      })),
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            errors: lastRun.errors,
          }
        : null,
    };
  });

  // Spec §38: leaveability — full history as CSV.
  server.get("/export/transactions.csv", async (_request, reply) => {
    const rows = await prisma.transaction.findMany({
      where: { deletedAt: null },
      orderBy: { timestamp: "asc" },
      include: { account: { select: { name: true, connection: { select: { provider: true } } } } },
    });
    const header =
      "account,date,amount,currency,merchant,description,category,status,provider,provider_transaction_id";
    const lines = rows.map((tx) =>
      [
        csvField(tx.account.name),
        (tx.bookedDate ?? tx.timestamp).toISOString().slice(0, 10),
        toMajorString(tx.amountMinor),
        tx.currency,
        csvField(tx.merchantName ?? ""),
        csvField(tx.description),
        csvField(tx.category ?? ""),
        tx.status,
        tx.account.connection.provider,
        tx.providerTransactionId ?? "",
      ].join(","),
    );
    return reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", "attachment; filename=transactions.csv")
      .send([header, ...lines].join("\n") + "\n");
  });
}
