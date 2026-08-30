import type { AccountType, PrismaClient } from "@prisma/client";
import type { ActualAccountType, ActualGateway } from "./gateway.js";

const TYPE_MAP: Record<AccountType, ActualAccountType> = {
  CURRENT: "checking",
  SAVINGS: "savings",
  CREDIT_CARD: "credit",
  OTHER: "other",
};

/**
 * Spec §24: the link table is the single source of truth; name matching
 * happens exactly once, at link creation, never on later syncs.
 */
export async function ensureAccountLink(
  prisma: PrismaClient,
  gateway: ActualGateway,
  localAccountId: string,
): Promise<string> {
  const existing = await prisma.actualAccountLink.findUnique({
    where: { localAccountId },
  });
  if (existing) {
    return existing.actualAccountId;
  }

  const account = await prisma.account.findUniqueOrThrow({ where: { id: localAccountId } });

  // Multi-currency banks (e.g. Wise) name every currency account identically.
  // Disambiguate with the currency so each gets its own Actual account.
  const sameNameCount = await prisma.account.count({
    where: { name: { equals: account.name, mode: "insensitive" }, id: { not: account.id } },
  });
  const targetName =
    sameNameCount > 0 ? `${account.name} (${account.currency})` : account.name;

  const candidates = await gateway.getAccounts();
  const match = candidates.find(
    (candidate) =>
      !candidate.closed && candidate.name.toLowerCase() === targetName.toLowerCase(),
  );
  const actualAccountId =
    match?.id ?? (await gateway.createAccount(targetName, TYPE_MAP[account.type]));

  await prisma.actualAccountLink.create({
    data: { localAccountId, actualAccountId },
  });
  return actualAccountId;
}
