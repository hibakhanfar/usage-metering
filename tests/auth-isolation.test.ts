import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { eq, sql } from "drizzle-orm";

import {
  prepareTestDatabase,
  testDb,
  testPool,
} from "./helpers/testDb";

import { buildApp } from "../src/app";
import {
  accounts,
  plans,
  requests,
  usageCounters,
  users,
} from "../src/db/schema";

import { createAccount } from "../src/services/accountsService";
import { createUser } from "../src/services/usersService";
import { createPlan } from "../src/services/plansService";

const app = buildApp(testDb, "test-only-admin-token");

const createdAccountIds: string[] = [];

let accountA: Awaited<ReturnType<typeof createAccount>>;
let accountB: Awaited<ReturnType<typeof createAccount>>;
let privatePlanId: string;

describe("API key authentication and account isolation", () => {
  beforeAll(async () => {
    await prepareTestDatabase();

    accountA = await createAccount(testDb, {
      name: `company-a-${randomUUID()}`,
      planName: "Starter",
    });

    createdAccountIds.push(accountA.id);

    accountB = await createAccount(testDb, {
      name: `company-b-${randomUUID()}`,
      planName: "Starter",
    });

    createdAccountIds.push(accountB.id);

    await createUser(testDb, accountA.id, {
      externalId: "company-a-user",
    });

    await createUser(testDb, accountB.id, {
      externalId: "company-b-user",
    });

    const privatePlan = await createPlan(testDb, accountB.id, {
      kind: "user",
      name: "PrivatePlan",
      monthlyAllowance: 500,
      dailyAllowance: null,
      maxPerRequest: 20,
    });

    privatePlanId = privatePlan.id;
  });

  afterAll(async () => {
    try {
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

  it("rejects a request without an API key", async () => {
    const response = await request(app)
      .get("/users");

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("missing_api_key");
  });

  it("rejects an invalid API key", async () => {
    const response = await request(app)
      .get("/users")
      .set("x-api-key", "not-a-valid-key");

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("invalid_api_key");
  });

  it("lists only the authenticated account's users", async () => {
    const response = await request(app)
      .get("/users")
      .set("x-api-key", accountA.apiKey);

    expect(response.status).toBe(200);

    expect(
      response.body.users.map(
        (user: { externalId: string }) => user.externalId,
      ),
    ).toEqual(["company-a-user"]);
  });

  it("cannot consume units for another account's user", async () => {
    const response = await request(app)
      .post("/consume")
      .set("x-api-key", accountA.apiKey)
      .send({
        userId: "company-b-user",
        units: 10,
        requestId: "foreign-user-001",
      });

    expect(response.status).toBe(404);

    for (const accountId of [accountA.id, accountB.id]) {
      const counters = await testDb
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, accountId));

      const history = await testDb
        .select()
        .from(requests)
        .where(eq(requests.accountId, accountId));

      expect(counters).toHaveLength(0);
      expect(history).toHaveLength(0);
    }
  });

  it("cannot view, modify, or assign another account's private plan", async () => {
    const listResponse = await request(app)
      .get("/plans")
      .set("x-api-key", accountA.apiKey);

    expect(listResponse.status).toBe(200);

    expect(
      listResponse.body.plans.map(
        (plan: { id: string }) => plan.id,
      ),
    ).not.toContain(privatePlanId);

    const updateResponse = await request(app)
      .patch(`/plans/${privatePlanId}`)
      .set("x-api-key", accountA.apiKey)
      .send({
        monthlyAllowance: 9999,
      });

    expect(updateResponse.status).toBe(404);

    const assignResponse = await request(app)
      .patch("/users/company-a-user/plan")
      .set("x-api-key", accountA.apiKey)
      .send({
        planId: privatePlanId,
      });

    expect(assignResponse.status).toBe(404);

    const [storedPlan] = await testDb
      .select()
      .from(plans)
      .where(eq(plans.id, privatePlanId));

    expect(storedPlan?.monthlyAllowance).toBe(500);

    const [storedUser] = await testDb
      .select()
      .from(users)
      .where(eq(users.accountId, accountA.id));

    expect(storedUser).toBeDefined();
    expect(storedUser?.userPlanId).not.toBe(privatePlanId);
  });
  it.each([0, -1, 1.5, "10"])(
  "rejects invalid consumption units: %s",
  async (units) => {
    const response = await request(app)
      .post("/consume")
      .set("x-api-key", accountA.apiKey)
      .send({
        userId: "company-a-user",
        units,
        requestId: `invalid-${randomUUID()}`,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("validation_error");
  },
);

it("returns consistent usage and filtered history without exposing another account's data", async () => {
  const accepted = await request(app)
    .post("/consume")
    .set("x-api-key", accountA.apiKey)
    .send({
      userId: "company-a-user",
      units: 10,
      requestId: "usage-accepted",
    });

  expect(accepted.status).toBe(200);
  expect(accepted.body.accepted).toBe(true);

  const rejected = await request(app)
    .post("/consume")
    .set("x-api-key", accountA.apiKey)
    .send({
      userId: "company-a-user",
      units: 25,
      requestId: "usage-rejected",
    });

  expect(rejected.status).toBe(200);
  expect(rejected.body.accepted).toBe(false);
  expect(rejected.body.rule).toBe("max_per_request");

  const usage = await request(app)
    .get("/usage")
    .query({ limit: 1, offset: 0 })
    .set("x-api-key", accountA.apiKey);

  expect(usage.status).toBe(200);
  expect(usage.body.account.monthly.used).toBe(10);
  expect(usage.body.users.total).toBe(1);
  expect(usage.body.users.items).toHaveLength(1);
  expect(usage.body.users.items[0].monthly.used).toBe(10);

  const history = await request(app)
    .get("/requests")
    .query({ limit: 1, offset: 0 })
    .set("x-api-key", accountA.apiKey);

  expect(history.status).toBe(200);
  expect(history.body.total).toBe(2);
  expect(history.body.items).toHaveLength(1);

  const nextPage = await request(app)
    .get("/requests")
    .query({ limit: 1, offset: 1 })
    .set("x-api-key", accountA.apiKey);

  expect(nextPage.status).toBe(200);
  expect(nextPage.body.items).toHaveLength(1);
  expect(nextPage.body.items[0].requestId).not.toBe(
    history.body.items[0].requestId,
  );

  const rejectedHistory = await request(app)
    .get("/requests")
    .query({
      accepted: "false",
      userId: "company-a-user",
    })
    .set("x-api-key", accountA.apiKey);

  expect(rejectedHistory.status).toBe(200);
  expect(rejectedHistory.body.total).toBe(1);
  expect(rejectedHistory.body.items[0].requestId).toBe(
    "usage-rejected",
  );

  const otherHistory = await request(app)
    .get("/requests")
    .set("x-api-key", accountB.apiKey);

  expect(otherHistory.status).toBe(200);
  expect(otherHistory.body.total).toBe(0);
  expect(otherHistory.body.items).toEqual([]);

  const otherUsage = await request(app)
    .get("/usage")
    .set("x-api-key", accountB.apiKey);

  expect(otherUsage.status).toBe(200);
  expect(otherUsage.body.account.monthly.used).toBe(0);
  expect(otherUsage.body.users.items[0].userId).toBe(
    "company-b-user",
  );
  expect(otherUsage.body.users.items[0].monthly.used).toBe(0);
});
it("keeps previous-month usage separate and queryable", async () => {
  const account = await createAccount(testDb, {
    name: `monthly-test-${randomUUID()}`,
    planName: "Starter",
  });

  createdAccountIds.push(account.id);

  const user = await createUser(testDb, account.id, {
    externalId: "monthly-user",
  });

  const periods = await testDb.execute(sql`
    SELECT to_char(
      date_trunc('month', now() AT TIME ZONE 'UTC')
        - interval '1 month',
      'YYYY-MM-DD'
    ) AS previous_month
  `);

  const previousMonth = String(periods.rows[0]?.previous_month);

  await testDb.insert(usageCounters).values([
    {
      accountId: account.id,
      userId: null,
      periodType: "month",
      periodStart: previousMonth,
      unitsUsed: 100,
    },
    {
      accountId: account.id,
      userId: user.id,
      periodType: "month",
      periodStart: previousMonth,
      unitsUsed: 100,
    },
  ]);

  const current = await request(app)
    .get("/usage")
    .set("x-api-key", account.apiKey);

  expect(current.status).toBe(200);
  expect(current.body.account.monthly.used).toBe(0);
  expect(current.body.users.items[0].monthly.used).toBe(0);

  const consumed = await request(app)
    .post("/consume")
    .set("x-api-key", account.apiKey)
    .send({
      userId: "monthly-user",
      units: 10,
      requestId: "new-month-action",
    });

  expect(consumed.status).toBe(200);
  expect(consumed.body.accepted).toBe(true);
  expect(consumed.body.account.monthly.used).toBe(10);
  expect(consumed.body.user.monthly.used).toBe(10);

  const historical = await request(app)
    .get("/usage")
    .query({ month: previousMonth.slice(0, 7) })
    .set("x-api-key", account.apiKey);

  expect(historical.status).toBe(200);
  expect(historical.body.current).toBe(false);
  expect(historical.body.account.monthly).toEqual({
    used: 100,
  });
  expect(historical.body.users.items[0].monthly).toEqual({
    used: 100,
  });
  expect(historical.body.account).not.toHaveProperty("plan");
  expect(historical.body.account).not.toHaveProperty("daily");
});

it("keeps previous-day usage separate while preserving monthly usage", async () => {
  const account = await createAccount(testDb, {
    name: `daily-test-${randomUUID()}`,
    planName: "Starter",
  });

  createdAccountIds.push(account.id);

  const user = await createUser(testDb, account.id, {
    externalId: "daily-user",
  });

  const periods = await testDb.execute(sql`
    SELECT
      to_char(
        (now() AT TIME ZONE 'UTC') - interval '1 day',
        'YYYY-MM-DD'
      ) AS yesterday,
      to_char(
        date_trunc('month', now() AT TIME ZONE 'UTC'),
        'YYYY-MM-DD'
      ) AS current_month
  `);

  const yesterday = String(periods.rows[0]?.yesterday);
  const currentMonth = String(periods.rows[0]?.current_month);

  // Existing current-month usage and a separate previous-day counter.
  // These fixtures test period selection independently.
  for (const userId of [null, user.id]) {
    await testDb.insert(usageCounters).values([
      {
        accountId: account.id,
        userId,
        periodType: "month",
        periodStart: currentMonth,
        unitsUsed: 40,
      },
      {
        accountId: account.id,
        userId,
        periodType: "day",
        periodStart: yesterday,
        unitsUsed: 30,
      },
    ]);
  }

  const before = await request(app)
    .get("/usage")
    .set("x-api-key", account.apiKey);

  expect(before.status).toBe(200);
  expect(before.body.account.monthly.used).toBe(40);
  expect(before.body.account.daily.used).toBe(0);
  expect(before.body.users.items[0].monthly.used).toBe(40);
  expect(before.body.users.items[0].daily.used).toBe(0);

  const consumed = await request(app)
    .post("/consume")
    .set("x-api-key", account.apiKey)
    .send({
      userId: "daily-user",
      units: 10,
      requestId: "new-day-action",
    });

  expect(consumed.status).toBe(200);
  expect(consumed.body.accepted).toBe(true);
  expect(consumed.body.account.monthly.used).toBe(50);
  expect(consumed.body.account.daily.used).toBe(10);
  expect(consumed.body.user.monthly.used).toBe(50);
  expect(consumed.body.user.daily.used).toBe(10);

  const stored = await testDb
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.accountId, account.id));

  const previousDayCounters = stored.filter(
    (counter) =>
      counter.periodType === "day" &&
      counter.periodStart === yesterday,
  );

  expect(previousDayCounters).toHaveLength(2);

  for (const counter of previousDayCounters) {
    expect(counter.unitsUsed).toBe(30);
  }
});

it("rejects future months in usage and request history", async () => {
  const periods = await testDb.execute(sql`
    SELECT to_char(
      date_trunc('month', now() AT TIME ZONE 'UTC')
        + interval '1 month',
      'YYYY-MM'
    ) AS future_month
  `);

  const futureMonth = String(periods.rows[0]?.future_month);

  for (const endpoint of ["/usage", "/requests"]) {
    const response = await request(app)
      .get(endpoint)
      .query({ month: futureMonth })
      .set("x-api-key", accountA.apiKey);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("bad_request");
    expect(response.body.message).toBe(
      "month cannot be in the future",
    );
  }
});

});