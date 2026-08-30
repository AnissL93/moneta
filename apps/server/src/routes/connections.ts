import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { ConnectionService } from "../services/connections/connection-service.js";

function html(body: string): string {
  return `<!doctype html><html><body><p>${body}</p></body></html>`;
}

export interface ConnectionRouteDeps {
  prisma: PrismaClient;
  connectionService?: ConnectionService;
}

export function registerConnectionRoutes(
  server: FastifyInstance,
  deps: ConnectionRouteDeps,
): void {
  const { prisma, connectionService } = deps;

  const requireService = (): ConnectionService => {
    if (!connectionService) {
      throw Object.assign(new Error("truelayer not configured"), { statusCode: 503 });
    }
    return connectionService;
  };

  server.post("/connections/truelayer", async (_request, reply) => {
    const session = await requireService().createAuthSession();
    return reply.code(201).send(session);
  });

  // Browser-redirected by TrueLayer: auth-exempt, protected by single-use state.
  server.get("/auth/truelayer/callback", async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    if (query.error || !query.code || !query.state) {
      return reply
        .code(400)
        .type("text/html")
        .send(html(`Bank connection failed: ${query.error ?? "missing code or state"}`));
    }
    try {
      const result = await requireService().handleCallback({
        code: query.code,
        state: query.state,
      });
      return reply
        .type("text/html")
        .send(
          html(
            `Bank connected — ${result.accountsDiscovered} account(s) discovered. You can close this tab.`,
          ),
        );
    } catch (error) {
      request.log.warn({ err: error }, "callback failed");
      return reply
        .code(400)
        .type("text/html")
        .send(html("Bank connection failed: invalid or expired authorization."));
    }
  });

  server.get("/connections", async () => {
    return { connections: await requireService().listConnections() };
  });

  server.post("/connections/:id/reauthorize", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.connection.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: "connection not found" });
    }
    const session = await requireService().createAuthSession(id);
    return reply.code(201).send(session);
  });

  // Soft delete: history is retained (spec §35).
  server.delete("/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.connection.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: "connection not found" });
    }
    await requireService().disableConnection(id);
    return { status: "DISABLED" };
  });

  server.get("/accounts", async () => {
    const accounts = await prisma.account.findMany({
      orderBy: { createdAt: "asc" },
      include: { balances: { orderBy: { observedAt: "desc" }, take: 1 } },
    });
    return {
      accounts: accounts.map((account) => {
        const latest = account.balances[0];
        return {
          id: account.id,
          name: account.name,
          type: account.type,
          currency: account.currency,
          institutionName: account.institutionName,
          accountNumberLast4: account.accountNumberLast4,
          active: account.active,
          lastSuccessfulSync: account.lastSuccessfulSync,
          latestBalance: latest
            ? {
                currentMinor: latest.currentAmountMinor?.toString() ?? null,
                availableMinor: latest.availableAmountMinor?.toString() ?? null,
                currency: latest.currency,
                observedAt: latest.observedAt,
              }
            : null,
        };
      }),
    };
  });
}
