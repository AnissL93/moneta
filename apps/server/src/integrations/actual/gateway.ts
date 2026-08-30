export interface ActualAccountInfo {
  id: string;
  name: string;
  closed: boolean;
}

/** Actual's transaction import shape (spec §25): integer minor units, negative = outflow. */
export interface ActualImportTransaction {
  account: string;
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  /** local canonical transaction id — Actual's dedup key (spec §26) */
  imported_id: string;
  payee_name?: string;
  imported_payee?: string;
  notes?: string;
  cleared: boolean;
}

export interface ActualImportResult {
  added: string[];
  updated: string[];
}

export type ActualAccountType = "checking" | "savings" | "credit" | "other";

// Same isolation pattern as BankingProvider: all @actual-app/api specifics
// stay behind this interface so export logic tests against a fake.
export interface ActualGateway {
  /** init + downloadBudget; must be called before other methods */
  open(): Promise<void>;
  /** sync + shutdown */
  close(): Promise<void>;
  getAccounts(): Promise<ActualAccountInfo[]>;
  createAccount(name: string, type: ActualAccountType): Promise<string>;
  importTransactions(
    accountId: string,
    transactions: ActualImportTransaction[],
  ): Promise<ActualImportResult>;
}
