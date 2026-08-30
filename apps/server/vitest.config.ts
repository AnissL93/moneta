import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    // DB-backed integration tests share one database; keep them serial.
    fileParallelism: false,
  },
});
