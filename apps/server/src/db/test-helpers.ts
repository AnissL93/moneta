import type { PrismaClient } from "@prisma/client";
import { createPrismaClient } from "./prisma.js";

export function createTestPrisma(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL not set — is vitest.global-setup.ts configured?");
  }
  return createPrismaClient(url);
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE settings, sync_errors, sync_runs, actual_account_links, transactions, balances, accounts, connections CASCADE`,
  );
}
