import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { plans, users } from "../db/schema";
import { badRequest, conflict, notFound } from "../lib/errors";

async function findUserPlan(
  db: Db,
  accountId: string,
  planId?: string,
) {
  const condition = planId
    ? and(
        eq(plans.id, planId),
        eq(plans.kind, "user"),
        or(
          isNull(plans.accountId),
          eq(plans.accountId, accountId),
        ),
      )
    : and(
        isNull(plans.accountId),
        eq(plans.kind, "user"),
        eq(plans.name, "Basic"),
        eq(plans.isPredefined, true),
      );

  const [plan] = await db
    .select({
      id: plans.id,
      name: plans.name,
    })
    .from(plans)
    .where(condition)
    .limit(1);

  if (!plan) {
    throw notFound("User plan not found or not accessible");
  }

  return plan;
}

export async function createUser(
  db: Db,
  accountId: string,
  input: { externalId: string; planId?: string },
) {
const plan = await findUserPlan(db, accountId, input.planId);

  const [user] = await db
    .insert(users)
    .values({
      accountId,
      externalId: input.externalId,
      userPlanId: plan.id,
    })
    .onConflictDoNothing()
    .returning({ id: users.id, externalId: users.externalId });
  if (!user) {
    throw conflict(`User "${input.externalId}" already exists`);
  }

  return { id: user.id, externalId: user.externalId, planName: plan.name };
}

export async function listUsers(db: Db, accountId: string) {
  return db
    .select({
      id: users.id,
      externalId: users.externalId,
      planName: plans.name,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(plans, eq(users.userPlanId, plans.id))
    .where(eq(users.accountId, accountId))
    .orderBy(users.createdAt);
}

export async function changeUserPlan(
  db: Db,
  accountId: string,
  externalId: string,
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

  if (plan.kind !== "user") {
    throw badRequest("A user requires a user plan");
  }

  const [user] = await db
    .update(users)
    .set({ userPlanId: plan.id })
    .where(
      and(
        eq(users.accountId, accountId),
        eq(users.externalId, externalId),
      ),
    )
    .returning({
      id: users.id,
      externalId: users.externalId,
      userPlanId: users.userPlanId,
    });

  if (!user) {
    throw notFound("User not found");
  }

  return {
    ...user,
    plan,
  };
}