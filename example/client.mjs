import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const adminToken = process.env.ADMIN_TOKEN;

if (!adminToken) {
  throw new Error("ADMIN_TOKEN is required to provision the demo account");
}

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      `${method} ${path}: HTTP ${response.status}: ${JSON.stringify(result)}`,
    );
  }

  return result;
}

async function main() {
  // Administrative setup for a fresh, repeatable demonstration.
  const account = await call(
    "POST",
    "/admin/accounts",
    {
      name: `Demo-${randomUUID()}`,
      planName: "Starter",
    },
    { "x-admin-token": adminToken },
  );

  // All account operations below use the account's API key.
  const headers = { "x-api-key": account.apiKey };

  const api = (method, path, body) =>
    call(method, path, body, headers);

  const accountPlan = await api("POST", "/plans", {
    kind: "account",
    name: "DemoAccount",
    monthlyAllowance: 30,
    dailyAllowance: null,
    maxPerRequest: 20,
  });

  const basic = await api("POST", "/plans", {
    kind: "user",
    name: "DemoBasic",
    monthlyAllowance: 100,
    dailyAllowance: null,
    maxPerRequest: 10,
  });

  const premium = await api("POST", "/plans", {
    kind: "user",
    name: "DemoPremium",
    monthlyAllowance: 100,
    dailyAllowance: null,
    maxPerRequest: 20,
  });

  await api("PATCH", "/account/plan", {
    planId: accountPlan.id,
  });

  await api("POST", "/users", {
    externalId: "ali",
    planId: basic.id,
  });

  await api("POST", "/users", {
    externalId: "sara",
    planId: premium.id,
  });

  console.log("\nUsage Metering — live API demonstration");
  console.log("Account: 30 units/month.");
  console.log("Ali: max 10 units/request. Sara: max 20 units/request.\n");

  async function action(label, userId, units) {
    const result = await api("POST", "/consume", {
      userId,
      units,
      requestId: randomUUID(),
    });

    console.log(label);
    console.log(
      JSON.stringify(
        {
          userId,
          units,
          accepted: result.accepted,
          rejectedBy: result.rejectedBy,
          rule: result.rule,
          userMonthlyRemaining: result.user.monthly.remaining,
          accountMonthlyRemaining: result.account.monthly.remaining,
        },
        null,
        2,
      ),
    );

    return result;
  }

  const first = await action("1. Accepted action", "ali", 5);
  assert.equal(first.accepted, true);
  assert.equal(first.account.monthly.used, 5);

  const userRejected = await action(
    "2. Rejected by Ali's per-request limit",
    "ali",
    15,
  );

  assert.equal(userRejected.accepted, false);
  assert.equal(userRejected.rejectedBy, "user");
  assert.equal(userRejected.rule, "max_per_request");
  assert.equal(userRejected.account.monthly.used, 5);

  console.log("\nUpdating Ali's plan through the API: max/request = 20.");

  await api("PATCH", `/plans/${basic.id}`, {
    maxPerRequest: 20,
  });

  const afterUserChange = await action(
    "3. Same quantity succeeds with a new request ID",
    "ali",
    15,
  );

  assert.equal(afterUserChange.accepted, true);
  assert.equal(afterUserChange.user.monthly.used, 20);

  const sara = await action(
    "4. Sara consumes the remaining shared allowance",
    "sara",
    10,
  );

  assert.equal(sara.accepted, true);
  assert.equal(sara.account.monthly.used, 30);

  const accountRejected = await action(
    "5. Rejected by the shared account limit",
    "sara",
    1,
  );

  assert.equal(accountRejected.accepted, false);
  assert.equal(accountRejected.rejectedBy, "account");
  assert.equal(accountRejected.rule, "monthly_allowance");
  assert.equal(accountRejected.account.monthly.used, 30);

  console.log("\nUpdating the account plan: monthly allowance = 50.");

  await api("PATCH", `/plans/${accountPlan.id}`, {
    monthlyAllowance: 50,
  });

  const afterAccountChange = await action(
    "6. New action succeeds after the account plan update",
    "sara",
    1,
  );

  assert.equal(afterAccountChange.accepted, true);
  assert.equal(afterAccountChange.account.monthly.used, 31);
  assert.equal(afterAccountChange.account.monthly.remaining, 19);

  console.log("\nPASS: all demonstration checks passed.");
  console.log("Plan changes required no client code changes or redeployment.");
}

main().catch((error) => {
  console.error("Demo failed:", error.message);
  process.exitCode = 1;
});