import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import * as schema from "../../src/db/schema";
import { seedPlans } from "../../src/db/seed";

const connectionString =
  process.env.TEST_DATABASE_URL ??
  "postgres://metering_test:local_test_password@127.0.0.1:5435/usage_metering_test";

const databaseUrl = new URL(connectionString);

if (databaseUrl.pathname !== "/usage_metering_test") {
  throw new Error(
    "Tests must use the usage_metering_test database",
  );
}

export const testPool = new Pool({
  connectionString,
  max: 10,
});

export const testDb = drizzle(testPool, { schema });

export async function prepareTestDatabase() {
  await migrate(testDb, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });

  await seedPlans(testDb);
}