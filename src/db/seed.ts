import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client";
import { plans } from "./schema";

type PredefinedPlan = {
  kind: "account" | "user";
  name: string;
  monthlyAllowance: number | null;
  dailyAllowance: number | null;
  maxPerRequest: number | null;
};

export const PREDEFINED_PLANS: PredefinedPlan[] = [
  { kind: "account", name: "Starter", monthlyAllowance: 10_000,  dailyAllowance: 1_000,  maxPerRequest: 100 },
  { kind: "account", name: "Pro",     monthlyAllowance: 100_000, dailyAllowance: 10_000, maxPerRequest: 500 },
  { kind: "user",    name: "Basic",   monthlyAllowance: 1_000,   dailyAllowance: 100,    maxPerRequest: 20 },
  { kind: "user",    name: "Premium", monthlyAllowance: 10_000,  dailyAllowance: 1_000,  maxPerRequest: 100 },
];

export async function seedPlans(db: Db): Promise<void> {
  for (const p of PREDEFINED_PLANS) {
    const existing = await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(isNull(plans.accountId), eq(plans.kind, p.kind), eq(plans.name, p.name)))
      .limit(1);

    if (existing.length > 0) {
      continue; 
    }

    await db
      .insert(plans)
      .values({ ...p, accountId: null, isPredefined: true })
      .onConflictDoNothing();
  }
}