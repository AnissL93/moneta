import { describe, expect, it } from "vitest";
import { mapAccount, mapBalance, toMinorUnits } from "./mapper.js";

describe("toMinorUnits", () => {
  it("converts decimal major units to bigint pence", () => {
    expect(toMinorUnits(1234.56)).toBe(123456n);
    expect(toMinorUnits(1200)).toBe(120000n);
    expect(toMinorUnits(0)).toBe(0n);
  });

  it("preserves sign for outflows/overdrafts", () => {
    expect(toMinorUnits(-0.01)).toBe(-1n);
    expect(toMinorUnits(-12.34)).toBe(-1234n);
  });

  it("rounds float noise to the nearest penny", () => {
    expect(toMinorUnits(10.01)).toBe(1001n);
    expect(toMinorUnits(4.1)).toBe(410n);
  });
});

describe("mapAccount", () => {
  const raw = {
    account_id: "acc-1",
    account_type: "TRANSACTION",
    display_name: "Main Current",
    currency: "GBP",
    account_number: { number: "12345678", sort_code: "12-34-56" },
    provider: { provider_id: "mock", display_name: "Mock Bank" },
  };

  it("maps a transaction account to canonical form", () => {
    expect(mapAccount(raw)).toEqual({
      providerAccountId: "acc-1",
      name: "Main Current",
      type: "CURRENT",
      currency: "GBP",
      accountNumberLast4: "5678",
      sortCodeMasked: "**-**-56",
      institutionName: "Mock Bank",
    });
  });

  it.each([
    ["TRANSACTION", "CURRENT"],
    ["SAVINGS", "SAVINGS"],
    ["BUSINESS_TRANSACTION", "CURRENT"],
    ["BUSINESS_SAVINGS", "SAVINGS"],
    ["SOMETHING_NEW", "OTHER"],
  ])("maps account_type %s to %s", (accountType, expected) => {
    expect(mapAccount({ ...raw, account_type: accountType }).type).toBe(expected);
  });

  it("falls back through display names and omits absent numbers", () => {
    const mapped = mapAccount({
      account_id: "acc-2",
      account_type: "SAVINGS",
      currency: "GBP",
      provider: { provider_id: "mock" },
    });
    expect(mapped.name).toBe("Account");
    expect(mapped.institutionName).toBe("mock");
    expect(mapped.accountNumberLast4).toBeUndefined();
    expect(mapped.sortCodeMasked).toBeUndefined();
  });
});

describe("mapBalance", () => {
  it("maps balances to minor units", () => {
    expect(mapBalance({ currency: "GBP", current: 1234.56, available: 1200 })).toEqual({
      currentMinor: 123456n,
      availableMinor: 120000n,
      currency: "GBP",
    });
  });

  it("maps absent fields to null", () => {
    expect(mapBalance({ currency: "GBP" })).toEqual({
      currentMinor: null,
      availableMinor: null,
      currency: "GBP",
    });
  });
});

describe("mapTransaction", () => {
  const raw = {
    transaction_id: "tx-1",
    timestamp: "2026-08-20T14:30:00Z",
    description: "COSTA COFFEE LEEDS",
    amount: 4.5,
    currency: "GBP",
    transaction_type: "DEBIT",
    transaction_category: "PURCHASE",
    transaction_classification: ["Food & Dining", "Coffee Shops"],
    merchant_name: "Costa Coffee",
    running_balance: { currency: "GBP", amount: 100.25 },
  };

  it("maps a settled debit with canonical negative sign", async () => {
    const { mapTransaction } = await import("./mapper.js");
    const mapped = mapTransaction(raw, "SETTLED");
    expect(mapped).toEqual({
      providerTransactionId: "tx-1",
      status: "SETTLED",
      timestamp: new Date("2026-08-20T14:30:00Z"),
      bookedDate: new Date("2026-08-20T00:00:00Z"),
      amountMinor: -450n,
      currency: "GBP",
      description: "COSTA COFFEE LEEDS",
      merchantName: "Costa Coffee",
      transactionType: "PURCHASE",
      category: "Food & Dining / Coffee Shops",
      runningBalanceMinor: 10025n,
    });
  });

  it("forces credits positive even when the provider sends a negative amount", async () => {
    const { mapTransaction } = await import("./mapper.js");
    const mapped = mapTransaction(
      { ...raw, amount: -25, transaction_type: "CREDIT" },
      "SETTLED",
    );
    expect(mapped.amountMinor).toBe(2500n);
  });

  it("forces debits negative even when the provider sends a positive amount", async () => {
    const { mapTransaction } = await import("./mapper.js");
    const mapped = mapTransaction({ ...raw, amount: 12.34, transaction_type: "DEBIT" }, "PENDING");
    expect(mapped.amountMinor).toBe(-1234n);
    expect(mapped.status).toBe("PENDING");
  });

  it("keeps the provider sign when transaction_type is absent", async () => {
    const { mapTransaction } = await import("./mapper.js");
    const noType = { ...raw } as Record<string, unknown>;
    delete noType.transaction_type;
    expect(mapTransaction(noType as never, "SETTLED").amountMinor).toBe(450n);
  });

  it("handles minimal payloads", async () => {
    const { mapTransaction } = await import("./mapper.js");
    const mapped = mapTransaction(
      { timestamp: "2026-08-21T00:10:00Z", amount: -1, currency: "GBP" } as never,
      "PENDING",
    );
    expect(mapped.providerTransactionId).toBeUndefined();
    expect(mapped.description).toBe("(no description)");
    expect(mapped.category).toBeUndefined();
    expect(mapped.runningBalanceMinor).toBeUndefined();
    expect(mapped.bookedDate).toEqual(new Date("2026-08-21T00:00:00Z"));
  });
});
