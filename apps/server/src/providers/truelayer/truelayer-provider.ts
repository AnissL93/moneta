import {
  type BankingProvider,
  type ProviderAccount,
  type ProviderBalance,
  ProviderRequestError,
  type ProviderTokens,
  ReauthRequiredError,
} from "../banking-provider.js";
import type { ProviderTransaction } from "../banking-provider.js";
import {
  mapAccount,
  mapBalance,
  mapTransaction,
  type RawTrueLayerAccount,
  type RawTrueLayerBalance,
  type RawTrueLayerTransaction,
} from "./mapper.js";

export interface TrueLayerProviderOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: "sandbox" | "live";
  fetchFn?: typeof fetch;
}

const SCOPES = "info accounts balance transactions offline_access";
// Refresh a minute before actual expiry so in-flight requests never race it.
const EXPIRY_HEADROOM_SECONDS = 60;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export class TrueLayerProvider implements BankingProvider {
  private readonly authBase: string;
  private readonly apiBase: string;
  private readonly providers: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: TrueLayerProviderOptions) {
    const sandbox = options.environment === "sandbox";
    this.authBase = sandbox
      ? "https://auth.truelayer-sandbox.com"
      : "https://auth.truelayer.com";
    this.apiBase = sandbox
      ? "https://api.truelayer-sandbox.com"
      : "https://api.truelayer.com";
    this.providers = sandbox ? "uk-cs-mock uk-ob-all uk-oauth-all" : "uk-ob-all uk-oauth-all";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  buildAuthUrl(state: string): string {
    const url = new URL(this.authBase);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("providers", this.providers);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<ProviderTokens> {
    return this.requestTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.options.redirectUri,
    });
  }

  async refreshTokens(refreshToken: string): Promise<ProviderTokens> {
    return this.requestTokens(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      // A rejected refresh grant means the consent itself is gone (spec §7.2).
      { reauthOnClientError: true },
    );
  }

  async getAccounts(accessToken: string): Promise<ProviderAccount[]> {
    const json = await this.getJson<{ results: RawTrueLayerAccount[] }>(
      `${this.apiBase}/data/v1/accounts`,
      accessToken,
    );
    return json.results.map(mapAccount);
  }

  async getBalance(accessToken: string, providerAccountId: string): Promise<ProviderBalance> {
    const json = await this.getJson<{ results: RawTrueLayerBalance[] }>(
      `${this.apiBase}/data/v1/accounts/${encodeURIComponent(providerAccountId)}/balance`,
      accessToken,
    );
    const first = json.results[0];
    if (!first) {
      throw new ProviderRequestError("balance response contained no results", 200);
    }
    return mapBalance(first);
  }

  async getTransactions(
    accessToken: string,
    providerAccountId: string,
    from: Date,
    to: Date,
  ): Promise<ProviderTransaction[]> {
    const url = new URL(
      `${this.apiBase}/data/v1/accounts/${encodeURIComponent(providerAccountId)}/transactions`,
    );
    url.searchParams.set("from", from.toISOString());
    url.searchParams.set("to", to.toISOString());
    const json = await this.getJson<{ results: RawTrueLayerTransaction[] }>(
      url.toString(),
      accessToken,
    );
    return json.results.map((raw) => mapTransaction(raw, "SETTLED"));
  }

  async getPendingTransactions(
    accessToken: string,
    providerAccountId: string,
  ): Promise<ProviderTransaction[]> {
    const json = await this.getJson<{ results: RawTrueLayerTransaction[] }>(
      `${this.apiBase}/data/v1/accounts/${encodeURIComponent(providerAccountId)}/transactions/pending`,
      accessToken,
    );
    return json.results.map((raw) => mapTransaction(raw, "PENDING"));
  }

  private async requestTokens(
    grant: Record<string, string>,
    options: { reauthOnClientError?: boolean } = {},
  ): Promise<ProviderTokens> {
    const response = await this.fetchFn(`${this.authBase}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...grant,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
    });
    if (!response.ok) {
      if (options.reauthOnClientError && response.status >= 400 && response.status < 500) {
        throw new ReauthRequiredError("token refresh rejected");
      }
      throw new ProviderRequestError(`token request failed`, response.status);
    }
    const json = (await response.json()) as TokenResponse;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? "",
      expiresAt: Date.now() + (json.expires_in - EXPIRY_HEADROOM_SECONDS) * 1000,
    };
  }

  private async getJson<T>(url: string, accessToken: string): Promise<T> {
    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401 || response.status === 403) {
      throw new ReauthRequiredError();
    }
    if (!response.ok) {
      throw new ProviderRequestError(`data request failed`, response.status);
    }
    return (await response.json()) as T;
  }
}
