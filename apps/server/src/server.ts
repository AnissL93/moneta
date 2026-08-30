import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/config.js";
import {
  type ConnectionRouteDeps,
  registerConnectionRoutes,
} from "./routes/connections.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerUiRoutes } from "./routes/ui.js";
import { registerSyncRoutes, type SyncRouteDeps } from "./routes/sync.js";

export type ServerDeps = ConnectionRouteDeps &
  Pick<SyncRouteDeps, "syncEngine"> & { actualConfigured?: boolean };

// Auth-exempt paths: /health is public; the TrueLayer callback arrives via
// browser redirect and is protected by its single-use state (spec §35); /ui
// is a static shell whose data calls still require the bearer token.
const AUTH_EXEMPT_PATHS = new Set(["/health", "/auth/truelayer/callback", "/ui"]);

function tokenMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function buildServer(config: AppConfig, deps?: ServerDeps): FastifyInstance {
  const server = Fastify({
    logger: config.nodeEnv !== "test",
  });

  // Every endpoint except the exempt paths requires the static bearer token (spec §35).
  server.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (AUTH_EXEMPT_PATHS.has(path)) {
      return;
    }
    const header = request.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !tokenMatches(provided, config.apiToken)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  server.get("/health", async () => ({ status: "ok" }));

  if (deps) {
    registerConnectionRoutes(server, deps);
    registerSyncRoutes(server, deps);
    registerStatusRoutes(server, {
      prisma: deps.prisma,
      actualConfigured: deps.actualConfigured ?? false,
    });
    registerUiRoutes(server);
  }

  return server;
}
