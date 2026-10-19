import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
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
import {
  changeUserPlan,
  createUser,
} from "../src/services/usersService";
import {
  changeAccountPlan,
  createPlan,
  updatePlan,
} from "../src/services/plansService";
import { consume } from "../src/services/consumeService";

const createdAccountIds: string[] = [];

async function createFixture() {
  const account = await createAccount(testDb, {
    name: `test-${randomUUID()}`,
    planName: "Starter",
  });

  createdAccountIds.push(account.id);

  const user = await createUser(testDb, account.id, {
    externalId: "test-user",
  });

  return { account, user };
}

describe("Consume service", () => {
  beforeAll(async () => {
    await prepareTestDatabase();
  });

afterAll(async () => {
  try {
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
      throw new Error("Starter plan is missing during test cleanup");
    }

    for (const accountId of createdAccountIds) {
      await testDb
        .delete(requests)
        .where(eq(requests.accountId, accountId));

      await testDb
        .delete(usageCounters)
        .where(eq(usageCounters.accountId, accountId));

      await testDb
        .delete(users)
        .where(eq(users.accountId, accountId));

      await testDb
        .update(accounts)
        .set({ accountPlanId: starter.id })
        .where(eq(accounts.id, accountId));

      await testDb
        .delete(plans)
        .where(eq(plans.accountId, accountId));

      await testDb
        .delete(accounts)
        .where(eq(accounts.id, accountId));
    }
  } finally {
    await testPool.end();
  }
});

  it("counts an accepted action for both account and user", async () => {
    const { account } = await createFixture();

    const result = await consume(testDb, account.id, {
      userId: "test-user",
      units: 10,
      requestId: "accepted-001",
    });

    expect(result.accepted).toBe(true);
    expect(result.replayed).toBe(false);

    expect(result.user.monthly.used).toBe(10);
    expect(result.account.monthly.used).toBe(10);
    expect(result.user.daily.used).toBe(10);
    expect(result.account.daily.used).toBe(10);

    // Verify persisted counters, not just the response.
    const counters = await testDb
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.accountId, account.id));

    expect(counters).toHaveLength(4);

    for (const counter of counters) {
      expect(counter.unitsUsed).toBe(10);
    }

    const history = await testDb
      .select()
      .from(requests)
      .where(eq(requests.accountId, account.id));

    expect(history).toHaveLength(1);
    expect(history[0]?.accepted).toBe(true);
    expect(history[0]?.units).toBe(10);
  });

  it("rolls back earlier counter increments when a later rule rejects", async () => {
    const { account, user } = await createFixture();

    const plan = await createPlan(testDb, account.id, {
      kind: "user",
      name: "SmallDaily",
      monthlyAllowance: 100,
      dailyAllowance: 5,
      maxPerRequest: 20,
    });

    await changeUserPlan(
      testDb,
      account.id,
      user.externalId,
      plan.id,
    );

    const result = await consume(testDb, account.id, {
      userId: user.externalId,
      units: 10,
      requestId: "rejected-001",
    });

    expect(result.accepted).toBe(false);
    expect(result.rejectedBy).toBe("user");
    expect(result.rule).toBe("daily_allowance");

    expect(result.user.monthly.used).toBe(0);
    expect(result.user.daily.used).toBe(0);
    expect(result.account.monthly.used).toBe(0);
    expect(result.account.daily.used).toBe(0);

    const counters = await testDb
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.accountId, account.id));

    expect(counters).toHaveLength(4);

    for (const counter of counters) {
      expect(counter.unitsUsed).toBe(0);
    }

    const history = await testDb
      .select()
      .from(requests)
      .where(eq(requests.accountId, account.id));

    expect(history).toHaveLength(1);
    expect(history[0]?.accepted).toBe(false);
    expect(history[0]?.rejectedRule).toBe("daily_allowance");
  });

  it("replays the same request without consuming twice", async () => {
    const { account } = await createFixture();

    const input = {
      userId: "test-user",
      units: 10,
      requestId: "retry-001",
    };

    const first = await consume(testDb, account.id, input);
    const second = await consume(testDb, account.id, input);

    expect(first.accepted).toBe(true);
    expect(first.replayed).toBe(false);

    expect(second.accepted).toBe(true);
    expect(second.replayed).toBe(true);

    expect(second.user.monthly.used).toBe(10);
    expect(second.account.monthly.used).toBe(10);

    const counters = await testDb
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.accountId, account.id));

    expect(counters).toHaveLength(4);

    for (const counter of counters) {
      expect(counter.unitsUsed).toBe(10);
    }

    const history = await testDb
      .select()
      .from(requests)
      .where(eq(requests.accountId, account.id));

    expect(history).toHaveLength(1);
  });
  it("rejects reusing a requestId with different parameters", async () => {
  const { account } = await createFixture();

  await createUser(testDb, account.id, {
    externalId: "other-user",
  });

  const input = {
    userId: "test-user",
    units: 10,
    requestId: "conflict-001",
  };

  await consume(testDb, account.id, input);

  // Same requestId, different units.
  await expect(
    consume(testDb, account.id, {
      ...input,
      units: 11,
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: "conflict",
  });

  // Same requestId, different user.
  await expect(
    consume(testDb, account.id, {
      ...input,
      userId: "other-user",
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: "conflict",
  });

  const counters = await testDb
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.accountId, account.id));

  expect(counters).toHaveLength(4);

  for (const counter of counters) {
    expect(counter.unitsUsed).toBe(10);
  }

  const history = await testDb
    .select()
    .from(requests)
    .where(eq(requests.accountId, account.id));

  expect(history).toHaveLength(1);
  expect(history[0]?.units).toBe(10);
  expect(history[0]?.accepted).toBe(true);
});
it("does not exceed the shared account allowance with parallel requests", async () => {
  const { account } = await createFixture();

  await createUser(testDb, account.id, {
    externalId: "other-user",
  });

  const accountPlan = await createPlan(testDb, account.id, {
    kind: "account",
    name: "SharedTen",
    monthlyAllowance: 10,
    dailyAllowance: null,
    maxPerRequest: 20,
  });

  await changeAccountPlan(testDb, account.id, accountPlan.id);

  const results = await Promise.all([
    consume(testDb, account.id, {
      userId: "test-user",
      units: 10,
      requestId: "parallel-001",
    }),
    consume(testDb, account.id, {
      userId: "other-user",
      units: 10,
      requestId: "parallel-002",
    }),
  ]);

  const accepted = results.filter((result) => result.accepted);
  const rejected = results.filter((result) => !result.accepted);

  expect(accepted).toHaveLength(1);
  expect(rejected).toHaveLength(1);

  expect(rejected[0]?.rejectedBy).toBe("account");
  expect(rejected[0]?.rule).toBe("monthly_allowance");

  const counters = await testDb
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.accountId, account.id));

  const accountMonthly = counters.find(
    (counter) =>
      counter.userId === null &&
      counter.periodType === "month",
  );

  const accountDaily = counters.find(
    (counter) =>
      counter.userId === null &&
      counter.periodType === "day",
  );

  const userMonthly = counters.filter(
    (counter) =>
      counter.userId !== null &&
      counter.periodType === "month",
  );

  const userDaily = counters.filter(
    (counter) =>
      counter.userId !== null &&
      counter.periodType === "day",
  );

  expect(accountMonthly?.unitsUsed).toBe(10);
  expect(accountDaily?.unitsUsed).toBe(10);

  expect(userMonthly).toHaveLength(2);
  expect(userDaily).toHaveLength(2);

  expect(
    userMonthly.map((counter) => counter.unitsUsed).sort((a, b) => a - b),
  ).toEqual([0, 10]);

  expect(
    userDaily.map((counter) => counter.unitsUsed).sort((a, b) => a - b),
  ).toEqual([0, 10]);

  const history = await testDb
    .select()
    .from(requests)
    .where(eq(requests.accountId, account.id));

  expect(history).toHaveLength(2);
  expect(history.filter((request) => request.accepted)).toHaveLength(1);
  expect(history.filter((request) => !request.accepted)).toHaveLength(1);
});

