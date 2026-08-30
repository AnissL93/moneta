import { z } from "zod";

const boolString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  // Static bearer token for every non-/health endpoint (spec §35).
  API_TOKEN: z.string().min(16),
  TRUELAYER_CLIENT_ID: z.string().default(""),
  TRUELAYER_CLIENT_SECRET: z.string().default(""),
  TRUELAYER_REDIRECT_URI: z.string().default(""),
  TRUELAYER_ENVIRONMENT: z.enum(["sandbox", "live"]).default("sandbox"),
  // 32 random bytes, hex-encoded (spec §29); required once credentials are stored (phase 2).
  APP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional(),
  SYNC_CRON: z.string().default("0 */6 * * *"),
  SYNC_OVERLAP_DAYS: z.coerce.number().int().min(0).default(7),
  INITIAL_SYNC_DAYS: z.coerce.number().int().min(1).default(365),
  PENDING_EXPIRY_DAYS: z.coerce.number().int().min(1).default(14),
  ACTUAL_SERVER_URL: z.string().default(""),
  ACTUAL_PASSWORD: z.string().default(""),
  ACTUAL_SYNC_ID: z.string().default(""),
  ACTUAL_ENCRYPTION_PASSWORD: z.string().default(""),
  ACTUAL_DATA_DIR: z.string().default("/data/actual-cache"),
  STORE_RAW_PROVIDER_DATA: boolString.default("true"),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  apiToken: string;
  trueLayer: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    environment: "sandbox" | "live";
  };
  appEncryptionKey?: string;
  syncCron: string;
  syncOverlapDays: number;
  initialSyncDays: number;
  pendingExpiryDays: number;
  actual: {
    serverUrl: string;
    password: string;
    syncId: string;
    encryptionPassword: string;
    dataDir: string;
  };
  storeRawProviderData: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    apiToken: e.API_TOKEN,
    trueLayer: {
      clientId: e.TRUELAYER_CLIENT_ID,
      clientSecret: e.TRUELAYER_CLIENT_SECRET,
      redirectUri: e.TRUELAYER_REDIRECT_URI,
      environment: e.TRUELAYER_ENVIRONMENT,
    },
    ...(e.APP_ENCRYPTION_KEY ? { appEncryptionKey: e.APP_ENCRYPTION_KEY } : {}),
    syncCron: e.SYNC_CRON,
    syncOverlapDays: e.SYNC_OVERLAP_DAYS,
    initialSyncDays: e.INITIAL_SYNC_DAYS,
    pendingExpiryDays: e.PENDING_EXPIRY_DAYS,
    actual: {
      serverUrl: e.ACTUAL_SERVER_URL,
      password: e.ACTUAL_PASSWORD,
      syncId: e.ACTUAL_SYNC_ID,
      encryptionPassword: e.ACTUAL_ENCRYPTION_PASSWORD,
      dataDir: e.ACTUAL_DATA_DIR,
    },
    storeRawProviderData: e.STORE_RAW_PROVIDER_DATA,
  };
}
