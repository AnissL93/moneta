import { randomBytes, randomUUID } from "node:crypto";
import type { ConnectionStatus, PrismaClient } from "@prisma/client";
import { decryptString, encryptString } from "../../lib/crypto.js";
import {
  type BankingProvider,
  type ProviderTokens,
  ReauthRequiredError,
} from "../../providers/banking-provider.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_NAME = "truelayer";

export interface ConnectionSummary {
  id: string;
  provider: string;
  institutionName: string | null;
  status: ConnectionStatus;
  consentExpiresAt: Date | null;
  lastSuccessfulSync: Date | null;
  createdAt: Date;
}

interface AuthState {
  connectionId?: string;
  createdAt: number;
}

export interface ConnectionServiceDeps {
  prisma: PrismaClient;
  provider: BankingProvider;
  encryptionKey: string;
  now?: () => number;
}

export class ConnectionService {
  private readonly prisma: PrismaClient;
  private readonly provider: BankingProvider;
  private readonly encryptionKey: string;
  private readonly now: () => number;

  constructor(deps: ConnectionServiceDeps) {
    this.prisma = deps.prisma;
    this.provider = deps.provider;
    this.encryptionKey = deps.encryptionKey;
    this.now = deps.now ?? Date.now;
  }

  async createAuthSession(connectionId?: string): Promise<{ authUrl: string; state: string }> {
    if (connectionId) {
      // Reauth must target an existing row — never a new one (spec §10).
      await this.prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    }
    const state = randomBytes(16).toString("hex");
    const value: AuthState = {
      ...(connectionId ? { connectionId } : {}),
      createdAt: this.now(),
    };
    await this.prisma.setting.create({
      data: { key: `auth_state:${state}`, value: JSON.stringify(value) },
    });
    return { authUrl: this.provider.buildAuthUrl(state), state };
  }

  async handleCallback(params: {
    code: string;
    state: string;
  }): Promise<{ connectionId: string; accountsDiscovered: number }> {
    const authState = await this.consumeState(params.state);
    const tokens = await this.provider.exchangeCode(params.code);
    const encryptedCredentials = this.encryptTokens(tokens);

    let connectionId: string;
    if (authState.connectionId) {
      await this.prisma.connection.update({
        where: { id: authState.connectionId },
        data: { encryptedCredentials, status: "ACTIVE" },
      });
      connectionId = authState.connectionId;
    } else {
      const created = await this.prisma.connection.create({
        data: {
          provider: PROVIDER_NAME,
          providerConnectionId: randomUUID(),
          status: "ACTIVE",
          encryptedCredentials,
        },
      });
      connectionId = created.id;
    }

    const accountsDiscovered = await this.discoverAccounts(connectionId);
    return { connectionId, accountsDiscovered };
  }

  async getValidAccessToken(connectionId: string): Promise<string> {
    const connection = await this.prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    if (!connection.encryptedCredentials) {
      throw new ReauthRequiredError("connection has no stored credentials");
    }
    const tokens = JSON.parse(
      decryptString(connection.encryptedCredentials, this.encryptionKey),
    ) as ProviderTokens;

    if (tokens.expiresAt > this.now()) {
      return tokens.accessToken;
    }

    try {
      const refreshed = await this.provider.refreshTokens(tokens.refreshToken);
      await this.prisma.connection.update({
        where: { id: connectionId },
        data: { encryptedCredentials: this.encryptTokens(refreshed) },
      });
      return refreshed.accessToken;
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        await this.prisma.connection.update({
          where: { id: connectionId },
          data: { status: "REAUTH_REQUIRED" },
        });
      }
      throw error;
    }
  }

  async discoverAccounts(connectionId: string): Promise<number> {
    const accessToken = await this.getValidAccessToken(connectionId);
    const remoteAccounts = await this.provider.getAccounts(accessToken);
    const syncedAt = new Date(this.now());

    for (const remote of remoteAccounts) {
      const data = {
        name: remote.name,
        type: remote.type,
        currency: remote.currency,
        accountNumberLast4: remote.accountNumberLast4 ?? null,
        sortCodeMasked: remote.sortCodeMasked ?? null,
        institutionName: remote.institutionName ?? null,
        active: true,
      };
      const account = await this.prisma.account.upsert({
        where: {
          connectionId_providerAccountId: {
            connectionId,
            providerAccountId: remote.providerAccountId,
          },
        },
        create: { connectionId, providerAccountId: remote.providerAccountId, ...data },
        update: data,
      });

      const balance = await this.provider.getBalance(accessToken, remote.providerAccountId);
      // Balances are appended, never overwritten — history feeds net-worth charts (spec §21).
      await this.prisma.balance.create({
        data: {
          accountId: account.id,
          currentAmountMinor: balance.currentMinor,
          availableAmountMinor: balance.availableMinor,
          currency: balance.currency,
          observedAt: syncedAt,
        },
      });
      // Note: accounts.last_successful_sync is the *transaction* sync cursor
      // (spec §17 window rule) — discovery must not touch it, or the first
      // real sync would skip the initial deep window.
    }

    const institutionName =
      remoteAccounts.find((a) => a.institutionName)?.institutionName ?? null;
    await this.prisma.connection.update({
      where: { id: connectionId },
      data: { lastSuccessfulSync: syncedAt, ...(institutionName ? { institutionName } : {}) },
    });
    return remoteAccounts.length;
  }

  async listConnections(): Promise<ConnectionSummary[]> {
    const rows = await this.prisma.connection.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      institutionName: row.institutionName,
      status: row.status,
      consentExpiresAt: row.consentExpiresAt,
      lastSuccessfulSync: row.lastSuccessfulSync,
      createdAt: row.createdAt,
    }));
  }

  async disableConnection(connectionId: string): Promise<void> {
    await this.prisma.connection.update({
      where: { id: connectionId },
      data: { status: "DISABLED" },
    });
  }

  private encryptTokens(tokens: ProviderTokens): string {
    return encryptString(JSON.stringify(tokens), this.encryptionKey);
  }

  private async consumeState(state: string): Promise<AuthState> {
    const key = `auth_state:${state}`;
    const row = await this.prisma.setting.findUnique({ where: { key } });
    if (row) {
      await this.prisma.setting.delete({ where: { key } });
    }
    const parsed = row ? (JSON.parse(row.value) as AuthState) : null;
    if (!parsed || this.now() - parsed.createdAt > STATE_TTL_MS) {
      throw new Error("invalid or expired state");
    }
    return parsed;
  }
}