it("preserves usage when switching a user's plan", async () => {
  const { account, user } = await createFixture();

  await consume(testDb, account.id, {
    userId: user.externalId,
    units: 10,
    requestId: "before-switch",
  });

  const plan = await createPlan(testDb, account.id, {
    kind: "user",
    name: "LargerPlan",
    monthlyAllowance: 2000,
    dailyAllowance: null,
    maxPerRequest: 50,
  });

  await changeUserPlan(
    testDb,
    account.id,
    user.externalId,
    plan.id,
  );

  const result = await consume(testDb, account.id, {
    userId: user.externalId,
    units: 20,
    requestId: "after-switch",
  });

  expect(result.accepted).toBe(true);
  expect(result.user.plan.id).toBe(plan.id);
  expect(result.user.monthly.used).toBe(30);
  expect(result.user.monthly.remaining).toBe(1970);
  expect(result.account.monthly.used).toBe(30);
});
it("preserves usage when switching the account's plan", async () => {
  const { account, user } = await createFixture();

  await consume(testDb, account.id, {
    userId: user.externalId,
    units: 10,
    requestId: "before-account-switch",
  });

  const plan = await createPlan(testDb, account.id, {
    kind: "account",
    name: "NewAccountPlan",
    monthlyAllowance: 20000,
    dailyAllowance: null,
    maxPerRequest: 200,
  });

  await changeAccountPlan(testDb, account.id, plan.id);

  const result = await consume(testDb, account.id, {
    userId: user.externalId,
    units: 10,
    requestId: "after-account-switch",
  });

  expect(result.accepted).toBe(true);
  expect(result.account.plan.id).toBe(plan.id);
  expect(result.account.monthly.used).toBe(20);
  expect(result.account.monthly.remaining).toBe(19980);
  expect(result.user.monthly.used).toBe(20);
});

