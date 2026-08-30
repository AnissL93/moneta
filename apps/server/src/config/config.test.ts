import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  NODE_ENV: "test",
  PORT: "3100",
  DATABASE_URL: "postgresql://finance:pw@localhost:5432/finance",
  API_TOKEN: "0123456789abcdef0123456789abcdef",
};

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const config = loadConfig(validEnv);
    expect(config.nodeEnv).toBe("test");
    expect(config.port).toBe(3100);
    expect(config.databaseUrl).toBe(validEnv.DATABASE_URL);
    expect(config.apiToken).toBe(validEnv.API_TOKEN);
  });

  it("applies defaults", () => {
    const config = loadConfig({ ...validEnv, PORT: undefined, NODE_ENV: undefined });
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe("development");
    expect(config.syncOverlapDays).toBe(7);
    expect(config.initialSyncDays).toBe(365);
    expect(config.pendingExpiryDays).toBe(14);
    expect(config.storeRawProviderData).toBe(true);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it("rejects a short API_TOKEN", () => {
    expect(() => loadConfig({ ...validEnv, API_TOKEN: "short" })).toThrow(/API_TOKEN/);
  });

  it("rejects a malformed APP_ENCRYPTION_KEY when provided", () => {
    expect(() =>
      loadConfig({ ...validEnv, APP_ENCRYPTION_KEY: "not-hex" }),
    ).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it("accepts a 64-hex-char APP_ENCRYPTION_KEY", () => {
    const key = "a".repeat(64);
    const config = loadConfig({ ...validEnv, APP_ENCRYPTION_KEY: key });
    expect(config.appEncryptionKey).toBe(key);
  });
});
