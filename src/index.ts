import { db, pool } from "./db/client";
import { runMigrations } from "./db/migrate";
import { seedPlans } from "./db/seed";
import { buildApp } from "./app";

async function main() {
  await runMigrations();
  await seedPlans(db);

  const adminToken = process.env.ADMIN_TOKEN ?? "dev-admin-token";
  const port = Number(process.env.PORT ?? 3000);

  const app = buildApp(db, adminToken);
  const server = app.listen(port, () => {
    console.log(`Usage metering service listening on :${port}`);
  });

  const shutdown = () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start", err);
  process.exit(1);
});