it("rejects after lowering an allowance below usage and allows consumption after raising it", async () => {
  const { account, user } = await createFixture();

  const plan = await createPlan(testDb, account.id, {
    kind: "user",
    name: "Adjustable",
    monthlyAllowance: 100,
    dailyAllowance: null,
    maxPerRequest: 20,
  });

  await changeUserPlan(
    testDb,
    account.id,
    user.externalId,
    plan.id,
  );

  const first = await consume(testDb, account.id, {
    userId: user.externalId,
    units: 20,
    requestId: "before-reduction",
  });

  expect(first.accepted).toBe(true);

  await updatePlan(testDb, account.id, plan.id, {
    monthlyAllowance: 10,
  });

  const rejected = await consume(testDb, account.id, {
    userId: user.externalId,
    units: 1,
    requestId: "after-reduction",
  });

  expect(rejected.accepted).toBe(false);
  expect(rejected.rejectedBy).toBe("user");
  expect(rejected.rule).toBe("monthly_allowance");
  expect(rejected.user.monthly.used).toBe(20);
  expect(rejected.user.monthly.remaining).toBe(0);
  expect(rejected.account.monthly.used).toBe(20);

  await updatePlan(testDb, account.id, plan.id, {
    monthlyAllowance: 50,
  });

  const accepted = await consume(testDb, account.id, {
    userId: user.externalId,
    units: 10,
    requestId: "after-increase",
  });

  expect(accepted.accepted).toBe(true);
  expect(accepted.user.monthly.used).toBe(30);
  expect(accepted.user.monthly.remaining).toBe(20);

  // The old rejection must remain unchanged.
  const history = await testDb
    .select()
    .from(requests)
    .where(eq(requests.accountId, account.id));

  expect(history).toHaveLength(3);

  const storedRejection = history.find(
    (entry) => entry.requestId === "after-reduction",
  );

  expect(storedRejection?.accepted).toBe(false);
  expect(storedRejection?.rejectedRule).toBe("monthly_allowance");
});

