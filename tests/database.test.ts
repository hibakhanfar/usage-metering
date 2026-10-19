import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  prepareTestDatabase,
  testDb,
  testPool,
} from "./helpers/testDb";

describe("Test database setup", () => {
  beforeAll(async () => {
    await prepareTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await testPool.end();
  });

  it("connects to the isolated test database", async () => {
    const result = await testDb.execute(sql`
      SELECT current_database() AS name
    `);

    expect(result.rows[0]?.name).toBe("usage_metering_test");
  });

  it("creates the required service tables", async () => {
    const result = await testDb.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `);

    const tableNames = result.rows.map((row) => row.table_name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "accounts",
        "users",
        "plans",
        "usage_counters",
        "requests",
      ]),
    );
  });
});