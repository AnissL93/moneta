import { describe, expect, it } from "vitest";
import { SyncInProgressError } from "../services/sync/sync-engine.js";
import { startScheduler } from "./scheduler.js";

function makeLog() {
  const lines: string[] = [];
  return {
    log: { info: (m: string) => lines.push(`info:${m}`), warn: (m: string) => lines.push(`warn:${m}`) },
    lines,
  };
}

function makeRegistrar() {
  let handler: (() => void) | undefined;
  let stopped = false;
  return {
    register: (_expr: string, fn: () => void) => {
      handler = fn;
      return { stop: () => void (stopped = true) };
    },
    tick: async () => {
      handler?.();
      // handler kicks off async work; let it settle
      await new Promise((resolve) => setImmediate(resolve));
    },
    isStopped: () => stopped,
  };
}

describe("startScheduler", () => {
  it("rejects an invalid cron expression", () => {
    const { log } = makeLog();
    expect(() =>
      startScheduler({
        cronExpression: "not a cron",
        engine: { syncAll: async () => [] },
        log,
      }),
    ).toThrow(/cron/i);
  });

  it("runs syncAll on each tick and logs the runs", async () => {
    const { log, lines } = makeLog();
    const registrar = makeRegistrar();
    let calls = 0;
    startScheduler({
      cronExpression: "0 */6 * * *",
      engine: {
        syncAll: async () => {
          calls += 1;
          return ["run-1"];
        },
      },
      log,
      register: registrar.register,
    });
    await registrar.tick();
    expect(calls).toBe(1);
    expect(lines.some((l) => l.includes("run-1"))).toBe(true);
  });

  it("swallows SyncInProgressError with a warning", async () => {
    const { log, lines } = makeLog();
    const registrar = makeRegistrar();
    startScheduler({
      cronExpression: "* * * * *",
      engine: {
        syncAll: async () => {
          throw new SyncInProgressError("conn-1");
        },
      },
      log,
      register: registrar.register,
    });
    await registrar.tick();
    expect(lines.some((l) => l.startsWith("warn:") && l.includes("already running"))).toBe(true);
  });

  it("survives arbitrary sync errors", async () => {
    const { log, lines } = makeLog();
    const registrar = makeRegistrar();
    startScheduler({
      cronExpression: "* * * * *",
      engine: {
        syncAll: async () => {
          throw new Error("db exploded");
        },
      },
      log,
      register: registrar.register,
    });
    await registrar.tick();
    expect(lines.some((l) => l.startsWith("warn:") && l.includes("db exploded"))).toBe(true);
  });

  it("stop() stops the underlying job", () => {
    const { log } = makeLog();
    const registrar = makeRegistrar();
    const scheduler = startScheduler({
      cronExpression: "* * * * *",
      engine: { syncAll: async () => [] },
      log,
      register: registrar.register,
    });
    scheduler.stop();
    expect(registrar.isStopped()).toBe(true);
  });
});