it("applies shared plan updates while preserving separate user totals", async () => {
  const { account, user } = await createFixture();

  const otherUser = await createUser(testDb, account.id, {
    externalId: "second-user",
  });

  const plan = await createPlan(testDb, account.id, {
    kind: "user",
    name: "SharedDefinition",
    monthlyAllowance: 100,
    dailyAllowance: null,
    maxPerRequest: 20,
  });

  await changeUserPlan(
    testDb,
    account.id,
    user.externalId,
    plan.id,
  );

  await changeUserPlan(
    testDb,
    account.id,
    otherUser.externalId,
    plan.id,
  );

  await consume(testDb, account.id, {
    userId: user.externalId,
    units: 10,
    requestId: "first-user-initial",
  });

  await consume(testDb, account.id, {
    userId: otherUser.externalId,
    units: 20,
    requestId: "second-user-initial",
  });

  await updatePlan(testDb, account.id, plan.id, {
    monthlyAllowance: 25,
  });

  const firstUserResult = await consume(testDb, account.id, {
    userId: user.externalId,
    units: 10,
    requestId: "first-user-next",
  });

  const secondUserResult = await consume(testDb, account.id, {
    userId: otherUser.externalId,
    units: 10,
    requestId: "second-user-next",
  });

  expect(firstUserResult.accepted).toBe(true);
  expect(firstUserResult.user.monthly.limit).toBe(25);
  expect(firstUserResult.user.monthly.used).toBe(20);
  expect(firstUserResult.user.monthly.remaining).toBe(5);

  expect(secondUserResult.accepted).toBe(false);
  expect(secondUserResult.rejectedBy).toBe("user");
  expect(secondUserResult.rule).toBe("monthly_allowance");
  expect(secondUserResult.user.monthly.limit).toBe(25);
  expect(secondUserResult.user.monthly.used).toBe(20);
  expect(secondUserResult.user.monthly.remaining).toBe(5);

  expect(secondUserResult.account.monthly.used).toBe(40);
});
it("consumes only once when identical requests are sent in parallel", async () => {
  const { account } = await createFixture();

  const input = {
    userId: "test-user",
    units: 10,
    requestId: "parallel-duplicate",
  };

  const results = await Promise.all([
    consume(testDb, account.id, input),
    consume(testDb, account.id, input),
  ]);

  expect(results.every((result) => result.accepted)).toBe(true);

  expect(
    results.filter((result) => result.replayed),
  ).toHaveLength(1);

  expect(
    results.filter((result) => !result.replayed),
  ).toHaveLength(1);

  const counters = await testDb
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.accountId, account.id));

  expect(counters).toHaveLength(4);

  for (const counter of counters) {
    expect(counter.unitsUsed).toBe(10);
  }

  const history = await testDb
    .select()
    .from(requests)
    .where(eq(requests.accountId, account.id));

  expect(history).toHaveLength(1);
});

it("preserves a rejected decision when retried after a plan change", async () => {
  const { account, user } = await createFixture();

  const input = {
    userId: user.externalId,
    units: 25,
    requestId: "rejected-retry",
  };

  const first = await consume(testDb, account.id, input);

  expect(first.accepted).toBe(false);
  expect(first.rule).toBe("max_per_request");

  const plan = await createPlan(testDb, account.id, {
    kind: "user",
    name: "LargerRequestLimit",
    monthlyAllowance: 1000,
    dailyAllowance: null,
    maxPerRequest: 50,
  });

  await changeUserPlan(
    testDb,
    account.id,
    user.externalId,
    plan.id,
  );

  const retry = await consume(testDb, account.id, input);

  expect(retry.replayed).toBe(true);
  expect(retry.accepted).toBe(false);
  expect(retry.rule).toBe("max_per_request");
  expect(retry.user.monthly.used).toBe(0);
  expect(retry.account.monthly.used).toBe(0);

  const newAttempt = await consume(testDb, account.id, {
    ...input,
    requestId: "new-operation-after-change",
  });

  expect(newAttempt.accepted).toBe(true);
  expect(newAttempt.user.monthly.used).toBe(25);
  expect(newAttempt.account.monthly.used).toBe(25);
});
});