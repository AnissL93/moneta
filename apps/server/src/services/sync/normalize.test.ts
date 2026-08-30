import { describe, expect, it } from "vitest";
import type { ProviderTransaction } from "../../providers/banking-provider.js";
import { normalizeBatch } from "./normalize.js";

const accountId = "acc-local-1";

function tx(overrides: Partial<ProviderTransaction>): ProviderTransaction {
  return {
    status: "SETTLED",
    timestamp: new Date("2026-08-20T14:30:00Z"),
    bookedDate: new Date("2026-08-20T00:00:00Z"),
    amountMinor: -450n,
    currency: "GBP",
    description: "COSTA COFFEE LEEDS",
    ...overrides,
  };
}

describe("normalizeBatch", () => {
  it("is deterministic across calls", () => {
    const batch = [tx({ providerTransactionId: "tx-1" }), tx({})];
    const first = normalizeBatch(accountId, batch);
    const second = normalizeBatch(accountId, batch);
    expect(first.map((t) => t.rawHash)).toEqual(second.map((t) => t.rawHash));
  });

  it("hashes id-bearing rows from the provider id only", () => {
    const a = normalizeBatch(accountId, [
      tx({ providerTransactionId: "tx-1", description: "OLD DESCRIPTION" }),
    ])[0]!;
    const b = normalizeBatch(accountId, [
      tx({ providerTransactionId: "tx-1", description: "NEW DESCRIPTION" }),
    ])[0]!;
    expect(a.rawHash).toBe(b.rawHash);
  });

  it("gives two identical id-less rows distinct hashes via occurrence index", () => {
    const [first, second] = normalizeBatch(accountId, [tx({}), tx({})]);
    expect(first!.rawHash).not.toBe(second!.rawHash);
  });

  it("assigns the same hashes regardless of batch order", () => {
    const a = tx({ description: "AAA SHOP" });
    const b = tx({ description: "BBB SHOP" });
    const forward = normalizeBatch(accountId, [a, b]);
    const backward = normalizeBatch(accountId, [b, a]);
    const hashOf = (list: typeof forward, description: string) =>
      list.find((t) => t.description === description)!.rawHash;
    expect(hashOf(forward, "AAA SHOP")).toBe(hashOf(backward, "AAA SHOP"));
    expect(hashOf(forward, "BBB SHOP")).toBe(hashOf(backward, "BBB SHOP"));
  });

  it("differs when merchant differs on id-less rows", () => {
    const [a] = normalizeBatch(accountId, [tx({ merchantName: "Costa" })]);
    const [b] = normalizeBatch(accountId, [tx({ merchantName: "Nero" })]);
    expect(a!.rawHash).not.toBe(b!.rawHash);
  });

  it("normalizes description whitespace/case for fingerprinting", () => {
    const [a] = normalizeBatch(accountId, [tx({ description: "  costa   coffee  leeds " })]);
    const [b] = normalizeBatch(accountId, [tx({ description: "COSTA COFFEE LEEDS" })]);
    expect(a!.rawHash).toBe(b!.rawHash);
  });

  it("differs across accounts", () => {
    const [a] = normalizeBatch("acc-1", [tx({})]);
    const [b] = normalizeBatch("acc-2", [tx({})]);
    expect(a!.rawHash).not.toBe(b!.rawHash);
  });
});
