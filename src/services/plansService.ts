import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import {  accounts, plans } from "../db/schema";
import { badRequest, conflict, notFound } from "../lib/errors";

export async function listPlans(db: Db, accountId: string) {
  return db
    .select()
    .from(plans)
    .where(
      or(
        isNull(plans.accountId),
        eq(plans.accountId, accountId),
      ),
    )
    .orderBy(plans.kind, plans.name, plans.id);
}

type CreatePlanInput = {
  kind: "account" | "user";
  name: string;
  monthlyAllowance: number | null;
  dailyAllowance: number | null;
  maxPerRequest: number | null;
};

export async function createPlan(
  db: Db,
  accountId: string,
  input: CreatePlanInput,
) {
  const [plan] = await db
    .insert(plans)
    .values({
      ...input,
      accountId,
      isPredefined: false,
    })
    .onConflictDoNothing()
    .returning();

  if (!plan) {
    throw conflict("A custom plan with this kind and name already exists");
  }

  return plan;
}

type UpdatePlanInput = Partial<Omit<CreatePlanInput, "kind">>;

export async function updatePlan(
  db: Db,
  accountId: string,
  planId: string,
  input: UpdatePlanInput,
) {
  const [plan] = await db
    .update(plans)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(plans.id, planId),
        eq(plans.accountId, accountId),
        eq(plans.isPredefined, false),
      ),
    )
    .returning();

  if (!plan) {
    throw notFound("Custom plan not found or not editable");
  }

  return plan;
}

export async function changeAccountPlan(
  db: Db,
  accountId: string,
  planId: string,
) {
  const [plan] = await db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.id, planId),
        or(
          isNull(plans.accountId),
          eq(plans.accountId, accountId),
        ),
      ),
    )
    .limit(1);

  if (!plan) {
    throw notFound("Plan not found");
  }

  if (plan.kind !== "account") {
    throw badRequest("An account requires an account plan");
  }

  const [account] = await db
    .update(accounts)
    .set({ accountPlanId: plan.id })
    .where(eq(accounts.id, accountId))
    .returning({
      id: accounts.id,
      name: accounts.name,
      accountPlanId: accounts.accountPlanId,
    });

  if (!account) {
    throw notFound("Account not found");
  }

  return {
    ...account,
    plan,
  };
}