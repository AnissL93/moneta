import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config/config.js";
import { loadConfig } from "./config/config.js";
import { buildServer } from "./server.js";

const token = "0123456789abcdef0123456789abcdef";

function testConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://finance:pw@localhost:5432/finance",
    API_TOKEN: token,
  });
}

describe("buildServer", () => {
  it("serves /health without authentication", async () => {
    const server = buildServer(testConfig());
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("rejects other routes without a bearer token", async () => {
    const server = buildServer(testConfig());
    const response = await server.inject({ method: "GET", url: "/accounts" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const server = buildServer(testConfig());
    const response = await server.inject({
      method: "GET",
      url: "/accounts",
      headers: { authorization: "Bearer wrong-token-wrong-token-wrong" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("lets a correct bearer token through to routing (404 for unknown route)", async () => {
    const server = buildServer(testConfig());
    const response = await server.inject({
      method: "GET",
      url: "/accounts",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
