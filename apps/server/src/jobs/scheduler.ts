import cron from "node-cron";
import { type SyncEngine, SyncInProgressError } from "../services/sync/sync-engine.js";

export interface SchedulerLog {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface SchedulerOptions {
  cronExpression: string;
  engine: Pick<SyncEngine, "syncAll">;
  log: SchedulerLog;
  /** injectable for tests; defaults to node-cron */
  register?: (expression: string, fn: () => void) => { stop: () => void };
}

export function startScheduler(options: SchedulerOptions): { stop: () => void } {
  if (!cron.validate(options.cronExpression)) {
    throw new Error(`invalid cron expression: ${options.cronExpression}`);
  }
  const register =
    options.register ??
    ((expression: string, fn: () => void) => cron.schedule(expression, fn));

  const job = register(options.cronExpression, () => {
    // Fire-and-forget: a scheduler tick must never crash the process (spec §18/§28).
    void (async () => {
      try {
        const runs = await options.engine.syncAll();
        options.log.info(`scheduled sync finished: ${runs.length} run(s) [${runs.join(", ")}]`);
      } catch (error) {
        if (error instanceof SyncInProgressError) {
          options.log.warn(`scheduled sync skipped: ${error.message}`);
        } else {
          options.log.warn(
            `scheduled sync failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();
  });

  options.log.info(`sync scheduler started (${options.cronExpression})`);
  return { stop: () => job.stop() };
}
