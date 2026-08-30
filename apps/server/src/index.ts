import { loadConfig } from "./config/config.js";
import { createPrismaClient } from "./db/prisma.js";
import { RealActualGateway } from "./integrations/actual/actual-gateway.js";
import { ActualExportService } from "./integrations/actual/export-service.js";
import { startScheduler } from "./jobs/scheduler.js";
import { RetryingBankingProvider } from "./providers/retrying-provider.js";
import { TrueLayerProvider } from "./providers/truelayer/truelayer-provider.js";
import { ConnectionService } from "./services/connections/connection-service.js";
import { SyncEngine } from "./services/sync/sync-engine.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);

const trueLayerConfigured =
  config.trueLayer.clientId !== "" &&
  config.trueLayer.clientSecret !== "" &&
  config.trueLayer.redirectUri !== "";
const actualConfigured =
  config.actual.serverUrl !== "" &&
  config.actual.password !== "" &&
  config.actual.syncId !== "";

let connectionService: ConnectionService | undefined;
let syncEngine: SyncEngine | undefined;
if (trueLayerConfigured) {
  if (!config.appEncryptionKey) {
    throw new Error("APP_ENCRYPTION_KEY is required when TrueLayer credentials are configured");
  }
  // §28 retry schedule wraps every provider call
  const provider = new RetryingBankingProvider(
    new TrueLayerProvider({
      clientId: config.trueLayer.clientId,
      clientSecret: config.trueLayer.clientSecret,
      redirectUri: config.trueLayer.redirectUri,
      environment: config.trueLayer.environment,
    }),
  );
  connectionService = new ConnectionService({
    prisma,
    provider,
    encryptionKey: config.appEncryptionKey,
  });
  const actualExporter = actualConfigured
    ? new ActualExportService({
        prisma,
        gateway: new RealActualGateway({
          serverUrl: config.actual.serverUrl,
          password: config.actual.password,
          syncId: config.actual.syncId,
          ...(config.actual.encryptionPassword
            ? { encryptionPassword: config.actual.encryptionPassword }
            : {}),
          dataDir: config.actual.dataDir,
        }),
      })
    : undefined;
  syncEngine = new SyncEngine({
    prisma,
    connectionService,
    provider,
    config: {
      syncOverlapDays: config.syncOverlapDays,
      initialSyncDays: config.initialSyncDays,
      pendingExpiryDays: config.pendingExpiryDays,
      storeRawProviderData: config.storeRawProviderData,
    },
    ...(actualExporter ? { actualExporter } : {}),
  });
}

const server = buildServer(config, {
  prisma,
  actualConfigured,
  ...(connectionService ? { connectionService } : {}),
  ...(syncEngine ? { syncEngine } : {}),
});

if (!trueLayerConfigured) {
  server.log.warn("TrueLayer credentials not configured — connection routes return 503");
} else if (!actualConfigured) {
  server.log.warn("Actual Budget not configured — transactions stay local only");
}

const scheduler = syncEngine
  ? startScheduler({
      cronExpression: config.syncCron,
      engine: syncEngine,
      log: {
        info: (message) => server.log.info(message),
        warn: (message) => server.log.warn(message),
      },
    })
  : undefined;

async function shutdown(signal: string): Promise<void> {
  server.log.info(`${signal} received, shutting down`);
  scheduler?.stop();
  await server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await server.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
