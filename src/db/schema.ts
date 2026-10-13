import {
  pgTable, pgEnum, uuid, text, integer, bigint, boolean,
  timestamp, date, index, uniqueIndex, check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const planKind = pgEnum("plan_kind", ["account", "user"]);
export const periodType = pgEnum("period_type", ["month", "day"]);
export const scopeType = pgEnum("scope_type", ["account", "user"]);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").references((): AnyPgColumn => accounts.id),
    kind: planKind("kind").notNull(),
    name: text("name").notNull(),
    monthlyAllowance: bigint("monthly_allowance", { mode: "number" }),
    dailyAllowance: bigint("daily_allowance", { mode: "number" }),
    maxPerRequest: bigint("max_per_request", { mode: "number" }),
    isPredefined: boolean("is_predefined").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),//here defaultNow() doesn't update the value automatically on update, so we need to handle that in the application
  },
  (t) => [
    uniqueIndex("plans_account_kind_name_uq").on(
      sql`coalesce(${t.accountId}, '00000000-0000-0000-0000-000000000000')`,
      t.kind,
      t.name,
    ),//ex: It is forbidden to create two global plans of type `user` with the name `Basic`.
    check("plans_monthly_nonneg", sql`${t.monthlyAllowance} IS NULL OR ${t.monthlyAllowance} >= 0`),
    check("plans_daily_nonneg", sql`${t.dailyAllowance} IS NULL OR ${t.dailyAllowance} >= 0`),
    check("plans_max_nonneg", sql`${t.maxPerRequest} IS NULL OR ${t.maxPerRequest} >= 0`),
  ],
);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  accountPlanId: uuid("account_plan_id").notNull().references(() => plans.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});


export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    // the caller's own identifier for this user
    externalId: text("external_id").notNull(),
    userPlanId: uuid("user_plan_id").notNull().references(() => plans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_account_external_uq").on(t.accountId, t.externalId)],
);

// ---------- usage counters ----------
// One row per (account | account+user) per period. New period = new row = zero usage.
export const usageCounters = pgTable(
  "usage_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    // NULL = the account-level (shared) counter
    userId: uuid("user_id").references(() => users.id),
    periodType: periodType("period_type").notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    unitsUsed: bigint("units_used", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("usage_counter_uq").on(
      t.accountId,
      sql`coalesce(${t.userId}, '00000000-0000-0000-0000-000000000000')`,
      t.periodType,
      t.periodStart,
    ),
    check("usage_nonneg", sql`${t.unitsUsed} >= 0`),
  ],
);

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    requestId: text("request_id").notNull(),
    units: bigint("units", { mode: "number" }).notNull(),
    accepted: boolean("accepted").notNull(),
    // for rejections: which level and which rules failed
    rejectedBy: scopeType("rejected_by"),
    rejectedRule: text("rejected_rule"),
    violations: text("violations"), // JSON string of all failed rules
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // UTC month this request belongs to (first day of the month)
    month: date("month", { mode: "string" }).notNull(),
  },
  (t) => [
    uniqueIndex("requests_account_request_uq").on(t.accountId, t.requestId),
    index("requests_account_created_idx").on(t.accountId, t.createdAt),
    index("requests_user_created_idx").on(t.userId, t.createdAt),
    check("requests_units_positive", sql`${t.units} > 0`),
  ],
);