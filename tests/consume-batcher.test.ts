import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import {
  prepareTestDatabase,
  testDb,
  testPool,
} from "./helpers/testDb";

import {
  accounts,
  plans,
  requests,
  usageCounters,
  users,
} from "../src/db/schema";

import { createAccount } from "../src/services/accountsService";
import { createUser } from "../src/services/usersService";
import {
  changeAccountPlan,
  createPlan,
} from "../src/services/plansService";
import { ConsumeBatcher } from "../src/services/consumeBatcher";

const createdAccountIds: string[] = [];

async function createFixture(monthlyAllowance = 100) {
  const account = await createAccount(testDb, {
    name: `batch-test-${randomUUID()}`,
    planName: "Starter",
  });

  createdAccountIds.push(account.id);

  const plan = await createPlan(testDb, account.id, {
    kind: "account",
    name: "BatchAccount",
    monthlyAllowance,
    dailyAllowance: null,
    maxPerRequest: 20,
  });

  await changeAccountPlan(testDb, account.id, plan.id);

  await createUser(testDb, account.id, {
    externalId: "ali",
  });

  await createUser(testDb, account.id, {
    externalId: "sara",
  });

  const batcher = new ConsumeBatcher(testDb, 50);

  return { account, batcher };
}

async function storedState(accountId: string) {
  const counters = await testDb
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.accountId, accountId));

  const history = await testDb
    .select()
    .from(requests)
    .where(eq(requests.accountId, accountId));

  const accountMonthly = counters.find(
    (counter) =>
      counter.userId === null &&
      counter.periodType === "month",
  );

  const userMonthlyTotal = counters
    .filter(
      (counter) =>
        counter.userId !== null &&
        counter.periodType === "month",
    )
    .reduce((sum, counter) => sum + counter.unitsUsed, 0);

  return { counters, history, accountMonthly, userMonthlyTotal };
}

describe("Consume batcher", () => {
  beforeAll(async () => {
    await prepareTestDatabase();
  });

  afterAll(async () => {
    try {
      if (createdAccountIds.length > 0) {
        const [starter] = await testDb
          .select({ id: plans.id })
          .from(plans)
          .where(
            and(
              isNull(plans.accountId),
              eq(plans.kind, "account"),
              eq(plans.name, "Starter"),
            ),
          )
          .limit(1);

        if (!starter) {
          throw new Error("Starter plan is missing during cleanup");
        }

        for (const accountId of createdAccountIds) {
          await testDb.transaction(async (tx) => {
            await tx
              .delete(requests)
              .where(eq(requests.accountId, accountId));

            await tx
              .delete(usageCounters)
              .where(eq(usageCounters.accountId, accountId));

            await tx
              .delete(users)
              .where(eq(users.accountId, accountId));

            await tx
              .update(accounts)
              .set({ accountPlanId: starter.id })
              .where(eq(accounts.id, accountId));

            await tx
              .delete(plans)
              .where(eq(plans.accountId, accountId));

            await tx
              .delete(accounts)
              .where(eq(accounts.id, accountId));
          });
        }
      }
    } finally {
      await testPool.end();
    }
  });

  it("keeps concurrent batched requests within the shared allowance", async () => {
    const { account, batcher } = await createFixture(10);

    const results = await Promise.all([
      batcher.consume(account.id, {
        userId: "ali",
        units: 5,
        requestId: "quota-1",
      }),
      batcher.consume(account.id, {
        userId: "sara",
        units: 5,
        requestId: "quota-2",
      }),
      batcher.consume(account.id, {
        userId: "ali",
        units: 5,
        requestId: "quota-3",
      }),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(2);

    const rejected = results.filter((result) => !result.accepted);

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.rejectedBy).toBe("account");
    expect(rejected[0]?.rule).toBe("monthly_allowance");

    const state = await storedState(account.id);

    expect(state.accountMonthly?.unitsUsed).toBe(10);
    expect(state.userMonthlyTotal).toBe(10);
    expect(state.history).toHaveLength(3);
    expect(
      state.history.filter((entry) => entry.accepted),
    ).toHaveLength(2);
  });

  it("counts identical concurrent requests only once", async () => {
    const { account, batcher } = await createFixture();

    const input = {
      userId: "ali",
      units: 10,
      requestId: "same-operation",
    };

    const results = await Promise.all([
      batcher.consume(account.id, input),
      batcher.consume(account.id, input),
      batcher.consume(account.id, input),
    ]);

    expect(results.every((result) => result.accepted)).toBe(true);

    expect(
      results.filter((result) => result.replayed === false),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.replayed === true),
    ).toHaveLength(2);

    const state = await storedState(account.id);

    expect(state.accountMonthly?.unitsUsed).toBe(10);
    expect(state.userMonthlyTotal).toBe(10);
    expect(state.history).toHaveLength(1);

    for (const counter of state.counters) {
      expect(counter.unitsUsed).toBe(10);
    }
  });

  it("isolates a conflicting request while preserving valid queued requests", async () => {
    const { account, batcher } = await createFixture();

    const results = await Promise.allSettled([
      batcher.consume(account.id, {
        userId: "ali",
        units: 1,
        requestId: "first-operation",
      }),
      batcher.consume(account.id, {
        userId: "sara",
        units: 5,
        requestId: "shared-request-id",
      }),
      batcher.consume(account.id, {
        userId: "sara",
        units: 6,
        requestId: "shared-request-id",
      }),
      batcher.consume(account.id, {
        userId: "ali",
        units: 2,
        requestId: "last-operation",
      }),
    ]);

    for (const index of [0, 1, 3]) {
      expect(results[index]).toMatchObject({
        status: "fulfilled",
        value: { accepted: true },
      });
    }

    expect(results[2]).toMatchObject({
      status: "rejected",
      reason: {
        status: 409,
        code: "conflict",
      },
    });

    const state = await storedState(account.id);

    expect(state.accountMonthly?.unitsUsed).toBe(8);
    expect(state.userMonthlyTotal).toBe(8);
    expect(state.history).toHaveLength(3);
    expect(state.history.every((entry) => entry.accepted)).toBe(true);

    expect(
      state.history.filter(
        (entry) => entry.requestId === "shared-request-id",
      ),
    ).toHaveLength(1);
  });
});