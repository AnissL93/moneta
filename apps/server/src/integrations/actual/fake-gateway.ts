import type {
  ActualAccountInfo,
  ActualAccountType,
  ActualGateway,
  ActualImportResult,
  ActualImportTransaction,
} from "./gateway.js";

/** In-memory ActualGateway for tests (test-only helper, not shipped code paths). */
export class FakeActualGateway implements ActualGateway {
  accounts: ActualAccountInfo[] = [];
  createdAccounts: Array<{ name: string; type: ActualAccountType }> = [];
  importedBatches: Array<{ accountId: string; transactions: ActualImportTransaction[] }> = [];
  /** imported_id → actual transaction id, mimicking Actual's dedup */
  private seenImportIds = new Map<string, string>();
  openCount = 0;
  closeCount = 0;
  failImports = false;
  private nextId = 1;

  async open(): Promise<void> {
    this.openCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  async getAccounts(): Promise<ActualAccountInfo[]> {
    return this.accounts;
  }

  async createAccount(name: string, type: ActualAccountType): Promise<string> {
    const id = `actual-acc-${this.nextId++}`;
    this.createdAccounts.push({ name, type });
    this.accounts.push({ id, name, closed: false });
    return id;
  }

  async importTransactions(
    accountId: string,
    transactions: ActualImportTransaction[],
  ): Promise<ActualImportResult> {
    if (this.failImports) {
      throw new Error("actual server unavailable");
    }
    this.importedBatches.push({ accountId, transactions });
    const added: string[] = [];
    const updated: string[] = [];
    for (const tx of transactions) {
      const existing = this.seenImportIds.get(tx.imported_id);
      if (existing) {
        updated.push(existing);
      } else {
        const id = `actual-tx-${this.nextId++}`;
        this.seenImportIds.set(tx.imported_id, id);
        added.push(id);
      }
    }
    return { added, updated };
  }
}
