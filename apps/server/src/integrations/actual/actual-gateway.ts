import { mkdir } from "node:fs/promises";
import * as api from "@actual-app/api";
import type {
  ActualAccountInfo,
  ActualAccountType,
  ActualGateway,
  ActualImportResult,
  ActualImportTransaction,
} from "./gateway.js";

export interface ActualGatewayConfig {
  serverUrl: string;
  password: string;
  syncId: string;
  encryptionPassword?: string;
  dataDir: string;
}

/**
 * Thin adapter over @actual-app/api. The api is a module-level singleton that
 * downloads the budget file into dataDir, mutates it locally, and syncs back
 * on shutdown — open()/close() bracket one export session.
 */
export class RealActualGateway implements ActualGateway {
  constructor(private readonly config: ActualGatewayConfig) {}

  async open(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    await api.init({
      dataDir: this.config.dataDir,
      serverURL: this.config.serverUrl,
      password: this.config.password,
    });
    await api.downloadBudget(
      this.config.syncId,
      this.config.encryptionPassword ? { password: this.config.encryptionPassword } : undefined,
    );
  }

  async close(): Promise<void> {
    await api.shutdown();
  }

  async getAccounts(): Promise<ActualAccountInfo[]> {
    const accounts = (await api.getAccounts()) as Array<{
      id: string;
      name: string;
      closed?: boolean;
    }>;
    return accounts.map((account) => ({
      id: account.id,
      name: account.name,
      closed: account.closed ?? false,
    }));
  }

  async createAccount(name: string, _type: ActualAccountType): Promise<string> {
    // Actual's current API account model has no type field on creation —
    // accounts are typed/categorized inside the Actual UI.
    return (await api.createAccount({ name }, 0)) as string;
  }

  async importTransactions(
    accountId: string,
    transactions: ActualImportTransaction[],
  ): Promise<ActualImportResult> {
    const result = (await api.importTransactions(accountId, transactions)) as {
      added?: string[];
      updated?: string[];
      errors?: unknown[];
    };
    if (result.errors && result.errors.length > 0) {
      throw new Error(`actual import reported ${result.errors.length} error(s)`);
    }
    return { added: result.added ?? [], updated: result.updated ?? [] };
  }
}
