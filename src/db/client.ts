import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5433/usage_metering",
  max: Number(process.env.DB_POOL_SIZE ?? 20),
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;