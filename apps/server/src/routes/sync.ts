import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { SyncEngine, SyncInProgressError } from "../services/sync/sync-engine.js";

export interface SyncRouteDeps {
  prisma: PrismaClient;
  syncEngine?: SyncEngine;
}

export function registerSyncRoutes(server: FastifyInstance, deps: SyncRouteDeps): void {
  const { prisma, syncEngine } = deps;

  const requireEngine = (): SyncEngine => {
    if (!syncEngine) {
      throw Object.assign(new Error("truelayer not configured"), { statusCode: 503 });
    }
    return syncEngine;
  };

  server.post("/sync", async (_request, reply) => {
    const runs = await requireEngine().syncAll();
    return reply.code(202).send({ runs });
  });

  server.post("/sync/:accountId", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      return reply.code(404).send({ error: "account not found" });
    }
    try {
      const runId = await requireEngine().syncAccount(accountId);
      return reply.code(202).send({ runId });
    } catch (error) {
      if (error instanceof SyncInProgressError) {
        return reply.code(409).send({ error: "sync already running" });
      }
      throw error;
    }
  });

  server.get("/sync/runs", async (request) => {
    const { limit } = request.query as { limit?: string };
    const take = Math.min(Number(limit) || 20, 100);
    const runs = await prisma.syncRun.findMany({
      orderBy: { startedAt: "desc" },
      take,
      include: { errors: { select: { accountId: true, errorType: true, message: true } } },
    });
    return { runs };
  });
}
