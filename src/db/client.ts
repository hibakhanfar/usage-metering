import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DB_POOL_SIZE ?? 20),
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;