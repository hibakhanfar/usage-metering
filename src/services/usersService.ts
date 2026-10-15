import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { plans, users } from "../db/schema";
import { conflict, notFound } from "../lib/errors";

async function findUserPlan(db: Db, accountId: string, planName: string) {
  const [plan] = await db
    .select({ id: plans.id, name: plans.name })
    .from(plans)
    .where(
      and(
        eq(plans.kind, "user"),
        eq(plans.name, planName),
        // predefined plans OR plans owned by THIS account only
        or(isNull(plans.accountId), eq(plans.accountId, accountId)),
      ),
    )
    .limit(1);

  if (!plan) {
    throw notFound(`User plan "${planName}" not found`);
  }
  return plan;
}

export async function createUser(
  db: Db,
  accountId: string,
  input: { externalId: string; planName: string },
) {
  const plan = await findUserPlan(db, accountId, input.planName);

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
  planName: string,
) {
  const plan = await findUserPlan(db, accountId, planName);

  const [user] = await db
    .update(users)
    .set({ userPlanId: plan.id })
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId)))
    .returning({ id: users.id, externalId: users.externalId });

  if (!user) {
    throw notFound(`User "${externalId}" not found`);
  }

  return { id: user.id, externalId: user.externalId, planName: plan.name };
}