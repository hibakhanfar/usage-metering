import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied");
      return pool.end();
    })
    .catch((err) => {
      console.error("Migration failed", err);
      process.exit(1);
    });
}