import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  "postgresql://finance:finance-dev-password@localhost:5432/finance";
const TEST_DB = "finance_test";

export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "42P04") {
      // anything other than "database already exists"
      throw error;
    }
  } finally {
    await admin.end();
  }

  const testUrl = new URL(ADMIN_URL);
  testUrl.pathname = `/${TEST_DB}`;
  process.env.TEST_DATABASE_URL = testUrl.toString();

  // cwd is apps/server when run via `npm test -w apps/server`.
  // Direct binary path: the RTK shell hook breaks `npx prisma` invocations.
  const prismaBin = resolve(process.cwd(), "../../node_modules/.bin/prisma");
  execFileSync(
    prismaBin,
    ["migrate", "deploy", "--schema", resolve(process.cwd(), "prisma/schema.prisma")],
    {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
      stdio: "pipe",
    },
  );
}
