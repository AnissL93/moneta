import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrisma, truncateAll } from "./test-helpers.js";

const prisma = createTestPrisma();

describe("prisma harness", () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("writes and reads a settings row", async () => {
    await prisma.setting.create({ data: { key: "smoke", value: "ok" } });
    const row = await prisma.setting.findUnique({ where: { key: "smoke" } });
    expect(row?.value).toBe("ok");
  });
});
