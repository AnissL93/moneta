import { describe, expect, it } from "vitest";
import { ProviderRequestError, ReauthRequiredError } from "../banking-provider.js";
import { TrueLayerProvider } from "./truelayer-provider.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(responses: Array<{ status: number; json: unknown }>) {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      ),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const response = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return new Response(JSON.stringify(response.json), { status: response.status });
  }) as typeof fetch;
  return { fetchFn, requests };
}

function provider(fetchFn?: typeof fetch): TrueLayerProvider {
  return new TrueLayerProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3000/auth/truelayer/callback",
    environment: "sandbox",
    ...(fetchFn ? { fetchFn } : {}),
  });
}

const tokenJson = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
  token_type: "Bearer",
};

describe("buildAuthUrl", () => {
  it("targets the sandbox auth host with all required params", () => {
    const url = new URL(provider().buildAuthUrl("state-123"));
    expect(url.origin).toBe("https://auth.truelayer-sandbox.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/auth/truelayer/callback",
    );
    expect(url.searchParams.get("scope")).toBe(
      "info accounts balance transactions offline_access",
    );
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("providers")).toContain("uk-cs-mock");
  });
});

describe("exchangeCode", () => {
  it("posts the authorization code as form data and returns tokens", async () => {
    const { fetchFn, requests } = fakeFetch([{ status: 200, json: tokenJson }]);
    const before = Date.now();
    const tokens = await provider(fetchFn).exchangeCode("the-code");

    expect(requests[0]!.url).toBe("https://auth.truelayer-sandbox.com/connect/token");
    expect(requests[0]!.method).toBe("POST");
    const body = new URLSearchParams(requests[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("redirect_uri")).toBe("http://localhost:3000/auth/truelayer/callback");

    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.refreshToken).toBe("refresh-1");
    // expires a minute early to leave refresh headroom
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3539_000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3540_000);
  });

  it("throws ProviderRequestError on server failure", async () => {
    const { fetchFn } = fakeFetch([{ status: 500, json: { error: "server_error" } }]);
    await expect(provider(fetchFn).exchangeCode("c")).rejects.toBeInstanceOf(
      ProviderRequestError,
    );
  });
});

describe("refreshTokens", () => {
  it("sends the refresh grant", async () => {
    const { fetchFn, requests } = fakeFetch([{ status: 200, json: tokenJson }]);
    await provider(fetchFn).refreshTokens("old-refresh");
    const body = new URLSearchParams(requests[0]!.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
  });

  it("throws ReauthRequiredError when the grant is rejected", async () => {
    const { fetchFn } = fakeFetch([{ status: 400, json: { error: "invalid_grant" } }]);
    await expect(provider(fetchFn).refreshTokens("dead")).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
  });
});

describe("data endpoints", () => {
  it("fetches and maps accounts with a bearer token", async () => {
    const { fetchFn, requests } = fakeFetch([
      {
        status: 200,
        json: {
          results: [
            {
              account_id: "acc-1",
              account_type: "TRANSACTION",
              display_name: "Main",
              currency: "GBP",
              account_number: { number: "12345678", sort_code: "12-34-56" },
              provider: { provider_id: "mock", display_name: "Mock Bank" },
            },
          ],
        },
      },
    ]);
    const accounts = await provider(fetchFn).getAccounts("access-1");
    expect(requests[0]!.url).toBe("https://api.truelayer-sandbox.com/data/v1/accounts");
    expect(requests[0]!.headers["Authorization"]).toBe("Bearer access-1");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.providerAccountId).toBe("acc-1");
  });

  it("fetches and maps a balance", async () => {
    const { fetchFn, requests } = fakeFetch([
      { status: 200, json: { results: [{ currency: "GBP", current: 10.5, available: 9 }] } },
    ]);
    const balance = await provider(fetchFn).getBalance("access-1", "acc-1");
    expect(requests[0]!.url).toBe(
      "https://api.truelayer-sandbox.com/data/v1/accounts/acc-1/balance",
    );
    expect(balance).toEqual({ currentMinor: 1050n, availableMinor: 900n, currency: "GBP" });
  });

  it("maps 401 responses to ReauthRequiredError", async () => {
    const { fetchFn } = fakeFetch([{ status: 401, json: { error: "unauthorized" } }]);
    await expect(provider(fetchFn).getAccounts("stale")).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
  });
});

describe("transaction endpoints", () => {
  it("fetches settled transactions with a from/to window", async () => {
    const { fetchFn, requests } = fakeFetch([
      {
        status: 200,
        json: {
          results: [
            {
              transaction_id: "tx-1",
              timestamp: "2026-08-20T14:30:00Z",
              description: "COSTA",
              amount: 4.5,
              currency: "GBP",
              transaction_type: "DEBIT",
            },
          ],
        },
      },
    ]);
    const from = new Date("2026-08-01T00:00:00Z");
    const to = new Date("2026-08-28T00:00:00Z");
    const transactions = await provider(fetchFn).getTransactions("access-1", "acc-1", from, to);

    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/data/v1/accounts/acc-1/transactions");
    expect(url.searchParams.get("from")).toBe(from.toISOString());
    expect(url.searchParams.get("to")).toBe(to.toISOString());
    expect(requests[0]!.headers["Authorization"]).toBe("Bearer access-1");
    expect(transactions[0]!.status).toBe("SETTLED");
    expect(transactions[0]!.amountMinor).toBe(-450n);
  });

  it("fetches pending transactions from the pending endpoint", async () => {
    const { fetchFn, requests } = fakeFetch([
      {
        status: 200,
        json: {
          results: [
            {
              timestamp: "2026-08-27T10:00:00Z",
              description: "PENDING CARD",
              amount: 9.99,
              currency: "GBP",
              transaction_type: "DEBIT",
            },
          ],
        },
      },
    ]);
    const pending = await provider(fetchFn).getPendingTransactions("access-1", "acc-1");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/data/v1/accounts/acc-1/transactions/pending",
    );
    expect(pending[0]!.status).toBe("PENDING");
    expect(pending[0]!.providerTransactionId).toBeUndefined();
  });
});
